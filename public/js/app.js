import { init, settings } from "./store.js";
import { fetchServerConfig } from "./llm.js";
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

const ctx = { serverConfig: null, param: null };
const nav = document.getElementById("nav");
const main = document.getElementById("main");
const banner = document.getElementById("banner");

nav.innerHTML = TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}">${t.label}</a>`).join("");

function keyBanner() {
  const used = new Set([settings.vision.provider, settings.stylist.provider]);
  const missing = [...used].filter((p) => !settings.providers[p]?.apiKey && !ctx.serverConfig?.serverKeys?.[p]);
  banner.hidden = missing.length === 0;
  banner.innerHTML = missing.length ? `Для работы нужен API-ключ (${missing.join(", ")}). <a href="#settings">Открыть настройки</a>` : "";
}

const currentTab = () => location.hash.replace(/^#/, "").split("/")[0] || "profile";

function route({ keepScroll = false } = {}) {
  const [id, param] = location.hash.replace(/^#/, "").split("/");
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  ctx.param = param || null;
  nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab.id));
  keyBanner();
  main.innerHTML = "";
  tab.view.render(main, ctx);
  if (!keepScroll) window.scrollTo(0, 0);
}

await init();
ctx.serverConfig = await fetchServerConfig();
window.addEventListener("hashchange", () => {
  pendingRefresh = null;
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
route();
