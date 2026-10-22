// Клиент к OpenAI-совместимым API (OpenRouter, OpenCode Go). Работает на сервере: ключи, модели и промпты
// в браузер не попадают. Не зависит от платформы: Netlify Functions, Cloudflare Workers, dev-сервер.
import { parseModelJson } from "../public/js/lib/json.js";

export const PROVIDERS = {
  openrouter: { base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY", webSearch: true },
  // OpenCode Go рассчитан на трафик кодинг-агентов и без заголовка x-opencode-session отклоняет запросы.
  // Для продакшена с пользователями он не предназначен, только для тестов.
  "opencode-go": { base: "https://opencode.ai/zen/go/v1", env: "OPENCODE_GO_API_KEY", webSearch: false },
};

export const EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

function headersFor(endpoint) {
  const h = {
    authorization: `Bearer ${endpoint.key}`,
    "content-type": "application/json",
    "http-referer": "https://capsula.app",
    "x-title": "Capsula Stylist",
  };
  if (endpoint.provider === "opencode-go") {
    h["x-opencode-session"] = endpoint.session || crypto.randomUUID();
    h["user-agent"] = "capsula-stylist/0.2";
  }
  return h;
}

function reasoningParams(endpoint, slot) {
  if (!slot.effort) return {};
  return endpoint.provider === "openrouter" ? { reasoning: { effort: slot.effort } } : { reasoning_effort: slot.effort };
}

// Только для OpenRouter: провайдеры, которые не хранят запросы и не учатся на них (в запросах фото людей),
// и запасная модель на случай, если основная недоступна.
function routingParams(endpoint, slot) {
  if (endpoint.provider !== "openrouter") return {};
  const out = { provider: { data_collection: "deny", ...(slot.sort ? { sort: slot.sort } : {}) } };
  if (slot.fallback && slot.fallback !== slot.model) out.models = [slot.model, slot.fallback];
  return out;
}

// Разбор ответа провайдера с ошибкой. OpenRouter прячет причину апстрима в error.metadata.raw,
// OpenAI называет параметр в error.param, часть серверов шлёт error строкой.
async function readError(res) {
  const body = await res.text().catch(() => "");
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {
    /* не JSON */
  }
  const e = j?.error;
  const message = (typeof e === "string" ? e : e?.message) || j?.message || body || res.statusText || String(res.status);
  const parts = [message];
  let shown = message;
  if (e && typeof e === "object") {
    for (const k of ["param", "code"]) if (typeof e[k] === "string") parts.push(e[k]);
    const raw = e.metadata?.raw;
    if (raw) {
      const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
      parts.push(rawStr);
      let inner = rawStr;
      try {
        const r = JSON.parse(rawStr);
        const er = r.error ?? r;
        inner = (typeof er === "string" ? er : er?.message) || rawStr;
        if (typeof er?.param === "string") parts.push(er.param);
      } catch {
        /* raw не JSON */
      }
      if (!message.includes(inner)) shown = `${message}: ${inner.slice(0, 400)}`;
    }
  }
  return { text: shown, detail: parts.join(" ") };
}

// Необязательные параметры: если провайдер называет такой параметр в ошибке, отбрасываем именно его.
const NAMED = {
  json: /response[_ -]?format|json[_ -]?(object|schema|mode|output)|structured[ _-]?outputs?/i,
  maxTokens: /max_tokens|max_completion_tokens/i,
  reasoning: /reasoning|effort/i,
  temperature: /temperature/i,
};
const GENERIC_UNSUPPORTED =
  /unsupported (parameter|value)|unknown (parameter|field|argument)|unrecognized (request )?(argument|parameter)|extra inputs|not supported/i;

function nextStep(detail, active) {
  for (const k of ["json", "maxTokens", "reasoning", "temperature"]) {
    if (!active[k] || !NAMED[k].test(detail)) continue;
    // У reasoning-моделей OpenAI вместо max_tokens нужен max_completion_tokens: переименовываем, а не теряем лимит.
    if (k === "maxTokens" && active.maxField === "max_tokens" && /max_completion_tokens/i.test(detail)) return { rename: true };
    return { drop: k };
  }
  // Ошибка без названия параметра: из необязательных чаще всего виноват effort (xhigh знают не все).
  if (GENERIC_UNSUPPORTED.test(detail) && active.reasoning) return { drop: "reasoning" };
  return null;
}

const DROP_NOTICE = {
  json: "провайдер не принял JSON-режим, ответ разобран из текста",
  maxTokens: "провайдер не принял лимит ответа, запрос выполнен без него",
  reasoning: "провайдер не принял режим рассуждения (effort), запрос выполнен без него",
  temperature: "провайдер не принял temperature, запрос выполнен без неё",
};

// Что провайдер не принимает, помним в пределах экземпляра функции, чтобы не слать заведомо отклоняемый запрос
// (с фото это ещё и до 5 МБ лишнего трафика на каждый вызов).
const LEARNED_TTL_MS = 30 * 60 * 1000;
const learned = new Map();
export const resetLearned = () => learned.clear();

// Решение живёт полчаса: провайдер мог починиться или смениться ключ, а вечно слать урезанный запрос не нужно.
function recall(key) {
  const entry = learned.get(key);
  if (!entry) return {};
  if (Date.now() - entry.at > LEARNED_TTL_MS) {
    learned.delete(key);
    return {};
  }
  return entry;
}

// Временные ошибки провайдера (перегрузка, лимит частоты, сбой шлюза, страница Cloudflare «error code: 1015»):
// один повтор через паузу.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
export let RETRY_DELAY_MS = 1200;
export const setRetryDelay = (ms) => (RETRY_DELAY_MS = ms);

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    });
  });

// Один запрос к модели со стримингом. Возвращает { text, annotations, truncated, finish, usage }.
// endpoint: { provider, key, session? }, slot: { model, effort, maxTokens, temperature, fallback }.
// Если провайдер отвечает 400/422 на необязательный параметр (reasoning, response_format, лимит токенов, temperature),
// запрос повторяется без него либо с переименованным параметром.
export async function chat({ endpoint, slot, messages, extra = {}, onProgress, onNotice, signal }) {
  const provider = PROVIDERS[endpoint.provider];
  if (!provider) throw new Error(`Неизвестный провайдер: ${endpoint.provider}`);
  if (!endpoint.key) throw new Error("На сервере не настроен ключ провайдера ИИ.");
  if (!slot.model?.trim()) throw new Error("На сервере не указана модель.");

  const { response_format, ...rest } = extra;
  const key = `${endpoint.provider}|${slot.model}|${slot.effort}|${slot.maxTokens}`;
  const memo = recall(key);
  const active = {
    reasoning: Boolean(slot.effort) && memo.reasoning !== false,
    json: Boolean(response_format) && memo.json !== false,
    maxTokens: Number(slot.maxTokens) > 0 && memo.maxTokens !== false,
    temperature: typeof slot.temperature === "number" && memo.temperature !== false,
    maxField: memo.maxField || "max_tokens",
  };

  const pending = {}; // что отбросили в этом вызове: запоминаем и сообщаем, только если запрос после этого прошёл
  let transientLeft = 1;
  for (let attempt = 0; ; attempt++) {
    const payload = {
      model: slot.model.trim(),
      messages,
      stream: true,
      ...routingParams(endpoint, slot),
      ...(active.reasoning ? reasoningParams(endpoint, slot) : {}),
      ...(active.maxTokens ? { [active.maxField]: Math.floor(Number(slot.maxTokens)) } : {}),
      ...(active.temperature ? { temperature: slot.temperature } : {}),
      ...(active.json ? { response_format } : {}),
      ...rest,
    };
    // Не идём за редиректом провайдера: ключ не должен уйти на другой адрес. redirect: "error" Cloudflare Workers не поддерживают.
    let res;
    try {
      res = await fetch(`${provider.base}/chat/completions`, {
        method: "POST",
        redirect: "manual",
        headers: headersFor(endpoint),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      // Сеть оборвалась до ответа: один повтор, пользователю незачем видеть разовый сбой.
      if (e?.name === "AbortError" || transientLeft-- <= 0) throw e;
      await pause(RETRY_DELAY_MS, signal);
      continue;
    }
    if (res.status >= 300 && res.status < 400) throw new Error(`${endpoint.provider}: провайдер ответил перенаправлением (${res.status})`);
    if (res.ok) {
      if (Object.keys(pending).length) {
        learned.set(key, { ...recall(key), ...pending, at: Date.now() });
        for (const k of Object.keys(pending)) if (k !== "maxField") onNotice?.(DROP_NOTICE[k]);
      }
      return readStream(res, onProgress);
    }

    const err = await readError(res);
    if (TRANSIENT_STATUS.has(res.status) || /error code: 10\d\d/i.test(err.detail)) {
      if (transientLeft-- > 0) {
        console.warn(`${endpoint.provider}: временная ошибка ${res.status}, повтор`);
        await pause(RETRY_DELAY_MS, signal);
        continue;
      }
    }
    const step = attempt < 4 && (res.status === 400 || res.status === 422) ? nextStep(err.detail, active) : null;
    if (!step) {
      const e = new Error(`${endpoint.provider}: ${err.text}`);
      e.status = res.status;
      throw e;
    }
    if (step.rename) {
      active.maxField = "max_completion_tokens";
      pending.maxField = active.maxField;
    } else {
      active[step.drop] = false;
      pending[step.drop] = false;
    }
  }
}

// Завершения, после которых ответ считается целым. Всё остальное (length, content_filter, error, ...) это обрыв.
const COMPLETE_FINISH = /^(stop|end_turn|stop_sequence|tool_calls|function_call|completed|eos|eos_token)$/i;

// Завершения «упёрлись в лимит токенов»: у разных провайдеров называются по-разному.
const LENGTH_FINISH = /^(length|max_tokens|max_output_tokens|model_length)$/i;

const errText = (e) => (typeof e === "string" ? e : e?.message || JSON.stringify(e));

// Ошибка «ответ не дошёл целиком». Данные потеряны, поэтому чинить такой ответ нельзя.
export function cutError({ finish, text = "" }) {
  let message;
  if (LENGTH_FINISH.test(finish || "")) {
    message = "Ответ модели обрезан: исчерпан лимит токенов. Попробуйте ещё раз, обычно со второго раза ответ короче.";
  } else if (finish) {
    message = `Модель остановила ответ (finish_reason: ${finish}). Часто это фильтр содержимого или сбой у провайдера. Попробуйте ещё раз.`;
  } else {
    message = "Соединение с моделью оборвалось до конца ответа. Попробуйте ещё раз.";
  }
  const err = new Error(message);
  err.raw = text;
  err.truncated = true;
  return err;
}

async function readStream(res, onProgress) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const j = await res.json();
    if (j.error) throw new Error(errText(j.error) || "Ошибка провайдера");
    const choice = j.choices?.[0];
    const finish = choice?.finish_reason || null;
    return {
      text: choice?.message?.content || "",
      annotations: choice?.message?.annotations || [],
      finish,
      truncated: Boolean(finish) && !COMPLETE_FINISH.test(finish),
      usage: j.usage || null,
      model: j.model || null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let thought = 0;
  let finish = null;
  let sawDone = false;
  let readFailure = null;
  let usage = null;
  let model = null;
  const annotations = [];

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    if (!data) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) {
      const err = new Error(errText(chunk.error) || "Ошибка провайдера в потоке");
      err.raw = text;
      throw err;
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const delta = choice?.delta || choice?.message || {};
    if (delta.content) text += delta.content;
    if (delta.reasoning) thought += delta.reasoning.length;
    if (delta.reasoning_content) thought += delta.reasoning_content.length;
    if (delta.annotations) annotations.push(...delta.annotations);
    onProgress?.({ chars: text.length, thought });
  };

  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // Соединение порвалось посреди ответа (таймаут, сброс сокета). Отмену не прячем.
        if (e?.name === "AbortError") throw e;
        readFailure = e;
        console.warn("Поток ответа оборвался:", e?.message || e);
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    if (!readFailure && buf.trim()) handle(buf.trim());
  } finally {
    reader.cancel().catch(() => {}); // при ошибке разбора чанка или отмене не оставляем соединение висеть
  }

  // Поток без finish_reason и без [DONE] оборвался: таймаут, разрыв соединения.
  const complete = finish ? COMPLETE_FINISH.test(finish) : sawDone;
  const truncated = !complete;
  if (!text.trim()) {
    if (truncated) throw cutError({ finish, text });
    throw new Error("Модель вернула пустой ответ.");
  }
  return { text, annotations, truncated, finish, usage, model };
}

// images: data URL или { label, url }: подпись идёт текстом прямо перед картинкой («Фото 2:»), так модель
// не путает номера.
export function userContent(text, images = []) {
  if (!images.length) return text;
  const image = (url) => ({ type: "image_url", image_url: { url } });
  return [
    { type: "text", text },
    ...images.flatMap((im) => (typeof im === "string" ? [image(im)] : [{ type: "text", text: im.label }, image(im.url)])),
  ];
}

// Разбирает ответ как JSON. Если ответ обрезан, чинить его нельзя: данные потеряны, и мы не выдаём половину за целое.
function parseResult(result, expect) {
  let parsed;
  try {
    parsed = parseModelJson(result.text, { expect });
  } catch (e) {
    if (result.truncated) throw cutError(result);
    throw e;
  }
  if ((parsed.repaired || parsed.nested) && result.truncated) throw cutError(result);
  if (parsed.repaired) console.warn("Ответ модели был невалидным JSON, исправлен автоматически");
  return parsed.value;
}

const addUsage = (a, b) => {
  if (!b) return a;
  if (!a) return { ...b };
  const out = { ...a };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) out[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0);
  return out;
};

// Запрос, на который модель отвечает JSON. Включает JSON-режим провайдера, чинит типичные ошибки разметки,
// а если не вышло, один раз просит модель переслать ответ как валидный JSON.
// expect: ключи корня ожидаемого ответа. По ним выбирается нужный объект, если в тексте их несколько.
export async function chatJson({ endpoint, slot, system, user, images = [], extra = {}, expect = [], onProgress, onNotice, signal }) {
  const opts = { endpoint, slot, extra: { response_format: { type: "json_object" }, ...extra }, onProgress, onNotice, signal };
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent(user, images) },
  ];
  const first = await chat({ ...opts, messages });
  try {
    return { data: parseResult(first, expect), annotations: first.annotations, usage: first.usage, model: first.model };
  } catch (firstError) {
    if (firstError.truncated) throw firstError;
    console.warn("Не удалось разобрать ответ модели:", firstError.message);
    const retry = await chat({
      ...opts,
      messages: [
        ...messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `Ответ не разобрался как JSON: ${firstError.message} Верни тот же результат целиком как один валидный JSON-объект по заданной схеме. Кавычки внутри строк экранируй или заменяй на «ёлочки». Без пояснений и без markdown.`,
        },
      ],
    });
    try {
      return {
        data: parseResult(retry, expect),
        annotations: retry.annotations,
        usage: addUsage(first.usage, retry.usage),
        model: retry.model,
      };
    } catch (retryError) {
      retryError.raw = first.text;
      retryError.raw2 = retry.text;
      throw retryError;
    }
  }
}
