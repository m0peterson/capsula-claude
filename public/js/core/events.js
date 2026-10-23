// Шина событий между модулями. Имена: «<модуль>:<что случилось>» для событий модулей и «app:<...>» для ядра.
// Слушатель, который бросил исключение, не мешает остальным и тому, кто событие отправил.
const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function emit(name, payload = {}) {
  for (const fn of [...(listeners.get(name) || [])]) {
    try {
      fn(payload);
    } catch (e) {
      console.warn(`Обработчик события ${name} упал:`, e);
    }
  }
}

export const clearEvents = () => listeners.clear();
