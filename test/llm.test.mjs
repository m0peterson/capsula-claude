import test from "node:test";
import assert from "node:assert/strict";

const { chat, chatJson, resetLearned, setRetryDelay } = await import("../server/llm.mjs");
setRetryDelay(1);

const endpoint = { provider: "openrouter", key: "sk-test" };
const slot = () => ({ model: "m/x", effort: "xhigh", maxTokens: 16000 });

const delta = (content, finish = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });
const sse = (chunks, { done = true } = {}) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const jsonStream = (obj) => sse([delta(JSON.stringify(obj).slice(0, 20)), delta(JSON.stringify(obj).slice(20), "stop")]);
const errorResponse = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });

function mockFetch(...responses) {
  const bodies = [];
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    assert.ok(next, "неожиданный лишний запрос");
    return typeof next === "function" ? next() : next;
  };
  return { bodies, calls, restore: () => (globalThis.fetch = original) };
}

const run = (fn) => async () => {
  resetLearned();
  try {
    await fn();
  } finally {
    globalThis.fetch = fetch0;
  }
};
const fetch0 = globalThis.fetch;

const ask = () => chatJson({ endpoint, slot: slot(), system: "JSON", user: "q" });

test(
  "параметры запроса: стрим, effort, лимит токенов, JSON-режим",
  run(async () => {
    const m = mockFetch(jsonStream({ a: 1 }));
    const { data } = await ask();
    assert.deepEqual(data, { a: 1 });
    const b = m.bodies[0];
    assert.equal(b.stream, true);
    assert.deepEqual(b.reasoning, { effort: "xhigh" });
    assert.equal(b.max_tokens, 16000);
    assert.deepEqual(b.response_format, { type: "json_object" });
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "ответ оборван без [DONE]: ошибка про обрыв, без ремонта и без повторного запроса",
  run(async () => {
    const m = mockFetch(sse([delta('{"a":[{"x":1},{"y":"обор')], { done: false }));
    await assert.rejects(ask(), (e) => e.truncated === true && /оборвалось/.test(e.message) && e.raw.includes("обор"));
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "finish_reason=length: ошибка про лимит токенов",
  run(async () => {
    const m = mockFetch(sse([delta('{"a":[{"x":1},{"y":"обор', "length")]));
    await assert.rejects(ask(), (e) => e.truncated === true && /лимит токенов/.test(e.message));
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "обрыв, но JSON уже целый: принимаем",
  run(async () => {
    mockFetch(sse([delta('{"a":1}')], { done: false }));
    const { data } = await ask();
    assert.deepEqual(data, { a: 1 });
  }),
);

test(
  "завершённый, но невалидный JSON чинится без повторного запроса",
  run(async () => {
    const m = mockFetch(sse([delta('{"a":"он сказал "привет" ему","b":[1,2,]}', "stop")]));
    const { data } = await ask();
    assert.deepEqual(data, { a: 'он сказал "привет" ему', b: [1, 2] });
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "нечинимый ответ: один повтор с текстом ошибки, потом результат",
  run(async () => {
    const m = mockFetch(sse([delta("Извините, не могу помочь с этим.", "stop")]), jsonStream({ ok: true }));
    const { data } = await ask();
    assert.deepEqual(data, { ok: true });
    assert.equal(m.bodies.length, 2);
    const msgs = m.bodies[1].messages;
    assert.equal(msgs.at(-2).role, "assistant");
    assert.match(msgs.at(-1).content, /не разобрался как JSON/);
  }),
);

test(
  "оба ответа плохие: ошибка несёт оба сырых ответа",
  run(async () => {
    mockFetch(sse([delta("первый мусор", "stop")]), sse([delta("второй мусор", "stop")]));
    await assert.rejects(ask(), (e) => e.raw === "первый мусор" && e.raw2 === "второй мусор");
  }),
);

test(
  "провайдер не знает response_format: повтор без него, остальное сохраняется",
  run(async () => {
    const m = mockFetch(errorResponse(400, "Unsupported parameter: response_format"), jsonStream({ a: 1 }));
    await ask();
    assert.equal(m.bodies.length, 2);
    assert.ok(m.bodies[0].response_format);
    assert.equal(m.bodies[1].response_format, undefined);
    assert.deepEqual(m.bodies[1].reasoning, { effort: "xhigh" });
    assert.equal(m.bodies[1].max_tokens, 16000);
  }),
);

test(
  "провайдер не знает reasoning: отбрасывается только он",
  run(async () => {
    const m = mockFetch(errorResponse(400, "reasoning effort is not supported by this model"), jsonStream({ a: 1 }));
    await ask();
    assert.equal(m.bodies[1].reasoning, undefined);
    assert.ok(m.bodies[1].response_format);
  }),
);

test(
  "400 не про параметры: без повторов, ошибка как есть",
  run(async () => {
    const m = mockFetch(errorResponse(400, "Image too big"));
    await assert.rejects(ask(), /Image too big/);
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "401 не повторяется",
  run(async () => {
    const m = mockFetch(errorResponse(401, "No auth"));
    await assert.rejects(ask(), /No auth/);
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "ответ без стрима (обычный JSON)",
  run(async () => {
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"a":2}' }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { data } = await ask();
    assert.deepEqual(data, { a: 2 });
  }),
);

test(
  "ошибка внутри потока пробрасывается",
  run(async () => {
    mockFetch(sse([delta('{"a"'), { error: { message: "Provider disconnected" } }], { done: false }));
    await assert.rejects(chat({ endpoint, slot: slot(), messages: [] }), /Provider disconnected/);
  }),
);

test(
  "пустой ответ при finish_reason=length объясняет про рассуждения",
  run(async () => {
    mockFetch(sse([{ choices: [{ delta: { reasoning: "думаю..." }, finish_reason: null }] }, delta("", "length")]));
    await assert.rejects(chat({ endpoint, slot: slot(), messages: [] }), /исчерпан лимит токенов/);
  }),
);

test(
  "maxTokens=0 не отправляется",
  run(async () => {
    const m = mockFetch(jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: { ...slot(), maxTokens: 0 }, system: "JSON", user: "q" });
    assert.equal(m.bodies[0].max_tokens, undefined);
  }),
);

// --- Регрессии из состязательного ревью -----------------------------------------------------------------
const brokenStream = (chunks, error = new TypeError("terminated")) => {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`));
        else controller.error(error);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

test(
  "соединение порвалось посреди ответа: понятная ошибка про обрыв, текст сохранён, без повторов",
  run(async () => {
    const m = mockFetch(brokenStream([delta('{"a":[{"x":1},{"y":"обор')]));
    await assert.rejects(ask(), (e) => e.truncated === true && /оборвалось/.test(e.message) && e.raw.includes("обор"));
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "соединение порвалось на стадии рассуждения: обрыв, а не «пустой ответ, проверьте ключ»",
  run(async () => {
    mockFetch(brokenStream([{ choices: [{ delta: { reasoning: "думаю..." }, finish_reason: null }] }]));
    await assert.rejects(ask(), (e) => e.truncated === true && /оборвалось/.test(e.message) && !/ключ/.test(e.message));
  }),
);

test(
  "отмена пользователем во время чтения не маскируется под обрыв",
  run(async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    mockFetch(brokenStream([delta('{"a":')], abort));
    await assert.rejects(ask(), (e) => e.name === "AbortError");
  }),
);

test(
  "finish_reason не из белого списка и JSON оборван: ошибка с причиной, без тихого ремонта",
  run(async () => {
    const m = mockFetch(sse([delta('{"a":[{"x":1},{"y":"обор', "content_filter")]));
    await assert.rejects(ask(), (e) => e.truncated === true && /content_filter/.test(e.message));
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "finish_reason content_filter, но JSON целый: принимаем",
  run(async () => {
    mockFetch(sse([delta('{"a":1}', "content_filter")]));
    assert.deepEqual((await ask()).data, { a: 1 });
  }),
);

test(
  "finish_reason в разном регистре считается нормальным",
  run(async () => {
    mockFetch(sse([delta('{"a":"он сказал "привет" мне"}', "STOP")]));
    assert.equal((await ask()).data.a, 'он сказал "привет" мне');
  }),
);

test(
  "OpenRouter: причина апстрима в metadata.raw, отбрасывается только reasoning",
  run(async () => {
    const wrapped = new Response(
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: JSON.stringify({ error: { message: "Unsupported value: 'xhigh' is not supported", param: "reasoning_effort" } }),
            provider_name: "X",
          },
        },
      }),
      { status: 400 },
    );
    const notices = [];
    const m = mockFetch(wrapped, jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", onNotice: (n) => notices.push(n) });
    assert.equal(m.bodies.length, 2);
    assert.equal(m.bodies[1].reasoning, undefined);
    assert.ok(m.bodies[1].response_format, "JSON-режим сохранён");
    assert.equal(m.bodies[1].max_tokens, 16000, "лимит сохранён");
    assert.equal(notices.length, 1);
    assert.match(notices[0], /effort/);
  }),
);

test(
  "OpenAI: параметр назван только в error.param, ошибка без слов reasoning/effort в тексте",
  run(async () => {
    const r = new Response(
      JSON.stringify({
        error: {
          message: "Unsupported value: 'xhigh' is not supported with this model.",
          param: "reasoning_effort",
          code: "unsupported_value",
        },
      }),
      { status: 400 },
    );
    const m = mockFetch(r, jsonStream({ a: 1 }));
    await ask();
    assert.equal(m.bodies[1].reasoning, undefined);
    assert.ok(m.bodies[1].response_format);
    assert.equal(m.bodies[1].max_tokens, 16000);
  }),
);

test(
  "max_tokens не поддерживается, нужен max_completion_tokens: переименование без потери лимита",
  run(async () => {
    const m = mockFetch(
      errorResponse(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
      jsonStream({ a: 1 }),
    );
    await ask();
    assert.equal(m.bodies[1].max_tokens, undefined);
    assert.equal(m.bodies[1].max_completion_tokens, 16000);
    assert.ok(m.bodies[1].response_format);
    assert.deepEqual(m.bodies[1].reasoning, { effort: "xhigh" });
  }),
);

test(
  "то, что провайдер не принимает, запоминается: следующий вызов сразу без параметра",
  run(async () => {
    const m = mockFetch(errorResponse(400, "Unsupported parameter: response_format"), jsonStream({ a: 1 }), jsonStream({ b: 2 }));
    await ask();
    await ask();
    assert.equal(m.bodies.length, 3);
    assert.equal(m.bodies[2].response_format, undefined);
  }),
);

test(
  "сторонний 400 про картинку не отбрасывает ни один параметр",
  run(async () => {
    const m = mockFetch(errorResponse(400, "Image is too large: maximum size is 20MB"));
    await assert.rejects(ask(), /too large/);
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "ошибка в потоке строкой сохраняет текст и уже полученное",
  run(async () => {
    mockFetch(sse([delta('{"a"'), { error: "model overloaded" }], { done: false }));
    await assert.rejects(ask(), (e) => e.message === "model overloaded" && e.raw === '{"a"');
  }),
);

test(
  "посторонняя сноска [1] в тексте до JSON: ответ берётся целиком с первого раза",
  run(async () => {
    const m = mockFetch(sse([delta('Результаты [1]:\n{"results":[{"title":"x"}]}', "stop")]));
    const { data } = await chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", expect: ["results"] });
    assert.deepEqual(data, { results: [{ title: "x" }] });
    assert.equal(m.bodies.length, 1);
  }),
);

// --- Регрессии второго раунда ревью --------------------------------------------------------------------
test(
  "JSON-режим распознаётся по словам «JSON mode» и «response format» с пробелом",
  run(async () => {
    const m = mockFetch(errorResponse(400, "This model does not support JSON mode"), jsonStream({ a: 1 }));
    await ask();
    assert.equal(m.bodies[1].response_format, undefined);
    assert.deepEqual(m.bodies[1].reasoning, { effort: "xhigh" }, "reasoning не тронут");
    resetLearned();
    const m2 = mockFetch(errorResponse(400, "Invalid response format for this model"), jsonStream({ a: 1 }));
    await ask();
    assert.equal(m2.bodies[1].response_format, undefined);
  }),
);

test(
  "неверная догадка не запоминается: если повтор тоже упал, следующий вызов шлёт всё заново",
  run(async () => {
    // 500 повторяется один раз как временная ошибка, поэтому в сценарии два сбоя подряд.
    const m = mockFetch(
      errorResponse(400, "Unsupported value: something not supported"),
      errorResponse(500, "upstream down"),
      errorResponse(500, "upstream down"),
      jsonStream({ a: 1 }),
    );
    await assert.rejects(ask(), /upstream down/);
    await ask();
    assert.equal(m.bodies.length, 4);
    assert.deepEqual(m.bodies[3].reasoning, { effort: "xhigh" }, "отказ от reasoning не закрепился");
  }),
);

test(
  "запомненный отказ не переносится на другого провайдера",
  run(async () => {
    const go = { provider: "opencode-go", key: "k" };
    const m = mockFetch(errorResponse(400, "Unsupported parameter: response_format"), jsonStream({ a: 1 }), jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: slot(), system: "JSON", user: "q" });
    await chatJson({ endpoint: go, slot: slot(), system: "JSON", user: "q" });
    assert.ok(m.bodies[2].response_format, "у другого провайдера JSON-режим пробуется снова");
  }),
);

test(
  "finish_reason MAX_TOKENS и LENGTH объясняются как лимит токенов, а не фильтр",
  run(async () => {
    for (const finish of ["MAX_TOKENS", "LENGTH", "max_output_tokens"]) {
      mockFetch(sse([delta('{"a":[{"x":1},{"y":"обор', finish)]));
      await assert.rejects(ask(), (e) => e.truncated && /лимит токенов/.test(e.message), finish);
    }
  }),
);

test(
  "ошибка чтения после [DONE] не превращает целый ответ в оборванный",
  run(async () => {
    const enc = new TextEncoder();
    const chunks = [`data: ${JSON.stringify(delta('{"a":1}'))}\n\n`, "data: [DONE]\n\n"];
    let i = 0;
    mockFetch(
      new Response(
        new ReadableStream({
          pull(c) {
            if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
            else c.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    assert.deepEqual((await ask()).data, { a: 1 });
  }),
);

test(
  "ошибка обработки чанка не выдаётся за обрыв соединения",
  run(async () => {
    mockFetch(sse([delta('{"a"'), { error: { message: "Rate limited" } }], { done: false }));
    await assert.rejects(ask(), (e) => e.message === "Rate limited" && !e.truncated);
  }),
);

test(
  "оборванный голый массив даёт ошибку обрыва, а не «1 вещь из N»",
  run(async () => {
    const items = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ index: i + 1, name: `Вещь ${i}` })));
    mockFetch(sse([delta(items.slice(0, items.length - 20), "length")]));
    await assert.rejects(chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", expect: ["items"] }), (e) => e.truncated === true);
  }),
);

test(
  "непочиняемый ответ без ключей: повтор запроса, а не принятие фрагмента",
  run(async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, name: `Вещь ${i}` }));
    const odd = JSON.stringify({ items }).replace('"Вещь 1"', '"Вещь 5" 1"');
    const m = mockFetch(sse([delta(odd, "stop")]), jsonStream({ items }));
    const { data } = await chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", expect: ["items"] });
    assert.equal(data.items.length, 5);
    assert.equal(m.bodies.length, 2);
  }),
);

// --- Регрессии третьего раунда ревью --------------------------------------------------------------------
const erroringStream = (chunks, { cancelled, error = new TypeError("terminated") } = {}) => {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i < chunks.length)
          c.enqueue(enc.encode(typeof chunks[i] === "string" ? chunks[i++] : `data: ${JSON.stringify(chunks[i++])}\n\n`));
        else if (error) c.error(error);
      },
      cancel() {
        if (cancelled) cancelled.done = true;
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

test(
  "после [DONE] ошибка чтения не делает ответ оборванным даже если JSON пришлось чинить",
  run(async () => {
    const broken = '{"a":"он сказал "привет" мне"}'; // требует ремонта: при truncated=true это была бы ошибка обрыва
    mockFetch(erroringStream([delta(broken), "data: [DONE]\n\n"]));
    assert.equal((await ask()).data.a, 'он сказал "привет" мне');
  }),
);

test(
  "исключение при обработке чанка (не ошибка сети) пробрасывается как есть и закрывает поток",
  run(async () => {
    const cancelled = { done: false };
    mockFetch(erroringStream([delta('{"a"'), { choices: [{ delta: { content: "x", annotations: 5 } }] }], { cancelled, error: null }));
    await assert.rejects(ask(), (e) => e instanceof TypeError && !e.truncated);
    await new Promise((r) => setTimeout(r, 0)); // cancel() запускается без ожидания
    assert.equal(cancelled.done, true, "reader.cancel() вызван");
  }),
);

test(
  "решение про параметр забывается через 30 минут",
  run(async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const m = mockFetch(
        errorResponse(400, "Unsupported parameter: response_format"),
        jsonStream({ a: 1 }),
        jsonStream({ a: 1 }),
        jsonStream({ a: 1 }),
      );
      await ask();
      await ask();
      assert.equal(m.bodies[2].response_format, undefined, "в пределах 30 минут параметр не шлётся");
      now += 31 * 60 * 1000;
      await ask();
      assert.ok(m.bodies[3].response_format, "через 31 минуту пробуем снова");
    } finally {
      Date.now = realNow;
    }
  }),
);

test(
  "ответ из вложенного фрагмента при finish=length даёт ошибку обрыва",
  run(async () => {
    const text = 'Анализ [фото:\n{"color_type":{"season":"осень"},"body":{"type":"груша"}}';
    mockFetch(sse([delta(text, "length")]));
    await assert.rejects(
      chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", expect: ["color_type", "body"] }),
      (e) => e.truncated === true,
    );
  }),
);

test(
  "черновик в рассуждениях до </think> не просачивается через chatJson",
  run(async () => {
    const draft = '{"items":[{"index":1,"name":"A"},{"index":2,"name":"B"},{"index":3,"name":"Сумка"}]}';
    mockFetch(sse([delta(`черновик ${draft} сумки нет\n</think>\n{"items":[{"index":1,"name":"A"},{"index":2,"name":"B"}]}`, "stop")]));
    const { data } = await chatJson({ endpoint, slot: slot(), system: "JSON", user: "q", expect: ["items"] });
    assert.equal(data.items.length, 2);
  }),
);

// --- Серверный клиент ------------------------------------------------------------------------------------
test(
  "OpenRouter: провайдеры без хранения данных, запасная модель, temperature",
  run(async () => {
    const m = mockFetch(jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: { ...slot(), fallback: "f/y", temperature: 0 }, system: "JSON", user: "q" });
    const b = m.bodies[0];
    assert.deepEqual(b.provider, { data_collection: "deny" });
    assert.deepEqual(b.models, ["m/x", "f/y"]);
    assert.equal(b.temperature, 0);
    assert.equal(m.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(m.calls[0].init.headers.authorization, "Bearer sk-test");
    assert.equal(m.calls[0].init.redirect, "manual");
  }),
);

test(
  "OpenCode Go: свой адрес, заголовок сессии, reasoning_effort, без параметров OpenRouter",
  run(async () => {
    const m = mockFetch(jsonStream({ a: 1 }));
    await chatJson({ endpoint: { provider: "opencode-go", key: "oc" }, slot: { ...slot(), fallback: "f/y" }, system: "JSON", user: "q" });
    const { url, init } = m.calls[0];
    assert.equal(url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.match(init.headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
    assert.match(init.headers["user-agent"], /capsula/);
    const b = m.bodies[0];
    assert.equal(b.reasoning_effort, "xhigh");
    assert.equal(b.reasoning, undefined);
    assert.equal(b.provider, undefined);
    assert.equal(b.models, undefined);
  }),
);

test(
  "провайдер не принимает temperature: повтор без неё, остальное сохраняется",
  run(async () => {
    const m = mockFetch(errorResponse(400, "Unsupported parameter: 'temperature' is not supported with this model."), jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: { ...slot(), temperature: 0 }, system: "JSON", user: "q" });
    assert.equal(m.bodies[1].temperature, undefined);
    assert.ok(m.bodies[1].response_format);
    assert.deepEqual(m.bodies[1].reasoning, { effort: "xhigh" });
  }),
);

test(
  "расход токенов из последнего чанка возвращается вместе с ответом",
  run(async () => {
    mockFetch(sse([delta('{"a":1}', "stop"), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }]));
    const r = await ask();
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });
  }),
);

test(
  "без ключа и без модели: понятная ошибка до запроса",
  run(async () => {
    const m = mockFetch();
    await assert.rejects(chatJson({ endpoint: { provider: "openrouter", key: "" }, slot: slot(), system: "s", user: "u" }), /ключ/);
    await assert.rejects(chatJson({ endpoint, slot: { ...slot(), model: " " }, system: "s", user: "u" }), /модель/);
    assert.equal(m.bodies.length, 0);
  }),
);

test(
  "редирект провайдера не выполняется и даёт ошибку",
  run(async () => {
    const m = mockFetch(new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    await assert.rejects(ask(), /перенаправлением \(302\)/);
    assert.equal(m.bodies.length, 1);
  }),
);

test(
  "временная ошибка провайдера (429, 5xx, Cloudflare 1015, сеть): один повтор, вторая ошибка уходит пользователю",
  run(async () => {
    for (const first of [
      errorResponse(429, "Rate limited"),
      errorResponse(503, "busy"),
      new Response("error code: 1015", { status: 403 }),
    ]) {
      const m = mockFetch(first, jsonStream({ a: 1 }));
      assert.deepEqual((await ask()).data, { a: 1 });
      assert.equal(m.bodies.length, 2);
    }
    let n = 0;
    globalThis.fetch = async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return jsonStream({ b: 2 });
    };
    assert.deepEqual((await ask()).data, { b: 2 });
    const m = mockFetch(errorResponse(502, "bad gateway"), errorResponse(502, "still bad"));
    await assert.rejects(ask(), /still bad/);
    assert.equal(m.bodies.length, 2, "не больше одного повтора");
  }),
);

// --- Responses API (OpenCode Go: Muse Spark, GPT) ----------------------------------------------------------
const rsse = (events) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const rdone = (text, { status = "completed", reason = null, usage } = {}) =>
  rsse([
    { type: "response.created", response: { id: "resp_1", model: "muse-spark-1.3-contributor", status: "in_progress" } },
    { type: "response.output_text.delta", delta: text.slice(0, 5) },
    { type: "response.output_text.delta", delta: text.slice(5) },
    {
      type: status === "completed" ? "response.completed" : "response.incomplete",
      response: {
        status,
        model: "muse-spark-1.3-contributor",
        incomplete_details: reason ? { reason } : null,
        usage: usage ?? { input_tokens: 100, output_tokens: 40, total_tokens: 140, output_tokens_details: { reasoning_tokens: 25 } },
      },
    },
  ]);
const go = { provider: "opencode-go", key: "oc" };
const muse = () => ({ model: "muse-spark-1.3-contributor", effort: "low", maxTokens: 9000 });

test(
  "Muse Spark на OpenCode Go идёт через /responses: instructions, input_image, лимит, JSON-формат, store=false",
  run(async () => {
    const m = mockFetch(rdone('{"a":1}'));
    const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const r = await chatJson({ endpoint: go, slot: muse(), system: "SYS", user: "вопрос", images: [{ label: "Фото 1:", url: IMG }] });
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(m.calls[0].url, "https://opencode.ai/zen/go/v1/responses");
    const b = m.bodies[0];
    assert.equal(b.instructions, "SYS");
    assert.deepEqual(b.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "вопрос" },
          { type: "input_text", text: "Фото 1:" },
          { type: "input_image", image_url: IMG },
        ],
      },
    ]);
    assert.equal(b.max_output_tokens, 9000);
    assert.deepEqual(b.reasoning, { effort: "low" });
    assert.deepEqual(b.text, { format: { type: "json_object" } });
    assert.equal(b.store, false);
    assert.equal(b.messages, undefined);
    assert.equal(b.response_format, undefined);
    assert.deepEqual(r.usage, {
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      completion_tokens_details: { reasoning_tokens: 25 },
    });
    assert.equal(r.protocol, "responses");
  }),
);

test(
  "Responses API: incomplete по лимиту это обрыв про токены, response.failed это ошибка провайдера",
  run(async () => {
    mockFetch(rdone('{"a":[1,2', { status: "incomplete", reason: "max_output_tokens" }));
    await assert.rejects(
      chatJson({ endpoint: go, slot: muse(), system: "S", user: "u" }),
      (e) => e.truncated && /лимит токенов/.test(e.message),
    );
    mockFetch(
      rsse([
        { type: "response.output_text.delta", delta: "{" },
        { type: "response.failed", response: { error: { message: "model overloaded" } } },
      ]),
    );
    await assert.rejects(chatJson({ endpoint: go, slot: muse(), system: "S", user: "u" }), /model overloaded/);
  }),
);

test(
  "модель не понимает chat/completions: один раз переключаемся на /responses и запоминаем",
  run(async () => {
    const unsupported = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "ModelProtocolUnsupported", message: "Model does not support this protocol." } }),
        {
          status: 400,
        },
      );
    const m = mockFetch(unsupported(), rdone('{"a":1}'), rdone('{"a":2}'));
    const slot = { model: "new-model-x", effort: "low", maxTokens: 100 };
    assert.deepEqual((await chatJson({ endpoint: go, slot, system: "S", user: "u" })).data, { a: 1 });
    assert.match(m.calls[0].url, /chat\/completions$/);
    assert.match(m.calls[1].url, /\/responses$/);
    assert.deepEqual((await chatJson({ endpoint: go, slot, system: "S", user: "u" })).data, { a: 2 });
    assert.match(m.calls[2].url, /\/responses$/, "второй вызов сразу в нужный протокол");
  }),
);

test(
  "effort, который модель не знает, меняется на ближайший допустимый, а не выкидывается",
  run(async () => {
    const m = mockFetch(
      errorResponse(
        400,
        "reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'. Supported values: [minimal, low, medium, high, xhigh, max]",
      ),
      rdone('{"a":1}'),
    );
    await chatJson({ endpoint: go, slot: { ...muse(), effort: "none" }, system: "S", user: "u" });
    assert.deepEqual(m.bodies[1].reasoning, { effort: "minimal" });
    const m2 = mockFetch(errorResponse(400, "Reasoning is mandatory for this endpoint and cannot be disabled."), jsonStream({ a: 1 }));
    await chatJson({ endpoint, slot: { model: "meta/muse-spark-1.3-contributor", effort: "none" }, system: "S", user: "u" });
    assert.deepEqual(m2.bodies[1].reasoning, { effort: "minimal" });
  }),
);

test(
  "трасса запроса: параметры без фото, статус, итог с токенами и сырой ответ",
  run(async () => {
    mockFetch(
      sse([
        {
          id: "gen-1",
          provider: "Meta",
          model: "meta/muse-spark-1.3-contributor",
          choices: [{ delta: { content: '{"a":1}' }, finish_reason: "stop" }],
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } },
      ]),
    );
    const events = [];
    const IMG = "data:image/jpeg;base64," + "A".repeat(4096);
    await chatJson({
      endpoint,
      slot: { model: "meta/muse-spark-1.3-contributor", effort: "low", dataCollection: "allow" },
      system: "S",
      user: "u",
      images: [IMG],
      trace: (type, data) => events.push({ type, ...data }),
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["llm.request", "llm.response", "llm.done", "llm.raw", "parse"],
    );
    const [req, res, done, raw] = events;
    assert.ok(!JSON.stringify(req).includes("AAAA"), "фото не попадает в лог");
    assert.deepEqual(req.params.messages[1].images, ["jpeg 3 КБ"]);
    assert.deepEqual(req.params.provider, { data_collection: "allow" });
    assert.equal(res.status, 200);
    assert.equal(done.served, "Meta");
    assert.equal(done.id, "gen-1");
    assert.deepEqual(done.usage, { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 });
    assert.equal(raw.text, '{"a":1}');
  }),
);
