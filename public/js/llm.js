import { settings } from "./store.js";
import { extractJson } from "./util.js";

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

// Один запрос к модели со стримингом. Возвращает { text, annotations }.
// Если провайдер не принимает параметр reasoning, один раз повторяет запрос без него.
export async function chat({ slot, messages, extra = {}, onProgress, signal }) {
  const problem = slotProblem(slot);
  if (problem) throw new Error(problem);

  let useReasoning = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = {
      model: slot.model.trim(),
      messages,
      stream: true,
      ...(useReasoning ? reasoningParams(slot) : {}),
      ...extra,
    };
    const res = await fetch("/api/llm", {
      method: "POST",
      headers: headersFor(slot),
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const msg = await readError(res);
      if (attempt === 0 && useReasoning && slot.effort && res.status === 400 && /reason|effort|unsupported|unknown|invalid/i.test(msg)) {
        useReasoning = false;
        continue;
      }
      throw new Error(`${slot.provider}: ${msg || res.status}`);
    }
    return readStream(res, onProgress);
  }
  throw new Error("Не удалось выполнить запрос");
}

async function readStream(res, onProgress) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "Ошибка провайдера");
    const msg = j.choices?.[0]?.message;
    return { text: msg?.content || "", annotations: msg?.annotations || [] };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let thought = 0;
  const annotations = [];

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(chunk.error.message || "Ошибка провайдера в потоке");
    const choice = chunk.choices?.[0];
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
  if (!text.trim()) throw new Error("Модель вернула пустой ответ. Проверьте название модели и ключ.");
  return { text, annotations };
}

export function userContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

// Запрос, на который модель отвечает JSON. При битом JSON просит исправить один раз.
export async function chatJson({ slot, system, user, images = [], extra, onProgress, signal }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent(user, images) },
  ];
  const first = await chat({ slot, messages, extra, onProgress, signal });
  try {
    return { data: extractJson(first.text), annotations: first.annotations };
  } catch {
    const retry = await chat({
      slot,
      messages: [
        ...messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: "Ответ не разобрался как JSON. Верни тот же результат строго как один валидный JSON без пояснений и без markdown.",
        },
      ],
      extra,
      onProgress,
      signal,
    });
    return { data: extractJson(retry.text), annotations: retry.annotations };
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
