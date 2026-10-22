// Хранилище данных пользователя. Каждый модуль владеет одним слайсом: своим ключом «mod:<id>» в IndexedDB.
// Фото, гардероб и результаты живут только в браузере, на сервер ничего не сохраняется.
//
// Слайс объявляет модуль (в своём model.js):
//   defineSlice("looks", { version, initial, migrate, fromLegacy })
//   migrate(raw, { from, get, note }) приводит сохранённое (любой формы, в том числе мусор) к нынешней форме.
//     from: версия сохранённого, 0 для данных старой версии приложения. get(id): данные другого слайса, уже
//     загруженного в этом проходе (модули грузятся в порядке modules.js, зависимости раньше). note(key, n): счётчик
//     для отчёта импорта, например droppedImages.
//   fromLegacy(state) достаёт данные слайса из общего блоба «state», в котором приложение хранило всё до модулей.
//
// Запись: save() помечает слайс изменённым, через 50 мс все изменённые слайсы пишутся одной транзакцией.
// Если IndexedDB недоступна, приложение работает в памяти и предупреждает об этом.
import { isRecord } from "../lib/coerce.js";
import { emit } from "./events.js";

const DB_NAME = "capsula";
const STORE = "kv";
const LEGACY_KEY = "state";
const keyOf = (id) => `mod:${id}`;

const slices = new Map(); // id → { id, version, initial, migrate, fromLegacy, data }
let order = []; // порядок модулей: в нём грузим и импортируем
let backend = null;
let failedIdb = null; // IndexedDB открылась, но чтение упало: туда не пишем, только чистим по «Удалить все данные»
const dirty = new Set();
let pendingClear = false;
let timer = null;

export function defineSlice(id, { version = 1, initial, migrate = (raw) => raw, fromLegacy = null }) {
  if (slices.has(id)) throw new Error(`Слайс «${id}» уже объявлен`);
  if (typeof initial !== "function") throw new Error(`У слайса «${id}» нет initial()`);
  const def = { id, version, initial, migrate, fromLegacy, data: initial() };
  slices.set(id, def);
  return {
    id,
    // Живой объект: менять его может только модуль-владелец, после изменения он вызывает save().
    get data() {
      return def.data;
    },
    save: () => markDirty(id),
    replace(next) {
      def.data = next;
      markDirty(id);
    },
  };
}

// --- Хранилища -----------------------------------------------------------------------------------------
export function memoryBackend(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getMany(keys) {
      return new Map(keys.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    async write({ puts, clear }) {
      if (clear) map.clear();
      for (const [k, v] of puts) map.set(k, structuredClone(v));
    },
  };
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Транзакция IndexedDB отменена"));
  });
}

function idbBackend(db) {
  return {
    kind: "idb",
    async getMany(keys) {
      const tx = db.transaction(STORE);
      const os = tx.objectStore(STORE);
      const out = new Map();
      for (const k of keys) {
        const req = os.get(k);
        req.onsuccess = () => req.result !== undefined && out.set(k, req.result);
      }
      await txDone(tx);
      return out;
    },
    // Одна транзакция: либо записалось всё, либо ничего.
    async write({ puts, clear }) {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      if (clear) os.clear();
      for (const [k, v] of puts) os.put(v, k);
      await txDone(tx);
    },
  };
}

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) return reject(new Error("IndexedDB нет в этом окружении"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(idbBackend(req.result));
    req.onerror = () => reject(req.error);
  });
}

// Для тестов: подменить хранилище до load().
export const useBackend = (b) => (backend = b);

// --- Миграция -------------------------------------------------------------------------------------------
function migrateSlice(def, raw, from, ctx) {
  try {
    return def.migrate(raw, { from, get: ctx.get, note: ctx.note });
  } catch (e) {
    console.warn(`Сохранённые данные «${def.id}» повреждены и сброшены:`, e.message);
    return def.initial();
  }
}

function legacyOf(def, legacy) {
  try {
    return def.fromLegacy(legacy);
  } catch (e) {
    console.warn(`Не удалось достать «${def.id}» из данных прошлой версии:`, e.message);
    return undefined;
  }
}

function context(next) {
  const notes = {};
  return {
    notes,
    // Данные зависимости из этого же прохода, а если её в проходе нет, текущие.
    get: (id) => {
      if (next.has(id)) return next.get(id);
      if (!slices.has(id)) throw new Error(`Нет слайса «${id}»`);
      return slices.get(id).data;
    },
    note: (key, n = 1) => (notes[key] = (notes[key] || 0) + n),
  };
}

const known = (ids) => ids.filter((id) => slices.has(id));

// Загружает слайсы в порядке ids (порядок модулей). Никогда не бросает: при сбое хранилища работаем в памяти.
export async function load(ids = [...slices.keys()]) {
  order = known(ids);
  for (const id of slices.keys()) if (!order.includes(id)) order.push(id);
  let stored = new Map();
  let legacy;
  try {
    backend ??= await openIdb();
    stored = await backend.getMany(order.map(keyOf));
    // Общий блоб прошлой версии читаем, только если какого-то слайса ещё нет: первый запуск после обновления
    // или прошлая запись разделения не дошла до диска. «state» не трогаем, старая версия приложения читает его после отката.
    if (order.some((id) => !stored.has(keyOf(id)))) legacy = (await backend.getMany([LEGACY_KEY])).get(LEGACY_KEY);
  } catch (e) {
    console.warn("IndexedDB недоступен, данные не сохранятся", e);
    if (backend?.kind === "idb") failedIdb = backend;
    backend = memoryBackend();
    stored = new Map();
    legacy = undefined;
  }

  const next = new Map();
  const ctx = context(next);
  const legacyClone = isRecord(legacy) ? structuredClone(legacy) : null;
  const split = [];
  for (const id of order) {
    const def = slices.get(id);
    const rec = stored.get(keyOf(id));
    if (isRecord(rec) && "data" in rec) {
      const from = Number(rec.v) || 0;
      if (from > def.version) console.warn(`Данные «${id}» сохранены более новой версией приложения (${from}), читаем как есть`);
      next.set(id, migrateSlice(def, rec.data, from, ctx));
    } else if (legacyClone && def.fromLegacy) {
      next.set(id, migrateSlice(def, legacyOf(def, legacyClone), 0, ctx));
      split.push(id);
    } else {
      next.set(id, def.initial());
    }
  }
  for (const [id, data] of next) slices.get(id).data = data;
  if (Object.keys(ctx.notes).length) console.warn("При загрузке отброшено:", ctx.notes);
  // Данные из блоба прошлой версии сразу пишем по своим ключам.
  for (const id of split) markDirty(id);
  return { notes: ctx.notes };
}

// --- Запись ---------------------------------------------------------------------------------------------
function markDirty(id) {
  dirty.add(id);
  // Throttle, не debounce: запись уходит не позже чем через 50 мс после первого изменения.
  if (timer === null) timer = setTimeout(() => flush().catch(() => {}), 50);
}

// Пишет все изменённые слайсы одной транзакцией. Если запись не удалась, слайсы остаются изменёнными
// и уйдут со следующей записью. Флаги не снимаются после записи: правка, сделанная во время записи, не теряется.
export async function flush() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!dirty.size && !pendingClear) return;
  const ids = [...dirty].filter((id) => slices.has(id));
  dirty.clear();
  const clear = pendingClear;
  pendingClear = false;
  const puts = ids.map((id) => {
    const def = slices.get(id);
    return [keyOf(id), JSON.parse(JSON.stringify({ v: def.version, data: def.data }))];
  });
  try {
    backend ??= memoryBackend();
    await backend.write({ puts, clear });
  } catch (e) {
    console.warn("Не удалось сохранить", e);
    for (const id of ids) dirty.add(id);
    if (clear) pendingClear = true;
    throw e;
  }
}

// Дополнительная попытка записи при уходе со страницы. Браузер не гарантирует, что транзакция успеет завершиться.
export function startPersistence() {
  if (typeof addEventListener !== "function") return;
  addEventListener("pagehide", () => flush().catch(() => {}));
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush().catch(() => {}));
}

// --- Копия, импорт, сброс -------------------------------------------------------------------------------
export function exportBackup() {
  const out = {};
  for (const id of order.length ? order : slices.keys()) {
    const def = slices.get(id);
    out[id] = { v: def.version, data: def.data };
  }
  return JSON.stringify({ app: "capsula", version: 2, exportedAt: new Date().toISOString(), slices: out }, null, 1);
}

const notBackup = () => new Error("Это не файл резервной копии Capsula");

// Принимает копию версии 2 (по слайсам) и версии 1 (общий блоб { state } из прошлой версии приложения).
// Слайсы, которых в копии нет, не трогаем. Возвращает счётчики отброшенного, например { droppedImages: 2 }.
export async function importBackup(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw notBackup();
  }
  const ids = order.length ? order : [...slices.keys()];
  const next = new Map();
  const ctx = context(next);
  if (isRecord(parsed) && parsed.version === 2 && isRecord(parsed.slices)) {
    for (const id of Object.keys(parsed.slices)) if (!slices.has(id)) console.warn(`В копии есть неизвестный раздел «${id}», он пропущен`);
    for (const id of ids) {
      if (!(id in parsed.slices)) continue;
      const rec = parsed.slices[id];
      next.set(id, migrateSlice(slices.get(id), isRecord(rec) ? rec.data : undefined, Number(rec?.v) || 0, ctx));
    }
  } else if (isRecord(parsed) && isRecord(parsed.state)) {
    const legacy = structuredClone(parsed.state);
    for (const id of ids) {
      const def = slices.get(id);
      if (def.fromLegacy) next.set(id, migrateSlice(def, legacyOf(def, legacy), 0, ctx));
    }
  } else {
    throw notBackup();
  }
  for (const [id, data] of next) {
    slices.get(id).data = data;
    dirty.add(id);
  }
  emit("app:data-replaced");
  await flush();
  return ctx.notes;
}

// Удаляет всё: весь ключ-значение, в том числе блоб прошлой версии и ключи удалённых модулей.
export async function resetAll() {
  for (const def of slices.values()) {
    def.data = def.initial();
    dirty.add(def.id);
  }
  pendingClear = true;
  emit("app:data-replaced");
  if (failedIdb) await failedIdb.write({ puts: [], clear: true });
  await flush();
}

export function resetStoreForTests() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  dirty.clear();
  pendingClear = false;
  backend = null;
  failedIdb = null;
  order = [];
  for (const def of slices.values()) def.data = def.initial();
}
