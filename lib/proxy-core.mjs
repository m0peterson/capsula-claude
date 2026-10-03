// Прокси к OpenAI-совместимым API (OpenRouter, OpenCode Go, свой провайдер).
// Не зависит от платформы: работает на Netlify Functions и Cloudflare Pages Functions.
// Ключи пользователя не логируются и не сохраняются. Ответ провайдера стримится как есть.

export const PROVIDERS = {
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
  },
  "opencode-go": {
    base: "https://opencode.ai/zen/go/v1",
    env: "OPENCODE_GO_API_KEY",
  },
};

// Лимит тела запроса у Netlify Functions около 6 МБ.
const MAX_BODY_BYTES = 5.5 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status, message) {
  return json({ error: { message } }, status);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Для своего провайдера принимаем только публичный https-хост по имени.
// Иначе прокси можно использовать для обращений во внутреннюю сеть.
export function validateCustomBase(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new Error("Некорректный Base URL");
  }
  if (url.protocol !== "https:") throw new Error("Base URL должен начинаться с https://");
  if (url.username || url.password) throw new Error("В Base URL нельзя указывать логин и пароль");
  // «localhost.» и «host.internal.» с точкой на конце это те же хосты.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  const internal =
    host === "localhost" ||
    !host.includes(".") ||
    /\.(local|localhost|internal|lan|corp|intranet|private)$/.test(host) ||
    host.endsWith(".home.arpa");
  if (isIp || internal) throw new Error("Base URL должен указывать на публичный домен, не на IP или локальный хост");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function publicConfig(getEnv) {
  return {
    serverKeys: Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => [name, Boolean(getEnv(p.env))])),
    accessCodeRequired: Boolean(getEnv("PILOT_ACCESS_CODE")),
  };
}

export async function handleLlm(req, getEnv) {
  if (req.method === "GET") return json(publicConfig(getEnv));
  if (req.method !== "POST") return fail(405, "Метод не поддерживается");

  // Прокси тратит серверные ключи, поэтому чужой сайт не должен уметь дёргать его из браузера пользователя.
  // Запрос с application/json из другого origin требует preflight, на который мы не отвечаем.
  if (req.headers.get("sec-fetch-site") === "cross-site") return fail(403, "Запросы с других сайтов не принимаются");
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return fail(415, "Ожидается Content-Type: application/json");

  const provider = req.headers.get("x-provider") || "openrouter";
  let key = (req.headers.get("x-api-key") || "").trim();
  let base;

  if (provider === "custom") {
    try {
      base = validateCustomBase(req.headers.get("x-base-url"));
    } catch (e) {
      return fail(400, e.message);
    }
    if (!key) return fail(401, "Для своего провайдера нужен API-ключ");
  } else if (PROVIDERS[provider]) {
    base = PROVIDERS[provider].base;
    if (!key) {
      // Токен пилота лежит в переменных окружения. Если задан код доступа, без него он не выдаётся.
      const serverKey = getEnv(PROVIDERS[provider].env);
      if (!serverKey) return fail(401, "API-ключ не указан. Добавьте его в настройках.");
      const code = getEnv("PILOT_ACCESS_CODE");
      if (code && !safeEqual(req.headers.get("x-access-code") || "", code)) {
        return fail(401, "Нужен код доступа к пилоту или собственный API-ключ (настройки).");
      }
      key = serverKey;
    }
  } else {
    return fail(400, "Неизвестный провайдер");
  }

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return fail(413, "Слишком большой запрос. Загрузите меньше или более лёгкие фото.");

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return fail(413, "Слишком большой запрос. Загрузите меньше или более лёгкие фото.");
  try {
    JSON.parse(body);
  } catch {
    return fail(400, "Тело запроса должно быть JSON");
  }

  let upstream;
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: req.signal, // клиент отменил запрос: не тратим токены на генерацию, которую никто не прочитает
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "http-referer": "https://capsula.app",
        "x-title": "Capsula Stylist",
      },
      body,
    });
  } catch (e) {
    return fail(502, `Не удалось связаться с провайдером: ${e.message}`);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
