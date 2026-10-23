import test from "node:test";
import assert from "node:assert/strict";
import { handleApi, resetRateLimits } from "../server/api.mjs";
import { resetLearned } from "../server/llm.mjs";
import { issueToken, verifyToken, seal, unseal, parseCodes, matchCode } from "../server/paywall.mjs";
import { teaserOf, TASKS } from "../server/tasks.mjs";
import { canonicalSeason } from "../server/modules/profile.mjs";
import { extractJson } from "../public/js/lib/json.js";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const PAID = { OPENROUTER_API_KEY: "srv-key", PRO_SECRET: "s3cret", PRO_CODES: "SPRING:7,VIP", ADMIN_CODE: "dev-42" };
const env = (vars) => (name) => vars[name];

const req = (path, body, headers = {}, init = {}) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

function mockFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const sseOf = (content, extra = []) =>
  new Response(
    [{ choices: [{ delta: { content }, finish_reason: "stop" }] }, ...extra].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

async function events(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [ev, data] = b.split("\n");
      return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
    });
}
const resultOf = async (res) => {
  const ev = await events(res);
  const r = ev.find((e) => e.event === "result" || e.event === "error");
  assert.ok(r, "в потоке есть итог");
  return r;
};

const ANALYSIS = {
  color_type: {
    season: "Мягкая осень (Soft Autumn)",
    undertone: "тёплый",
    contrast: "средний",
    confidence: "medium",
    reasoning: "медные волосы",
    best_colors: ["a", "b", "c", "d", "e", "f"].map((n, i) => ({ name: `Цвет ${n}`, hex: `#00000${i}` })),
    neutrals: [{ name: "Кэмел", hex: "#c19a6b" }],
    avoid_colors: [{ name: "Неон", hex: "#39ff14" }],
    metals: "золото",
  },
  body: {
    height_cm: 168,
    figure_type: "песочные часы",
    proportions: "плечи равны бёдрам",
    goals: ["подчеркнуть талию"],
    confidence: "medium",
  },
  styles: [{ name: "Минимализм" }, { name: "Классика" }, { name: "Кэжуал" }],
  silhouettes: [{ zone: "Верх", recommend: "V-вырез", avoid: "объём" }],
  fabrics_prints: "матовые ткани",
  summary: "Итог",
};

const run = (fn) => async () => {
  resetRateLimits();
  resetLearned();
  await fn();
};

test(
  "GET /api/config: без значений ключей и секретов",
  run(async () => {
    const res = await handleApi(new Request("http://x/api/config"), env(PAID));
    const j = await res.json();
    assert.deepEqual(j, { ready: true, paywall: true, price: "", payUrl: "", devCodes: true, webSearch: true });
    assert.doesNotMatch(JSON.stringify(j), /srv-key|s3cret|SPRING|dev-42/);
    const bare = await (await handleApi(new Request("http://x/api/config"), env({}))).json();
    assert.equal(bare.ready, false);
    assert.equal(bare.paywall, false);
    assert.equal((await handleApi(new Request("http://x/api/llm"), env(PAID))).status, 404, "старого прокси больше нет");
  }),
);

test(
  "старый открытый прокси /api/llm больше не пересылает произвольные запросы",
  run(async () => {
    const m = mockFetch(() => sseOf("{}"));
    try {
      const res = await handleApi(req("/api/llm", { model: "x", messages: [{ role: "user", content: "hi" }] }), env(PAID));
      assert.equal(res.status, 404);
      assert.equal(m.calls.length, 0);
    } finally {
      m.restore();
    }
  }),
);

test(
  "анализ на бесплатном плане: урезанный результат, счётчики скрытого и конверт с полным",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify(ANALYSIS)));
    try {
      const res = await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG], inputs: { height: "168" } } }), env(PAID));
      assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
      const { event, data: r } = await resultOf(res);
      assert.equal(event, "result");
      assert.equal(r.plan, "free");
      assert.equal(r.data.color_type.season, "Мягкая осень", "сезон приведён к каноническому названию");
      assert.equal(r.data.color_type.best_colors.length, 4);
      assert.deepEqual(r.data.color_type.neutrals, []);
      assert.equal(r.data.body.proportions, "");
      assert.equal(r.data.body.figure_type, "песочные часы");
      assert.equal(r.data.styles.length, 1);
      assert.deepEqual(r.locked, {
        best_colors: 2,
        neutrals: 1,
        avoid_colors: 1,
        metals: true,
        body: true,
        styles: 2,
        silhouettes: 1,
        fabrics_prints: true,
        summary: true,
      });
      assert.equal(r.data.summary, "", "итог пересказывает закрытое, поэтому тоже закрыт");
      assert.doesNotMatch(
        JSON.stringify(r.data) + JSON.stringify(r.locked),
        /Кэмел|Неон|V-вырез|матовые/,
        "скрытое не утекает в открытую часть",
      );
      assert.doesNotMatch(r.sealed, /Кэмел/, "конверт зашифрован");

      // Промпт собран на сервере: системный промпт с 12 сезонами, анкета, фото, temperature 0.
      const b = m.calls[0].body;
      assert.match(b.messages[0].content, /Яркая зима/);
      assert.match(b.messages[1].content[0].text, /Рост, см: 168/);
      assert.equal(b.messages[1].content[1].image_url.url, IMG);
      assert.equal(b.temperature, 0);
      assert.equal(b.model, "deepseek/deepseek-v4.1-flash");
      assert.equal(m.calls[0].init.headers.authorization, "Bearer srv-key");

      // Купили Pro: конверт открывается без повторной генерации.
      const act = await (await handleApi(req("/api/activate", { code: " spring " }), env(PAID))).json();
      assert.ok(act.token);
      assert.ok(act.until > Date.now() + 6 * 86400000 && act.until < Date.now() + 8 * 86400000, "SPRING действует 7 дней");
      const un = await (
        await handleApi(req("/api/unlock", { sealed: { analysis: r.sealed } }, { "x-pro-token": act.token }), env(PAID))
      ).json();
      assert.equal(un.results.analysis.color_type.neutrals[0].name, "Кэмел");
      assert.equal(un.results.analysis.color_type.season, "Мягкая осень");
      assert.equal(m.calls.length, 1, "модель второй раз не вызывалась");
    } finally {
      m.restore();
    }
  }),
);

test(
  "Pro и сервер без PRO_SECRET получают полный результат без конверта",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify(ANALYSIS)));
    try {
      const token = await issueToken("s3cret", { days: 1 });
      for (const [vars, headers] of [
        [PAID, { "x-pro-token": token }],
        [PAID, { "x-admin-code": "dev-42" }],
        [{ OPENROUTER_API_KEY: "k" }, {}],
      ]) {
        const { data: r } = await resultOf(
          await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] } }, headers), env(vars)),
        );
        assert.equal(r.plan, "pro");
        assert.equal(r.locked, null);
        assert.equal(r.sealed, null);
        assert.equal(r.data.color_type.neutrals.length, 1);
      }
    } finally {
      m.restore();
    }
  }),
);

test(
  "активация: неверный код, код разработчика, сервер без платного доступа",
  run(async () => {
    const bad = await handleApi(req("/api/activate", { code: "NOPE" }), env(PAID));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /не подошёл/);
    assert.deepEqual(await (await handleApi(req("/api/activate", { code: "dev-42" }), env(PAID))).json(), { admin: true });
    const off = await handleApi(req("/api/activate", { code: "VIP" }), env({ OPENROUTER_API_KEY: "k" }));
    assert.equal(off.status, 400);
    const vip = await (await handleApi(req("/api/activate", { code: "vip" }), env(PAID))).json();
    assert.ok(vip.until > Date.now() + 29 * 86400000, "код без срока даёт 30 дней");
  }),
);

test(
  "перебор кодов упирается в лимит попыток",
  run(async () => {
    const codes = [];
    for (let i = 0; i < 12; i++)
      codes.push((await handleApi(req("/api/activate", { code: `X${i}` }, { "x-forwarded-for": "1.2.3.4" }), env(PAID))).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(400));
    assert.deepEqual(codes.slice(10), [429, 429]);
  }),
);

test(
  "unlock без Pro и с поддельным токеном: 402",
  run(async () => {
    const sealed = await seal("s3cret", "analysis", ANALYSIS);
    assert.equal((await handleApi(req("/api/unlock", { sealed: { analysis: sealed } }), env(PAID))).status, 402);
    const fake = (await issueToken("other", { days: 1 })).replace(/.$/, "x");
    assert.equal((await handleApi(req("/api/unlock", { sealed: { analysis: sealed } }, { "x-pro-token": fake }), env(PAID))).status, 402);
    const expired = await issueToken("s3cret", { days: 1, now: Date.now() - 2 * 86400000 });
    assert.equal(
      (await handleApi(req("/api/unlock", { sealed: { analysis: sealed } }, { "x-pro-token": expired }), env(PAID))).status,
      402,
    );
  }),
);

test(
  "поиск с ИИ только в Pro, в Pro идёт с веб-поиском и проверкой ссылок",
  run(async () => {
    const results = {
      results: [
        { title: "Тренч", url: "https://shop.example/item/1" },
        { title: "Выдумка", url: "https://fake.example/x" },
      ],
    };
    const m = mockFetch(() =>
      sseOf(JSON.stringify(results), [
        { choices: [{ delta: { annotations: [{ url_citation: { url: "https://www.shop.example/item/1/" } }] } }] },
      ]),
    );
    try {
      const free = await handleApi(req("/api/task", { task: "search", input: { query: "тренч" } }), env(PAID));
      assert.equal(free.status, 402);
      assert.equal((await free.json()).error.code, "pro_required");
      assert.equal(m.calls.length, 0);

      const token = await issueToken("s3cret", { days: 1 });
      const { data: r } = await resultOf(
        await handleApi(
          req("/api/task", { task: "search", input: { query: "тренч", palette: ["олива"] } }, { "x-pro-token": token }),
          env(PAID),
        ),
      );
      assert.deepEqual(m.calls[0].body.plugins, [{ id: "web", max_results: 5 }]);
      assert.equal(r.data.verified, true);
      assert.deepEqual(
        r.data.results.map((x) => x.title),
        ["Тренч"],
      );
    } finally {
      m.restore();
    }
  }),
);

test(
  "образы: бесплатно два, остальные в конверте; полный анализ из конверта уходит в промпт",
  run(async () => {
    const looks = { looks: [1, 2, 3, 4].map((i) => ({ name: `Образ ${i}`, item_ids: ["w1", "w2"] })) };
    const m = mockFetch(() => sseOf(JSON.stringify(looks)));
    try {
      const sealedAnalysis = await seal("s3cret", "analysis", ANALYSIS);
      const teaser = teaserOf("analysis", TASKS.analysis.finish(ANALYSIS)).data;
      const input = {
        profile: { inputs: {}, analysis: teaser },
        wardrobe: [
          { id: "w1", name: "Тренч", image: IMG },
          { id: "w2", name: "Джинсы" },
        ],
        count: 4,
      };
      const { data: r } = await resultOf(
        await handleApi(req("/api/task", { task: "looks", input, sealed: { analysis: sealedAnalysis } }), env(PAID)),
      );
      assert.deepEqual(
        r.data.looks.map((l) => l.name),
        ["Образ 1", "Образ 2"],
      );
      assert.deepEqual(r.locked, { looks: 2 });
      const prompt = m.calls[0].body.messages[1].content;
      assert.match(prompt, /Нейтральные: Кэмел/, "в промпт попал полный анализ, а не урезанный");
      assert.match(prompt, /w1: Тренч/);
      assert.doesNotMatch(prompt, /base64/, "картинки в текстовый промпт не попадают");
    } finally {
      m.restore();
    }
  }),
);

test(
  "капсула: бесплатно видны три самые важные покупки, остальное в конверте",
  run(async () => {
    const buy = ["low", "high", "medium", "high", "low"].map((priority, i) => ({ id: `b${i + 1}`, name: `Вещь ${i + 1}`, priority }));
    const m = mockFetch(() =>
      sseOf(JSON.stringify({ concept: "К", palette: [], keep: [], buy, looks: [{ name: "Л", refs: ["b1"] }], notes: "н" })),
    );
    try {
      const { data: r } = await resultOf(
        await handleApi(req("/api/task", { task: "capsule", input: { options: { size: 10 } } }), env(PAID)),
      );
      assert.deepEqual(
        r.data.buy.map((b) => b.id),
        ["b2", "b3", "b4"],
      );
      assert.deepEqual(r.data.looks, []);
      assert.deepEqual(r.locked, { buy: 2, looks: 1, drop: 0, notes: true });
      assert.match(m.calls[0].body.messages[1].content, /собираем капсулу с нуля/);
    } finally {
      m.restore();
    }
  }),
);

test(
  "вход проверяется до обращения к провайдеру",
  run(async () => {
    const m = mockFetch(() => sseOf("{}"));
    try {
      const cases = [
        [{ task: "analysis", input: { photos: [] } }, /фото/],
        [{ task: "analysis", input: { photos: ["https://evil.example/x.jpg"] } }, /формате/],
        [{ task: "analysis", input: { photos: [IMG, IMG, IMG, IMG] } }, /не больше 3/],
        [{ task: "wardrobe", input: { photos: Array(7).fill(IMG) } }, /не больше 6/],
        [{ task: "looks", input: { wardrobe: [{ id: "w1", name: "x" }] } }, /2-3 вещи/],
        [{ task: "search", input: { query: " " } }, /запрос/],
        [{ task: "rm-rf", input: {} }, /Неизвестная задача/],
      ];
      for (const [body, re] of cases) {
        const res = await handleApi(req("/api/task", body), env({ OPENROUTER_API_KEY: "k" }));
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
        assert.match((await res.json()).error.message, re);
      }
      assert.equal(m.calls.length, 0);
    } finally {
      m.restore();
    }
  }),
);

test(
  "ошибка модели приходит событием error; сырой ответ видит только разработчик",
  run(async () => {
    const m = mockFetch(() => sseOf("Извините, не могу."));
    try {
      const user = await resultOf(await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] } }), env(PAID)));
      assert.equal(user.event, "error");
      assert.match(user.data.message, /JSON/);
      assert.equal(user.data.raw, undefined);
      const dev = await resultOf(
        await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] } }, { "x-admin-code": "dev-42" }), env(PAID)),
      );
      assert.equal(dev.data.raw, "Извините, не могу.");
    } finally {
      m.restore();
    }
  }),
);

test(
  "подмена модели работает только с кодом разработчика",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify(ANALYSIS)));
    try {
      const vars = { ...PAID, OPENCODE_GO_API_KEY: "go-key" };
      const dev = { provider: "opencode-go", vision: { model: "glm-5.3-flash", effort: "none" } };
      await resultOf(
        await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] }, dev }, { "x-admin-code": "wrong" }), env(vars)),
      );
      assert.equal(m.calls[0].body.model, "deepseek/deepseek-v4.1-flash");
      assert.match(m.calls[0].url, /openrouter/);
      await resultOf(
        await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] }, dev }, { "x-admin-code": "dev-42" }), env(vars)),
      );
      assert.equal(m.calls[1].body.model, "glm-5.3-flash");
      assert.equal(m.calls[1].body.reasoning_effort, "none");
      assert.match(m.calls[1].url, /opencode\.ai/);
      assert.equal(m.calls[1].init.headers.authorization, "Bearer go-key");
    } finally {
      m.restore();
    }
  }),
);

test(
  "OpenRouter по умолчанию: быстрые провайдеры без хранения данных, запасная модель; образы без рассуждений",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify({ looks: [{ name: "a", item_ids: ["w1", "w2"] }] })));
    try {
      const wardrobe = [
        { id: "w1", name: "a" },
        { id: "w2", name: "b" },
      ];
      await resultOf(await handleApi(req("/api/task", { task: "looks", input: { wardrobe } }), env({ OPENROUTER_API_KEY: "k" })));
      const b = m.calls[0].body;
      assert.deepEqual(b.provider, { data_collection: "deny", sort: "throughput" });
      assert.deepEqual(b.models, ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna"]);
      assert.deepEqual(b.reasoning, { effort: "none" });
      await resultOf(
        await handleApi(
          req("/api/task", { task: "looks", input: { wardrobe } }),
          env({ OPENROUTER_API_KEY: "k", OPENROUTER_SORT: "price", MODEL_FALLBACK: "" }),
        ),
      );
      assert.deepEqual(m.calls[1].body.provider, { data_collection: "deny", sort: "price" });
      assert.equal(m.calls[1].body.models, undefined);
    } finally {
      m.restore();
    }
  }),
);

test(
  "модель и провайдер задаются переменными окружения",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify(ANALYSIS)));
    try {
      await resultOf(
        await handleApi(
          req("/api/task", { task: "analysis", input: { photos: [IMG] } }),
          env({ OPENCODE_GO_API_KEY: "go", MODEL_VISION: "qwen3.8-flash", EFFORT_VISION: "medium" }),
        ),
      );
      assert.match(m.calls[0].url, /opencode\.ai\/zen\/go/);
      assert.equal(m.calls[0].body.model, "qwen3.8-flash");
      assert.equal(m.calls[0].body.reasoning_effort, "medium");
    } finally {
      m.restore();
    }
  }),
);

test(
  "бесплатный план упирается в лимит задач на IP",
  run(async () => {
    const m = mockFetch(() => sseOf(JSON.stringify(ANALYSIS)));
    try {
      const statuses = [];
      for (let i = 0; i < 21; i++) {
        const res = await handleApi(
          req("/api/task", { task: "analysis", input: { photos: [IMG] } }, { "cf-connecting-ip": "9.9.9.9" }),
          env(PAID),
        );
        statuses.push(res.status);
        await res.text();
      }
      assert.equal(statuses.filter((s) => s === 200).length, 20);
      assert.equal(statuses.at(-1), 429);
      const other = await handleApi(
        req("/api/task", { task: "analysis", input: { photos: [IMG] } }, { "cf-connecting-ip": "8.8.8.8" }),
        env(PAID),
      );
      assert.equal(other.status, 200, "другой IP не задет");
      await other.text();
    } finally {
      m.restore();
    }
  }),
);

test(
  "отмена клиентом доходит до запроса к провайдеру",
  run(async () => {
    const ctl = new AbortController();
    let seen;
    const m = mockFetch(
      (url, init) =>
        new Promise((_, reject) => {
          seen = init.signal;
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    try {
      const res = await handleApi(req("/api/task", { task: "analysis", input: { photos: [IMG] } }, {}, { signal: ctl.signal }), env(PAID));
      const reader = res.body.getReader();
      for (let i = 0; i < 20 && !seen; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(seen && !seen.aborted, "запрос к провайдеру начался");
      ctl.abort();
      await reader.cancel();
      for (let i = 0; i < 20 && !seen.aborted; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(seen.aborted, "сигнал провайдеру отменён");
    } finally {
      m.restore();
    }
  }),
);

test(
  "защита API: чужой сайт, не JSON, большое тело, не объект",
  run(async () => {
    const m = mockFetch(() => sseOf("{}"));
    try {
      const plain = new Request("http://x/api/task", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
      assert.equal((await handleApi(plain, env(PAID))).status, 415);
      assert.equal((await handleApi(req("/api/task", { task: "analysis" }, { "sec-fetch-site": "cross-site" }), env(PAID))).status, 403);
      assert.equal((await handleApi(req("/api/task", "[1,2]"), env(PAID))).status, 400);
      assert.equal((await handleApi(req("/api/task", "{oops"), env(PAID))).status, 400);
      const huge = req("/api/task", { a: "y" }, { "content-length": String(6 * 1024 * 1024) });
      assert.equal((await handleApi(huge, env(PAID))).status, 413);
      assert.equal((await handleApi(req("/api/task", { a: "x".repeat(6 * 1024 * 1024) }), env(PAID))).status, 413);
      assert.equal((await handleApi(new Request("http://x/api/task", { method: "PUT", body: "{}" }), env(PAID))).status, 405);
      assert.equal(m.calls.length, 0);
    } finally {
      m.restore();
    }
  }),
);

test("токены и конверты: подделка, чужой ключ, чужая задача", async () => {
  const t = await issueToken("k1", { days: 2 });
  assert.ok(await verifyToken("k1", t));
  assert.equal(await verifyToken("k2", t), null);
  assert.equal(await verifyToken("k1", t + "x"), null);
  assert.equal(await verifyToken("k1", `${t}.x`), null);
  assert.equal(await verifyToken("", t), null);
  const s = await seal("k1", "looks", { looks: [1] });
  assert.deepEqual(await unseal("k1", "looks", s), { looks: [1] });
  assert.equal(await unseal("k1", "capsule", s), null, "конверт другой задачи");
  assert.equal(await unseal("k2", "looks", s), null);
  const [iv, ct] = s.split(".");
  assert.equal(await unseal("k1", "looks", `${iv}.${ct.slice(0, -2)}AA`), null, "подменённый шифртекст");
  assert.equal(await unseal("k1", "looks", "мусор"), null);
});

test("коды Pro и названия сезонов", () => {
  const codes = parseCodes(" A:7 , b ,, C:0, D:99999");
  assert.deepEqual(codes, [
    { code: "A", days: 7 },
    { code: "b", days: 30 },
    { code: "C", days: 30 },
    { code: "D", days: 3650 },
  ]);
  assert.equal(matchCode(codes, " B ").code, "b");
  assert.equal(matchCode(codes, ""), null);
  assert.equal(matchCode(codes, "AB"), null);
  assert.equal(canonicalSeason("Мягкая осень (Soft Autumn), ближе к тёплой осени"), "Мягкая осень");
  assert.equal(canonicalSeason("Тёплая осень (с переходом в Мягкую осень)"), "Тёплая осень");
  assert.equal(canonicalSeason("глубокая осень"), "Тёмная осень");
  assert.equal(canonicalSeason("Теплая весна"), "Тёплая весна");
  assert.equal(canonicalSeason("Что-то своё"), "Что-то своё");
});

test("teaserOf: фигура с низкой уверенностью не продаётся, а показывается как есть", () => {
  const a = TASKS.analysis.finish({ ...ANALYSIS, body: { ...ANALYSIS.body, confidence: "low", notes: "нужно фото в рост" } });
  const { data, locked } = teaserOf("analysis", a);
  assert.equal(locked.body, false);
  assert.equal(data.body.notes, "нужно фото в рост");
  assert.equal(data.body.proportions, "плечи равны бёдрам");
});

test("соседний сезон приводится к каноническому и не дублирует основной", () => {
  const a = TASKS.analysis.finish({ ...ANALYSIS, color_type: { ...ANALYSIS.color_type, neighbor_season: "глубокая осень" } });
  assert.equal(a.color_type.neighbor_season, "Тёмная осень");
  const same = TASKS.analysis.finish({ ...ANALYSIS, color_type: { ...ANALYSIS.color_type, neighbor_season: "Мягкая осень" } });
  assert.equal(same.color_type.neighbor_season, "");
});

test("teaserOf: если скрывать нечего, результат полный и без счётчиков", () => {
  assert.deepEqual(teaserOf("looks", { looks: [{ name: "a" }] }), { data: { looks: [{ name: "a" }] }, locked: null });
  assert.equal(teaserOf("wardrobe", { items: [] }).locked, null);
});

test("extractJson: обёртки и мусор вокруг", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Вот ответ: {"a":[1,2]} Готово.'), { a: [1, 2] });
  assert.deepEqual(extractJson('[{"x":1}]'), [{ x: 1 }]);
  assert.throws(() => extractJson("без json"));
});
