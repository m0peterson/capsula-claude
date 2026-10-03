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

async function readError(res) {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || text;
  } catch {
    return text || res.statusText;
  }
}

// Необязательные параметры, которые можно отбросить, если провайдер их не принимает.
const OPTIONAL_PATTERNS = {
  json: /response_format|json|schema|structured/i,
  maxTokens: /max_tokens|max_completion_tokens|maximum|too large|context length|exceed/i,
  reasoning: /reason|effort|thinking/i,
};

function pickDrop(msg, active) {
  const named = Object.keys(OPTIONAL_PATTERNS).find((k) => active[k] && OPTIONAL_PATTERNS[k].test(msg));
  if (named) return named;
  if (!/unsupported|unknown|invalid|not support|parameter|param/i.test(msg)) return null;
  return ["json", "maxTokens", "reasoning"].find((k) => active[k]) || null;
}

// Один запрос к модели со стримингом. Возвращает { text, annotations, truncated, finish }.
// Если провайдер отвечает 400 на необязательный параметр (reasoning, response_format, max_tokens),
// запрос повторяется без него.
export async function chat({ slot, messages, extra = {}, onProgress, signal }) {
  const problem = slotProblem(slot);
  if (problem) throw new Error(problem);

  const { response_format, ...rest } = extra;
  const active = {
    reasoning: Boolean(slot.effort),
    json: Boolean(response_format),
    maxTokens: Number(slot.maxTokens) > 0,
  };

  for (let attempt = 0; ; attempt++) {
    const payload = {
      model: slot.model.trim(),
      messages,
      stream: true,
      ...(active.reasoning ? reasoningParams(slot) : {}),
      ...(active.maxTokens ? { max_tokens: Number(slot.maxTokens) } : {}),
      ...(active.json ? { response_format } : {}),
      ...rest,
    };
    const res = await fetch("/api/llm", {
      method: "POST",
      headers: headersFor(slot),
      body: JSON.stringify(payload),
      signal,
    });
    if (res.ok) return readStream(res, onProgress);

    const msg = await readError(res);
    const drop = attempt < 3 && (res.status === 400 || res.status === 422) ? pickDrop(msg, active) : null;
    if (!drop) throw new Error(`${slot.provider}: ${msg || res.status}`);
    active[drop] = false;
  }
}

async function readStream(res, onProgress) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "Ошибка провайдера");
    const msg = j.choices?.[0]?.message;
    const finish = j.choices?.[0]?.finish_reason || null;
    return { text: msg?.content || "", annotations: msg?.annotations || [], finish, truncated: finish === "length" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let thought = 0;
  let finish = null;
  let sawDone = false;
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
    if (chunk.error) throw new Error(chunk.error.message || "Ошибка провайдера в потоке");
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const delta = choice?.delta || choice?.message || {};
    if (delta.content) text += delta.content;
    if (delta.reasoning) thought += delta.reasoning.length;
    if (delta.reasoning_content) thought += delta.reasoning_content.length;
    if (delta.annotations) annotations.push(...delta.annotations);
    onProgress?.({ chars: text.length, thought });
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handle(buf.trim());
  // Поток без finish_reason и без [DONE] оборвался: таймаут функции хостинга, разрыв соединения.
  const truncated = finish === "length" || (!finish && !sawDone);
  if (!text.trim()) {
    throw new Error(
      truncated && finish === "length"
        ? "Модель исчерпала лимит токенов на рассуждение и не успела написать ответ. Задайте или увеличьте «Лимит ответа» или снизьте effort в настройках."
        : "Модель вернула пустой ответ. Проверьте название модели и ключ.",
    );
  }
  return { text, annotations, truncated, finish };
}

export function userContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

function truncatedError(result) {
  const err = new Error(
    result.finish === "length"
      ? "Ответ модели обрезан: исчерпан лимит токенов (рассуждения тоже тратят лимит). Задайте или увеличьте «Лимит ответа» или снизьте effort в настройках."
      : "Соединение оборвалось до конца ответа. На Netlify так бывает из-за таймаута функции: при effort xhigh ответы идут долго. Снизьте effort до high или medium в настройках либо разверните приложение на Cloudflare Pages.",
  );
  err.raw = result.text;
  err.truncated = true;
  return err;
}

// Разбирает ответ как JSON. Если ответ обрезан, чинить его нельзя: данные потеряны, и мы не выдаём половину за целое.
function parseResult(result) {
  let parsed;
  try {
    parsed = parseModelJson(result.text);
  } catch (e) {
    if (result.truncated) throw truncatedError(result);
    throw e;
  }
  if (parsed.repaired && result.truncated) throw truncatedError(result);
  if (parsed.repaired) console.warn("Ответ модели был невалидным JSON, исправлен автоматически");
  return parsed.value;
}

// Запрос, на который модель отвечает JSON. Включает JSON-режим провайдера, чинит типичные ошибки разметки,
// а если не вышло, один раз просит модель переслать ответ как валидный JSON.
export async function chatJson({ slot, system, user, images = [], extra = {}, onProgress, signal }) {
  const opts = { slot, extra: { response_format: { type: "json_object" }, ...extra }, onProgress, signal };
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent(user, images) },
  ];
  const first = await chat({ ...opts, messages });
  try {
    return { data: parseResult(first), annotations: first.annotations };
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
      return { data: parseResult(retry), annotations: retry.annotations };
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
