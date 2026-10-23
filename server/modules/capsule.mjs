// Модуль «Капсула» на сервере: капсульный гардероб со списком покупок (задача capsule) и его бесплатная часть.
import { isRecord } from "../../public/js/lib/coerce.js";
import { normalizeCapsule } from "../../public/js/modules/capsule/schema.js";
import { BASE, str } from "../kit.mjs";
import { profileInputs, clientAnalysis, profileBrief } from "./profile.mjs";
import { wardrobeItems, wardrobeBrief } from "./wardrobe.mjs";

export const CAPSULE_SYSTEM = `${BASE}
Задача: собрать капсульный гардероб. Если у клиента есть вещи, сначала используй их, потом предложи, что докупить, чтобы всё легко сочеталось и давало максимум образов при минимуме вещей.
Принципы: единая цветовая палитра из цветов клиента (3-4 базовых, 1-2 акцентных), у каждой новой вещи есть минимум 3 пары в капсуле, нет вещей-одиночек.
Схема ответа:
{
  "concept": "идея капсулы в 2-3 предложениях",
  "palette": [{"name": "...", "hex": "#RRGGBB", "role": "база | акцент | нейтраль"}],
  "keep": [{"id": "id вещи из гардероба", "role": "какую задачу решает в капсуле"}],
  "drop": [{"id": "id вещи из гардероба", "reason": "почему в капсулу не вошла"}],
  "buy": [{
    "id": "b1, b2, ...",
    "name": "конкретное название вещи",
    "category": "top | bottom | dress | outerwear | shoes | bag | accessory | other",
    "color": "название цвета",
    "color_hex": "#RRGGBB",
    "description": "крой, длина, ткань, детали, что искать",
    "why": "что даёт капсуле",
    "pairs_with": ["id вещей из гардероба и из buy, с которыми носится"],
    "price_range": "ориентир цены в валюте клиента",
    "priority": "high | medium | low",
    "search_query": "поисковый запрос для магазина на русском, 3-6 слов"
  }],
  "looks": [{"name": "...", "occasion": "...", "refs": ["id из гардероба или buy"], "description": "..."}],
  "notes": "как расширять капсулу дальше и чего избегать при покупках"
}
Не включай в buy вещи, которые дублируют уже имеющиеся. Образов в капсуле дай 8-12. Общий размер капсулы (keep + buy) не больше запрошенного.`;

// Сколько покупок видно бесплатно.
export const FREE = { buy: 3 };

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

export const tasks = {
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
};
