import test from "node:test";
import assert from "node:assert/strict";

// store.js рассчитан на браузер: подставляем минимальные глобалы.
globalThis.addEventListener = () => {};
globalThis.document = { visibilityState: "visible" };

const { settings } = await import("../public/js/store.js");
const { chat, chatJson, resetLearned } = await import("../public/js/llm.js");

settings.providers.openrouter.apiKey = "sk-test";
const slot = () => ({ provider: "openrouter", model: "m/x", effort: "xhigh", maxTokens: 16000 });

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
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    assert.ok(next, "неожиданный лишний запрос");
    return typeof next === "function" ? next() : next;
  };
  return { bodies, restore: () => (globalThis.fetch = original) };
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

const ask = () => chatJson({ slot: slot(), system: "JSON", user: "q" });

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
    await assert.rejects(chat({ slot: slot(), messages: [] }), /Provider disconnected/);
  }),
);

test(
  "пустой ответ при finish_reason=length объясняет про рассуждения",
  run(async () => {
    mockFetch(sse([{ choices: [{ delta: { reasoning: "думаю..." }, finish_reason: null }] }, delta("", "length")]));
    await assert.rejects(chat({ slot: slot(), messages: [] }), /исчерпан лимит токенов/);
  }),
);

test(
  "maxTokens=0 не отправляется",
  run(async () => {
    const m = mockFetch(jsonStream({ a: 1 }));
    await chatJson({ slot: { ...slot(), maxTokens: 0 }, system: "JSON", user: "q" });
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
    await chatJson({ slot: slot(), system: "JSON", user: "q", onNotice: (n) => notices.push(n) });
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
    const { data } = await chatJson({ slot: slot(), system: "JSON", user: "q", expect: ["results"] });
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
    const m = mockFetch(
      errorResponse(400, "Unsupported value: something not supported"),
      errorResponse(500, "upstream down"),
      jsonStream({ a: 1 }),
    );
    await assert.rejects(ask(), /upstream down/);
    await ask();
    assert.equal(m.bodies.length, 3);
    assert.deepEqual(m.bodies[2].reasoning, { effort: "xhigh" }, "отказ от reasoning не закрепился");
  }),
);

test(
  "запомненный отказ не переносится на другой адрес своего провайдера",
  run(async () => {
    settings.providers.custom.baseUrl = "https://a.example.com/v1";
    settings.providers.custom.apiKey = "k";
    const custom = () => ({ provider: "custom", model: "m/x", effort: "xhigh", maxTokens: 0 });
    const m = mockFetch(errorResponse(400, "Unsupported parameter: response_format"), jsonStream({ a: 1 }), jsonStream({ a: 1 }));
    await chatJson({ slot: custom(), system: "JSON", user: "q" });
    settings.providers.custom.baseUrl = "https://b.example.com/v1";
    await chatJson({ slot: custom(), system: "JSON", user: "q" });
    assert.ok(m.bodies[2].response_format, "на другом адресе JSON-режим пробуется снова");
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
    await assert.rejects(chatJson({ slot: slot(), system: "JSON", user: "q", expect: ["items"] }), (e) => e.truncated === true);
  }),
);

test(
  "непочиняемый ответ без ключей: повтор запроса, а не принятие фрагмента",
  run(async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, name: `Вещь ${i}` }));
    const odd = JSON.stringify({ items }).replace('"Вещь 1"', '"Вещь 5" 1"');
    const m = mockFetch(sse([delta(odd, "stop")]), jsonStream({ items }));
    const { data } = await chatJson({ slot: slot(), system: "JSON", user: "q", expect: ["items"] });
    assert.equal(data.items.length, 5);
    assert.equal(m.bodies.length, 2);
  }),
);
