import test from "node:test";
import assert from "node:assert/strict";

// store.js рассчитан на браузер: подставляем минимальные глобалы.
globalThis.addEventListener = () => {};
globalThis.document = { visibilityState: "visible" };

const { settings } = await import("../public/js/store.js");
const { chat, chatJson } = await import("../public/js/llm.js");

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
    await assert.rejects(chat({ slot: slot(), messages: [] }), /лимит токенов на рассуждение/);
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
