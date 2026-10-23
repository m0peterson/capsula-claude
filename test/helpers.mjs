// Запуск модулей в Node на хранилище в памяти: так тесты проверяют загрузку, миграцию и импорт как в браузере.
import { start, resetForTests } from "../public/js/core/registry.js";
import { useBackend, memoryBackend, importBackup } from "../public/js/core/store.js";
import modules from "../public/js/modules.js";

export async function boot(seed = {}, list = modules) {
  resetForTests();
  const backend = memoryBackend(seed);
  useBackend(backend);
  await start(list);
  return backend;
}

export const data = (id) => modules.find((m) => m.id === id).slice.data;

// Данные прошлой версии приложения (общий блоб state) через импорт копии версии 1.
export async function migrateLegacy(state) {
  await boot();
  const notes = await importBackup(JSON.stringify({ version: 1, state }));
  return {
    notes,
    profile: data("profile"),
    wardrobe: data("wardrobe"),
    looks: data("looks"),
    capsule: data("capsule"),
    search: data("search"),
  };
}
