// Гардероб из фото образов: разбор ответа модели, рамки, вырезка, серверная задача outfits.
import test from "node:test";
import assert from "node:assert/strict";
import { handleApi, resetRateLimits } from "../server/api.mjs";
import { resetLearned } from "../server/llm.mjs";
import { normalizeOutfits, normalizeBox, outfitsToWire } from "../public/js/modules/wardrobe/schema.js";
import { cropRect } from "../public/js/lib/images.js";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const env = (vars) => (name) => vars[name];

const req = (body, headers = {}) =>
  new Request("http://x/api/task", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function mockFetch(content) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function resultOf(res) {
  const text = await res.text();
  const block = text.split("\n\n").find((b) => b.startsWith("event: result") || b.startsWith("event: error"));
  assert.ok(block, `в потоке есть итог: ${text.slice(0, 300)}`);
  const [ev, data] = block.split("\n");
  return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
}

const ITEM = (over) => ({ name: "Чёрные джинсы", category: "bottom", color: "чёрный", color_hex: "#111111", ...over });

test("рамка: доли переводятся в 0-1000, выход за край обрезается, вырожденная отбрасывается", () => {
  assert.deepEqual(normalizeBox([100, 200, 500, 600]), [100, 200, 500, 600]);
  assert.deepEqual(normalizeBox([0.1, 0.2, 0.5, 0.6]), [100, 200, 500, 600]);
  assert.deepEqual(normalizeBox([-20, 10, 1200, 990]), [0, 10, 1000, 990]);
  assert.equal(normalizeBox([500, 500, 503, 900]), null, "плоская рамка");
  assert.equal(normalizeBox([500, 500, 100, 900]), null, "перевёрнутая рамка");
  assert.equal(normalizeBox([1, 2, 3]), null);
  assert.equal(normalizeBox(["a", 2, 3, 4]), null);
  assert.equal(normalizeBox("100,200,500,600"), null);
});

test("outfits: номера фото с 1, лучшее фото по умолчанию первое, чужие номера и метки отбрасываются", () => {
  const out = normalizeOutfits(
    {
      items: [
        ITEM({ photos: [1, 3, 9], best: { photo: 3, box_2d: [400, 300, 850, 700] }, same_as: "E2" }),
        ITEM({ name: "Белые кеды", category: "shoes", photos: [2], best: null, same_as: "E99" }),
        ITEM({ name: "Сумка", category: "bag", photos: [], best: { photo: 2, box_2d: [300, 400, 500, 600] } }),
        { name: "", photos: [1] },
        null,
        "мусор",
      ],
    },
    { photoCount: 3, known: new Set(["E1", "E2"]) },
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].photos, [0, 2], "фото 9 нет в пачке");
  assert.equal(out[0].best, 2);
  assert.deepEqual(out[0].box, [400, 300, 850, 700]);
  assert.equal(out[0].same_as, "E2");
  assert.equal(out[0].item.recognized, true);
  assert.equal(out[1].best, 1, "без best берём первое фото");
  assert.equal(out[1].box, null);
  assert.equal(out[1].same_as, "", "метки, которой не было в списке, не существует");
  assert.deepEqual(out[2].photos, [1], "лучшее фото попадает в список фото");
});

test("outfits: нумерация с 0 распознаётся, если встретился 0", () => {
  const out = normalizeOutfits({ items: [ITEM({ photos: [0, 1], best: { photo: 1, box_2d: [1, 1, 900, 900] } })] }, { photoCount: 2 });
  assert.deepEqual(out[0].photos, [0, 1]);
  assert.equal(out[0].best, 1);
});

test("outfits: одна вещь, перечисленная дважды с той же рамкой, склеивается", () => {
  const box = [400, 300, 850, 700];
  const out = normalizeOutfits(
    {
      items: [
        ITEM({ photos: [1], best: { photo: 1, box_2d: box } }),
        ITEM({ name: "Джинсы прямые", photos: [1, 2], best: { photo: 1, box_2d: [405, 302, 848, 701] } }),
        ITEM({ name: "Юбка", photos: [1], best: { photo: 1, box_2d: [600, 300, 900, 700] } }),
      ],
    },
    { photoCount: 2 },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].photos, [0, 1]);
});

test("outfits: ответ сервера проходит тот же разбор и даёт тот же результат", () => {
  const raw = {
    items: [
      ITEM({ photos: [2, 1], best: { photo: 2, box_2d: [0.1, 0.1, 0.9, 0.5] }, same_as: "E1" }),
      ITEM({ name: "Кеды", category: "shoes", photos: [1] }),
    ],
  };
  const opts = { photoCount: 2, known: new Set(["E1"]) };
  const once = normalizeOutfits(raw, opts);
  assert.deepEqual(normalizeOutfits(outfitsToWire(once), opts), once);
});

test("вырезка: рамка с запасом, в пределах фото, вырожденная даёт null", () => {
  assert.deepEqual(cropRect([100, 100, 600, 500], 1000, 2000, 0), { left: 100, top: 200, width: 400, height: 1000 });
  const r = cropRect([0, 0, 1000, 1000], 800, 600);
  assert.deepEqual(r, { left: 0, top: 0, width: 800, height: 600 }, "запас не выходит за края");
  const padded = cropRect([400, 400, 600, 600], 1000, 1000, 0.1);
  assert.deepEqual(padded, { left: 380, top: 380, width: 240, height: 240 });
  assert.equal(cropRect([500, 500, 502, 900], 1000, 1000), null);
  assert.equal(cropRect(null, 1000, 1000), null);
});

const run = (fn) => async () => {
  resetRateLimits();
  resetLearned();
  await fn();
};

test(
  "задача outfits: модель для рамок, фото подписаны номерами, список имеющихся вещей в промпте",
  run(async () => {
    const answer = {
      items: [
        ITEM({ photos: [1, 2], best: { photo: 2, box_2d: [400, 300, 850, 700] }, same_as: null }),
        ITEM({ name: "Тренч", category: "outerwear", photos: [1], best: { photo: 1, box_2d: [200, 250, 750, 750] }, same_as: "E1" }),
      ],
    };
    const m = mockFetch(JSON.stringify(answer));
    try {
      const input = {
        photos: [IMG, IMG],
        known: [
          { ref: "E1", name: "Бежевый тренч", category: "outerwear", color: "бежевый" },
          { ref: "<script>", name: "x" },
          { ref: "E2", name: "Свитер", category: "кофты" },
        ],
        sheets: [IMG],
      };
      const res = await handleApi(req({ task: "outfits", input }), env({ OPENROUTER_API_KEY: "k", PRO_SECRET: "s" }));
      const { event, data: r } = await resultOf(res);
      assert.equal(event, "result");
      assert.equal(r.plan, "free");
      assert.equal(r.locked, null, "импорт гардероба бесплатный и целиком");
      assert.equal(r.data.items.length, 2);
      assert.deepEqual(r.data.items[0].best, { photo: 2, box_2d: [400, 300, 850, 700] });
      assert.equal(r.data.items[1].same_as, "E1");

      const b = m.calls[0];
      assert.equal(b.model, "google/gemini-3.8-flash");
      assert.deepEqual(b.models, ["google/gemini-3.8-flash", "qwen/qwen3.8-flash"]);
      assert.deepEqual(b.reasoning, { effort: "minimal" });
      assert.equal(b.temperature, 0);
      const parts = b.messages[1].content;
      assert.match(parts[0].text, /Фото образов: 2/);
      assert.match(parts[0].text, /E1: Бежевый тренч \| outerwear \| бежевый/);
      assert.match(parts[0].text, /E2: Свитер \| other/, "неизвестная категория приводится к other");
      assert.doesNotMatch(parts[0].text, /script/, "кривая метка отброшена");
      assert.deepEqual(
        parts.slice(1).map((p) => p.text || p.type),
        ["Фото 1:", "image_url", "Фото 2:", "image_url", "Таблица миниатюр 1:", "image_url"],
      );
    } finally {
      m.restore();
    }
  }),
);

test(
  "задача outfits: больше 10 фото и пустой ответ отклоняются понятным текстом",
  run(async () => {
    const e = env({ OPENROUTER_API_KEY: "k" });
    const tooMany = await handleApi(req({ task: "outfits", input: { photos: Array(11).fill(IMG) } }), e);
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error.message, /не больше 10 фото/);
    const none = await handleApi(req({ task: "outfits", input: { photos: [] } }), e);
    assert.match((await none.json()).error.message, /фото образа/);

    const m = mockFetch(JSON.stringify({ items: [] }));
    try {
      const { event, data } = await resultOf(await handleApi(req({ task: "outfits", input: { photos: [IMG] } }), e));
      assert.equal(event, "error");
      assert.match(data.message, /не нашлось ни одной вещи/);
    } finally {
      m.restore();
    }
  }),
);

test(
  "модель для рамок меняется переменными окружения, общий MODEL_FALLBACK её не трогает",
  run(async () => {
    const m = mockFetch(JSON.stringify({ items: [ITEM({ photos: [1], best: { photo: 1, box_2d: [1, 1, 999, 999] } })] }));
    const call = (vars) =>
      handleApi(req({ task: "outfits", input: { photos: [IMG] } }), env({ OPENROUTER_API_KEY: "k", ...vars })).then(resultOf);
    try {
      await call({ MODEL_FALLBACK: "openai/gpt-6-luna" });
      assert.deepEqual(m.calls[0].models, ["google/gemini-3.8-flash", "qwen/qwen3.8-flash"], "запасная для рамок своя");
      await call({ MODEL_DETECT: "qwen/qwen3.8-flash" });
      assert.equal(m.calls[1].model, "qwen/qwen3.8-flash");
      assert.equal(m.calls[1].models, undefined, "запасная совпадает с основной");
      await call({ MODEL_DETECT_FALLBACK: "" });
      assert.equal(m.calls[2].model, "google/gemini-3.8-flash");
      assert.equal(m.calls[2].models, undefined, "пустая запасная модель отключает запасную");
    } finally {
      m.restore();
    }
  }),
);
