// Приведение ответов модели к форме, с которой работает интерфейс.
// Модель может вернуть строку вместо списка, null внутри массива, число вместо текста. Всё это отсекается здесь,
// до сохранения в state: иначе один кривой ответ ломает вкладку и после перезагрузки.
import { arr, isRecord } from "./util.js";

export const CATEGORY_KEYS = ["top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "other"];
const PRIORITIES = ["high", "medium", "low"];
const HEX_IN_TEXT = /#[0-9a-f]{3,8}\b/i;

export function text(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  // Массив строк вместо строки (например, «ткани» списком): не стираем, склеиваем.
  if (Array.isArray(v)) {
    // «;» между предложениями даёт «.;», поэтому после знака конца предложения склеиваем пробелом.
    return v
      .map(text)
      .filter(Boolean)
      .reduce((acc, x) => (acc ? acc + (/[.!?…]$/.test(acc) ? " " : "; ") + x : x), "");
  }
  return "";
}

// hex только если он настоящий: выдуманный серый в промпты и данные не пишем.
const validHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(text(h)) ? text(h) : "");

export const records = (v) => arr(v).filter(isRecord);

// Список строк: массив строк, либо строка через «;» или перенос строки.
export function list(v) {
  if (Array.isArray(v)) return v.map(text).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

// Список id: строки или объекты вида {id} / {ref}.
function ids(v) {
  return arr(v)
    .map((x) => (isRecord(x) ? text(x.id) || text(x.ref) : text(x)))
    .filter(Boolean);
}

export function colors(v) {
  return arr(v)
    .map((c) => {
      if (isRecord(c)) {
        const hex = text(c.hex) || text(c.color_hex);
        const name = text(c.name) || text(c.color) || hex;
        return name ? { name, hex: validHex(hex), role: text(c.role) } : null;
      }
      const s = typeof c === "string" ? c.trim() : "";
      if (!s) return null;
      const m = s.match(HEX_IN_TEXT);
      const name = s
        .replace(HEX_IN_TEXT, "")
        .replace(/[()\s]+$/, "")
        .trim();
      return { name: name || s, hex: validHex(m?.[0]), role: "" };
    })
    .filter(Boolean);
}

const incomplete = (what) => new Error(`Модель вернула неполный результат: ${what}. Попробуйте ещё раз или смените модель.`);

export function normalizeAnalysis(data) {
  if (!isRecord(data)) throw incomplete("нет анализа");
  const c = typeof data.color_type === "string" ? { season: data.color_type } : data.color_type;
  const b = typeof data.body === "string" ? { figure_type: data.body } : data.body;
  if (!isRecord(c) || !isRecord(b)) throw incomplete("нет цветотипа или фигуры");

  const color_type = {
    season: text(c.season),
    undertone: text(c.undertone),
    contrast: text(c.contrast),
    confidence: text(c.confidence).toLowerCase(),
    reasoning: text(c.reasoning),
    best_colors: colors(c.best_colors),
    neutrals: colors(c.neutrals),
    avoid_colors: colors(c.avoid_colors),
    metals: text(c.metals),
  };
  const h = Number(b.height_cm);
  const result = {
    color_type,
    body: {
      height_cm: Number.isFinite(h) && h > 80 && h < 250 ? Math.round(h) : null,
      height_category: text(b.height_category),
      figure_type: text(b.figure_type),
      proportions: text(b.proportions),
      goals: list(b.goals),
      confidence: text(b.confidence).toLowerCase(),
      notes: text(b.notes),
    },
    styles: arr(data.styles)
      .map((s) => (isRecord(s) ? s : typeof s === "string" ? { name: s } : null))
      .filter(Boolean)
      .map((s) => ({ name: text(s.name), description: text(s.description), why: text(s.why) }))
      .filter((s) => s.name || s.description),
    silhouettes: arr(data.silhouettes)
      .map((s) => (isRecord(s) ? s : typeof s === "string" ? { recommend: s } : null))
      .filter(Boolean)
      .map((s) => ({ zone: text(s.zone), recommend: text(s.recommend), avoid: text(s.avoid) }))
      .filter((s) => s.zone || s.recommend),
    fabrics_prints: text(data.fabrics_prints),
    summary: text(data.summary),
  };
  // Отклоняем, только если в ответе нет вообще ничего полезного. Пустой цветотип при остальном содержимом это не повод всё выбросить.
  const useful =
    result.color_type.season ||
    result.color_type.best_colors.length ||
    result.body.figure_type ||
    result.body.proportions ||
    result.styles.length ||
    result.silhouettes.length;
  if (!useful) throw incomplete("в анализе нет ни цветотипа, ни фигуры, ни стилей, ни силуэтов");
  return result;
}

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

export function normalizeLooks(data, validIds) {
  return records(data?.looks)
    .map((l) => ({
      name: text(l.name) || "Образ",
      occasion: text(l.occasion),
      season: text(l.season),
      item_ids: [...new Set(ids(l.item_ids).filter((id) => validIds.has(id)))],
      description: text(l.description),
      tips: text(l.tips),
      missing: text(l.missing),
    }))
    .filter((l) => l.item_ids.length >= 2);
}

// keep ждёт role, drop ждёт reason: модель может перепутать, поэтому сохраняем оба поля одним текстом.
function idRoles(v, validIds) {
  return arr(v)
    .map((x) => {
      if (!isRecord(x)) return { id: text(x), role: "", reason: "" };
      const why = text(x.role) || text(x.reason);
      return { id: text(x.id), role: why, reason: text(x.reason) || why };
    })
    .filter((x) => validIds.has(x.id));
}

export function normalizeCapsule(data, validIds) {
  if (!isRecord(data)) throw incomplete("нет капсулы");
  const taken = new Set();
  const buy = records(data.buy)
    .map((b) => ({ ...b, name: text(b.name) }))
    .filter((b) => b.name)
    .map((b, i) => {
      let id = text(b.id);
      if (!id || taken.has(id) || validIds.has(id)) id = `b${i + 1}`;
      while (taken.has(id) || validIds.has(id)) id += "x";
      taken.add(id);
      const category = text(b.category).toLowerCase();
      const priority = text(b.priority).toLowerCase();
      return {
        id,
        name: b.name.slice(0, 160),
        category: CATEGORY_KEYS.includes(category) ? category : "other",
        color: text(b.color),
        color_hex: validHex(b.color_hex),
        description: text(b.description),
        why: text(b.why),
        pairs_with: ids(b.pairs_with),
        price_range: text(b.price_range),
        priority: PRIORITIES.includes(priority) ? priority : "medium",
        search_query: text(b.search_query) || b.name,
      };
    });
  const keep = idRoles(data.keep, validIds);
  if (!buy.length && !keep.length) throw incomplete("в капсуле нет ни вещей из гардероба, ни покупок");

  return {
    concept: text(data.concept),
    palette: colors(data.palette),
    keep,
    drop: idRoles(data.drop, validIds),
    buy,
    looks: records(data.looks)
      .map((l) => ({
        name: text(l.name) || "Образ",
        occasion: text(l.occasion),
        refs: ids(l.refs ?? l.items),
        description: text(l.description),
      }))
      .filter((l) => l.refs.length),
    notes: text(data.notes),
  };
}

export function normalizeSearch(data) {
  return records(Array.isArray(data) ? data : data?.results)
    .map((r) => ({ title: text(r.title) || text(r.name), shop: text(r.shop), url: text(r.url), price: text(r.price), why: text(r.why) }))
    .filter((r) => r.url);
}
