// Форма вещи гардероба и ответов распознавания: общий контракт сервера (server/modules/wardrobe.mjs) и браузера.
import { arr, isRecord, text, list } from "../../lib/coerce.js";
import { CATEGORY_KEYS } from "../../shared/catalog.js";

// Одна распознанная вещь. null, если это не объект или у него нет названия.
export function normalizeItem(raw) {
  if (!isRecord(raw)) return null;
  const name = text(raw.name);
  if (!name) return null;
  const rawFormality = raw.formality === null || raw.formality === "" ? NaN : Number(raw.formality);
  const category = text(raw.category).toLowerCase();
  const hex = text(raw.color_hex);
  return {
    name: name.slice(0, 120),
    category: CATEGORY_KEYS.includes(category) ? category : "other",
    color: text(raw.color),
    color_hex: /^#[0-9a-f]{3,8}$/i.test(hex) ? hex : "",
    material: text(raw.material),
    style: text(raw.style),
    seasons: list(raw.seasons),
    formality: Number.isFinite(rawFormality) ? Math.min(5, Math.max(1, Math.round(rawFormality))) : null,
    notes: text(raw.notes),
    recognized: true,
  };
}

// Сопоставляет ответ модели с фото пачки. Возвращает [{ target, item }], где target это номер фото в пачке с нуля.
// Номера index берём, только если они у всех записей целые, не повторяются и укладываются в пачку
// (нумерация с 1, а если встретился 0, то с 0). Иначе сопоставляем по порядку.
export function recognizedItems(data, count) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : isRecord(data) && data.name ? [data] : [];
  const idx = rows.map((r) => (isRecord(r) && r.index !== null && r.index !== "" && r.index !== undefined ? Number(r.index) : NaN));
  const base = idx.includes(0) ? 0 : 1;
  const usable =
    idx.length > 0 && idx.every((i) => Number.isInteger(i) && i - base >= 0 && i - base < count) && new Set(idx).size === idx.length;
  const out = [];
  rows.forEach((raw, pos) => {
    const item = normalizeItem(raw);
    const target = usable ? idx[pos] - base : pos;
    if (item && target < count) out.push({ target, item });
  });
  return out;
}

// --- Вещи из фото образов -------------------------------------------------------------------------------

// Рамка [ymin, xmin, ymax, xmax] в координатах 0-1000. Модели иногда отдают доли (0-1): переводим.
// null, если рамка не годится для вырезки.
export function normalizeBox(v) {
  if (!Array.isArray(v) || v.length !== 4) return null;
  let b = v.map(Number);
  if (!b.every(Number.isFinite)) return null;
  if (b.every((x) => x >= 0 && x <= 1) && b.some((x) => x > 0)) b = b.map((x) => x * 1000);
  b = b.map((x) => Math.round(Math.min(1000, Math.max(0, x))));
  const [y0, x0, y1, x1] = b;
  return y1 - y0 >= 10 && x1 - x0 >= 10 ? b : null;
}

const area = ([y0, x0, y1, x1]) => (y1 - y0) * (x1 - x0);
function iou(a, b) {
  const y0 = Math.max(a[0], b[0]);
  const x0 = Math.max(a[1], b[1]);
  const y1 = Math.min(a[2], b[2]);
  const x1 = Math.min(a[3], b[3]);
  const inter = y1 > y0 && x1 > x0 ? (y1 - y0) * (x1 - x0) : 0;
  return inter / (area(a) + area(b) - inter || 1);
}

// Ответ задачи outfits: уникальные вещи из нескольких фото образов.
// Возвращает [{ item, photos, best, box, same_as }]: photos и best это номера фото с нуля, box рамка на фото best
// (или null), same_as метка уже имеющейся вещи («E3») из known или "".
// Номера фото модель даёт с 1; если среди них встречается 0, считаем, что с 0.
export function normalizeOutfits(data, { photoCount, known = new Set() }) {
  const rows = (Array.isArray(data) ? data : arr(data?.items)).filter(isRecord);
  const refs = rows
    .flatMap((r) => [...arr(r.photos), r.best?.photo])
    .map(Number)
    .filter(Number.isInteger);
  const base = refs.includes(0) ? 0 : 1;
  const photo = (v) => {
    const n = Number(isRecord(v) ? v.photo : v) - base;
    return Number.isInteger(n) && n >= 0 && n < photoCount ? n : null;
  };
  const out = [];
  for (const r of rows) {
    const item = normalizeItem(r);
    if (!item) continue;
    const photos = [
      ...new Set(
        arr(r.photos)
          .map(photo)
          .filter((n) => n !== null),
      ),
    ];
    let best = isRecord(r.best) ? photo(r.best.photo) : null;
    if (best === null) best = photos[0] ?? null;
    if (best !== null && !photos.includes(best)) photos.unshift(best);
    const box = best !== null && isRecord(r.best) ? normalizeBox(r.best.box_2d ?? r.best.box) : null;
    const same = text(r.same_as);
    const entry = { item, photos: photos.sort((a, b) => a - b), best, box, same_as: known.has(same) ? same : "" };
    // Модель иногда перечисляет одну вещь дважды: та же категория и почти та же рамка на том же фото.
    const twin = box && out.find((o) => o.box && o.best === best && o.item.category === item.category && iou(o.box, box) > 0.85);
    if (twin) twin.photos = [...new Set([...twin.photos, ...entry.photos])].sort((a, b) => a - b);
    else out.push(entry);
  }
  return out;
}

// Обратно в форму ответа модели (номера фото с 1): так сервер отдаёт результат, а браузер прогоняет его
// через тот же normalizeOutfits.
export const outfitsToWire = (entries) =>
  entries.map((e) => ({
    ...e.item,
    photos: e.photos.map((n) => n + 1),
    best: e.best === null ? null : { photo: e.best + 1, box_2d: e.box },
    same_as: e.same_as || null,
  }));

// Вещь для запроса к серверу: без картинки и служебных полей, тело запроса так в сотни раз меньше.
export const itemForServer = ({ image, recognized, source, ...w }) => w;
