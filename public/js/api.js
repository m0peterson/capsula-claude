// Клиент API приложения. Промпты, модели и ключи живут на сервере, сюда приходят только готовые результаты.
import { state, settings } from "./store.js";

let config = null;

// Что умеет сервер. Если API недоступен (например, открыта статика без функций), считаем, что сервер не готов.
export async function fetchConfig() {
  try {
    const res = await fetch("/api/config");
    config = res.ok ? await res.json() : null;
  } catch {
    config = null;
  }
  return config;
}

export const serverConfig = () => config;

// Гардероб без фото: серверу картинки для образов и капсулы не нужны, а тело запроса так в сотни раз меньше.
export const wardrobeForServer = () => state.wardrobe.map(({ image, recognized, ...w }) => w);
export const profileForServer = () => ({ inputs: state.profile.inputs, analysis: state.profile.analysis });
// Полный анализ бесплатного пользователя в конверте: сервер подставит его в промпт образов и капсулы.
export const sealedAnalysis = () => (state.locks.analysis ? { analysis: state.locks.analysis.sealed } : undefined);

export const isPro = () => Boolean(settings.devCode) || (Boolean(settings.proToken) && settings.proUntil > Date.now());

// Платный доступ включён на сервере, а у пользователя нет Pro: часть результатов придёт урезанной.
export const isLimited = () => Boolean(config?.paywall) && !isPro();

function headers() {
  const h = { "content-type": "application/json" };
  if (settings.proToken && settings.proUntil > Date.now()) h["x-pro-token"] = settings.proToken;
  if (settings.devCode) h["x-admin-code"] = settings.devCode;
  return h;
}

async function apiError(res) {
  let j = null;
  try {
    j = await res.json();
  } catch {
    /* не JSON */
  }
  const err = new Error(j?.error?.message || `Сервер ответил ошибкой ${res.status}`);
  err.status = res.status;
  err.code = j?.error?.code || "";
  return err;
}

// Выполняет задачу на сервере. Ответ идёт потоком событий: progress, затем result или error.
// Возвращает { data, locked, sealed, plan }.
// Если соединение оборвалось без результата (на Netlify функцию обрывают через 30 секунд), повторяем один раз:
// обычно второй ответ модели приходит быстрее.
export async function runServerTask(task, input, opts = {}) {
  try {
    return await runOnce(task, input, opts);
  } catch (e) {
    if (!e.cut || opts.signal?.aborted) throw e;
    return runOnce(task, input, opts);
  }
}

async function runOnce(task, input, { sealed, signal, onProgress } = {}) {
  const body = { task, input };
  if (sealed) body.sealed = sealed;
  if (settings.devCode) body.dev = settings.dev;
  const res = await fetch("/api/task", { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok) throw await apiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let outcome = null;
  const handle = (block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "progress") onProgress?.(payload);
    else if (event === "result") outcome = { ok: true, payload };
    else if (event === "error") outcome = { ok: false, payload };
  };
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        break; // соединение порвалось: ниже скажем об этом, если результата не было
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        handle(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    }
    if (buf.trim()) handle(buf);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!outcome) {
    const err = new Error("Соединение с сервером оборвалось до конца ответа. Попробуйте ещё раз.");
    err.truncated = true;
    err.cut = true;
    throw err;
  }
  if (!outcome.ok) {
    const p = outcome.payload || {};
    const err = new Error(p.message || "Ошибка");
    if (p.raw) err.raw = p.raw;
    if (p.raw2) err.raw2 = p.raw2;
    err.truncated = Boolean(p.truncated);
    throw err;
  }
  return outcome.payload;
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// Код Pro или код разработчика. Возвращает { token, until } или { admin: true }.
export const activateCode = (code) => post("/api/activate", { code });

// Вскрывает конверты с полными результатами. Нужен действующий Pro.
export const unlockSealed = (sealed) => post("/api/unlock", { sealed }).then((r) => r.results || {});
