// Логи сервера: трасса одной задачи от входа до ответа модели.
//
// LOG_LEVEL   info (по умолчанию): строка на задачу (модель, время, токены, цена, ошибка).
//             debug: ещё каждый запрос к модели: параметры, статус, время до первого байта и токена, повторы,
//             отброшенные параметры, разбор JSON. Запросы с кодом разработчика пишутся так всегда.
//             trace: ещё промпты и сырые ответы модели.
// LOG_FORMAT  json (по умолчанию): одна строка JSON на событие, её разбирают Cloudflare Workers Logs и Netlify.
//             pretty: короткие строки для терминала (так по умолчанию в npm run dev).
//
// Фото не попадают в логи никогда, только их число и размер. Запрос с кодом разработчика получает всю трассу,
// включая промпты и ответ модели, в потоке ответа (событие debug): её показывает вкладка «Логи».

const LEVELS = { info: 1, debug: 2, trace: 3 };

// С какого уровня событие пишется в консоль.
const EVENT_LEVEL = { task: 1, "task.start": 2, "task.prompt": 3, "llm.raw": 3 };
const levelOf = (type) => EVENT_LEVEL[type] ?? 2;

// Длинные поля в консоли режем: у Workers Logs и Netlify есть предел на строку лога.
const CONSOLE_TEXT_LIMIT = 16000;
const SINK_TEXT_LIMIT = 200000;

export function logSettings(getEnv) {
  const name = LEVELS[getEnv("LOG_LEVEL")] ? getEnv("LOG_LEVEL") : "info";
  return { name, level: LEVELS[name], pretty: getEnv("LOG_FORMAT") === "pretty" };
}

export const requestId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function clip(value, limit) {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[ещё ${value.length - limit} зн.]` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, limit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, limit)]));
  return value;
}

// Трасса задачи. emit(type, data) пишет событие в консоль (по уровню), в sink (dev-сервер пишет файл)
// и разработчику в поток ответа.
export function startTrace({ rid, task, getEnv, admin = false, sink, send }) {
  const { level, pretty } = logSettings(getEnv);
  const consoleLevel = admin ? Math.max(level, LEVELS.debug) : level;
  const started = Date.now();
  function emit(type, data = {}) {
    const ev = { type, t: Date.now() - started, ...data };
    if (admin && send) send("debug", ev);
    if (sink) {
      try {
        sink({ ts: new Date().toISOString(), rid, task, ...clip(ev, SINK_TEXT_LIMIT) });
      } catch {
        /* лог не ломает задачу */
      }
    }
    if (levelOf(type) > consoleLevel) return;
    const out = clip(ev, CONSOLE_TEXT_LIMIT);
    if (pretty) console.log(prettyLine(rid, task, out));
    else {
      const { type: _type, ...rest } = out;
      console.log(JSON.stringify({ evt: type, rid, task, ...rest }));
    }
  }
  return { rid, emit, elapsed: () => Date.now() - started };
}

// --- Человекочитаемый вывод для терминала ---------------------------------------------------------------------
const sec = (ms) => (ms == null ? "?" : ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);
const usd = (v) => (v == null || v === "" ? "" : `$${Number(v).toFixed(Number(v) < 0.01 ? 5 : 3)}`);
const indent = (text) =>
  String(text)
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

export function usageText(u) {
  if (!u) return "";
  const parts = [`токены ${u.in ?? u.prompt_tokens ?? "?"} → ${u.out ?? u.completion_tokens ?? "?"}`];
  const r = u.reasoning ?? u.completion_tokens_details?.reasoning_tokens;
  if (r) parts.push(`рассуждения ${r}`);
  if (u.cost != null) parts.push(usd(u.cost));
  return parts.join(", ");
}

export function prettyLine(rid, task, e) {
  // ts есть у событий из файла (npm run logs), у живых событий берём текущее время. Время UTC.
  const head = `${(e.ts ? new Date(e.ts) : new Date()).toISOString().slice(11, 23)} ${rid} ${task.padEnd(9)} +${sec(e.t).padStart(6)}`;
  const call = e.call && e.call !== "main" ? ` [${e.call}]` : "";
  switch (e.type) {
    case "task.start":
      return `${head} ▶ ${e.provider} ${e.model}${e.fallback ? ` (запасная ${e.fallback})` : ""} effort=${e.effort || "-"}${e.dataCollection ? ` data=${e.dataCollection}` : ""} план=${e.plan}${e.admin ? " разработчик" : ""}${e.images ? ` фото=${e.images.length} [${e.images.join(", ")}]` : ""} промпт=${e.systemChars}+${e.userChars} зн.`;
    case "task.prompt":
      return `${head} промпт\n${indent(`[system]\n${e.system}\n[user]\n${e.user}`)}`;
    case "llm.request": {
      const p = e.params || {};
      const keys = Object.keys(p).filter((k) => !["model", "messages", "input", "instructions", "stream"].includes(k));
      const flags = keys.map((k) => `${k}=${typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k]}`).join(" ");
      return `${head}${call} → #${e.attempt} ${e.protocol} ${p.model} ${e.kb} КБ ${flags}`;
    }
    case "llm.response":
      return `${head}${call} ← #${e.attempt} HTTP ${e.status} за ${sec(e.ms)}`;
    case "llm.retry":
      return `${head}${call} ↻ #${e.attempt} повтор через ${sec(e.waitMs)}: ${e.reason}${e.status ? ` (${e.status})` : ""}`;
    case "llm.adjust":
      return `${head}${call} ⚙ #${e.attempt} ${e.change}: ${e.because}`;
    case "llm.error":
      return `${head}${call} ✗ #${e.attempt} ${e.status ? `HTTP ${e.status} ` : ""}${e.error}${e.detail && e.detail !== e.error ? `\n${indent(e.detail)}` : ""}`;
    case "llm.done": {
      const served = e.model && e.model !== e.requested ? ` ответила ${e.model}` : "";
      return `${head}${call} ✓ модель ${sec(e.ms)} (первый токен ${sec(e.firstTokenMs)}) ${e.chars} зн.${e.thought ? `, рассуждения ${e.thought} зн.` : ""}, finish=${e.finish}${e.truncated ? " ОБРЕЗАН" : ""}${e.annotations ? `, источников ${e.annotations}` : ""}; ${usageText(e.usage)}${served}${e.served ? ` [${e.served}]` : ""}${e.id ? ` id=${e.id}` : ""}`;
    }
    case "llm.raw":
      return `${head}${call} ответ модели\n${indent(e.text)}`;
    case "parse":
      return `${head}${call} ${e.ok ? "JSON разобран" : "JSON не разобран"}${e.repaired ? " (починен)" : ""}${e.nested ? " (вложенный)" : ""}${e.error ? `: ${e.error}` : ""}`;
    case "task":
      return `${head} ${e.ok ? "■ готово" : "■ ОШИБКА"} ${sec(e.ms)} ${e.model || ""}${e.usage ? `; ${usageText(e.usage)}` : ""}${e.error ? `: ${e.error}` : ""}`;
    default:
      return `${head} ${e.type} ${JSON.stringify(e)}`;
  }
}
