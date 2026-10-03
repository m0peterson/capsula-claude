import test from "node:test";
import assert from "node:assert/strict";
import { handleLlm, validateCustomBase } from "../lib/proxy-core.mjs";
import { extractJson } from "../public/js/util.js";

const env = (vars) => (name) => vars[name];
const post = (headers = {}, body = { model: "m", messages: [] }) =>
  new Request("http://x/api/llm", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function mockFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("GET отдаёт конфиг без значений ключей", async () => {
  const res = await handleLlm(new Request("http://x/api/llm"), env({ OPENROUTER_API_KEY: "secret", PILOT_ACCESS_CODE: "c" }));
  const j = await res.json();
  assert.deepEqual(j, { serverKeys: { openrouter: true, "opencode-go": false }, accessCodeRequired: true });
});

test("ключ пользователя уходит провайдеру, тело и стрим проходят как есть", async () => {
  const m = mockFetch(() => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const res = await handleLlm(post({ "x-provider": "openrouter", "x-api-key": "user-key" }), env({}));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(await res.text(), "data: {}\n\n");
    assert.equal(m.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(m.calls[0].init.headers.authorization, "Bearer user-key");
    assert.equal(m.calls[0].init.redirect, "error");
  } finally {
    m.restore();
  }
});

test("OpenCode Go идёт на свой endpoint", async () => {
  const m = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    await handleLlm(post({ "x-provider": "opencode-go", "x-api-key": "k" }), env({}));
    assert.equal(m.calls[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
  } finally {
    m.restore();
  }
});

test("статус ошибки провайдера пробрасывается", async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
  try {
    const res = await handleLlm(post({ "x-api-key": "k" }), env({}));
    assert.equal(res.status, 401);
    assert.match(await res.text(), /bad key/);
  } finally {
    m.restore();
  }
});

test("без ключа и без серверного токена: 401", async () => {
  const res = await handleLlm(post({}), env({}));
  assert.equal(res.status, 401);
});

test("токен пилота без кода доступа", async () => {
  const m = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await handleLlm(post({}), env({ OPENROUTER_API_KEY: "pilot" }));
    assert.equal(res.status, 200);
    assert.equal(m.calls[0].init.headers.authorization, "Bearer pilot");
  } finally {
    m.restore();
  }
});

test("код доступа: неверный отклоняется, верный принимается", async () => {
  const m = mockFetch(() => new Response("{}", { status: 200 }));
  const e = env({ OPENROUTER_API_KEY: "pilot", PILOT_ACCESS_CODE: "open-sesame" });
  try {
    assert.equal((await handleLlm(post({}), e)).status, 401);
    assert.equal((await handleLlm(post({ "x-access-code": "nope" }), e)).status, 401);
    assert.equal(m.calls.length, 0);
    assert.equal((await handleLlm(post({ "x-access-code": "open-sesame" }), e)).status, 200);
  } finally {
    m.restore();
  }
});

test("собственный ключ работает без кода доступа", async () => {
  const m = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await handleLlm(post({ "x-api-key": "mine" }), env({ OPENROUTER_API_KEY: "pilot", PILOT_ACCESS_CODE: "c" }));
    assert.equal(res.status, 200);
    assert.equal(m.calls[0].init.headers.authorization, "Bearer mine");
  } finally {
    m.restore();
  }
});

test("свой провайдер: ключ обязателен, серверный токен не подставляется", async () => {
  const res = await handleLlm(
    post({ "x-provider": "custom", "x-base-url": "https://api.example.com/v1" }),
    env({ OPENROUTER_API_KEY: "pilot" }),
  );
  assert.equal(res.status, 401);
});

test("validateCustomBase отсекает небезопасные адреса", () => {
  assert.equal(validateCustomBase("https://api.example.com/v1/"), "https://api.example.com/v1");
  for (const bad of [
    "http://api.example.com",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://intranet/v1",
    "https://a.internal/v1",
    "https://u:p@api.example.com",
    "nonsense",
  ]) {
    assert.throws(() => validateCustomBase(bad), undefined, bad);
  }
});

test("неизвестный провайдер и не-JSON тело", async () => {
  assert.equal((await handleLlm(post({ "x-provider": "evil", "x-api-key": "k" }), env({}))).status, 400);
  const bad = new Request("http://x/api/llm", { method: "POST", headers: { "x-api-key": "k" }, body: "not json" });
  assert.equal((await handleLlm(bad, env({}))).status, 400);
});

test("extractJson: обёртки и мусор вокруг", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Вот ответ: {"a":[1,2]} Готово.'), { a: [1, 2] });
  assert.deepEqual(extractJson('[{"x":1}]'), [{ x: 1 }]);
  assert.throws(() => extractJson("без json"));
});
