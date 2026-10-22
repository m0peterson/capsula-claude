// Словарь предметной области, который нужен нескольким модулям и серверу. Один список вместо двух копий.

export const CATEGORIES = {
  top: "Верх",
  bottom: "Низ",
  dress: "Платья",
  outerwear: "Верхняя одежда",
  shoes: "Обувь",
  bag: "Сумки",
  accessory: "Аксессуары",
  other: "Другое",
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export const catLabel = (c) => CATEGORIES[c] || CATEGORIES.other;

export const PRIORITIES = ["high", "medium", "low"];

export const PRIORITY = { high: "Купить первым", medium: "Желательно", low: "Позже" };

// Ошибка «модель вернула неполный результат»: её текст видит пользователь.
export const incomplete = (what) => new Error(`Модель вернула неполный результат: ${what}. Попробуйте ещё раз или смените модель.`);
