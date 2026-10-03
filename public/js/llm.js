import { settings } from "./store.js";
import { parseModelJson } from "./util.js";

export const EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const MODEL_SUGGESTIONS = {
  openrouter: ["meta/muse-spark-1.3-contributor", "meta/muse-spark-1.3", "openai/gpt-6-luna", "openai/gpt-6-luna-pro"],
  "opencode-go": ["kimi-k2.6", "kimi-k2.7-code", "glm-5.2", "mimo-v2.5", "mimo-v2.5-pro", "deepseek-v4-pro", "deepseek-v4-flash"],
  custom: [],
};

export function slotProblem(slot) {
  if (!slot.model?.trim()) return "Не указана модель. Откройте «Настройки».";
  if (slot.provider === "custom") {
    const c = settings.providers.custom;
    if (!c.baseUrl || !c.apiKey) return "Для своего провайдера укажите Base URL и ключ в настройках.";
  }
  return null;
}

function headersFor(slot) {
  const p = settings.providers[slot.provider] || {};
  const h = { "content-type": "application/json", "x-provider": slot.provider };
  if (p.apiKey) h["x-api-key"] = p.apiKey;
  else if (settings.accessCode) h["x-access-code"] = settings.accessCode;
  if (slot.provider === "custom") h["x-base-url"] = p.baseUrl || "";
  return h;
}

function reasoningParams(slot) {
  if (!slot.effort) return {};
  return slot.provider === "openrouter" ? { reasoning: { effort: slot.effort } } : { reasoning_effort: slot.effort };
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
};
const GENERIC_UNSUPPORTED =
  /unsupported (parameter|value)|unknown (parameter|field|argument)|unrecognized (request )?(argument|parameter)|extra inputs|not supported/i;

function nextStep(detail, active) {
  for (const k of ["json", "maxTokens", "reasoning"]) {
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
  json: "Провайдер не принял JSON-режим, ответ придётся разбирать из текста.",
  maxTokens: "Провайдер не принял лимит ответа, запрос выполнен без него.",
  reasoning: "Провайдер не принял режим рассуждения (effort), запрос выполнен без него.",
};

// Что провайдер не принимает, помним до перезагрузки страницы, чтобы не слать заведомо отклоняемый запрос
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

// Один запрос к модели со стримингом. Возвращает { text, annotations, truncated, finish }.
// Если провайдер отвечает 400/422 на необязательный параметр (reasoning, response_format, лимит токенов),
// запрос повторяется без него либо с переименованным параметром.
export async function chat({ slot, messages, extra = {}, onProgress, onNotice, signal }) {
  const problem = slotProblem(slot);
  if (problem) throw new Error(problem);

  const { response_format, ...rest } = extra;
  const where = slot.provider === "custom" ? settings.providers.custom?.baseUrl || "" : "";
  const key = `${slot.provider}|${where}|${slot.model}|${slot.effort}|${slot.maxTokens}`;
  const memo = recall(key);
  const active = {
    reasoning: Boolean(slot.effort) && memo.reasoning !== false,
    json: Boolean(response_format) && memo.json !== false,
    maxTokens: Number(slot.maxTokens) > 0 && memo.maxTokens !== false,
    maxField: memo.maxField || "max_tokens",
  };

  const pending = {}; // что отбросили в этом вызове: запоминаем и сообщаем, только если запрос после этого прошёл
  for (let attempt = 0; ; attempt++) {
    const payload = {
      model: slot.model.trim(),
      messages,
      stream: true,
      ...(active.reasoning ? reasoningParams(slot) : {}),
      ...(active.maxTokens ? { [active.maxField]: Math.floor(Number(slot.maxTokens)) } : {}),
      ...(active.json ? { response_format } : {}),
      ...rest,
    };
    const res = await fetch("/api/llm", {
      method: "POST",
      headers: headersFor(slot),
      body: JSON.stringify(payload),
      signal,
    });
    if (res.ok) {
      if (Object.keys(pending).length) {
        learned.set(key, { ...recall(key), ...pending, at: Date.now() });
        for (const k of Object.keys(pending)) if (k !== "maxField") onNotice?.(DROP_NOTICE[k]);
      }
      return readStream(res, onProgress);
    }

    const err = await readError(res);
    const step = attempt < 3 && (res.status === 400 || res.status === 422) ? nextStep(err.detail, active) : null;
    if (!step) throw new Error(`${slot.provider}: ${err.text}`);
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
    message =
      "Ответ модели обрезан: исчерпан лимит токенов (рассуждения тоже тратят лимит). Задайте или увеличьте «Лимит ответа» либо снизьте effort в настройках.";
  } else if (finish) {
    message = `Провайдер остановил ответ (finish_reason: ${finish}). Часто это фильтр содержимого или сбой у провайдера. Повторите запрос или смените модель.`;
  } else {
    message =
      "Соединение оборвалось до конца ответа. На Netlify так бывает из-за таймаута функции: при effort xhigh ответы идут долго. Снизьте effort до high или medium в настройках либо разверните приложение на Cloudflare Pages.";
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
        // Соединение порвалось посреди ответа (таймаут функции, сброс сокета). Отмену пользователем не прячем.
        if (e?.name === "AbortError") throw e;
        readFailure = e;
        console.warn("Поток ответа оборвался:", e);
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

  // Поток без finish_reason и без [DONE] оборвался: таймаут функции хостинга, разрыв соединения.
  const complete = finish ? COMPLETE_FINISH.test(finish) : sawDone;
  const truncated = !complete;
  if (!text.trim()) {
    if (truncated) throw cutError({ finish, text });
    throw new Error("Модель вернула пустой ответ. Проверьте название модели и ключ.");
  }
  return { text, annotations, truncated, finish };
}

export function userContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
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

// Запрос, на который модель отвечает JSON. Включает JSON-режим провайдера, чинит типичные ошибки разметки,
// а если не вышло, один раз просит модель переслать ответ как валидный JSON.
// expect: ключи корня ожидаемого ответа. По ним выбирается нужный объект, если в тексте их несколько.
export async function chatJson({ slot, system, user, images = [], extra = {}, expect = [], onProgress, onNotice, signal }) {
  const opts = { slot, extra: { response_format: { type: "json_object" }, ...extra }, onProgress, onNotice, signal };
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent(user, images) },
  ];
  const first = await chat({ ...opts, messages });
  try {
    return { data: parseResult(first, expect), annotations: first.annotations };
  } catch (firstError) {
    if (firstError.truncated) throw firstError;
    console.warn("Не удалось разобрать ответ модели:", firstError.message, first.text);
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
      return { data: parseResult(retry, expect), annotations: retry.annotations };
    } catch (retryError) {
      retryError.raw = first.text;
      retryError.raw2 = retry.text;
      throw retryError;
    }
  }
}

export async function fetchServerConfig() {
  try {
    const res = await fetch("/api/llm");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
