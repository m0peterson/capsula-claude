// Платный доступ без базы данных.
// Pro-токен: срок действия, подписанный HMAC. Его выдаёт сервер в обмен на код (продажа кодов вручную или вебхук оплаты).
// Запечатанный результат: полный ответ модели, зашифрованный AES-GCM. Бесплатный пользователь получает урезанную версию
// и конверт; после оплаты сервер вскрывает конверт, и человек видит ровно тот результат, который ему показали частично,
// без повторной генерации.
// Всё работает на Web Crypto: одинаково в Node 20+, Netlify и Cloudflare Workers.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Сравнение строк за время, не зависящее от места первого различия.
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const keyCache = new Map();
async function hmacKey(secret) {
  const id = `h:${secret}`;
  if (!keyCache.has(id)) {
    keyCache.set(
      id,
      crypto.subtle.importKey("raw", enc.encode(`capsula-pro:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    );
  }
  return keyCache.get(id);
}

async function aesKey(secret) {
  const id = `a:${secret}`;
  if (!keyCache.has(id)) {
    keyCache.set(
      id,
      crypto.subtle
        .digest("SHA-256", enc.encode(`capsula-seal:${secret}`))
        .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])),
    );
  }
  return keyCache.get(id);
}

async function sign(secret, payload) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

// Токен: base64url(JSON {exp, src}).подпись. exp в миллисекундах.
export async function issueToken(secret, { days, src = "code", now = Date.now() }) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: now + days * 86400000, src })));
  return `${payload}.${await sign(secret, payload)}`;
}

// Возвращает { exp, src } для действующего токена или null.
export async function verifyToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string" || token.length > 600) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await sign(secret, payload))) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(payload)));
    return Number.isFinite(data.exp) && data.exp > now ? { exp: data.exp, src: String(data.src || "") } : null;
  } catch {
    return null;
  }
}

// PRO_CODES: «КОД» или «КОД:дней» через запятую. Без срока код даёт 30 дней.
export function parseCodes(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [code, days] = x.split(":");
      const d = Math.floor(Number(days));
      return { code: code.trim(), days: Number.isFinite(d) && d > 0 ? Math.min(d, 3650) : 30 };
    })
    .filter((x) => x.code);
}

// Проверяет все коды, не останавливаясь на первом совпадении: время ответа не выдаёт, сколько символов угадано.
export function matchCode(codes, input) {
  const s = String(input || "")
    .trim()
    .toUpperCase();
  let found = null;
  for (const c of codes) if (safeEqual(c.code.toUpperCase(), s) && !found) found = c;
  return s ? found : null;
}

// Конверт: base64url(iv).base64url(шифртекст). Внутри JSON {task, data, iat}.
export async function seal(secret, task, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({ task, data, iat: Date.now() }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), plain);
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

// Вскрывает конверт задачи task. Чужой, повреждённый или подделанный конверт даёт null.
export async function unseal(secret, task, sealed) {
  if (!secret || typeof sealed !== "string" || sealed.length > 400000) return null;
  const [iv, ct, extra] = sealed.split(".");
  if (!iv || !ct || extra !== undefined) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(secret), fromB64url(ct));
    const obj = JSON.parse(dec.decode(plain));
    return obj?.task === task ? obj.data : null;
  } catch {
    return null;
  }
}
