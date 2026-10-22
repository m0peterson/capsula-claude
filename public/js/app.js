import { init } from "./store.js";
import { fetchConfig, serverConfig, isPro } from "./api.js";
import { openPaywall, proUntilText } from "./pro.js";
import * as profile from "./views/profile.js";
import * as wardrobe from "./views/wardrobe.js";
import * as looks from "./views/looks.js";
import * as capsule from "./views/capsule.js";
import * as search from "./views/search.js";
import * as settingsView from "./views/settings.js";

const TABS = [
  { id: "profile", label: "Профиль", view: profile },
  { id: "wardrobe", label: "Гардероб", view: wardrobe },
  { id: "looks", label: "Образы", view: looks },
  { id: "capsule", label: "Капсула", view: capsule },
  { id: "search", label: "Поиск", view: search },
  { id: "settings", label: "Настройки", view: settingsView },
];

const ctx = { param: null };
const nav = document.getElementById("nav");
const main = document.getElementById("main");
const banner = document.getElementById("banner");
const planBtn = document.getElementById("plan");

nav.innerHTML = TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}">${t.label}</a>`).join("");

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

const currentTab = () => location.hash.replace(/^#/, "").split("/")[0] || "profile";

function route({ keepScroll = false } = {}) {
  const [id, param] = location.hash.replace(/^#/, "").split("/");
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  ctx.param = param || null;
  nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab.id));
  serverBanner();
  main.innerHTML = "";
  tab.view.render(main, ctx);
  if (!keepScroll) window.scrollTo(0, 0);
}

await init();
await fetchConfig();
paintPlan();
window.addEventListener("hashchange", () => {
  pendingRefresh = null;
  // Pro активирован или включён режим разработчика: открытые результаты нужно перерисовать.
  window.addEventListener("capsula:plan", () => {
    paintPlan();
    refreshNow();
  });
  route();
});
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
window.addEventListener("capsula:refresh", (e) => {
  if (currentTab() !== e.detail.tab) return;
  if (isEditing()) pendingRefresh = e.detail.tab;
  else refreshNow();
});
document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRefresh && currentTab() === pendingRefresh && !isEditing()) refreshNow();
  }, 50);
});
// Pro активирован или включён режим разработчика: открытые результаты нужно перерисовать.
window.addEventListener("capsula:plan", () => {
  paintPlan();
  refreshNow();
});
route();
