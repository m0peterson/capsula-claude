import { jsonrepair } from "./vendor/jsonrepair/index.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const uid = (p = "w") => p + Math.random().toString(36).slice(2, 9);

export const safeHex = (h) => {
  const s = String(h ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : "#cccccc";
};

// Картинки приложения это только data URL растровых форматов. Всё остальное (в том числе из импортированной копии)
// нельзя подставлять в src: через кавычку в значении можно дописать атрибут и выполнить свой скрипт.
export const safeImage = (u) => (typeof u === "string" && /^data:image\/(?:jpe?g|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : "");

export const safeUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

export const arr = (v) => (Array.isArray(v) ? v : []);

// Обычный объект (не массив, не null).
export const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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

function jsonError(raw, cause) {
  const reason = cause ? ` (${cause.message})` : "";
  const err = new Error(`Модель вернула ответ, который не удалось разобрать как JSON${reason}.`);
  err.raw = raw;
  return err;
}

const MAX_STARTS = 64;
const MAX_REPAIRS = 4;

// Начала значений в тексте. Закрытый кусок пропускаем целиком: вложенное не интересно, иначе оборванный
// ответ превращается во вложенный объект. Незакрытую скобку концом не считаем: после неё может идти ответ,
// но всё, что найдено дальше, помечается nested: оно может оказаться лишь кусочком оборванного корня.
function startsOf(src) {
  const out = [];
  const re = /[{[]/g;
  let from = 0;
  let open = false;
  while (out.length < MAX_STARTS) {
    re.lastIndex = from;
    const m = re.exec(src);
    if (!m) break;
    out.push({ start: m.index, nested: open });
    const end = balancedEnd(src, m.index);
    if (end < 0) open = true;
    from = end < 0 ? m.index + 1 : end + 1;
  }
  return out;
}

// Содержимое ``` блоков. Без регулярок с откатом: на незакрытых ограждениях они дают квадратичное время.
function fencedBlocks(t) {
  const out = [];
  let pos = 0;
  for (;;) {
    const open = t.indexOf("```", pos);
    if (open < 0) break;
    const nl = t.indexOf("\n", open + 3);
    const tagOnly = nl >= 0 && nl - open < 40 && /^[\w-]*\s*$/.test(t.slice(open + 3, nl));
    const bodyStart = tagOnly ? nl + 1 : open + 3;
    const close = t.indexOf("```", bodyStart);
    if (close < 0) break;
    out.push(t.slice(bodyStart, close));
    pos = close + 3;
  }
  return out;
}

// Убирает рассуждения, попавшие в content. Незакрытый <think> значит, что до ответа модель не дошла.
// Возвращает text без парных блоков и tail: то, что идёт после одиночного закрывающего тега (или null).
// Открывающий тег у некоторых провайдеров срезан, и тогда всё до закрывающего это рассуждения. В них бывают
// черновики JSON, которые крупнее итога, поэтому tail разбирается первым.
function stripThink(t) {
  const open = /<(think|thinking|reasoning)>/gi;
  let out = "";
  let pos = 0;
  let m;
  while ((m = open.exec(t))) {
    out += t.slice(pos, m.index);
    const closeRe = new RegExp(`</${m[1]}>`, "gi");
    closeRe.lastIndex = m.index + m[0].length;
    const c = closeRe.exec(t);
    if (!c) return { text: out, tail: null };
    pos = c.index + c[0].length;
    open.lastIndex = pos;
  }
  out += t.slice(pos);
  const stray = /<\/(?:think|thinking|reasoning)>/i.exec(out);
  return { text: out, tail: stray ? out.slice(stray.index + stray[0].length) : null };
}

// Лучший кандидат среди JSON-фрагментов набора источников или null. См. parseModelJson.
function pickBest(sources, expect, note) {
  const candidates = [];
  for (const src of sources) {
    let repairs = 0;
    for (const { start, nested } of startsOf(src)) {
      const last = src.lastIndexOf(src[start] === "{" ? "}" : "]");
      const end = balancedEnd(src, start);
      const balanced = end >= 0 ? src.slice(start, end + 1) : null;
      const toLast = last > start ? src.slice(start, last + 1) : null;

      let found = null;
      for (const slice of new Set([balanced, toLast])) {
        if (slice === null) continue;
        try {
          found = { value: JSON.parse(slice), repaired: false };
          break;
        } catch (e) {
          note(e);
        }
      }
      // Ремонт дорогой, а бюджет мал: тратим его только на куски, похожие на JSON. Проза со скобками вроде
      // «[x]» или «{пример}» кавычек и двоеточий не содержит.
      if (!found && repairs < MAX_REPAIRS && /["':]/.test(balanced ?? src.slice(start, start + 400))) {
        repairs++;
        for (const slice of new Set([src.slice(start), toLast, balanced])) {
          if (slice === null) continue;
          try {
            const value = JSON.parse(jsonrepair(slice));
            // jsonrepair склеивает несколько корневых значений в массив: «{...} [1]» это не наш объект.
            if (Array.isArray(value) !== (src[start] === "[")) continue;
            found = { value, repaired: true };
            break;
          } catch (e) {
            note(e);
          }
        }
      }
      if (found && found.value !== null && typeof found.value === "object") candidates.push({ ...found, nested });
    }
  }

  const scored = candidates
    .map((c) => {
      let value = c.value;
      // Ответ в обёртке {"analysis": {...}}: достаём вложенный объект, если в нём ожидаемые ключи.
      if (isRecord(value) && expect.length && !expect.some((k) => k in value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && isRecord(value[keys[0]]) && expect.some((k) => k in value[keys[0]])) value = value[keys[0]];
      }
      const isRec = isRecord(value);
      return {
        value,
        repaired: c.repaired,
        nested: c.nested,
        plausible: isRec ? Object.keys(value).length > 0 : value.some((x) => x !== null && typeof x === "object"),
        hits: isRec ? expect.filter((k) => k in value).length : 0,
        isRec,
        size: JSON.stringify(value).length,
      };
    })
    // Фрагмент внутри незакрытой скобки без единого ожидаемого ключа это кусок оборванного ответа, а не ответ.
    .filter((c) => c.plausible && !(c.nested && expect.length && c.hits === 0))
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        Number(a.nested) - Number(b.nested) ||
        Number(b.isRec) - Number(a.isRec) ||
        b.size - a.size ||
        Number(a.repaired) - Number(b.repaired),
    );
  if (scored.length) return scored[0];
  // Единственное, что нашлось: честный пустой объект.
  const empty = candidates.find((c) => isRecord(c.value) && Object.keys(c.value).length === 0 && !c.repaired && !c.nested);
  return empty ? { value: empty.value, repaired: false, nested: false, hits: 0 } : null;
}

// Разбирает JSON из ответа модели и сообщает, пришлось ли его чинить.
// Снимает <think>-блоки и ```-обёртки, игнорирует текст до и после, чинит типичные ошибки моделей:
// неэкранированные кавычки внутри строк, висячие запятые, комментарии, одинарные кавычки, оборванный конец.
//
// Кандидатов собираем со всех начал и источников и выбираем лучшего. Сноска «[1]» или «{}» в прозе тоже
// валидный JSON, поэтому «первый разобравшийся» не годится. Лучший: больше всего ожидаемых ключей корня
// (opts.expect), потом не вложенный в незакрытую скобку, потом объект, а не массив, потом больший размер,
// потом нечинённый. Поле nested в результате говорит, что ответ найден внутри незакрытой скобки.
export function parseModelJson(text, { expect = [] } = {}) {
  const raw = String(text ?? "");
  const { text: t, tail } = stripThink(raw);

  let firstError = null;
  const note = (e) => (firstError ??= e);
  const sourcesOf = (str) => [...fencedBlocks(str), str];

  // После одиночного </think> лежит итоговый ответ. Если в нём есть то, что мы ждём, черновики из рассуждений не нужны.
  if (tail !== null) {
    const best = pickBest(sourcesOf(tail), expect, note);
    if (best && (!expect.length || best.hits > 0)) return { value: best.value, repaired: best.repaired, nested: best.nested };
  }
  const best = pickBest(sourcesOf(t), expect, note);
  if (best) return { value: best.value, repaired: best.repaired, nested: best.nested };
  throw jsonError(raw, firstError);
}

export const extractJson = (text, opts) => parseModelJson(text, opts).value;

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
