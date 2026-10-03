// Данные клиента (фото, гардероб, результаты) лежат в IndexedDB браузера. Настройки и ключи в localStorage.
// На сервер ничего не сохраняется.

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

export async function init() {
  try {
    const saved = await idbGet("state");
    if (saved) Object.assign(state, defaultState(), saved);
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

// Throttle, не debounce: запись гарантированно уходит не позже чем через 250 мс после первого изменения.
let timer = null;
function flush() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
  idbSet("state", JSON.parse(JSON.stringify(state))).catch((e) => console.warn("Не удалось сохранить", e));
}

export function save() {
  if (timer === null) timer = setTimeout(flush, 250);
}

// Не теряем последние правки при закрытии вкладки.
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
  const parsed = JSON.parse(text);
  if (!parsed?.state) throw new Error("Это не файл резервной копии Capsula");
  Object.assign(state, defaultState(), parsed.state);
  await idbSet("state", JSON.parse(JSON.stringify(state)));
}
