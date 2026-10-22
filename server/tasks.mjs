// Задачи стилиста на сервере. Клиент присылает только данные (фото, анкету, гардероб), а промпт, модель
// и то, какая часть результата достаётся бесплатно, решает сервер. Каждая задача живёт в модуле
// server/modules/<id>.mjs рядом с промптом; здесь только их список.
//
// У каждой задачи:
//   slot      какая модель работает: vision (фото), detect (вещи на фото образов, рамки) или text
//   pro       только для Pro
//   webSearch нужен веб-поиск провайдера
//   validate  приводит вход к безопасной форме или бросает InputError (её текст увидит пользователь)
//   prompt    собирает запрос к модели: { system, user, images, expect, temperature?, extra? }
//   finish    приводит ответ модели к форме, с которой работает интерфейс
//   teaser    что видно бесплатно: { data, locked }, где locked это сколько и чего скрыто
import * as profile from "./modules/profile.mjs";
import * as wardrobe from "./modules/wardrobe.mjs";
import * as looks from "./modules/looks.mjs";
import * as capsule from "./modules/capsule.mjs";
import * as search from "./modules/search.mjs";

export { InputError } from "./kit.mjs";

const MODULES = { profile, wardrobe, looks, capsule, search };

export const TASKS = {};
for (const [id, m] of Object.entries(MODULES)) {
  for (const [name, task] of Object.entries(m.tasks)) {
    if (TASKS[name]) throw new Error(`Задача «${name}» объявлена дважды (модуль ${id})`);
    TASKS[name] = task;
  }
}

// Задачи с бесплатной частью: их конверты вскрывает /api/unlock.
export const LOCKABLE = Object.keys(TASKS).filter((t) => TASKS[t].teaser);

// Урезанная версия результата для бесплатного плана. Если скрывать нечего, locked = null.
export function teaserOf(task, full) {
  const t = TASKS[task];
  if (!t.teaser) return { data: full, locked: null };
  const { data, locked } = t.teaser(full);
  const hidden = Object.values(locked).some((v) => (typeof v === "number" ? v > 0 : Boolean(v)));
  return hidden ? { data, locked } : { data: full, locked: null };
}
