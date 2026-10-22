// Модуль «Профиль» на сервере: анализ клиента по фото и анкете (задача analysis), бесплатная часть анализа,
// краткая сводка профиля для промптов других модулей (profileBrief).
import { isRecord, text } from "../../public/js/lib/coerce.js";
import { normalizeAnalysis } from "../../public/js/modules/profile/schema.js";
import { BASE, str, images } from "../kit.mjs";

// 12 сезонов. Модель выбирает строго из списка: иначе одна и та же внешность получает то «Тёмную», то «Глубокую» осень.
export const SEASONS = [
  "Светлая весна",
  "Тёплая весна",
  "Яркая весна",
  "Светлое лето",
  "Холодное лето",
  "Мягкое лето",
  "Мягкая осень",
  "Тёплая осень",
  "Тёмная осень",
  "Тёмная зима",
  "Холодная зима",
  "Яркая зима",
];

export const ANALYSIS_SYSTEM = `${BASE}
Задача: анализ клиента по фото и анкете.
Схема ответа:
{
  "color_type": {
    "season": "строго одно название из списка: ${SEASONS.join(", ")}",
    "neighbor_season": "второй по близости сезон из того же списка: внешность на границе двух сезонов встречается часто",
    "undertone": "тёплый | холодный | нейтральный",
    "contrast": "низкий | средний | высокий",
    "confidence": "low | medium | high",
    "reasoning": "на чём основан вывод: кожа, волосы, глаза, контраст",
    "best_colors": [{"name": "название цвета", "hex": "#RRGGBB"}],
    "neutrals": [{"name": "...", "hex": "#RRGGBB"}],
    "avoid_colors": [{"name": "...", "hex": "#RRGGBB"}],
    "metals": "золото | серебро | розовое золото | комбинировать, с пояснением"
  },
  "body": {
    "height_cm": число или null,
    "height_category": "невысокий | средний | высокий",
    "figure_type": "тип фигуры словами: песочные часы, прямоугольник, груша, перевёрнутый треугольник, яблоко и т.п.",
    "proportions": "описание пропорций: плечи, талия, бёдра, длина ног, торс",
    "goals": ["что визуально сбалансировать или подчеркнуть"],
    "confidence": "low | medium | high",
    "notes": "что мешает точной оценке"
  },
  "styles": [{"name": "направление", "description": "как выглядит", "why": "почему подходит клиенту"}],
  "silhouettes": [{"zone": "Верх | Низ | Платья и комбинезоны | Верхняя одежда | Обувь | Аксессуары", "recommend": "какие силуэты, длины, вырезы, ткани и почему", "avoid": "чего избегать и почему"}],
  "fabrics_prints": "ткани, фактуры, принты и масштаб рисунка",
  "summary": "итог на 3-5 предложений: как одеваться, чтобы выглядеть лучше"
}
Сезон определяй по трём осям: подтон (тёплый или холодный), светлота (светлая или глубокая внешность), чистота (яркая или приглушённая). Название сезона берётся по ведущей оси.
Смотри только на кожу, волосы (у корней, если они окрашены), глаза и брови. Цвет одежды, макияжа, фона и тёплый или холодный свет лампы это не признаки внешности: не опирайся на них, а если они искажают картину, понижай confidence и скажи об этом в reasoning.
В best_colors дай 8-10 цветов, самые выигрышные первыми. В neutrals 4-5, в avoid_colors 4-5. Стилей 3, лучший первым.`;

export const INPUT_KEYS = {
  gender: "Пол",
  age: "Возраст",
  height: "Рост, см",
  size: "Размер одежды",
  city: "Город или климат",
  budget: "Бюджет",
};

export function profileInputs(v) {
  const src = isRecord(v) ? v : {};
  const out = {};
  for (const k of Object.keys(INPUT_KEYS)) if (str(src[k], 80)) out[k] = str(src[k], 80);
  return out;
}

// Анализ из браузера: полный (Pro) или урезанный. Это лишь подсказка для промпта, поэтому кривой просто отбрасываем.
export function clientAnalysis(v) {
  if (!isRecord(v)) return null;
  try {
    return normalizeAnalysis(v);
  } catch {
    return null;
  }
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
export const FREE = { colors: 4, styles: 1 };

// profile: { inputs, analysis }. Анализ может быть полным или урезанным (бесплатный план): берём то, что есть.
export function profileBrief(profile) {
  const inputs = isRecord(profile?.inputs) ? profile.inputs : {};
  const lines = [];
  const map = { gender: "Пол", age: "Возраст", height: "Рост, см", size: "Размер одежды", city: "Город или климат", budget: "Бюджет" };
  for (const [k, label] of Object.entries(map)) if (text(inputs[k])) lines.push(`${label}: ${text(inputs[k])}`);

  // Повторная нормализация защищает от данных старой версии, сохранённых в кривой форме.
  let analysis = null;
  try {
    if (profile?.analysis) analysis = normalizeAnalysis(profile.analysis);
  } catch {
    /* повреждённый анализ не учитываем */
  }
  if (analysis) {
    const c = analysis.color_type;
    const b = analysis.body;
    const named = (x) => (x.hex ? `${x.name} ${x.hex}` : x.name);
    lines.push(`Цветотип: ${c.season || "?"} (${c.undertone || "?"}, контраст ${c.contrast || "?"})`);
    if (c.best_colors.length) lines.push(`Лучшие цвета: ${c.best_colors.map(named).join(", ")}`);
    if (c.neutrals.length) lines.push(`Нейтральные: ${c.neutrals.map(named).join(", ")}`);
    if (c.avoid_colors.length) lines.push(`Избегать: ${c.avoid_colors.map((x) => x.name).join(", ")}`);
    if (b.figure_type || b.proportions) lines.push(`Фигура: ${b.figure_type || "?"}; ${b.proportions}; цели: ${b.goals.join("; ")}`);
    if (analysis.styles.length) lines.push(`Подходящие стили: ${analysis.styles.map((x) => x.name).join(", ")}`);
    for (const x of analysis.silhouettes) lines.push(`Силуэты (${x.zone}): ${x.recommend}. Избегать: ${x.avoid}`);
  }
  return lines.join("\n") || "Данных о клиенте нет.";
}

export const tasks = {
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
};
