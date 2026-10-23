// Модуль «Гардероб» на сервере: распознавание вещей по одной (задача wardrobe), вещи из фото образов
// (задача outfits), гардероб в промпте других модулей (wardrobeItems, wardrobeBrief).
import { arr, isRecord, records, text, list } from "../../public/js/lib/coerce.js";
import { CATEGORY_KEYS } from "../../public/js/shared/catalog.js";
import { recognizedItems, normalizeOutfits, outfitsToWire } from "../../public/js/modules/wardrobe/schema.js";
import { BASE, str, images } from "../kit.mjs";

export const WARDROBE_SYSTEM = `${BASE}
Задача: распознать вещи гардероба по фото. Фото пронумерованы с 1. На каждом фото одна вещь, но если их несколько, опиши главную.
Схема ответа:
{"items": [{
  "index": номер фото,
  "name": "короткое название, например «Бежевый тренч прямого кроя»",
  "category": "top | bottom | dress | outerwear | shoes | bag | accessory | other",
  "color": "название цвета",
  "color_hex": "#RRGGBB",
  "material": "предположительная ткань или null",
  "style": "кэжуал | классика | спорт | вечерний | и т.п.",
  "seasons": ["зима", "весна", "лето", "осень"],
  "formality": число от 1 (домашнее) до 5 (вечернее),
  "notes": "крой, детали, принт"
}]}`;

const MAX_WARDROBE = 200;
export function wardrobeItems(v) {
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

export const OUTFITS_SYSTEM = `${BASE}
Задача: разобрать гардероб клиента по его фото в образах. Фото пронумерованы с 1, на всех один и тот же человек.
Найди все вещи одежды и обуви, сумки и заметные аксессуары (головной убор, шарф, ремень, очки), которые на нём надеты или у него в руках. Телефон, мелкие украшения и вещи других людей не включай.
Одна и та же вещь часто встречается на нескольких фото (те же джинсы, та же сумка): это ОДНА вещь, перечисли её один раз и укажи все фото, где она есть. Разный свет, поза и ракурс не делают вещи разными. Похожие, но разные вещи (другой оттенок, крой, длина, фактура, детали) это разные вещи.
Если передан список вещей, которые уже есть в гардеробе, и таблица их миниатюр с метками E1, E2, ..., сверяйся с ними: если найденная вещь та же самая, что уже есть, укажи её метку в same_as, иначе null. Не придумывай метки, которых нет в списке.
Для каждой вещи выбери фото, где она видна лучше всего (целиком, крупно, не загорожена), и дай рамку на нём.
Схема ответа:
{"items": [{
  "name": "короткое название, например «Бежевый тренч прямого кроя»",
  "category": "top | bottom | dress | outerwear | shoes | bag | accessory | other",
  "color": "название цвета",
  "color_hex": "#RRGGBB",
  "material": "предположительная ткань или null",
  "style": "кэжуал | классика | спорт | вечерний | и т.п.",
  "seasons": ["зима", "весна", "лето", "осень"],
  "formality": число от 1 (домашнее) до 5 (вечернее),
  "notes": "крой, детали, принт",
  "photos": [номера фото, где видна вещь],
  "best": {"photo": номер лучшего фото, "box_2d": [ymin, xmin, ymax, xmax]},
  "same_as": "метка E... из списка или null"
}]}
box_2d: рамка вещи на этом фото в координатах 0-1000 относительно его размера (0,0 левый верхний угол), плотно вокруг вещи. Пара обуви это одна вещь, рамка вокруг обеих.`;

// Имеющиеся вещи для сверки: метка E<n>, название, категория, цвет. Картинки к ним идут таблицами миниатюр.
const MAX_KNOWN = 150;
function knownItems(v) {
  return records(v)
    .slice(0, MAX_KNOWN)
    .map((k) => ({
      ref: /^E\d{1,3}$/.test(text(k.ref)) ? text(k.ref) : "",
      name: str(k.name, 120) || "Вещь",
      category: CATEGORY_KEYS.includes(text(k.category)) ? text(k.category) : "other",
      color: str(k.color, 60),
    }))
    .filter((k) => k.ref);
}

export function wardrobeBrief(items) {
  const rows = arr(items).filter(isRecord);
  if (!rows.length) return "Гардероб пуст.";
  return rows
    .map(
      (w) =>
        `${text(w.id)}: ${text(w.name)} | ${text(w.category)} | ${text(w.color) || "?"} ${text(w.color_hex)} | ${text(w.material) || "-"} | ${text(w.style) || "-"} | сезоны: ${list(w.seasons).join(",") || "-"} | формальность ${w.formality ?? "-"} | ${text(w.notes)}`,
    )
    .join("\n");
}

export const tasks = {
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

  outfits: {
    slot: "detect",
    validate(input) {
      return {
        photos: images(input.photos, { min: 1, max: 10, what: "хотя бы одно фото образа" }),
        known: knownItems(input.known),
        sheets: images(input.sheets ?? [], { min: 0, max: 3, what: "" }),
      };
    },
    prompt(c) {
      const known = c.known.length
        ? `\n\nУже есть в гардеробе (метка: описание):\n${c.known.map((k) => `${k.ref}: ${k.name} | ${k.category} | ${k.color || "?"}`).join("\n")}${c.sheets.length ? "\nМиниатюры этих вещей в таблицах после фото образов, метка написана в углу клетки." : ""}`
        : "";
      return {
        system: OUTFITS_SYSTEM,
        user: `Фото образов: ${c.photos.length}, по порядку, начиная с 1.${known}`,
        images: [
          ...c.photos.map((url, i) => ({ label: `Фото ${i + 1}:`, url })),
          ...c.sheets.map((url, i) => ({ label: `Таблица миниатюр ${i + 1}:`, url })),
        ],
        expect: ["items"],
        temperature: 0,
      };
    },
    finish(data, c) {
      const items = normalizeOutfits(data, { photoCount: c.photos.length, known: new Set(c.known.map((k) => k.ref)) });
      if (!items.length) throw new Error("На фото не нашлось ни одной вещи. Нужны фото, где одежда видна целиком.");
      return { items: outfitsToWire(items) };
    },
  },
};
