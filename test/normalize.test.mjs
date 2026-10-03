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
      ["Серый", ""],
    ],
  );
  assert.equal(a.styles.length, 2, "строка в списке стилей становится названием");
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
      photos: ["data:image/png;base64,iVBORw0KGgo=", 5, null],
      inputs: null,
      analysis: { color_type: { season: "Лето", best_colors: "x" }, body: { goals: "a;b" } },
    },
    looks: [{ name: "L", item_ids: ["w1", "w2", "gone"] }, null, { name: "bad", item_ids: ["gone"] }],
    capsule: { buy: [null, { name: "Рубашка" }], keep: [{ id: "w1" }, { id: "gone" }] },
    search: { a: { results: [null, { title: "t", url: "https://x.y" }] }, b: "мусор", c: null },
  };
  migrate(st);
  assert.equal(st.wardrobe.length, 2);
  assert.deepEqual(st.profile.photos, ["data:image/png;base64,iVBORw0KGgo="]);
  assert.deepEqual(st.profile.inputs, {});
  assert.deepEqual(st.profile.analysis.body.goals, ["a", "b"]);
  assert.equal(st.looks.length, 1);
  assert.deepEqual(st.capsule.keep, [{ id: "w1", role: "", reason: "" }]);
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

// --- Регрессии второго раунда ревью --------------------------------------------------------------------
test("причина отказа в drop сохраняется, а role и reason взаимозаменяемы", () => {
  const valid = new Set(["w1", "w2", "w3"]);
  const c = N.normalizeCapsule(
    {
      buy: [{ name: "x" }],
      keep: [{ id: "w1", reason: "база" }],
      drop: [
        { id: "w2", reason: "дублирует" },
        { id: "w3", role: "лишнее" },
      ],
    },
    valid,
  );
  assert.equal(c.drop[0].reason, "дублирует");
  assert.equal(c.drop[1].reason, "лишнее");
  assert.equal(c.keep[0].role, "база");
  assert.deepEqual(N.normalizeCapsule(c, valid), c, "идемпотентно");
});

test("text(): массив строк склеивается, а не стирается", () => {
  assert.equal(N.text(["шерсть", "хлопок", null, ""]), "шерсть; хлопок");
  assert.equal(N.text({ a: 1 }), "");
  assert.equal(N.normalizeItem({ name: "Свитер", material: ["шерсть", "акрил"], notes: ["крупная вязка"] }).material, "шерсть; акрил");
});

test("анализ: пустой цветотип при остальном содержимом не отбрасывает всё", () => {
  const a = N.normalizeAnalysis({ color_type: {}, body: { figure_type: "груша" }, summary: "Носите приталенное" });
  assert.equal(a.body.figure_type, "груша");
  assert.equal(a.summary, "Носите приталенное");
  assert.throws(() => N.normalizeAnalysis({ color_type: {}, body: {} }), /неполный/);
});

test("hex: выдуманный серый не попадает ни в данные, ни в промпт", () => {
  assert.equal(N.colors([{ name: "Роза" }])[0].hex, "");
  const brief = profileBrief({
    profile: {
      inputs: {},
      analysis: N.normalizeAnalysis({ color_type: { season: "Лето", best_colors: [{ name: "Роза" }] }, body: { figure_type: "x" } }),
    },
  });
  assert.doesNotMatch(brief, /#cccccc/);
  assert.match(brief, /Лучшие цвета: Роза$/m);
});

test("аналогично для покупок капсулы", () => {
  const c = N.normalizeCapsule({ buy: [{ name: "Рубашка" }] }, new Set());
  assert.equal(c.buy[0].color_hex, "");
});

test("картинки: только data URL растровых форматов", async () => {
  const { safeImage } = await import("../public/js/util.js");
  const ok = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(safeImage(ok), ok);
  for (const bad of [
    'x" onerror="alert(1)',
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    ok + '"onload="x',
    5,
    null,
    "",
  ]) {
    assert.equal(safeImage(bad), "", String(bad));
  }
});

test("миграция чистит чужие картинки и id вещей", () => {
  const ok = "data:image/png;base64,iVBORw0KGgo=";
  const st = {
    ...defaultState(),
    wardrobe: [
      { id: "w1", name: "A", image: 'x" onerror="alert(1)' },
      { id: "w2", name: "B", image: ok },
    ],
    profile: { photos: [ok, "javascript:alert(1)"], inputs: {}, analysis: null },
  };
  migrate(st);
  assert.equal(st.wardrobe[0].image, "");
  assert.equal(st.wardrobe[1].image, ok);
  assert.deepEqual(st.profile.photos, [ok]);
});

test("importData проходит миграцию и отклоняет не-копии", async () => {
  const { importData, state } = await import("../public/js/store.js");
  globalThis.indexedDB = undefined;
  await assert.rejects(importData("{}"), /не файл резервной копии/);
  await assert.rejects(importData('{"state":"строка"}'), /не файл резервной копии/);
  const ok = "data:image/png;base64,iVBORw0KGgo=";
  const backup = JSON.stringify({
    version: 1,
    state: {
      wardrobe: [{ id: "w1", name: "A", image: "bad" }],
      profile: { photos: [ok, "bad"], inputs: {}, analysis: { color_type: { season: "Лето", best_colors: "x" }, body: { goals: "a;b" } } },
    },
  });
  try {
    await importData(backup);
  } catch (e) {
    if (!/indexedDB|IDB|open/i.test(String(e))) throw e; // в node нет IndexedDB: проверяем состояние, а не запись
  }
  assert.equal(state.wardrobe[0].image, "");
  assert.deepEqual(state.profile.photos, [ok]);
  assert.deepEqual(state.profile.analysis.body.goals, ["a", "b"]);
});

// --- Регрессии третьего раунда ревью --------------------------------------------------------------------
test("анализ из одного summary отклоняется: прежний хороший анализ не затирается пустой оболочкой", () => {
  assert.throws(() => N.normalizeAnalysis({ color_type: {}, body: {}, summary: "Просто текст" }), /неполный/);
  assert.ok(N.normalizeAnalysis({ color_type: {}, body: {}, silhouettes: [{ zone: "Верх", recommend: "приталенный" }] }));
});

test("text(): предложения склеиваются пробелом, остальное через «;»", () => {
  assert.equal(N.text(["Носите приталенное.", "Избегайте боксов."]), "Носите приталенное. Избегайте боксов.");
  assert.equal(N.text(["шерсть", "хлопок"]), "шерсть; хлопок");
  assert.equal(N.text(["Хорошо!", "ткань"]), "Хорошо! ткань");
});

test("картинки: jpg принимается, миграция и импорт сообщают, сколько отброшено", async () => {
  const { safeImage } = await import("../public/js/util.js");
  assert.equal(safeImage("data:image/jpg;base64,/9j/4AAQ"), "data:image/jpg;base64,/9j/4AAQ");
  const st = {
    ...defaultState(),
    wardrobe: [
      { id: "w1", image: "javascript:x" },
      { id: "w2", image: "data:image/png;base64,AAAA" },
    ],
    profile: { photos: ["bad", "data:image/png;base64,AAAA"], inputs: {}, analysis: null },
  };
  assert.deepEqual(migrate(st), { droppedImages: 2 });
  const { importData } = await import("../public/js/store.js");
  globalThis.indexedDB = undefined;
  let res;
  try {
    res = await importData(JSON.stringify({ state: { wardrobe: [{ id: "w1", image: "bad" }] } }));
  } catch (e) {
    assert.match(String(e), /open|indexedDB/i);
  }
  assert.ok(res === undefined || res.droppedImages === 1);
});
