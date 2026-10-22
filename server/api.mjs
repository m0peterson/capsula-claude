// HTTP API приложения. Не зависит от платформы: Netlify Functions, Cloudflare Workers и Pages, dev-сервер.
//
//   GET  /api/config    что умеет сервер: включён ли платный доступ, цена, ссылка на оплату, веб-поиск
//   POST /api/task      задача стилиста { task, input }; ответ это поток SSE: progress, notice, затем result или error
//   POST /api/activate  { code } → Pro-токен (или признак кода разработчика)
//   POST /api/unlock    { sealed: { analysis?, looks?, capsule? } } с Pro-токеном → полные результаты
//
// Задачи и промпты живут в server/modules/<id>.mjs (список в tasks.mjs), здесь только транспорт, план и лимиты.
//
// Раньше здесь был прокси /api/llm, который пересылал провайдеру любой запрос с серверным ключом. Через него
// любой мог пользоваться ключом как бесплатным API, а промпты лежали в браузере. Теперь промпты, модель и
// граница бесплатного плана живут только на сервере.
import { PROVIDERS, EFFORTS, chatJson } from "./llm.mjs";
import { TASKS, InputError, teaserOf, LOCKABLE } from "./tasks.mjs";
import { issueToken, verifyToken, parseCodes, matchCode, seal, unseal, safeEqual } from "./paywall.mjs";
import { isRecord } from "../public/js/lib/coerce.js";
import { safeUrl } from "../public/js/lib/html.js";

// Лимит тела запроса у Netlify Functions около 6 МБ.
const MAX_BODY_BYTES = 5.5 * 1024 * 1024;

// detect: вещи на фото образов с рамками. deepseek-v4.1-flash ставит рамки мимо вещей, а Gemini 3.8 Flash и Qwen 3.8 Flash
// точно (замер октябрь 2026 на 6 фото образов: 10 вещей из 10, повторы склеены верно; Gemini 13 с, Qwen 30 с).
const DEFAULT_MODELS = {
  openrouter: {
    model: "deepseek/deepseek-v4.1-flash",
    fallback: "openai/gpt-6-luna",
    detect: { model: "google/gemini-3.8-flash", fallback: "qwen/qwen3.8-flash" },
  },
  "opencode-go": { model: "deepseek-v4.1-flash", fallback: "", detect: { model: "deepseek-v4.1-flash", fallback: "" } },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status, message, code) {
  return json({ error: { message, ...(code ? { code } : {}) } }, status);
}

// Настройки сервера из переменных окружения.
export function readConfig(getEnv) {
  const keys = Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => [name, getEnv(p.env) || ""]));
  let provider = getEnv("LLM_PROVIDER") || (keys.openrouter ? "openrouter" : keys["opencode-go"] ? "opencode-go" : "openrouter");
  if (!PROVIDERS[provider]) provider = "openrouter";
  const d = DEFAULT_MODELS[provider];
  const effort = (v) => (EFFORTS.includes(v) ? v : "low");
  const maxTokens = Math.max(0, Math.floor(Number(getEnv("MAX_TOKENS") ?? 24000)) || 0);
  // Фото разбираем с короткими рассуждениями: так стабильнее цветотип. Образы и капсулу без них: у deepseek-v4.1-flash
  // рассуждения на одной и той же капсуле занимали от 2 до 7.6 тыс. токенов, то есть 31-54 секунды вместо 15-22.
  // MODEL_FALLBACK общий для фото и текста. У detect своя запасная модель: не каждая умеет ставить рамки.
  const slot = (prefix, fallbackEffort, defaults = d) => ({
    model: getEnv(`MODEL_${prefix}`) || defaults.model,
    fallback: getEnv(`MODEL_${prefix}_FALLBACK`) ?? (defaults === d ? getEnv("MODEL_FALLBACK") : undefined) ?? defaults.fallback,
    effort: effort(getEnv(`EFFORT_${prefix}`) ?? fallbackEffort),
    maxTokens,
    // Самые быстрые провайдеры модели: на deepseek-v4.1-flash это убрало хвост в 40 секунд при той же цене.
    sort: ["price", "throughput", "latency"].includes(getEnv("OPENROUTER_SORT")) ? getEnv("OPENROUTER_SORT") : "throughput",
  });
  return {
    provider,
    keys,
    // У Gemini 3.8 Flash рассуждения не отключаются, minimal самый быстрый режим.
    slots: { vision: slot("VISION", "low"), detect: slot("DETECT", "minimal", d.detect), text: slot("TEXT", "none") },
    secret: getEnv("PRO_SECRET") || "",
    codes: parseCodes(getEnv("PRO_CODES")),
    admin: getEnv("ADMIN_CODE") || "",
    payUrl: safeUrl(getEnv("PAY_URL") || "").startsWith("https://") ? safeUrl(getEnv("PAY_URL")) : "",
    price: getEnv("PRO_PRICE") || "",
  };
}

export function publicConfig(cfg) {
  return {
    ready: Boolean(cfg.keys[cfg.provider]),
    paywall: Boolean(cfg.secret),
    price: cfg.price,
    payUrl: cfg.payUrl,
    devCodes: Boolean(cfg.admin),
    webSearch: PROVIDERS[cfg.provider].webSearch,
  };
}

// --- Ограничение частоты -------------------------------------------------------------------------------
// В памяти экземпляра функции: на serverless это лишь грубая защита от перебора и скриптов, а не квота.
const hits = new Map();
export const resetRateLimits = () => hits.clear();

function limited(bucket, ip, max, windowMs, now = Date.now()) {
  const id = `${bucket}|${ip}`;
  const list = (hits.get(id) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(id, list);
    return true;
  }
  list.push(now);
  hits.set(id, list);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k);
  return false;
}

const clientIp = (req) =>
  req.headers.get("cf-connecting-ip") ||
  req.headers.get("x-nf-client-connection-ip") ||
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
  "local";

// --- План пользователя ----------------------------------------------------------------------------------
async function planOf(req, cfg) {
  if (cfg.admin && safeEqual(req.headers.get("x-admin-code") || "", cfg.admin)) return { plan: "pro", admin: true };
  if (!cfg.secret) return { plan: "pro", open: true }; // платный доступ не настроен: пилот, всё открыто
  const t = await verifyToken(cfg.secret, req.headers.get("x-pro-token") || "");
  return t ? { plan: "pro", until: t.exp } : { plan: "free" };
}

// Разработчик (код ADMIN_CODE) может подменить провайдера и модели, чтобы сравнивать их на живом приложении.
const MODEL_RE = /^[\w.\-/:@]{1,100}$/;
function devSlots(cfg, dev) {
  let provider = cfg.provider;
  if (isRecord(dev) && PROVIDERS[dev.provider] && cfg.keys[dev.provider]) provider = dev.provider;
  const other = DEFAULT_MODELS[provider];
  const base =
    provider === cfg.provider
      ? cfg.slots
      : {
          vision: { model: other.model, fallback: other.fallback, effort: "low", maxTokens: cfg.slots.vision.maxTokens },
          detect: { ...other.detect, effort: "minimal", maxTokens: cfg.slots.vision.maxTokens },
        };
  const pick = (name) => {
    const s = { ...(base[name] || base.vision) };
    const o = isRecord(dev) && isRecord(dev[name]) ? dev[name] : {};
    if (typeof o.model === "string" && MODEL_RE.test(o.model.trim())) {
      s.model = o.model.trim();
      s.fallback = "";
    }
    if (typeof o.effort === "string" && EFFORTS.includes(o.effort)) s.effort = o.effort;
    return s;
  };
  return { provider, slots: { vision: pick("vision"), detect: pick("detect"), text: pick("text") } };
}

// --- Поток событий ----------------------------------------------------------------------------------------
const encoder = new TextEncoder();

function eventStream(req, work) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  req.signal?.addEventListener?.("abort", onAbort);
  let closed = false;
  let ping = null;
  const stream = new ReadableStream({
    start(controller) {
      const write = (s) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Комментарий раз в 10 секунд не даёт прокси и браузеру закрыть соединение, пока модель думает.
      ping = setInterval(() => write(": ping\n\n"), 10000);
      Promise.resolve()
        .then(() => work({ send, signal: ctl.signal }))
        .then(
          (result) => send("result", result),
          (e) => {
            if (e?.name !== "AbortError" || !ctl.signal.aborted) send("error", e?.payload || { message: e?.message || "Ошибка" });
          },
        )
        .finally(() => {
          clearInterval(ping);
          req.signal?.removeEventListener?.("abort", onAbort);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* уже закрыт */
            }
          }
        });
    },
    cancel() {
      // Клиент закрыл соединение: не тратим токены на генерацию, которую никто не прочитает.
      closed = true;
      clearInterval(ping);
      ctl.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

// --- Обработчики ------------------------------------------------------------------------------------------
async function runTask(req, body, cfg) {
  const task = TASKS[body.task];
  if (!task) return fail(400, "Неизвестная задача");
  const who = await planOf(req, cfg);
  if (task.pro && who.plan !== "pro") return fail(402, "Поиск конкретных моделей с ИИ доступен в Pro.", "pro_required");
  if (limited(who.plan === "pro" ? "task-pro" : "task-free", clientIp(req), who.plan === "pro" ? 120 : 20, 10 * 60 * 1000)) {
    return fail(429, "Слишком много запросов. Подождите несколько минут.");
  }

  const { provider, slots } = who.admin ? devSlots(cfg, body.dev) : { provider: cfg.provider, slots: cfg.slots };
  if (!cfg.keys[provider]) return fail(503, "На сервере не настроен ключ провайдера ИИ.");
  if (task.webSearch && !PROVIDERS[provider].webSearch) return fail(400, "Веб-поиск работает только через OpenRouter.");

  let clean;
  try {
    clean = task.validate(isRecord(body.input) ? body.input : {});
  } catch (e) {
    if (e instanceof InputError) return fail(400, e.message);
    throw e;
  }
  // Полный анализ бесплатного пользователя лежит в конверте: для образов и капсулы берём его, а не урезанную версию.
  if (clean.profile && typeof body.sealed?.analysis === "string") {
    const full = await unseal(cfg.secret, "analysis", body.sealed.analysis);
    if (full) clean.profile.analysis = full;
  }

  const slot = { ...slots[task.slot] };
  const p = task.prompt(clean);
  if (typeof p.temperature === "number") slot.temperature = p.temperature;

  return eventStream(req, async ({ send, signal }) => {
    const started = Date.now();
    let last = 0;
    const onProgress = (pr) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      send("progress", pr);
    };
    let out;
    try {
      out = await chatJson({
        endpoint: { provider, key: cfg.keys[provider] },
        slot,
        system: p.system,
        user: p.user,
        images: p.images || [],
        extra: p.extra || {},
        expect: p.expect || [],
        signal,
        onProgress,
        onNotice: (m) => console.warn(`[${body.task}] ${m}`),
      });
    } catch (e) {
      log({
        task: body.task,
        plan: who.plan,
        model: slot.model,
        ms: Date.now() - started,
        ok: false,
        error: String(e?.message).slice(0, 200),
      });
      if (e?.name === "AbortError") throw e;
      // Сырой ответ модели нужен только разработчику, пользователю хватит понятного текста.
      e.payload = { message: e.message, truncated: Boolean(e.truncated), ...(who.admin ? { raw: e.raw, raw2: e.raw2 } : {}) };
      throw e;
    }
    let full;
    try {
      full = task.finish(out.data, clean, out);
    } catch (e) {
      log({ task: body.task, plan: who.plan, model: slot.model, ms: Date.now() - started, ok: false, error: "shape" });
      e.payload = { message: e.message, ...(who.admin ? { raw: JSON.stringify(out.data).slice(0, 20000) } : {}) };
      throw e;
    }
    log({ task: body.task, plan: who.plan, model: out.model || slot.model, ms: Date.now() - started, ok: true, usage: usageOf(out.usage) });

    if (who.plan === "pro") return { data: full, locked: null, sealed: null, plan: "pro" };
    const { data, locked } = teaserOf(body.task, full);
    return { data, locked, sealed: locked ? await seal(cfg.secret, body.task, full) : null, plan: "free" };
  });
}

async function activate(req, body, cfg) {
  if (limited("activate", clientIp(req), 10, 10 * 60 * 1000)) return fail(429, "Слишком много попыток. Подождите несколько минут.");
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return fail(400, "Введите код.");
  if (cfg.admin && safeEqual(code, cfg.admin)) return json({ admin: true });
  if (!cfg.secret) return fail(400, "Платный доступ на этом сервере не настроен.");
  const match = matchCode(cfg.codes, code);
  if (!match) return fail(400, "Код не подошёл. Проверьте, нет ли опечатки.");
  const token = await issueToken(cfg.secret, { days: match.days });
  const t = await verifyToken(cfg.secret, token);
  return json({ token, until: t.exp });
}

async function unlock(req, body, cfg) {
  const who = await planOf(req, cfg);
  if (who.plan !== "pro") return fail(402, "Нужен Pro.", "pro_required");
  const sealed = isRecord(body.sealed) ? body.sealed : {};
  const out = {};
  for (const task of LOCKABLE) {
    if (typeof sealed[task] === "string") out[task] = await unseal(cfg.secret, task, sealed[task]);
  }
  return json({ results: out });
}

const usageOf = (u) =>
  u ? { in: u.prompt_tokens, out: u.completion_tokens, reasoning: u.completion_tokens_details?.reasoning_tokens, cost: u.cost } : null;

// Одна строка JSON на задачу: видно в логах Netlify и Cloudflare. Без персональных данных.
function log(entry) {
  console.log(JSON.stringify({ evt: "task", ...entry }));
}

export async function handleApi(req, getEnv) {
  const cfg = readConfig(getEnv);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (req.method === "GET" || req.method === "HEAD") {
    return path === "/api/config" ? json(publicConfig(cfg)) : fail(404, "Не найдено");
  }
  if (req.method !== "POST") return fail(405, "Метод не поддерживается");

  // Сервер тратит свои ключи, поэтому чужой сайт не должен уметь дёргать API из браузера пользователя.
  // Запрос с application/json из другого origin требует preflight, на который мы не отвечаем.
  if (req.headers.get("sec-fetch-site") === "cross-site") return fail(403, "Запросы с других сайтов не принимаются");
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return fail(415, "Ожидается Content-Type: application/json");

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return fail(413, "Слишком большой запрос. Загрузите меньше или более лёгкие фото.");
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "Слишком большой запрос. Загрузите меньше или более лёгкие фото.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Тело запроса должно быть JSON");
  }
  if (!isRecord(body)) return fail(400, "Тело запроса должно быть JSON-объектом");

  try {
    if (path === "/api/task") return await runTask(req, body, cfg);
    if (path === "/api/activate") return await activate(req, body, cfg);
    if (path === "/api/unlock") return await unlock(req, body, cfg);
  } catch (e) {
    console.error(e);
    return fail(500, "Внутренняя ошибка сервера");
  }
  return fail(404, "Не найдено");
}
