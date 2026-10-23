// Контракт модуля. Модуль это папка modules/<id>/ с манифестом index.js:
//
//   export default defineModule({
//     id: "looks",                         // как папка, /^[a-z][a-z-]*$/
//     requires: ["profile", "wardrobe"],   // жёсткие зависимости: их api.js модуль может импортировать. В modules.js стоят раньше.
//     slice,                               // необязательно: данные модуля (defineSlice в model.js)
//     route: { label, order, render, visible? },  // необязательно: вкладка. render(root, { param });
//                                          // visible() → false прячет вкладку (например, только для разработчика)
//     init() {},                           // необязательно: подписки на события, один раз после загрузки данных
//     locked: { task, sealed(), unlock(full) },  // необязательно: результат, урезанный бесплатным планом
//   });
const ID = /^[a-z][a-z-]*$/;

export function defineModule(m) {
  const fail = (why) => {
    throw new Error(`Модуль «${m?.id}»: ${why}`);
  };
  if (!m || typeof m !== "object") fail("манифест должен быть объектом");
  if (!ID.test(m.id || "")) fail("id из строчных латинских букв и дефиса");
  const requires = m.requires ?? [];
  if (!Array.isArray(requires) || !requires.every((r) => typeof r === "string")) fail("requires это список id");
  if (m.slice && m.slice.id !== m.id) fail("слайс модуля называется так же, как модуль");
  if (m.route) {
    const r = m.route;
    if (typeof r.label !== "string" || !Number.isFinite(r.order) || typeof r.render !== "function")
      fail("route это { label, order, render }");
    if (r.visible !== undefined && typeof r.visible !== "function") fail("route.visible это функция");
  }
  if (m.init && typeof m.init !== "function") fail("init это функция");
  if (m.locked) {
    const l = m.locked;
    if (typeof l.task !== "string" || typeof l.sealed !== "function" || typeof l.unlock !== "function")
      fail("locked это { task, sealed, unlock }");
  }
  return Object.freeze({ ...m, requires: Object.freeze([...requires]) });
}
