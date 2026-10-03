import test from "node:test";
import assert from "node:assert/strict";

globalThis.addEventListener = () => {};
globalThis.document = { visibilityState: "visible" };

const N = await import("../public/js/normalize.js");
const { migrate, defaultState } = await import("../public/js/store.js");
const { profileBrief, wardrobeBrief } = await import("../public/js/prompts.js");
const { swatches, safeHtml } = await import("../public/js/ui.js");
const { safeHex } = await import("../public/js/util.js");

const goodAnalysis = {
  color_type: { season: "Мягкое лето", undertone: "холодный", best_colors: [{ name: "Роза", hex: "#c9929c" }] },
  body: { figure_type: "песочные часы", goals: ["талия"] },
};

test("анализ: строка вместо списка и null в массивах не ломают ни нормализацию, ни промпт", () => {
  const a = N.normalizeAnalysis({
    color_type: { season: "Лето", best_colors: [null, "Роза #c9929c", { name: "Серый", hex: 123 }, 7], avoid_colors: "красный" },
    body: { figure_type: "груша", goals: "удлинить ноги; подчеркнуть талию", height_cm: "168" },
    styles: [null, { name: "Smart casual" }, "x"],
    silhouettes: "верх: приталенный",
  });
  assert.deepEqual(a.body.goals, ["удлинить ноги", "подчеркнуть талию"]);
  assert.equal(a.body.height_cm, 168);
  assert.deepEqual(
    a.color_type.best_colors.map((c) => [c.name, c.hex]),
    [
      ["Роза", "#c9929c"],
      ["Серый", "#cccccc"],
    ],
  );
  assert.equal(a.styles.length, 1);
  assert.deepEqual(a.silhouettes, []);
  const brief = profileBrief({ profile: { inputs: {}, analysis: a } });
  assert.match(brief, /Лето/);
  assert.doesNotThrow(() => swatches(a.color_type.best_colors));
});

test("анализ: неполный ответ отклоняется с понятной ошибкой", () => {
  assert.throws(() => N.normalizeAnalysis({}), /неполный/);
  assert.throws(() => N.normalizeAnalysis({ color_type: {}, body: {} }), /цветотип/);
  assert.throws(() => N.normalizeAnalysis([]), /неполный/);
  assert.equal(N.normalizeAnalysis({ color_type: "Лето", body: "груша" }).color_type.season, "Лето");
});

test("profileBrief и wardrobeBrief переживают повреждённые сохранённые данные", () => {
  assert.doesNotThrow(() =>
    profileBrief({
      profile: { inputs: {}, analysis: { color_type: { best_colors: "x" }, body: { goals: "a" }, styles: "s", silhouettes: "t" } },
    }),
  );
  assert.doesNotThrow(() => profileBrief({ profile: { inputs: {}, analysis: "мусор" } }));
  const out = wardrobeBrief([null, { id: "w1", name: "Тренч", seasons: "весна", formality: null }, "x", { id: "w2", name: 5 }]);
  assert.match(out, /w1: Тренч/);
  assert.equal(out.split("\n").length, 2);
});

test("вещи: мусорные записи не становятся распознанными", () => {
  assert.equal(N.normalizeItem({}), null);
  assert.equal(N.normalizeItem("Бежевый тренч"), null);
  assert.equal(N.normalizeItem({ name: "   " }), null);
  assert.deepEqual(N.recognizedItems({ items: [{}, "строка", null] }, 3), []);
  assert.deepEqual(N.recognizedItems({ items: ["Тренч", "Джинсы"] }, 2), []);
});

test("вещи: formality null или пустая строка не превращается в «1»", () => {
  assert.equal(N.normalizeItem({ name: "a", formality: null }).formality, null);
  assert.equal(N.normalizeItem({ name: "a", formality: "" }).formality, null);
  assert.equal(N.normalizeItem({ name: "a", formality: "4" }).formality, 4);
  assert.equal(N.normalizeItem({ name: "a", formality: 9 }).formality, 5);
  assert.equal(N.normalizeItem({ name: "a", category: "TOP", color_hex: "red" }).category, "top");
  assert.equal(N.normalizeItem({ name: "a", category: "TOP", color_hex: "red" }).color_hex, "");
});

test("вещи: одна вещь без обёртки items принимается", () => {
  const r = N.recognizedItems({ index: 1, name: "Тренч", category: "outerwear" }, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].item.name, "Тренч");
});

test("вещи: сопоставление с фото по index и по порядку", () => {
  const row = (index, name) => ({ index, name });
  const pairs = (data, n) => N.recognizedItems(data, n).map((x) => [x.target, x.item.name]);
  assert.deepEqual(pairs({ items: [row(1, "A"), row(2, "B")] }, 2), [
    [0, "A"],
    [1, "B"],
  ]);
  assert.deepEqual(
    pairs({ items: [row(2, "B"), row(1, "A")] }, 2),
    [
      [1, "B"],
      [0, "A"],
    ],
    "порядок ответа не важен",
  );
  assert.deepEqual(
    pairs({ items: [row(0, "A"), row(1, "B")] }, 2),
    [
      [0, "A"],
      [1, "B"],
    ],
    "нумерация с нуля",
  );
  assert.deepEqual(
    pairs({ items: [row("1", "A"), row("2", "B")] }, 2),
    [
      [0, "A"],
      [1, "B"],
    ],
    "индекс строкой",
  );
  assert.deepEqual(
    pairs({ items: [{ name: "A" }, { name: "B" }] }, 2),
    [
      [0, "A"],
      [1, "B"],
    ],
    "без index по порядку",
  );
  assert.deepEqual(
    pairs({ items: [row(1, "A"), row(1, "B")] }, 2),
    [
      [0, "A"],
      [1, "B"],
    ],
    "повторы index игнорируются",
  );
  assert.deepEqual(pairs({ items: [row(5, "A")] }, 2), [[0, "A"]], "index вне пачки игнорируется");
  assert.deepEqual(
    pairs({ items: [row(1, "A"), row(2, "B"), row(3, "C")] }, 2),
    [
      [0, "A"],
      [1, "B"],
    ],
    "лишнее отбрасывается",
  );
});

test("образы: чужие id отбрасываются, меньше двух вещей это не образ", () => {
  const valid = new Set(["w1", "w2", "w3"]);
  const looks = N.normalizeLooks(
    {
      looks: [
        { name: "A", item_ids: ["w1", "w2", "bogus", "w1"] },
        { name: "B", item_ids: ["bogus"] },
        null,
        { name: "C", item_ids: "w1; w2" },
        { item_ids: [{ id: "w1" }, { ref: "w3" }] },
      ],
    },
    valid,
  );
  assert.deepEqual(
    looks.map((l) => l.item_ids),
    [
      ["w1", "w2"],
      ["w1", "w3"],
    ],
  );
  assert.equal(looks[1].name, "Образ");
});

test("капсула: повторные и совпадающие с гардеробом id переименовываются, пустая отклоняется", () => {
  const valid = new Set(["w1"]);
  const c = N.normalizeCapsule(
    {
      keep: [{ id: "w1", role: "база" }, { id: "bogus" }, "w1"],
      buy: [
        { id: "b1", name: "Рубашка", priority: "HIGH" },
        { id: "b1", name: "Лоферы", category: "shoes" },
        { id: "w1", name: "Пальто" },
        { name: "" },
        null,
      ],
      looks: [
        { name: "L", refs: ["w1", "b1"] },
        { name: "пустой", refs: [] },
      ],
    },
    valid,
  );
  assert.deepEqual(
    c.buy.map((b) => b.id),
    ["b1", "b2", "b3"],
  );
  assert.equal(c.buy[0].priority, "high");
  assert.equal(c.buy[1].search_query, "Лоферы");
  assert.equal(c.keep.length, 2);
  assert.equal(c.looks.length, 1);
  assert.throws(() => N.normalizeCapsule({ buy: [], keep: [{ id: "bogus" }] }, valid), /неполный/);
  assert.throws(() => N.normalizeCapsule("x", valid));
});

test("поиск: записи без ссылки и не-объекты отбрасываются", () => {
  const r = N.normalizeSearch({ results: [null, "x", { title: "A" }, { title: "B", url: "https://a.b/c", price: 4000 }] });
  assert.deepEqual(r, [{ title: "B", shop: "", url: "https://a.b/c", price: "4000", why: "" }]);
  assert.deepEqual(N.normalizeSearch({ results: "нет" }), []);
});

test("safeHex переживает не-строки", () => {
  assert.equal(safeHex(123), "#cccccc");
  assert.equal(safeHex(null), "#cccccc");
  assert.equal(safeHex(" #AbC "), "#AbC");
  assert.equal(safeHex("red; background:url(x)"), "#cccccc");
});

test("safeHtml: исключение при показе превращается в сообщение, а не в пустую вкладку", () => {
  const html = safeHtml(() => {
    throw new TypeError("x.map is not a function");
  });
  assert.match(html, /повреждён/);
  assert.equal(
    safeHtml(() => "ok"),
    "ok",
  );
});

test("миграция: сохранённое в кривой форме приводится к нынешней, неисправимое сбрасывается", () => {
  const st = {
    ...defaultState(),
    wardrobe: [{ id: "w1", name: "A" }, null, "x", { id: "w2", name: "B" }],
    profile: {
      photos: ["data:x", 5, null],
      inputs: null,
      analysis: { color_type: { season: "Лето", best_colors: "x" }, body: { goals: "a;b" } },
    },
    looks: [{ name: "L", item_ids: ["w1", "w2", "gone"] }, null, { name: "bad", item_ids: ["gone"] }],
    capsule: { buy: [null, { name: "Рубашка" }], keep: [{ id: "w1" }, { id: "gone" }] },
    search: { a: { results: [null, { title: "t", url: "https://x.y" }] }, b: "мусор", c: null },
  };
  migrate(st);
  assert.equal(st.wardrobe.length, 2);
  assert.deepEqual(st.profile.photos, ["data:x"]);
  assert.deepEqual(st.profile.inputs, {});
  assert.deepEqual(st.profile.analysis.body.goals, ["a", "b"]);
  assert.equal(st.looks.length, 1);
  assert.deepEqual(st.capsule.keep, [{ id: "w1", role: "" }]);
  assert.equal(st.capsule.buy[0].id, "b1");
  assert.deepEqual(Object.keys(st.search), ["a"]);

  const broken = {
    ...defaultState(),
    profile: { photos: [], inputs: {}, analysis: { color_type: {}, body: {} } },
    capsule: { concept: "x" },
    looks: "мусор",
  };
  migrate(broken);
  assert.equal(broken.profile.analysis, null);
  assert.equal(broken.capsule, null);
  assert.deepEqual(broken.looks, []);
});

test("аналитический результат нормализуется идемпотентно", () => {
  const once = N.normalizeAnalysis(goodAnalysis);
  assert.deepEqual(N.normalizeAnalysis(once), once);
});
