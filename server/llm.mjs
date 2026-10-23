// Клиент к OpenAI-совместимым API (OpenRouter, OpenCode Go). Работает на сервере: ключи, модели и промпты
// в браузер не попадают. Не зависит от платформы: Netlify Functions, Cloudflare Workers, dev-сервер.
//
// Два протокола: chat/completions и Responses API (/responses). У OpenCode Go часть моделей (Muse Spark, GPT)
// отвечает только по второму, на первый они отвечают «Model does not support this protocol».
import { parseModelJson } from "../public/js/lib/json.js";

export const PROVIDERS = {
  openrouter: { base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY", webSearch: true },
  // OpenCode Go рассчитан на трафик кодинг-агентов и без заголовка x-opencode-session отклоняет запросы.
  // Для продакшена с пользователями он не предназначен, только для тестов.
  "opencode-go": {
    base: "https://opencode.ai/zen/go/v1",
    env: "OPENCODE_GO_API_KEY",
    webSearch: false,
    // Модели, которые понимают только Responses API (проверено в октябре 2026). Для остальных протокол
    // определяется по ошибке провайдера и запоминается.
    responses: /^(muse-|gpt-)/,
    switchable: true,
  },
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

function reasoningParams(endpoint, protocol, effort) {
  if (!effort) return {};
  if (protocol === "responses" || endpoint.provider === "openrouter") return { reasoning: { effort } };
  return { reasoning_effort: effort };
}

// Только для OpenRouter: политика данных и запасная модель на случай, если основная недоступна.
// По умолчанию только провайдеры, которые не хранят запросы и не учатся на них (в запросах фото людей).
// Модели «-contributor» (Muse Spark 1.3 Contributor и т. п.) дёшевы именно потому, что провайдер на запросах учится:
// с deny у них нет ни одного провайдера, и вызывающий передаёт dataCollection: "allow".
function routingParams(endpoint, slot) {
  if (endpoint.provider !== "openrouter") return {};
  const out = { provider: { data_collection: slot.dataCollection || "deny", ...(slot.sort ? { sort: slot.sort } : {}) } };
  if (slot.fallback && slot.fallback !== slot.model) out.models = [slot.model, slot.fallback];
  return out;
}

// Протокол модели: заданный провайдером для известных моделей, иначе chat/completions.
function protocolFor(endpoint, model) {
  const re = PROVIDERS[endpoint.provider]?.responses;
  return re && re.test(model) ? "responses" : "chat";
}

// Сообщения chat/completions в формат Responses API: system уходит в instructions, картинки в input_image.
export function toResponsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "system") {
      instructions.push(parts.map((p) => p.text || "").join("\n"));
      continue;
    }
    const textType = m.role === "assistant" ? "output_text" : "input_text";
    input.push({
      role: m.role,
      content: parts.map((p) =>
        p.type === "image_url" ? { type: "input_image", image_url: p.image_url.url } : { type: textType, text: p.text },
      ),
    });
  }
  return { instructions: instructions.join("\n\n"), input };
}

// Тело запроса для протокола. Параметры, от которых провайдер отказался, сюда уже не попадают (active).
function buildPayload({ protocol, endpoint, slot, active, messages, response_format, rest }) {
  const common = {
    model: slot.model.trim(),
    stream: true,
    ...routingParams(endpoint, slot),
    ...(active.reasoning ? reasoningParams(endpoint, protocol, active.effort) : {}),
    ...(active.temperature ? { temperature: slot.temperature } : {}),
  };
  const maxTokens = Math.floor(Number(slot.maxTokens));
  if (protocol === "responses") {
    const { instructions, input } = toResponsesInput(messages);
    return {
      ...common,
      ...(instructions ? { instructions } : {}),
      input,
      store: false, // провайдер не хранит ответ у себя: продолжать диалог по id нам не нужно
      ...(active.maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...(active.json ? { text: { format: response_format } } : {}),
      ...rest,
    };
  }
  return {
    ...common,
    messages,
    ...(active.maxTokens ? { [active.maxField]: maxTokens } : {}),
    ...(active.json ? { response_format } : {}),
    ...rest,
  };
}

// Тело запроса для лога: без картинок (только тип и размер) и без текста промпта (он пишется в лог один раз отдельно).
export function describePayload(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "messages" || k === "input") out[k] = summarizeMessages(v);
    else if (k === "instructions") out[k] = `${v.length} зн.`;
    else out[k] = v;
  }
  return out;
}

function summarizeMessages(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    const parts = typeof m.content === "string" ? [{ text: m.content }] : Array.isArray(m.content) ? m.content : [];
    let chars = 0;
    const images = [];
    for (const p of parts) {
      const url = p.image_url?.url ?? (typeof p.image_url === "string" ? p.image_url : null);
      if (url) images.push(imageInfo(url));
      else chars += (p.text || "").length;
    }
    return { role: m.role, chars, ...(images.length ? { images } : {}) };
  });
}

// «jpeg 182 КБ» по data URL: сами фото в логи не пишем никогда.
export function imageInfo(url) {
  const m = /^data:image\/([\w.+-]+);base64,/.exec(url || "");
  if (!m) return "url";
  return `${m[1]} ${Math.round(((url.length - m[0].length) * 3) / 4 / 1024)} КБ`;
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
  json: /response[_ -]?format|text\.format|json[_ -]?(object|schema|mode|output)|structured[ _-]?outputs?/i,
  maxTokens: /max_tokens|max_completion_tokens|max_output_tokens/i,
  reasoning: /reasoning|effort/i,
  temperature: /temperature/i,
};
const GENERIC_UNSUPPORTED =
  /unsupported (parameter|value)|unknown (parameter|field|argument)|unrecognized (request )?(argument|parameter)|extra inputs|not supported/i;

// Ошибка «модель не понимает этот протокол» (OpenCode Go: ModelProtocolUnsupported).
const PROTOCOL_UNSUPPORTED = /ModelProtocolUnsupported|does not support this protocol/i;

// Effort, который провайдер примет вместо отклонённого. Muse Spark не знает none и перечисляет допустимые
// («Supported values: [minimal, low, ...]»), OpenRouter пишет «Reasoning is mandatory ... cannot be disabled».
// Берём ближайший не слабее запрошенного: без effort модель думает по умолчанию, то есть дольше.
function closerEffort(detail, effort) {
  const listed = /supported values?:?\s*\[([^\]]+)\]/i.exec(detail)?.[1];
  const order = EFFORTS.slice(1);
  if (listed) {
    const ok = listed
      .split(",")
      .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
      .filter((v) => order.includes(v));
    const at = order.indexOf(effort);
    const pick = ok.find((v) => order.indexOf(v) >= at) || ok[ok.length - 1];
    return pick && pick !== effort ? pick : null;
  }
  if (effort === "none" && /mandatory|cannot be disabled/i.test(detail)) return "minimal";
  return null;
}

function nextStep(detail, active) {
  if (active.reasoning && NAMED.reasoning.test(detail)) {
    const effort = closerEffort(detail, active.effort);
    if (effort) return { effort };
  }
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

// Один запрос к модели со стримингом. Возвращает { text, annotations, truncated, finish, usage, model, served, id, timing }.
// endpoint: { provider, key, session? }, slot: { model, effort, maxTokens, temperature, fallback, dataCollection }.
// Если провайдер отвечает 400/422 на необязательный параметр (reasoning, response_format, лимит токенов, temperature),
// запрос повторяется без него, с переименованным параметром или с допустимым effort.
// trace(type, data): события для логов (запрос, статус, повторы, итог). Фото в них не попадают.
export async function chat({ endpoint, slot, messages, extra = {}, onProgress, onNotice, trace, call = "main", signal }) {
  const provider = PROVIDERS[endpoint.provider];
  if (!provider) throw new Error(`Неизвестный провайдер: ${endpoint.provider}`);
  if (!endpoint.key) throw new Error("На сервере не настроен ключ провайдера ИИ.");
  if (!slot.model?.trim()) throw new Error("На сервере не указана модель.");
  const emit = (type, data) => {
    try {
      trace?.(type, { call, ...data });
    } catch {
      /* лог не должен ломать запрос */
    }
  };

  const { response_format, ...rest } = extra;
  const key = `${endpoint.provider}|${slot.model}|${slot.effort}|${slot.maxTokens}`;
  const memo = recall(key);
  const active = {
    reasoning: Boolean(slot.effort) && memo.reasoning !== false,
    effort: memo.effort || slot.effort,
    json: Boolean(response_format) && memo.json !== false,
    maxTokens: Number(slot.maxTokens) > 0 && memo.maxTokens !== false,
    temperature: typeof slot.temperature === "number" && memo.temperature !== false,
    maxField: memo.maxField || "max_tokens",
  };
  let protocol = memo.protocol || protocolFor(endpoint, slot.model.trim());
  let switchedProtocol = false;

  const pending = {}; // что поменяли в этом вызове: запоминаем и сообщаем, только если запрос после этого прошёл
  let transientLeft = 1;
  for (let attempt = 1; ; attempt++) {
    const payload = buildPayload({ protocol, endpoint, slot, active, messages, response_format, rest });
    const url = `${provider.base}/${protocol === "responses" ? "responses" : "chat/completions"}`;
    const body = JSON.stringify(payload);
    emit("llm.request", {
      attempt,
      provider: endpoint.provider,
      protocol,
      url,
      kb: Math.round(body.length / 1024),
      params: describePayload(payload),
    });
    const sent = Date.now();
    // Не идём за редиректом провайдера: ключ не должен уйти на другой адрес. redirect: "error" Cloudflare Workers не поддерживают.
    let res;
    try {
      res = await fetch(url, { method: "POST", redirect: "manual", headers: headersFor(endpoint), body, signal });
    } catch (e) {
      // Сеть оборвалась до ответа: один повтор, пользователю незачем видеть разовый сбой.
      if (e?.name === "AbortError" || transientLeft-- <= 0) {
        emit("llm.error", {
          attempt,
          ms: Date.now() - sent,
          error: e?.name === "AbortError" ? "отменено: клиент закрыл соединение" : `сеть: ${e?.message || e}`,
        });
        throw e;
      }
      emit("llm.retry", { attempt, ms: Date.now() - sent, reason: `сеть: ${e?.message || e}`, waitMs: RETRY_DELAY_MS });
      await pause(RETRY_DELAY_MS, signal);
      continue;
    }
    const ttfb = Date.now() - sent;
    emit("llm.response", { attempt, status: res.status, ms: ttfb });
    if (res.status >= 300 && res.status < 400) throw new Error(`${endpoint.provider}: провайдер ответил перенаправлением (${res.status})`);
    if (res.ok) {
      if (Object.keys(pending).length) {
        learned.set(key, { ...recall(key), ...pending, at: Date.now() });
        for (const k of Object.keys(pending)) if (DROP_NOTICE[k] && pending[k] === false) onNotice?.(DROP_NOTICE[k]);
      }
      let out;
      try {
        out = await readStream(res, { protocol, onProgress, sent });
      } catch (e) {
        emit("llm.error", { attempt, ms: Date.now() - sent, error: e?.message || String(e), ...(e?.raw ? { raw: e.raw } : {}) });
        throw e;
      }
      out.timing = { ttfb, first: out.firstMs, total: Date.now() - sent };
      out.protocol = protocol;
      emit("llm.done", {
        attempt,
        ms: out.timing.total,
        ttfbMs: ttfb,
        firstTokenMs: out.firstMs,
        chars: out.text.length,
        thought: out.thought,
        finish: out.finish,
        truncated: out.truncated,
        ...(out.annotations.length ? { annotations: out.annotations.length } : {}),
        usage: out.usage,
        requested: slot.model.trim(),
        model: out.model,
        served: out.served,
        id: out.id,
      });
      emit("llm.raw", { attempt, text: out.text });
      return out;
    }

    const err = await readError(res);
    emit("llm.error", { attempt, status: res.status, ms: Date.now() - sent, error: err.text, detail: err.detail.slice(0, 2000) });
    if (TRANSIENT_STATUS.has(res.status) || /error code: 10\d\d/i.test(err.detail)) {
      if (transientLeft-- > 0) {
        emit("llm.retry", { attempt, status: res.status, reason: "временная ошибка провайдера", waitMs: RETRY_DELAY_MS });
        await pause(RETRY_DELAY_MS, signal);
        continue;
      }
    }
    // Модель не понимает протокол: пробуем другой один раз. Работает у провайдеров с обоими протоколами.
    if (res.status === 400 && provider.switchable && !switchedProtocol && PROTOCOL_UNSUPPORTED.test(err.detail)) {
      switchedProtocol = true;
      const was = protocol;
      protocol = protocol === "responses" ? "chat" : "responses";
      pending.protocol = protocol;
      emit("llm.adjust", { attempt, change: `протокол ${was} → ${protocol}`, because: err.text });
      continue;
    }
    const step = attempt <= 4 && (res.status === 400 || res.status === 422) ? nextStep(err.detail, active) : null;
    if (!step) {
      const e = new Error(`${endpoint.provider}: ${err.text}`);
      e.status = res.status;
      throw e;
    }
    if (step.rename) {
      active.maxField = "max_completion_tokens";
      pending.maxField = active.maxField;
      emit("llm.adjust", { attempt, change: "max_tokens → max_completion_tokens", because: err.text });
    } else if (step.effort) {
      emit("llm.adjust", { attempt, change: `effort ${active.effort} → ${step.effort}`, because: err.text });
      active.effort = step.effort;
      pending.effort = step.effort;
    } else {
      active[step.drop] = false;
      pending[step.drop] = false;
      emit("llm.adjust", { attempt, change: `без параметра ${step.drop}`, because: err.text });
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

// Расход токенов Responses API в форме chat/completions: так его читают логи и подсчёт стоимости.
function responsesUsage(u) {
  if (!u) return null;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
    ...(u.output_tokens_details?.reasoning_tokens != null
      ? { completion_tokens_details: { reasoning_tokens: u.output_tokens_details.reasoning_tokens } }
      : {}),
    ...(u.cost != null ? { cost: u.cost } : {}),
  };
}

// Итог ответа Responses API: completed это целый ответ, incomplete с причиной это обрыв.
function responsesFinish(r) {
  if (r.status === "completed") return "stop";
  if (r.status === "incomplete") return r.incomplete_details?.reason || "incomplete";
  return r.status || null;
}

// Чанк chat/completions.
function chatChunk(chunk, acc) {
  if (chunk.error) {
    const err = new Error(errText(chunk.error) || "Ошибка провайдера в потоке");
    err.raw = acc.text;
    throw err;
  }
  if (chunk.usage) acc.usage = chunk.usage;
  if (chunk.model) acc.model = chunk.model;
  if (chunk.provider) acc.served = chunk.provider;
  if (chunk.id) acc.id = chunk.id;
  const choice = chunk.choices?.[0];
  if (choice?.finish_reason) acc.finish = choice.finish_reason;
  const delta = choice?.delta || choice?.message || {};
  if (delta.content) acc.text += delta.content;
  if (delta.reasoning) acc.thought += delta.reasoning.length;
  if (delta.reasoning_content) acc.thought += delta.reasoning_content.length;
  if (delta.annotations) acc.annotations.push(...delta.annotations);
}

// Событие Responses API. Текст ответа идёт в response.output_text.delta, итог в response.completed/incomplete.
function responsesChunk(ev, acc) {
  switch (ev.type) {
    case "response.output_text.delta":
      acc.text += ev.delta || "";
      break;
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      acc.thought += (ev.delta || "").length;
      break;
    case "response.output_text.annotation.added":
      if (ev.annotation) acc.annotations.push(ev.annotation);
      break;
    case "response.created":
      acc.id = ev.response?.id || acc.id;
      acc.model = ev.response?.model || acc.model;
      break;
    case "response.completed":
    case "response.incomplete": {
      const r = ev.response || {};
      acc.finish = responsesFinish(r);
      acc.usage = responsesUsage(r.usage);
      acc.model = r.model || acc.model;
      acc.done = true;
      break;
    }
    case "response.failed":
    case "error": {
      const e = ev.response?.error || ev.error || ev;
      const err = new Error(errText(e.message ? e.message : e) || "Ошибка провайдера в потоке");
      err.raw = acc.text;
      throw err;
    }
  }
}

// Ответ без стрима (провайдер проигнорировал stream: true).
function readWhole(j, protocol) {
  if (j.error) throw new Error(errText(j.error) || "Ошибка провайдера");
  if (protocol === "responses") {
    const text = (j.output || [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
    const finish = responsesFinish(j);
    return { text, annotations: [], finish, usage: responsesUsage(j.usage), model: j.model || null, id: j.id || null };
  }
  const choice = j.choices?.[0];
  return {
    text: choice?.message?.content || "",
    annotations: choice?.message?.annotations || [],
    finish: choice?.finish_reason || null,
    usage: j.usage || null,
    model: j.model || null,
    served: j.provider || null,
    id: j.id || null,
  };
}

async function readStream(res, { protocol = "chat", onProgress, sent = Date.now() } = {}) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const out = readWhole(await res.json(), protocol);
    return { thought: 0, served: null, firstMs: null, ...out, truncated: Boolean(out.finish) && !COMPLETE_FINISH.test(out.finish) };
  }

  const onData = protocol === "responses" ? responsesChunk : chatChunk;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = {
    text: "",
    thought: 0,
    finish: null,
    done: false,
    usage: null,
    model: null,
    served: null,
    id: null,
    annotations: [],
    firstMs: null,
  };
  let buf = "";
  let readFailure = null;

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      acc.done = true;
      return;
    }
    if (!data) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    onData(chunk, acc);
    if (acc.firstMs === null && (acc.text || acc.thought)) acc.firstMs = Date.now() - sent;
    onProgress?.({ chars: acc.text.length, thought: acc.thought });
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
  const complete = acc.finish ? COMPLETE_FINISH.test(acc.finish) : acc.done;
  const truncated = !complete;
  if (!acc.text.trim()) {
    if (truncated) throw cutError({ finish: acc.finish, text: acc.text });
    throw new Error("Модель вернула пустой ответ.");
  }
  const { done: _done, ...out } = acc;
  return { ...out, truncated };
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
function parseResult(result, expect, emit) {
  let parsed;
  try {
    parsed = parseModelJson(result.text, { expect });
  } catch (e) {
    emit("parse", { ok: false, error: e.message });
    if (result.truncated) throw cutError(result);
    throw e;
  }
  if ((parsed.repaired || parsed.nested) && result.truncated) {
    emit("parse", { ok: false, error: "ответ обрезан, а JSON пришлось чинить", repaired: parsed.repaired, nested: parsed.nested });
    throw cutError(result);
  }
  emit("parse", { ok: true, repaired: parsed.repaired, nested: parsed.nested });
  return parsed.value;
}

const addUsage = (a, b) => {
  if (!b) return a;
  if (!a) return { ...b };
  const out = { ...a };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) out[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0);
  const r = (u) => Number(u.completion_tokens_details?.reasoning_tokens) || 0;
  if (r(a) || r(b)) out.completion_tokens_details = { reasoning_tokens: r(a) + r(b) };
  return out;
};

// Запрос, на который модель отвечает JSON. Включает JSON-режим провайдера, чинит типичные ошибки разметки,
// а если не вышло, один раз просит модель переслать ответ как валидный JSON.
// expect: ключи корня ожидаемого ответа. По ним выбирается нужный объект, если в тексте их несколько.
export async function chatJson({
  endpoint,
  slot,
  system,
  user,
  images = [],
  extra = {},
  expect = [],
  onProgress,
  onNotice,
  trace,
  signal,
}) {
  const opts = { endpoint, slot, extra: { response_format: { type: "json_object" }, ...extra }, onProgress, onNotice, trace, signal };
  const emit = (call) => (type, data) => {
    try {
      trace?.(type, { call, ...data });
    } catch {
      /* лог не должен ломать запрос */
    }
  };
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent(user, images) },
  ];
  const first = await chat({ ...opts, messages });
  const meta = (r) => ({ model: r.model, served: r.served, id: r.id, protocol: r.protocol, timing: r.timing });
  try {
    return { data: parseResult(first, expect, emit("main")), annotations: first.annotations, usage: first.usage, ...meta(first) };
  } catch (firstError) {
    if (firstError.truncated) throw firstError;
    const retry = await chat({
      ...opts,
      call: "json-retry",
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
        data: parseResult(retry, expect, emit("json-retry")),
        annotations: retry.annotations,
        usage: addUsage(first.usage, retry.usage),
        ...meta(retry),
      };
    } catch (retryError) {
      retryError.raw = first.text;
      retryError.raw2 = retry.text;
      throw retryError;
    }
  }
}
