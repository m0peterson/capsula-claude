// Оболочка: навигация из маршрутов модулей, роутинг по #<id>/<param>, баннер сервера, кнопка Pro,
// перерисовка вкладки после фоновой задачи. Ни одного конкретного модуля не знает.
import { serverConfig, isPro } from "./api.js";
import { openPaywall, proUntilText } from "./paywall.js";
import { on } from "./events.js";
import { esc } from "../lib/html.js";

export function startShell({ routes }) {
  const nav = document.getElementById("nav");
  const main = document.getElementById("main");
  const banner = document.getElementById("banner");
  const planBtn = document.getElementById("plan");
  if (!routes.length) throw new Error("Нет ни одного модуля с вкладкой");

  nav.innerHTML = routes.map((r) => `<a href="#${esc(r.id)}" data-tab="${esc(r.id)}">${esc(r.label)}</a>`).join("");
  document.querySelector(".brand")?.setAttribute("href", `#${routes[0].id}`);

  function serverBanner() {
    const cfg = serverConfig();
    const problem = !cfg
      ? "Сервер приложения недоступен. Проверьте подключение и обновите страницу."
      : !cfg.ready
        ? "На сервере не настроен ключ провайдера ИИ, анализ и подбор пока не работают."
        : "";
    banner.hidden = !problem;
    banner.textContent = problem;
  }

  function paintPlan() {
    const cfg = serverConfig();
    planBtn.hidden = !cfg?.paywall && !isPro();
    planBtn.classList.toggle("is-pro", isPro());
    planBtn.textContent = isPro() ? "Pro" : "Получить Pro";
    planBtn.title = isPro() ? `Pro ${proUntilText()}` : "Открыть все результаты";
  }
  planBtn.addEventListener("click", () => (isPro() ? (location.hash = "#settings") : openPaywall()));

  // Любая кнопка с data-paywall на любом экране открывает окно Pro.
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-paywall]")) openPaywall();
  });

  const decodeParam = (p) => {
    try {
      return p ? decodeURIComponent(p) : null;
    } catch {
      return p;
    }
  };
  const parseHash = () => location.hash.replace(/^#/, "").split("/");
  const currentRoute = () => routes.find((r) => r.id === parseHash()[0]) || routes[0];

  function route({ keepScroll = false } = {}) {
    const [, param] = parseHash();
    const r = currentRoute();
    nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === r.id));
    serverBanner();
    main.innerHTML = "";
    r.render(main, { param: decodeParam(param) });
    if (!keepScroll) window.scrollTo(0, 0);
  }

  // Задача закончилась, пока пользователь был на другой вкладке и вернулся: перерисовываем её с готовым результатом.
  // Если в этот момент пользователь печатает в поле формы, перерисовка отнимет фокус и съест набранное:
  // откладываем её до ухода из поля. Прокрутку сохраняем.
  let pendingRefresh = null;
  const isEditing = () => {
    const a = document.activeElement;
    return Boolean(a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  const refreshNow = () => {
    pendingRefresh = null;
    const y = window.scrollY;
    route({ keepScroll: true });
    window.scrollTo(0, y);
  };
  const refresh = (id) => {
    if (id && currentRoute().id !== id) return;
    if (isEditing()) pendingRefresh = currentRoute().id;
    else refreshNow();
  };
  on("app:task-finished", ({ module }) => refresh(module));
  on("app:data-replaced", () => refresh());
  // Pro активирован или включён режим разработчика: открытые результаты нужно перерисовать.
  on("app:plan-changed", () => {
    paintPlan();
    refreshNow();
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (pendingRefresh && currentRoute().id === pendingRefresh && !isEditing()) refreshNow();
    }, 50);
  });
  window.addEventListener("hashchange", () => {
    pendingRefresh = null;
    route();
  });

  paintPlan();
  route();
}
