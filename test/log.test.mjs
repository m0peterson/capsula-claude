// Логи и трасса задачи: что видит разработчик, что пишется в консоль и в файл dev-сервера.
import test from "node:test";
import assert from "node:assert/strict";
import { handleApi, resetRateLimits } from "../server/api.mjs";
import { resetLearned } from "../server/llm.mjs";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ" + "B".repeat(2000);
const ENV = { OPENROUTER_API_KEY: "k", ADMIN_CODE: "dev-1", PRO_SECRET: "s" };
const env = (vars) => (name) => vars[name];
const LOOKS = { looks: [{ name: "a", item_ids: ["w1", "w2"] }] };
const wardrobe = [
  { id: "w1", name: "a" },
  { id: "w2", name: "b" },
];

const req = (body, headers = {}) =>
  new Request("http://x/api/task", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const sseOf = (content) =>
  new Response(
    [
      { id: "gen-7", provider: "Meta", choices: [{ delta: { content }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.00002 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

async function events(res) {
  return (await res.text())
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [ev, data] = b.split("\n");
      return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

// Консоль на время теста: строки, которые сервер напечатал.
function captureConsole() {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => (console.log = log) };
}

const run = (fn) => async () => {
  resetRateLimits();
  resetLearned();
  const fetch0 = globalThis.fetch;
  const out = captureConsole();
  try {
    await fn(out.lines);
  } finally {
    globalThis.fetch = fetch0;
    out.restore();
  }
};

test(
  "разработчик получает трассу в потоке: промпт, запрос, ответ модели, итог; id запроса в результате и заголовке",
  run(async () => {
    globalThis.fetch = async () => sseOf(JSON.stringify(LOOKS));
    const res = await handleApi(req({ task: "looks", input: { wardrobe } }, { "x-admin-code": "dev-1" }), env(ENV));
    const rid = res.headers.get("x-request-id");
    assert.match(rid, /^[0-9a-f]{10}$/);
    const ev = await events(res);
    const debug = ev.filter((e) => e.event === "debug").map((e) => e.data);
    assert.deepEqual(
      debug.map((d) => d.type),
      ["task.start", "task.prompt", "llm.request", "llm.response", "llm.done", "llm.raw", "parse", "task"],
    );
    const byType = Object.fromEntries(debug.map((d) => [d.type, d]));
    assert.equal(byType["task.start"].model, "meta/muse-spark-1.3-contributor");
    assert.equal(byType["task.start"].dataCollection, "allow");
    assert.match(byType["task.prompt"].system, /стилист/);
    assert.equal(byType["llm.raw"].text, JSON.stringify(LOOKS));
    assert.equal(byType["llm.done"].served, "Meta");
    assert.deepEqual(byType.task.usage, { in: 50, out: 20, cost: 0.00002 });
    assert.ok(
      debug.every((d) => Number.isFinite(d.t)),
      "у каждого события время от начала задачи",
    );
    assert.equal(ev.find((e) => e.event === "result").data.rid, rid);
  }),
);

test(
  "обычный пользователь трассу не получает, но id запроса для поддержки есть",
  run(async () => {
    globalThis.fetch = async () => sseOf(JSON.stringify(LOOKS));
    const ev = await events(await handleApi(req({ task: "looks", input: { wardrobe } }), env(ENV)));
    assert.equal(ev.filter((e) => e.event === "debug").length, 0);
    assert.match(ev.find((e) => e.event === "result").data.rid, /^[0-9a-f]{10}$/);
  }),
);

test(
  "консоль: по умолчанию одна строка JSON на задачу, без промптов; LOG_LEVEL=debug добавляет запросы к модели",
  run(async (lines) => {
    globalThis.fetch = async () => sseOf(JSON.stringify(LOOKS));
    await events(await handleApi(req({ task: "looks", input: { wardrobe } }), env(ENV)));
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.evt, "task");
    assert.equal(line.ok, true);
    assert.equal(line.task, "looks");

    lines.length = 0;
    await events(await handleApi(req({ task: "looks", input: { wardrobe } }), env({ ...ENV, LOG_LEVEL: "debug" })));
    const types = lines.map((l) => JSON.parse(l).evt);
    assert.ok(types.includes("llm.request") && types.includes("llm.done"), types.join());
    assert.ok(!types.includes("task.prompt") && !types.includes("llm.raw"), "промпты и ответы только на уровне trace");

    lines.length = 0;
    await events(await handleApi(req({ task: "looks", input: { wardrobe } }), env({ ...ENV, LOG_LEVEL: "trace", LOG_FORMAT: "pretty" })));
    const text = lines.join("\n");
    assert.match(text, /▶ openrouter meta\/muse-spark-1\.3-contributor/);
    assert.match(text, /\[system\]/);
    assert.match(text, /✓ модель/);
    assert.match(text, /■ готово/);
  }),
);

test(
  "ошибка модели попадает в лог с текстом провайдера, фото в логах нет ни в каком виде",
  run(async (lines) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy" } }), { status: 404 });
    const sink = [];
    const res = await handleApi(
      req({ task: "analysis", input: { photos: [IMG] } }, { "x-admin-code": "dev-1" }),
      env({ ...ENV, LOG_LEVEL: "trace" }),
      { log: (e) => sink.push(e) },
    );
    const ev = await events(res);
    const err = ev.find((e) => e.event === "error").data;
    assert.match(err.message, /data policy/);
    assert.ok(err.rid);
    const types = sink.map((e) => e.type);
    assert.ok(types.includes("llm.error") && types.includes("task"), types.join());
    assert.equal(sink.find((e) => e.type === "task").ok, false);
    assert.ok(sink.every((e) => e.rid === err.rid && e.ts));
    const all = JSON.stringify(sink) + lines.join("\n") + JSON.stringify(ev);
    assert.ok(!all.includes("BBBBBBBB"), "фото не попадает ни в файл, ни в консоль, ни в поток");
    assert.match(JSON.stringify(sink.find((e) => e.type === "task.start").images), /jpeg/);
  }),
);

test(
  "/api/config: разработчик видит провайдеров и модели сервера, остальные нет",
  run(async () => {
    const get = (headers = {}) =>
      handleApi(new Request("http://x/api/config", { headers }), env({ ...ENV, OPENCODE_GO_API_KEY: "go" })).then((r) => r.json());
    assert.equal((await get()).dev, undefined);
    const dev = (await get({ "x-admin-code": "dev-1" })).dev;
    assert.equal(dev.provider, "openrouter");
    assert.deepEqual(dev.providers, ["openrouter", "opencode-go"]);
    assert.equal(dev.slots["opencode-go"].vision.model, "muse-spark-1.3-contributor");
    assert.equal(dev.slots.openrouter.text.effort, "minimal");
    assert.equal(dev.logLevel, "info");
  }),
);

test(
  "код разработчика нельзя подбирать через /api/config: после 10 неверных с IP не принимается даже верный",
  run(async () => {
    const get = (code) =>
      handleApi(new Request("http://x/api/config", { headers: { "x-admin-code": code, "cf-connecting-ip": "9.9.9.9" } }), env(ENV)).then(
        (r) => r.json(),
      );
    assert.ok((await get("dev-1")).dev, "верный код работает");
    for (let i = 0; i < 10; i++) assert.equal((await get(`guess-${i}`)).dev, undefined);
    assert.equal((await get("dev-1")).dev, undefined, "после 10 неверных попыток код не принимается");
    const other = await handleApi(
      new Request("http://x/api/config", { headers: { "x-admin-code": "dev-1", "cf-connecting-ip": "8.8.8.8" } }),
      env(ENV),
    );
    assert.ok((await other.json()).dev, "другой IP не задет");
  }),
);
