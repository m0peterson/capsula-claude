import { jsonrepair } from "./vendor/jsonrepair/index.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const uid = (p = "w") => p + Math.random().toString(36).slice(2, 9);

export const safeHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(String(h || "").trim()) ? h.trim() : "#cccccc");

export const safeUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

export const arr = (v) => (Array.isArray(v) ? v : []);

// Конец первого сбалансированного значения от позиции start. Скобки внутри строк не считаются.
function balancedEnd(t, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i;
  }
  return -1;
}

const isObj = (v) => v !== null && typeof v === "object";
// После ремонта массив принимаем, только если в нём объекты: «[фото 1]» из прозы это не ответ.
const plausible = (v) => isObj(v) && (!Array.isArray(v) || v.some(isObj));

function jsonError(raw, cause) {
  const reason = cause ? ` (${cause.message})` : "";
  const err = new Error(`Модель вернула ответ, который не удалось разобрать как JSON${reason}.`);
  err.raw = raw;
  return err;
}

// Верхнеуровневые начала значений в тексте. Вложенные пропускаем, иначе оборванный ответ
// превращается во вложенный объект вместо целого.
function topStarts(src) {
  const out = [];
  let from = 0;
  while (out.length < 6) {
    const found = src.slice(from).search(/[{[]/);
    if (found < 0) break;
    const start = from + found;
    out.push(start);
    const end = balancedEnd(src, start);
    if (end < 0) break;
    from = end + 1;
  }
  return out;
}

// Разбирает JSON из ответа модели и сообщает, пришлось ли его чинить.
// Снимает <think>-блоки и ```-обёртки, игнорирует текст до и после, чинит типичные ошибки моделей:
// неэкранированные кавычки внутри строк, висячие запятые, комментарии, одинарные кавычки, оборванный конец.
export function parseModelJson(text) {
  const raw = String(text ?? "");
  let t = raw.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  const stray = t.search(/<\/(?:think|thinking|reasoning)>/i); // открывающий тег у некоторых провайдеров срезан
  if (stray >= 0) t = t.slice(t.indexOf(">", stray) + 1);

  const sources = [...t.matchAll(/```[\w-]*\s*([\s\S]*?)```/g)].map((m) => m[1]);
  sources.push(t);

  // Варианты среза для одного начала: хвост целиком, до последней закрывающей скобки, сбалансированный кусок.
  const slices = (src, start) => {
    const last = src.lastIndexOf(src[start] === "{" ? "}" : "]");
    const end = balancedEnd(src, start);
    return {
      balanced: end >= 0 ? src.slice(start, end + 1) : null,
      tail: src.slice(start),
      toLast: last > start ? src.slice(start, last + 1) : null,
    };
  };

  let firstError = null;
  const note = (e) => (firstError ??= e);

  // Проход 1: обычный JSON.parse.
  for (const src of sources) {
    for (const start of topStarts(src)) {
      const { balanced, toLast } = slices(src, start);
      for (const slice of new Set([balanced, toLast])) {
        if (slice === null) continue;
        try {
          const v = JSON.parse(slice);
          if (isObj(v)) return { value: v, repaired: false };
        } catch (e) {
          note(e);
        }
      }
    }
  }

  // Проход 2: ремонт. Из всех начал берём самый полный результат: так мусорная скобка в прозе
  // вроде «[фото 1]» не побеждает настоящий ответ.
  for (const src of sources) {
    let best = null;
    let bestLen = 0;
    for (const start of topStarts(src)) {
      const { tail, toLast, balanced } = slices(src, start);
      for (const slice of new Set([tail, toLast, balanced])) {
        if (slice === null) continue;
        try {
          const v = JSON.parse(jsonrepair(slice));
          const len = plausible(v) ? JSON.stringify(v).length : 0;
          if (len > 2 && len > bestLen) {
            best = v;
            bestLen = len;
          }
          if (len > 2) break;
        } catch (e) {
          note(e);
        }
      }
    }
    if (best) return { value: best, repaired: true };
  }

  throw jsonError(raw, firstError);
}

export const extractJson = (text) => parseModelJson(text).value;

// Сжимает фото до maxSide и возвращает JPEG data URL. Учитывает EXIF-поворот.
export async function fileToDataUrl(file, maxSide = 1024, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Не удалось открыть «${file.name}». Поддерживаются JPG, PNG, WebP.`);
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

// Уменьшает уже готовый data URL (для миниатюр вещей).
export function shrinkDataUrl(dataUrl, maxSide = 420, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Не удалось уменьшить изображение"));
    img.src = dataUrl;
  });
}
