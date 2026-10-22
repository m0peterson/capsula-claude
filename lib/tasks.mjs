// Задачи стилиста на сервере. Клиент присылает только данные (фото, анкету, гардероб), а промпт, модель
// и то, какая часть результата достаётся бесплатно, решает сервер.
//
// У каждой задачи:
//   slot      какая модель работает: vision (получает фото) или text
//   pro       только для Pro
//   validate  приводит вход к безопасной форме или бросает понятную ошибку (её текст увидит пользователь)
//   prompt    собирает запрос к модели
//   finish    приводит ответ модели к форме, с которой работает интерфейс
//   teaser    что видно бесплатно: { data, locked }, где locked это сколько и чего скрыто
import {
  ANALYSIS_SYSTEM,
  WARDROBE_SYSTEM,
  LOOKS_SYSTEM,
  CAPSULE_SYSTEM,
  SEARCH_SYSTEM,
  SEASONS,
  profileBrief,
  wardrobeBrief,
} from "./prompts.mjs";
import {
  normalizeAnalysis,
  normalizeLooks,
  normalizeCapsule,
  normalizeSearch,
  recognizedItems,
  text,
  list,
  CATEGORY_KEYS,
} from "../public/js/normalize.js";
import { arr, isRecord, safeImage, safeUrl } from "../public/js/util.js";

export class InputError extends Error {}

const str = (v, max) => text(v).slice(0, max);

// Фото приходят data URL от клиента (он сжимает их до 1024 px). Каждое не больше 2 МБ.
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;
function images(v, { min, max, what }) {
  const list = arr(v);
  if (list.length < min) throw new InputError(`Добавьте ${what}.`);
  if (list.length > max) throw new InputError(`За один раз можно отправить не больше ${max} фото.`);
  return list.map((u) => {
    const ok = safeImage(u);
    if (!ok) throw new InputError("Фото повреждено или в неподдерживаемом формате. Поддерживаются JPG, PNG, WebP.");
    if (ok.length > MAX_IMAGE_CHARS) throw new InputError("Фото слишком большое.");
    return ok;
  });
}

const INPUT_KEYS = { gender: "Пол", age: "Возраст", height: "Рост, см", size: "Размер одежды", city: "Город или климат", budget: "Бюджет" };

function profileInputs(v) {
  const src = isRecord(v) ? v : {};
  const out = {};
  for (const k of Object.keys(INPUT_KEYS)) if (str(src[k], 80)) out[k] = str(src[k], 80);
  return out;
}

// Анализ из браузера: полный (Pro) или урезанный. Это лишь подсказка для промпта, поэтому кривой просто отбрасываем.
function clientAnalysis(v) {
  if (!isRecord(v)) return null;
  try {
    return normalizeAnalysis(v);
  } catch {
    return null;
  }
}

const MAX_WARDROBE = 200;
function wardrobeItems(v) {
  return arr(v)
    .filter(isRecord)
    .slice(0, MAX_WARDROBE)
    .map((w) => ({
      id: str(w.id, 40),
      name: str(w.name, 120) || "Вещь",
      category: CATEGORY_KEYS.includes(text(w.category)) ? text(w.category) : "other",
      color: str(w.color, 60),
      color_hex: /^#[0-9a-f]{3,8}$/i.test(text(w.color_hex)) ? text(w.color_hex) : "",
      material: str(w.material, 60),
      style: str(w.style, 60),
      seasons: list(w.seasons)
        .slice(0, 4)
        .map((s) => s.slice(0, 20)),
      formality: Number.isFinite(Number(w.formality)) && w.formality !== null && w.formality !== "" ? Number(w.formality) : null,
      notes: str(w.notes, 200),
    }))
    .filter((w) => w.id);
}

// Название сезона из ответа модели к одному из 12 канонических: «Мягкая осень (Soft Autumn)» → «Мягкая осень».
const SEASON_ALIASES = {
  "глубокая осень": "Тёмная осень",
  "глубокая зима": "Тёмная зима",
  "чистая весна": "Яркая весна",
  "чистая зима": "Яркая зима",
};
// Если названий несколько («Мягкая осень, ближе к тёплой осени»), берём упомянутое первым.
export function canonicalSeason(s) {
  const norm = (x) => x.toLowerCase().replace(/ё/g, "е");
  const low = norm(text(s));
  let best = null;
  for (const [variant, name] of [...SEASONS.map((n) => [n, n]), ...Object.entries(SEASON_ALIASES)]) {
    const at = low.indexOf(norm(variant));
    if (at >= 0 && (!best || at < best.at)) best = { at, name };
  }
  return best ? best.name : text(s);
}

// Сколько видно бесплатно.
export const FREE = { colors: 4, styles: 1, looks: 2, buy: 3 };

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

export const TASKS = {
  analysis: {
    slot: "vision",
    validate(input) {
      return {
        photos: images(input.photos, { min: 1, max: 3, what: "хотя бы одно фото" }),
        inputs: profileInputs(input.inputs),
        wishes: str(input.wishes, 1000),
      };
    },
    prompt(c) {
      const form = Object.entries(c.inputs)
        .map(([k, v]) => `${INPUT_KEYS[k]}: ${v}`)
        .join("\n");
      return {
        system: ANALYSIS_SYSTEM,
        user: `Анкета клиента:\n${form || "не заполнена"}\n\nПожелания по стилю: ${c.wishes || "нет"}\n\nФото клиента во вложении (${c.photos.length} шт.).`,
        images: c.photos,
        expect: ["color_type", "body"],
        temperature: 0, // цветотип не должен меняться от повторного запуска на тех же фото
      };
    },
    finish(data) {
      const a = normalizeAnalysis(data);
      a.color_type.season = canonicalSeason(a.color_type.season);
      a.color_type.neighbor_season = canonicalSeason(a.color_type.neighbor_season);
      if (a.color_type.neighbor_season === a.color_type.season) a.color_type.neighbor_season = "";
      return a;
    },
    teaser(a) {
      const c = a.color_type;
      const b = a.body;
      // Фигуру по фото определить не удалось: не продаём пустоту. Показываем как есть, там написано, какое фото нужно.
      const bodyOpen = b.confidence === "low";
      const locked = {
        best_colors: Math.max(0, c.best_colors.length - FREE.colors),
        neutrals: c.neutrals.length,
        avoid_colors: c.avoid_colors.length,
        metals: Boolean(c.metals),
        body: !bodyOpen && Boolean(b.proportions || b.goals.length || b.notes),
        styles: Math.max(0, a.styles.length - FREE.styles),
        silhouettes: a.silhouettes.length,
        fabrics_prints: Boolean(a.fabrics_prints),
        // В итоге модель пересказывает палитру, металлы и чего избегать: в открытой части он раскрыл бы закрытое.
        summary: Boolean(a.summary),
      };
      const data = {
        color_type: { ...c, best_colors: c.best_colors.slice(0, FREE.colors), neutrals: [], avoid_colors: [], metals: "" },
        body: bodyOpen ? b : { ...b, proportions: "", goals: [], notes: "" },
        styles: a.styles.slice(0, FREE.styles),
        silhouettes: [],
        fabrics_prints: "",
        summary: "",
      };
      // Если в урезанной версии не осталось ничего, что можно показать, отдаём один силуэт: пустой экран хуже.
      if (!c.season && !data.color_type.best_colors.length && !b.figure_type && !data.styles.length && a.silhouettes.length) {
        data.silhouettes = a.silhouettes.slice(0, 1);
        locked.silhouettes--;
      }
      return { data, locked };
    },
  },

  wardrobe: {
    slot: "vision",
    validate(input) {
      return { photos: images(input.photos, { min: 1, max: 6, what: "фото вещей" }) };
    },
    prompt(c) {
      return {
        system: WARDROBE_SYSTEM,
        user: `Распознай вещи на ${c.photos.length} фото. Фото идут по порядку, начиная с 1.`,
        images: c.photos,
        expect: ["items"],
        temperature: 0,
      };
    },
    finish(data, c) {
      const items = recognizedItems(data, c.photos.length);
      if (!items.length) throw new Error("Модель не вернула ни одной распознанной вещи. Попробуйте ещё раз.");
      return { items };
    },
  },

  looks: {
    slot: "text",
    validate(input) {
      const wardrobe = wardrobeItems(input.wardrobe);
      if (wardrobe.length < 2) throw new InputError("Для образов нужно хотя бы 2-3 вещи в гардеробе.");
      const count = Math.min(12, Math.max(3, Math.floor(Number(input.count)) || 6));
      return {
        profile: { inputs: profileInputs(input.profile?.inputs), analysis: clientAnalysis(input.profile?.analysis) },
        wardrobe,
        wishes: str(input.wishes, 1000),
        count,
      };
    },
    prompt(c) {
      return {
        system: LOOKS_SYSTEM,
        user: `Клиент:\n${profileBrief(c.profile)}\n\nГардероб (id: описание):\n${wardrobeBrief(c.wardrobe)}\n\nПожелания: ${c.wishes || "нет"}\n\nСоставь ${c.count} образов.`,
        expect: ["looks"],
      };
    },
    finish(data, c) {
      const looks = normalizeLooks(data, new Set(c.wardrobe.map((w) => w.id)));
      if (!looks.length) throw new Error("Модель не вернула ни одного образа из ваших вещей. Попробуйте ещё раз.");
      return { looks };
    },
    teaser(r) {
      return { data: { looks: r.looks.slice(0, FREE.looks) }, locked: { looks: Math.max(0, r.looks.length - FREE.looks) } };
    },
  },

  capsule: {
    slot: "text",
    validate(input) {
      const o = isRecord(input.options) ? input.options : {};
      const size = Math.min(40, Math.max(6, Math.floor(Number(o.size)) || 15));
      return {
        profile: { inputs: profileInputs(input.profile?.inputs), analysis: clientAnalysis(input.profile?.analysis) },
        wardrobe: input.useWardrobe === false ? [] : wardrobeItems(input.wardrobe),
        options: { size, season: str(o.season, 40) || "Круглый год", budget: str(o.budget, 60) },
        wishes: str(input.wishes, 1000),
      };
    },
    prompt(c) {
      const o = c.options;
      return {
        system: CAPSULE_SYSTEM,
        user: `Клиент:\n${profileBrief(c.profile)}\n\nГардероб клиента (id: описание):\n${c.wardrobe.length ? wardrobeBrief(c.wardrobe) : "Не используем, собираем капсулу с нуля."}\n\nЗапрос:\n- размер капсулы: до ${o.size} вещей\n- сезон: ${o.season}\n- бюджет на докупку: ${o.budget || "не ограничен"}\n- пожелания: ${c.wishes || "нет"}`,
        expect: ["buy", "keep", "concept"],
      };
    },
    finish(data, c) {
      return normalizeCapsule(data, new Set(c.wardrobe.map((w) => w.id)));
    },
    teaser(cap) {
      // Бесплатно видно самое важное из списка покупок: сначала вещи с высоким приоритетом.
      const order = cap.buy
        .map((b, i) => ({ b, i }))
        .sort((x, y) => PRIORITY_ORDER[x.b.priority] - PRIORITY_ORDER[y.b.priority] || x.i - y.i);
      const shown = new Set(order.slice(0, FREE.buy).map((x) => x.b.id));
      return {
        data: {
          concept: cap.concept,
          palette: cap.palette,
          keep: cap.keep,
          drop: [],
          buy: cap.buy.filter((b) => shown.has(b.id)),
          looks: [],
          notes: "",
        },
        locked: { buy: cap.buy.length - shown.size, looks: cap.looks.length, drop: cap.drop.length, notes: Boolean(cap.notes) },
      };
    },
  },

  search: {
    slot: "text",
    pro: true,
    webSearch: true,
    validate(input) {
      const query = str(input.query, 200);
      if (!query) throw new InputError("Введите запрос.");
      const item = isRecord(input.item) ? input.item : {};
      return {
        query,
        description: str(item.description, 500),
        color: str(item.color, 60),
        price: str(item.price_range, 60),
        palette: list(input.palette)
          .slice(0, 12)
          .map((x) => x.slice(0, 40)),
        budget: str(input.budget, 60),
        city: str(input.city, 80),
      };
    },
    prompt(c) {
      return {
        system: SEARCH_SYSTEM,
        user: `Запрос: ${c.query}\n${c.description ? `Описание вещи: ${c.description}\n` : ""}${c.color ? `Цвет: ${c.color}\n` : ""}Цвета клиента: ${c.palette.join(", ") || "не определены"}\nБюджет: ${c.price || c.budget || "не указан"}\nРегион и магазины: ${c.city || "Россия"}, нужны магазины с доставкой туда.`,
        expect: ["results"],
        extra: { plugins: [{ id: "web", max_results: 5 }] },
      };
    },
    finish(data, c, { annotations }) {
      let results = normalizeSearch(data);
      const key = (u) => {
        const href = safeUrl(u);
        if (!href) return "";
        const x = new URL(href);
        return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "");
      };
      const cited = new Set(
        arr(annotations)
          .filter(isRecord)
          .map((a) => key(a.url_citation?.url || a.url))
          .filter(Boolean),
      );
      // Если источники известны, оставляем только ссылки из реальной выдачи поиска.
      // Если после фильтра ничего не осталось, показываем всё, но помечаем как непроверенное.
      const confirmed = results.filter((r) => cited.has(key(r.url)));
      const verified = confirmed.length > 0;
      if (verified) results = confirmed;
      return { results, verified };
    },
  },
};

// Урезанная версия результата для бесплатного плана. Если скрывать нечего, locked = null.
export function teaserOf(task, full) {
  const t = TASKS[task];
  if (!t.teaser) return { data: full, locked: null };
  const { data, locked } = t.teaser(full);
  const hidden = Object.values(locked).some((v) => (typeof v === "number" ? v > 0 : Boolean(v)));
  return hidden ? { data, locked } : { data: full, locked: null };
}
