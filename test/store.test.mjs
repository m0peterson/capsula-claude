// Хранилище по модулям: переезд со старого общего блоба, запись, копия, сброс, события между модулями.
import test from "node:test";
import assert from "node:assert/strict";
import { flush, exportBackup, importBackup, resetAll } from "../public/js/core/store.js";
import { emit } from "../public/js/core/events.js";
import { unlockAll } from "../public/js/core/paywall.js";
import { boot, data } from "./helpers.mjs";
import { addItems, removeItem, undoLastImport, setLastImport } from "../public/js/modules/wardrobe/model.js";
import { commitCapsule } from "../public/js/modules/capsule/model.js";
import { setWishes } from "../public/js/modules/profile/model.js";
import * as wardrobeApi from "../public/js/modules/wardrobe/api.js";

const IMG = "data:image/png;base64,iVBORw0KGgo=";
const ANALYSIS = { color_type: { season: "Мягкое лето", best_colors: [{ name: "Роза", hex: "#c9929c" }] }, body: { figure_type: "груша" } };
const LEGACY = {
  profile: { photos: [IMG], inputs: { height: "168" }, analysis: ANALYSIS },
  wishes: "минимализм",
  wardrobe: [
    { id: "w1", name: "Джинсы", category: "bottom", image: IMG },
    { id: "w2", name: "Рубашка", category: "top" },
  ],
  looks: [{ name: "Офис", item_ids: ["w1", "w2"] }],
  capsule: { concept: "База", buy: [{ name: "Тренч" }], keep: [{ id: "w1" }] },
  capsuleOptions: { size: 20, season: "Зима", budget: "", useWardrobe: true },
  search: { тренч: { results: [{ title: "T", url: "https://x.y" }] } },
  searchLast: "тренч",
  locks: { looks: { locked: { looks: 3 }, sealed: "env-looks" } },
};

const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

test("первый запуск после обновления: общий блоб раскладывается по модулям, сам блоб не трогается", async () => {
  const b = await boot({ state: LEGACY });
  assert.equal(data("profile").wishes, "минимализм", "пожелания переехали в профиль");
  assert.equal(data("profile").analysis.color_type.season, "Мягкое лето");
  assert.deepEqual(
    data("wardrobe").items.map((w) => w.id),
    ["w1", "w2"],
  );
  assert.equal(data("looks").list.length, 1);
  assert.deepEqual(data("looks").lock, { locked: { looks: 3 }, sealed: "env-looks" });
  assert.equal(data("capsule").options.size, 20);
  assert.equal(data("capsule").result.buy[0].name, "Тренч");
  assert.equal(data("search").last, "тренч");
  await flush();
  for (const id of ["profile", "wardrobe", "looks", "capsule", "search"]) assert.ok(b.map.has(`mod:${id}`), `записан mod:${id}`);
  assert.deepEqual(b.map.get("state"), LEGACY, "блоб прошлой версии остался для отката");
  assert.equal(b.map.get("mod:wardrobe").v, 1);
});

test("если ключ модуля уже есть, блоб прошлой версии для него не читается; недостающий берётся из блоба", async () => {
  await boot({ state: LEGACY, "mod:wardrobe": { v: 1, data: { items: [{ id: "n1", name: "Новая вещь" }] } } });
  assert.deepEqual(
    data("wardrobe").items.map((w) => w.id),
    ["n1"],
  );
  assert.equal(data("profile").wishes, "минимализм", "профиля не было в mod:, он из блоба");
  assert.equal(data("looks").list.length, 0, "образы ссылались на вещи, которых в гардеробе уже нет");
});

test("повреждённый слайс сбрасывается, остальные целы", async () => {
  await quiet(() =>
    boot({
      "mod:profile": { v: 1, data: { photos: [IMG], inputs: {}, analysis: { color_type: {}, body: {} }, wishes: 5 } },
      "mod:wardrobe": { v: 1, data: "мусор" },
      "mod:capsule": { v: 1, data: { result: { concept: "только концепция" }, options: { size: 1000 } } },
    }),
  );
  assert.equal(data("profile").analysis, null);
  assert.equal(data("profile").wishes, "");
  assert.deepEqual(data("profile").photos, [IMG]);
  assert.deepEqual(data("wardrobe").items, []);
  assert.equal(data("capsule").result, null);
  assert.equal(data("capsule").options.size, 15, "размер вне 6-40 сброшен");
});

test("правки нескольких модулей за один тик уходят одной записью; при сбое остаются несохранёнными", async () => {
  const b = await boot();
  await flush();
  const writes = [];
  const original = b.write;
  let fail = true;
  b.write = async (w) => {
    writes.push(w.puts.map(([k]) => k).sort());
    if (fail) throw new Error("квота");
    return original(w);
  };
  addItems([{ name: "Пальто", category: "outerwear" }]);
  setWishes("тепло");
  await quiet(() => assert.rejects(flush(), /квота/));
  fail = false;
  await flush();
  assert.deepEqual(writes, [
    ["mod:profile", "mod:wardrobe"],
    ["mod:profile", "mod:wardrobe"],
  ]);
  assert.equal(b.map.get("mod:profile").data.wishes, "тепло");
});

test("удаление вещи чистит образы через событие, пересборка капсулы чистит кэш поиска", async () => {
  await boot({ state: LEGACY });
  removeItem("w2");
  assert.deepEqual(data("looks").list[0].item_ids, ["w1"]);
  assert.equal(Object.keys(data("search").cache).length, 1);
  commitCapsule({ concept: "x", palette: [], keep: [], drop: [], buy: [], looks: [], notes: "" });
  assert.deepEqual(data("search").cache, {});
});

test("отмена импорта из фото убирает именно добавленные им вещи", async () => {
  await boot({ state: LEGACY });
  const added = addItems([{ name: "A" }, { name: "B" }], { first: true });
  setLastImport({ added: added.map((w) => w.id), photos: 3, found: 4, repeats: 2, known: 2, at: 1 });
  assert.equal(wardrobeApi.count(), 4);
  assert.equal(data("wardrobe").items[0].name, "A", "новые вещи в начале списка");
  removeItem(added[0].id);
  assert.deepEqual(data("wardrobe").lastImport.added, [added[1].id]);
  assert.equal(undoLastImport(), 1);
  assert.deepEqual(
    data("wardrobe").items.map((w) => w.id),
    ["w1", "w2"],
  );
  assert.equal(data("wardrobe").lastImport, null);
});

test("копия: версия 2 туда и обратно; слайсы, которых нет в копии, не трогаются; неизвестные пропускаются", async () => {
  await boot({ state: LEGACY });
  const backup = JSON.parse(exportBackup());
  assert.equal(backup.version, 2);
  assert.deepEqual(Object.keys(backup.slices).sort(), ["capsule", "looks", "profile", "search", "wardrobe"]);

  await boot();
  delete backup.slices.search;
  backup.slices.calendar = { v: 1, data: {} };
  const notes = await quiet(() => importBackup(JSON.stringify(backup)));
  assert.deepEqual(notes, {});
  assert.equal(data("profile").wishes, "минимализм");
  assert.equal(data("wardrobe").items.length, 2);
  assert.equal(data("search").last, "", "поиска в копии не было: остался как был");
  await assert.rejects(importBackup("не json"), /не файл резервной копии/);
  await assert.rejects(importBackup(JSON.stringify({ version: 2 })), /не файл резервной копии/);
});

test("«Удалить все данные» стирает всё, включая блоб прошлой версии", async () => {
  const b = await boot({ state: LEGACY, "mod:old-module": { v: 1, data: 1 } });
  let replaced = 0;
  const { on } = await import("../public/js/core/events.js");
  on("app:data-replaced", () => replaced++);
  await resetAll();
  assert.equal(replaced, 1);
  assert.equal(b.map.has("state"), false);
  assert.equal(b.map.has("mod:old-module"), false);
  assert.deepEqual(b.map.get("mod:wardrobe").data, { items: [], lastImport: null });
  assert.equal(data("profile").wishes, "");
});

test("после покупки Pro конверты всех модулей вскрываются одним запросом", async () => {
  await boot({
    state: { ...LEGACY, locks: { looks: { locked: { looks: 3 }, sealed: "env-looks" }, analysis: { locked: {}, sealed: "env-a" } } },
  });
  const original = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    const full = {
      looks: [
        { name: "Полный", item_ids: ["w1", "w2"] },
        { name: "Второй", item_ids: ["w1", "w2"] },
      ],
    };
    return new Response(JSON.stringify({ results: { looks: full, analysis: null } }), { headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(await unlockAll(), 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(body.sealed, { analysis: "env-a", looks: "env-looks" });
  assert.equal(data("looks").list.length, 2);
  assert.equal(data("looks").lock, null);
  assert.ok(data("profile").lock, "анализ не вскрылся: конверт остаётся");
});

test("событие без слушателей и упавший слушатель не ломают отправителя", async () => {
  await boot();
  const { on } = await import("../public/js/core/events.js");
  on("x:y", () => {
    throw new Error("упал");
  });
  let ok = false;
  on("x:y", () => (ok = true));
  await quiet(() => emit("x:y"));
  assert.ok(ok);
  emit("nobody:listens");
});
