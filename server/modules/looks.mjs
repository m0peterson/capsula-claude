// Модуль «Образы» на сервере: образы строго из вещей гардероба (задача looks) и их бесплатная часть.
import { normalizeLooks } from "../../public/js/modules/looks/schema.js";
import { BASE, InputError, str } from "../kit.mjs";
import { profileInputs, clientAnalysis, profileBrief } from "./profile.mjs";
import { wardrobeItems, wardrobeBrief } from "./wardrobe.mjs";

export const LOOKS_SYSTEM = `${BASE}
Задача: составить готовые образы СТРОГО из вещей, которые есть в гардеробе клиента. Нельзя придумывать вещи, которых нет в списке.
Опирайся на цветотип и фигуру клиента, если они переданы, и на пожелания.
Схема ответа:
{"looks": [{
  "name": "название образа",
  "occasion": "повод",
  "season": "сезон",
  "item_ids": ["id вещей из списка"],
  "description": "как выглядит образ целиком и почему он работает",
  "tips": "как носить: заправка, рукава, аксессуары, обувь",
  "missing": "чего одной вещи не хватает до идеала, или null"
}]}
Каждый образ должен содержать вещи минимум из 2 категорий и использовать только переданные id. Не повторяй один и тот же образ с заменой одной вещи.`;

// Сколько образов видно бесплатно.
export const FREE = { looks: 2 };

export const tasks = {
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
};
