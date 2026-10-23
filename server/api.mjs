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
import { PROVIDERS, EFFORTS, chatJson, imageInfo } from "./llm.mjs";
import { startTrace, requestId, logSettings } from "./log.mjs";
import { TASKS, InputError, teaserOf, LOCKABLE } from "./tasks.mjs";
import { issueToken, verifyToken, parseCodes, matchCode, seal, unseal, safeEqual } from "./paywall.mjs";
import { isRecord } from "../public/js/lib/coerce.js";
import { safeUrl } from "../public/js/lib/html.js";

// Лимит тела запроса у Netlify Functions около 6 МБ.
const MAX_BODY_BYTES = 5.5 * 1024 * 1024;

// Muse Spark 1.3 Contributor во всех слотах: быстрый и дешёвый ($0.10 / $0.20 за 1M токенов на OpenRouter).
// «Contributor» значит, что Meta учится на запросах: см. dataPolicy ниже и README, раздел «Модели».
// Запасные модели на OpenRouter срабатывают, только если основная недоступна. Для detect запасная своя:
// не каждая модель умеет ставить рамки (Qwen 3.8 Flash проверен: 10 вещей из 10).
const DEFAULT_MODELS = {
  openrouter: {
    model: "meta/muse-spark-1.3-contributor",
    fallback: "openai/gpt-6-luna",
    detect: { model: "meta/muse-spark-1.3-contributor", fallback: "qwen/qwen3.8-flash" },
  },
  "opencode-go": {
    model: "muse-spark-1.3-contributor",
    fallback: "",
    detect: { model: "muse-spark-1.3-contributor", fallback: "" },
  },
};

// Политика данных OpenRouter для модели. По умолчанию deny: только провайдеры, которые не учатся на запросах.
// У моделей «-contributor» единственный провайдер учится на запросах, с deny OpenRouter отвечает «No endpoints
// found matching your data policy», поэтому для них allow. OPENROUTER_DATA_COLLECTION задаёт политику явно.
export function dataPolicy(cfg, model) {
  if (cfg.dataCollection) return cfg.dataCollection;
  return /-contributor\b/.test(model || "") ? "allow" : "deny";
}

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
  const effort = (v) => (EFFORTS.includes(v) ? v : "low");
  const maxTokens = Math.max(0, Math.floor(Number(getEnv("MAX_TOKENS") ?? 24000)) || 0);
  // Самые быстрые провайдеры модели: на deepseek-v4.1-flash это убрало хвост в 40 секунд при той же цене.
  const sort = ["price", "throughput", "latency"].includes(getEnv("OPENROUTER_SORT")) ? getEnv("OPENROUTER_SORT") : "throughput";
  // Слоты провайдера. Переменные MODEL_*, EFFORT_* относятся к основному провайдеру: имена моделей у провайдеров разные.
  // Фото разбираем с короткими рассуждениями (low): так стабильнее цветотип. Рамки и текст с minimal: Muse Spark
  // не умеет без рассуждений (none он отклоняет), а minimal самый быстрый из допустимых.
  // MODEL_FALLBACK общий для фото и текста. У detect своя запасная модель: не каждая умеет ставить рамки.
  const slotsFor = (prov) => {
    const d = DEFAULT_MODELS[prov];
    const env = prov === provider ? getEnv : () => undefined;
    const slot = (prefix, fallbackEffort, defaults = d) => ({
      model: env(`MODEL_${prefix}`) || defaults.model,
      fallback: env(`MODEL_${prefix}_FALLBACK`) ?? (defaults === d ? env("MODEL_FALLBACK") : undefined) ?? defaults.fallback,
      effort: effort(env(`EFFORT_${prefix}`) ?? fallbackEffort),
      maxTokens,
      sort,
    });
    return { vision: slot("VISION", "low"), detect: slot("DETECT", "minimal", d.detect), text: slot("TEXT", "minimal") };
  };
  const slotsBy = Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, slotsFor(p)]));
  const dc = getEnv("OPENROUTER_DATA_COLLECTION");
  return {
    provider,
    keys,
    slots: slotsBy[provider],
    slotsBy,
    dataCollection: dc === "allow" || dc === "deny" ? dc : "",
    secret: getEnv("PRO_SECRET") || "",
    codes: parseCodes(getEnv("PRO_CODES")),
    admin: getEnv("ADMIN_CODE") || "",
    payUrl: safeUrl(getEnv("PAY_URL") || "").startsWith("https://") ? safeUrl(getEnv("PAY_URL")) : "",
    price: getEnv("PRO_PRICE") || "",
  };
}

export function publicConfig(cfg, { admin = false, getEnv } = {}) {
  const out = {
    ready: Boolean(cfg.keys[cfg.provider]),
    paywall: Boolean(cfg.secret),
    price: cfg.price,
    payUrl: cfg.payUrl,
    devCodes: Boolean(cfg.admin),
    webSearch: PROVIDERS[cfg.provider].webSearch,
  };
  // Разработчику: какие провайдеры и модели стоят на сервере, чтобы настройки показывали их, а не «как на сервере».
  if (admin) {
    const slim = (slots) =>
      Object.fromEntries(Object.entries(slots).map(([k, s]) => [k, { model: s.model, fallback: s.fallback, effort: s.effort }]));
    out.dev = {
      provider: cfg.provider,
      providers: Object.keys(PROVIDERS).filter((p) => cfg.keys[p]),
      slots: Object.fromEntries(Object.entries(cfg.slotsBy).map(([p, s]) => [p, slim(s)])),
      logLevel: logSettings(getEnv || (() => undefined)).name,
    };
  }
  return out;
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

const recentHits = (bucket, ip, windowMs, now = Date.now()) => (hits.get(`${bucket}|${ip}`) || []).filter((t) => now - t < windowMs).length;

const clientIp = (req) =>
  req.headers.get("cf-connecting-ip") ||
  req.headers.get("x-nf-client-connection-ip") ||
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
  "local";

// --- План пользователя ----------------------------------------------------------------------------------
// Код разработчика в заголовке. Неверный код это попытка подбора: после 10 неверных за 10 минут с одного IP
// код не принимается вовсе, даже верный. Иначе /api/config, который отвечает разработчику иначе, стал бы
// оракулом для перебора без ограничений.
const ADMIN_GUESSES = 10;
function isAdmin(req, cfg) {
  const code = req.headers.get("x-admin-code") || "";
  if (!cfg.admin || !code) return false;
  const ip = clientIp(req);
  if (recentHits("admin-guess", ip, 10 * 60 * 1000) >= ADMIN_GUESSES) return false;
  if (safeEqual(code, cfg.admin)) return true;
  limited("admin-guess", ip, ADMIN_GUESSES, 10 * 60 * 1000);
  return false;
}

async function planOf(req, cfg) {
  if (isAdmin(req, cfg)) return { plan: "pro", admin: true };
  if (!cfg.secret) return { plan: "pro", open: true }; // платный доступ не настроен: пилот, всё открыто
  const t = await verifyToken(cfg.secret, req.headers.get("x-pro-token") || "");
  return t ? { plan: "pro", until: t.exp } : { plan: "free" };
}

// Разработчик (код ADMIN_CODE) может подменить провайдера и модели, чтобы сравнивать их на живом приложении.
const MODEL_RE = /^[\w.\-/:@]{1,100}$/;
function devSlots(cfg, dev) {
  let provider = cfg.provider;
  if (isRecord(dev) && PROVIDERS[dev.provider] && cfg.keys[dev.provider]) provider = dev.provider;
  const base = cfg.slotsBy[provider];
  const pick = (name) => {
    const s = { ...base[name] };
    const o = isRecord(dev) && isRecord(dev[name]) ? dev[name] : {};
    if (typeof o.model === "string" && MODEL_RE.test(o.model.trim())) {
      s.model = o.model.trim();
      s.fallback = "";
    }
    // Пустая строка в настройках браузера значит «как на сервере», а не «без рассуждений»: раньше она стирала
    // серверный effort, и в режиме разработчика модели думали на уровне провайдера по умолчанию (в 5-10 раз дольше).
    if (typeof o.effort === "string" && o.effort && EFFORTS.includes(o.effort)) s.effort = o.effort;
    return s;
  };
  return { provider, slots: { vision: pick("vision"), detect: pick("detect"), text: pick("text") } };
}

// --- Поток событий ----------------------------------------------------------------------------------------
const encoder = new TextEncoder();

function eventStream(req, rid, work) {
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
          (result) => send("result", { ...result, rid }),
          (e) => {
            if (e?.name !== "AbortError" || !ctl.signal.aborted)
              send("error", { ...(e?.payload || { message: e?.message || "Ошибка" }), rid });
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
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-request-id": rid,
    },
  });
}

// --- Обработчики ------------------------------------------------------------------------------------------
async function runTask(req, body, cfg, ctx) {
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
  if (provider === "openrouter") slot.dataCollection = dataPolicy(cfg, slot.model);
  const p = task.prompt(clean);
  if (typeof p.temperature === "number") slot.temperature = p.temperature;
  const rid = requestId();

  return eventStream(req, rid, async ({ send, signal }) => {
    const trace = startTrace({ rid, task: body.task, getEnv: ctx.getEnv, admin: who.admin, sink: ctx.log, send });
    const images = (p.images || []).map((im) => imageInfo(typeof im === "string" ? im : im.url));
    trace.emit("task.start", {
      plan: who.plan,
      admin: Boolean(who.admin),
      provider,
      slot: task.slot,
      model: slot.model,
      fallback: slot.fallback || "",
      effort: slot.effort || "",
      maxTokens: slot.maxTokens,
      temperature: slot.temperature,
      dataCollection: slot.dataCollection,
      images: images.length ? images : undefined,
      systemChars: p.system.length,
      userChars: p.user.length,
    });
    trace.emit("task.prompt", { system: p.system, user: p.user });

    let last = 0;
    const onProgress = (pr) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      send("progress", pr);
    };
    const summary = (extra) => trace.emit("task", { plan: who.plan, provider, model: slot.model, ms: trace.elapsed(), ...extra });
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
        onNotice: (m) => trace.emit("notice", { message: m }),
        trace: trace.emit,
      });
    } catch (e) {
      summary({ ok: false, error: e?.name === "AbortError" ? "отменено клиентом" : String(e?.message).slice(0, 300) });
      if (e?.name === "AbortError") throw e;
      // Сырой ответ модели нужен только разработчику, пользователю хватит понятного текста.
      e.payload = { message: e.message, truncated: Boolean(e.truncated), ...(who.admin ? { raw: e.raw, raw2: e.raw2 } : {}) };
      throw e;
    }
    let full;
    try {
      full = task.finish(out.data, clean, out);
    } catch (e) {
      trace.emit("shape", { ok: false, error: e.message });
      summary({ ok: false, model: out.model || slot.model, usage: usageOf(out.usage), error: `форма ответа: ${e.message}` });
      e.payload = { message: e.message, ...(who.admin ? { raw: JSON.stringify(out.data).slice(0, 20000) } : {}) };
      throw e;
    }
    summary({ ok: true, model: out.model || slot.model, served: out.served, usage: usageOf(out.usage) });

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

// opts.log(entry): дополнительный приёмник событий трассы. dev-сервер пишет их в .logs/api.jsonl.
export async function handleApi(req, getEnv, opts = {}) {
  const cfg = readConfig(getEnv);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (req.method === "GET" || req.method === "HEAD") {
    return path === "/api/config" ? json(publicConfig(cfg, { admin: isAdmin(req, cfg), getEnv })) : fail(404, "Не найдено");
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
    if (path === "/api/task") return await runTask(req, body, cfg, { getEnv, log: opts.log });
    if (path === "/api/activate") return await activate(req, body, cfg);
    if (path === "/api/unlock") return await unlock(req, body, cfg);
  } catch (e) {
    console.error(e);
    return fail(500, "Внутренняя ошибка сервера");
  }
  return fail(404, "Не найдено");
}
