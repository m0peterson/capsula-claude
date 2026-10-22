// Гардероб из фото образов: модель находит на всех фото уникальные вещи и рамку каждой на лучшем фото,
// браузер вырезает вещи из оригиналов и добавляет новые в гардероб. Повторы внутри пачки убирает модель
// (она видит все фото сразу), повторы с уже имеющимися вещами она находит по таблице их миниатюр.
import { runServerTask } from "../../core/api.js";
import { openImage, bitmapToDataUrl, bitmapToBlob, cropToDataUrl, contactSheet } from "../../lib/images.js";
import { safeImage } from "../../lib/html.js";
import { items, addItems, setLastImport } from "./model.js";
import { normalizeOutfits } from "./schema.js";

export const MAX_OUTFIT_PHOTOS = 10;
// Сколько имеющихся вещей показываем модели для сверки: две таблицы по 36 миниатюр.
const MAX_KNOWN = 72;
const SHEET = { tile: 160, cols: 6, per: 36 };
// Сервер принимает тело до 5.5 МБ. Детальные фото с телефона даже в 1024 px бывают по 450 КБ в base64,
// десять таких с таблицами не влезают: тогда пережимаем фото мельче, а не показываем ошибку «слишком большой запрос».
const BODY_BUDGET = 4.6 * 1024 * 1024;

// Имеющиеся вещи для сверки: текстом с метками E1, E2, ... и таблицами миниатюр с теми же метками.
async function knownWardrobe() {
  const list = items().slice(0, MAX_KNOWN);
  const known = list.map((w, i) => ({ ref: `E${i + 1}`, name: w.name, category: w.category, color: w.color || "" }));
  const withImage = list.map((w, i) => ({ image: safeImage(w.image), label: `E${i + 1}` })).filter((e) => e.image);
  const sheets = [];
  for (let i = 0; i < withImage.length; i += SHEET.per) sheets.push(await contactSheet(withImage.slice(i, i + SHEET.per), SHEET));
  return { list, known, sheets };
}

// files: File[] (фото образов). t: помощник runTask. Возвращает отчёт { added, photos, found, repeats, known, at }.
export async function importOutfits(files, { signal, onProgress, setLabel }) {
  const picked = files.slice(0, MAX_OUTFIT_PHOTOS);
  setLabel(`Готовлю фото: ${picked.length} шт.`);
  // Модели уходит копия 1024 px, а вещи вырезаем из копии 1600 px: так миниатюры резче. Оригиналы сразу закрываем,
  // десяток открытых фото по 12 Мп на телефоне не помещается в память.
  const photos = [];
  const sources = [];
  for (const f of picked) {
    const b = await openImage(f);
    try {
      photos.push(bitmapToDataUrl(b, 1024, 0.82));
      sources.push(await bitmapToBlob(b, 1600, 0.9));
    } finally {
      b.close?.();
    }
  }
  const { list, known, sheets } = await knownWardrobe();
  const size = () => [...photos, ...sheets].reduce((n, u) => n + u.length, 0);
  if (size() > BODY_BUDGET) {
    for (let i = 0; i < photos.length; i++) {
      const b = await createImageBitmap(sources[i]);
      try {
        photos[i] = bitmapToDataUrl(b, 896, 0.7);
      } finally {
        b.close?.();
      }
    }
  }
  if (size() > BODY_BUDGET) throw new Error("Фото слишком тяжёлые для одного захода. Загрузите меньше фото за раз.");

  setLabel(`Ищу вещи на ${photos.length} фото`);
  const r = await runServerTask("outfits", { photos, known, sheets }, { signal, onProgress });
  const found = normalizeOutfits(r.data?.items, { photoCount: photos.length, known: new Set(known.map((k) => k.ref)) });
  if (!found.length) throw new Error("На фото не нашлось ни одной вещи. Нужны фото, где одежда видна целиком.");

  setLabel("Вырезаю вещи");
  const crops = new Map();
  for (const n of new Set(found.filter((f) => f.box).map((f) => f.best))) {
    const bitmap = await createImageBitmap(sources[n]);
    try {
      for (const f of found) if (f.best === n && f.box) crops.set(f, cropToDataUrl(bitmap, f.box));
    } finally {
      bitmap.close?.();
    }
  }
  const fresh = [];
  let matched = 0;
  for (const f of found) {
    const image = crops.get(f) || "";
    if (f.same_as) {
      matched++;
      // Вещь уже есть. Если у неё нет фото (например, после загрузки копии), берём вырезку.
      const existing = list[Number(f.same_as.slice(1)) - 1];
      if (existing && !safeImage(existing.image) && image) existing.image = image;
      continue;
    }
    fresh.push({ ...f.item, image, source: "outfit" });
  }
  const added = addItems(fresh, { first: true });
  // Сколько раз вещи встретились сверх первого: столько повторов склеено.
  const repeats = found.reduce((n, f) => n + Math.max(0, f.photos.length - 1), 0);
  const report = { added: added.map((w) => w.id), photos: photos.length, found: found.length, repeats, known: matched, at: Date.now() };
  setLastImport(added.length ? report : null);
  return report;
}
