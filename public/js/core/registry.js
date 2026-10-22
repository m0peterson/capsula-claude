// Запуск модулей: проверка списка, загрузка настроек и данных, init(). DOM не трогает.
import { loadSettings } from "./settings.js";
import { load, startPersistence, resetStoreForTests } from "./store.js";
import { clearEvents } from "./events.js";

let started = [];

export const modules = () => started;

export function validate(list) {
  const seen = new Set();
  for (const m of list) {
    if (seen.has(m.id)) throw new Error(`Модуль «${m.id}» указан дважды`);
    for (const r of m.requires) if (!seen.has(r)) throw new Error(`Модуль «${m.id}» требует «${r}», а тот не указан раньше в modules.js`);
    seen.add(m.id);
  }
}

export async function start(list) {
  validate(list);
  started = list;
  loadSettings();
  await load(list.filter((m) => m.slice).map((m) => m.id));
  startPersistence();
  for (const m of list) m.init?.();
  const routes = list
    .filter((m) => m.route)
    .map((m) => ({ id: m.id, ...m.route }))
    .sort((a, b) => a.order - b.order);
  return { routes };
}

export function resetForTests() {
  started = [];
  resetStoreForTests();
  clearEvents();
}
