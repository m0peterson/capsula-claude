// Данные клиента (фото, гардероб, результаты) лежат в IndexedDB браузера. Настройки и ключи в localStorage.
// На сервер ничего не сохраняется.

import { normalizeAnalysis, normalizeLooks, normalizeCapsule, normalizeSearch } from "./normalize.js";
import { isRecord, safeImage } from "./util.js";

const DB_NAME = "capsula";
const STORE = "kv";
const SETTINGS_KEY = "capsula.settings.v1";

export const defaultState = () => ({
  profile: { photos: [], inputs: {}, analysis: null },
  wardrobe: [],
  wishes: "",
  looks: [],
  capsule: null,
  search: {},
  searchLast: "",
  capsuleOptions: null,
});

export const defaultSettings = () => ({
  accessCode: "",
  providers: {
    openrouter: { apiKey: "" },
    "opencode-go": { apiKey: "" },
    custom: { apiKey: "", baseUrl: "" },
  },
  // Слот vision получает фото (анализ клиента, распознавание вещей).
  // Слот stylist работает с текстом (образы, капсула, поиск).
  vision: { provider: "openrouter", model: "meta/muse-spark-1.3-contributor", effort: "xhigh", maxTokens: 0 },
  stylist: { provider: "openrouter", model: "openai/gpt-6-luna", effort: "xhigh", maxTokens: 0 },
});

export const state = defaultState();
export let settings = defaultSettings();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Результаты, сохранённые старой версией, могли быть в кривой форме и ломали вкладки при открытии.
// Приводим их к нынешней форме; то, что привести нельзя, сбрасываем (его можно пересчитать).
export function migrate(st) {
  const attempt = (label, fn) => {
    try {
      return fn();
    } catch (e) {
      console.warn(`Сохранённый результат «${label}» повреждён и сброшен:`, e.message);
      return null;
    }
  };
  let droppedImages = 0;
  st.wardrobe = (Array.isArray(st.wardrobe) ? st.wardrobe : []).filter(isRecord).map((w) => {
    const image = safeImage(w.image);
    if (w.image && !image) droppedImages++;
    return { ...w, id: String(w.id ?? ""), image };
  });
  const ids = new Set(st.wardrobe.map((w) => w.id));
  st.profile = isRecord(st.profile) ? st.profile : defaultState().profile;
  const photos = Array.isArray(st.profile.photos) ? st.profile.photos : [];
  st.profile.photos = photos.filter((p) => safeImage(p));
  droppedImages += photos.length - st.profile.photos.length;
  st.profile.inputs = isRecord(st.profile.inputs) ? st.profile.inputs : {};
  if (st.profile.analysis) st.profile.analysis = attempt("анализ", () => normalizeAnalysis(st.profile.analysis));
  st.looks = attempt("образы", () => normalizeLooks({ looks: st.looks }, ids)) || [];
  if (st.capsule) st.capsule = attempt("капсула", () => normalizeCapsule(st.capsule, ids));
  st.search = isRecord(st.search) ? st.search : {};
  for (const [k, v] of Object.entries(st.search)) {
    st.search[k] = isRecord(v) ? { ...v, results: normalizeSearch(v.results) } : undefined;
    if (st.search[k] === undefined) delete st.search[k];
  }
  return { droppedImages };
}

export async function init() {
  try {
    const saved = await idbGet("state");
    if (saved) {
      Object.assign(state, defaultState(), saved);
      migrate(state);
    }
  } catch (e) {
    console.warn("IndexedDB недоступен, данные не сохранятся", e);
  }
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (raw) {
      const d = defaultSettings();
      settings = {
        ...d,
        ...raw,
        providers: {
          openrouter: { ...d.providers.openrouter, ...raw.providers?.openrouter },
          "opencode-go": { ...d.providers["opencode-go"], ...raw.providers?.["opencode-go"] },
          custom: { ...d.providers.custom, ...raw.providers?.custom },
        },
        vision: { ...d.vision, ...raw.vision },
        stylist: { ...d.stylist, ...raw.stylist },
      };
    }
  } catch {
    /* повреждённые настройки игнорируем */
  }
}

// Throttle, не debounce: запись гарантированно уходит не позже чем через 50 мс после первого изменения.
// Запись в IndexedDB асинхронна и при закрытии вкладки может не успеть, поэтому окно держим коротким.
let timer = null;
function flush() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
  idbSet("state", JSON.parse(JSON.stringify(state))).catch((e) => console.warn("Не удалось сохранить", e));
}

export function save() {
  if (timer === null) timer = setTimeout(flush, 50);
}

// Дополнительная попытка при уходе со страницы. Браузер не гарантирует, что транзакция успеет завершиться.
addEventListener("pagehide", flush);
addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("Не удалось сохранить настройки", e);
  }
}

export async function resetAll() {
  Object.assign(state, defaultState());
  await idbSet("state", JSON.parse(JSON.stringify(state)));
}

export const exportData = () => JSON.stringify({ version: 1, state }, null, 1);

export async function importData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Это не файл резервной копии Capsula");
  }
  if (!isRecord(parsed?.state)) throw new Error("Это не файл резервной копии Capsula");
  // Копия может быть из старой версии или составлена вручную: приводим к нынешней форме так же, как при загрузке.
  const next = { ...defaultState(), ...parsed.state };
  const { droppedImages } = migrate(next);
  Object.assign(state, next);
  await idbSet("state", JSON.parse(JSON.stringify(state)));
  return { droppedImages };
}
