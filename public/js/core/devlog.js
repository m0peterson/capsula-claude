// Журнал задач для режима разработчика: что ушло на сервер, что сервер сделал (трасса из событий debug: промпт,
// запросы к модели, статусы, повторы, токены, сырой ответ), что вернулось и сколько заняло.
// Пишется только в режиме разработчика: сервер шлёт трассу только с кодом разработчика, а обычному пользователю
// журнал не нужен. Хранится в localStorage этого браузера, последние MAX_ENTRIES задач. Фото в журнал не попадают.
import { settings } from "./settings.js";
import { emit } from "./events.js";
import { isRecord } from "../lib/coerce.js";

const KEY = "capsula.devlog.v1";
const MAX_ENTRIES = 40;
const MAX_TEXT = 60000; // длиннее режем: промпт и ответ модели в одной записи

let entries = null; // новые первыми

export const devlogOn = () => Boolean(settings.devCode);

function load() {
  entries = [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (Array.isArray(raw)) entries = raw.filter((e) => isRecord(e) && typeof e.id === "string").slice(0, MAX_ENTRIES);
  } catch {
    /* нет localStorage или мусор: начинаем с пустого журнала */
  }
  // Задача, которая шла при закрытии вкладки, уже не закончится.
  for (const e of entries) if (e.status === "running") e.status = "interrupted";
}

function save() {
  for (let keep = entries.length; keep > 0; keep = Math.floor(keep / 2)) {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, keep)));
      return;
    } catch {
      /* не влезло: храним вдвое меньше */
    }
  }
}

let notifyTimer = null;
function changed() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    emit("app:devlog");
  }, 150);
}

export function devlogEntries() {
  if (!entries) load();
  return entries;
}

export function clearDevlog() {
  entries = [];
  save();
  changed();
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[ещё ${s.length - MAX_TEXT} зн.]` : s);

// Вход задачи для журнала: фото заменяются размером, длинные списки и тексты сокращаются.
export function summarizeInput(v, depth = 0) {
  if (typeof v === "string") {
    if (v.startsWith("data:image/")) return `[фото ${Math.round((v.length * 3) / 4 / 1024)} КБ]`;
    return v.length > 300 ? `${v.slice(0, 300)}…(${v.length} зн.)` : v;
  }
  if (Array.isArray(v)) {
    if (depth > 2) return `[${v.length} шт.]`;
    const head = v.slice(0, 12).map((x) => summarizeInput(x, depth + 1));
    return v.length > 12 ? [...head, `…ещё ${v.length - 12}`] : head;
  }
  if (isRecord(v)) {
    if (depth > 3) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, summarizeInput(x, depth + 1)]));
  }
  return v;
}

// Новая запись. Вне режима разработчика null: остальные функции его спокойно принимают.
export function startEntry(task, input) {
  if (!devlogOn()) return null;
  devlogEntries();
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    task,
    at: Date.now(),
    status: "running",
    rids: [],
    input: summarizeInput(input),
    events: [],
  };
  entries.unshift(entry);
  entries.length = Math.min(entries.length, MAX_ENTRIES);
  changed();
  return entry;
}

export function logEvent(entry, ev) {
  if (!entry || !isRecord(ev)) return;
  const e = { ...ev };
  for (const k of ["text", "system", "user", "detail", "raw"]) if (typeof e[k] === "string") e[k] = clip(e[k]);
  e.at = Date.now() - entry.at;
  if (e.type === "client.request" && e.rid) entry.rids.push(e.rid);
  if (e.type === "task.start") Object.assign(entry, { provider: e.provider, model: e.model, effort: e.effort });
  if (e.type === "llm.done" && e.model) entry.served = e.model;
  if (e.type === "task") Object.assign(entry, { usage: e.usage || entry.usage, model: e.model || entry.model });
  entry.events.push(e);
  changed();
}

// status: ok | error | cancelled.
export function finishEntry(entry, { status, error, plan, locked } = {}) {
  if (!entry) return;
  Object.assign(entry, { status, ms: Date.now() - entry.at });
  if (error) entry.error = String(error).slice(0, 2000);
  if (plan) entry.plan = plan;
  if (locked) entry.locked = locked;
  save();
  changed();
}
