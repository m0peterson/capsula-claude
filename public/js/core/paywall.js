// Pro: окно оплаты, активация кода, вскрытие полных результатов и заглушки на месте скрытого.
// Какие результаты урезаны, знают модули: у них в манифесте есть locked { task, sealed(), unlock(full) }.
import { settings, saveSettings } from "./settings.js";
import { serverConfig, isPro, activateCode, unlockSealed, fetchConfig } from "./api.js";
import { modules } from "./registry.js";
import { emit } from "./events.js";
import { esc } from "../lib/html.js";
import { toast } from "../ui/components.js";

const FEATURES = [
  "Вся палитра: ваши цвета, нейтральная база, цвета, которых лучше избегать, металлы",
  "Фигура и пропорции: что подчеркнуть и как сбалансировать",
  "Силуэты по зонам: верх, низ, платья, верхняя одежда, обувь, аксессуары",
  "Все образы из вашего гардероба, а не только первые два",
  "Капсула целиком: весь список покупок с приоритетами и образы капсулы",
  "Поиск конкретных моделей в магазинах с помощью ИИ",
];

// Кнопка «открыть в Pro» в строку.
export const lockedNote = (text) =>
  `<button type="button" class="lock-note" data-paywall><span class="lock-ico" aria-hidden="true"></span>${esc(text)}</button>`;

// Размытая заглушка вместо скрытого блока. Внутри нет настоящих данных: их нет и в браузере.
export function lockedBlock(title, what, kind = "text") {
  const fake =
    kind === "swatches"
      ? `<div class="swatches">${["#b9a89a", "#8f9a8a", "#a7b3bf", "#c4a7a1", "#9a8fa8"].map((c) => `<div class="swatch"><span class="chip" style="background:${c}"></span><span class="sw-name">Цвет</span></div>`).join("")}</div>`
      : `<p>Здесь подробные рекомендации стилиста по вашей внешности и фигуре: что носить, какие длины и ткани выбрать и почему.</p><p>Ещё несколько строк с конкретными советами по силуэтам и сочетаниям.</p>`;
  return `<div class="locked">
    ${title ? `<h3>${esc(title)}</h3>` : ""}
    <div class="locked-fake" aria-hidden="true">${fake}</div>
    <button type="button" class="locked-cta" data-paywall><span class="lock-ico" aria-hidden="true"></span>${esc(what)}</button>
  </div>`;
}

export function proCard(title, text) {
  const price = serverConfig()?.price;
  return `<section class="card pro-cta">
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    <button type="button" class="primary" data-paywall>Открыть всё в Pro${price ? ` · ${esc(price)}` : ""}</button>
  </section>`;
}

// Вскрывает конверты всех модулей разом: полный результат подменяет урезанный без повторной генерации.
export async function unlockAll() {
  const owners = new Map();
  for (const m of modules()) {
    const sealed = m.locked?.sealed();
    if (typeof sealed === "string" && sealed) owners.set(m.locked.task, { m, sealed });
  }
  if (!owners.size) return 0;
  const results = await unlockSealed(Object.fromEntries([...owners].map(([task, o]) => [task, o.sealed])));
  let n = 0;
  for (const [task, full] of Object.entries(results)) {
    if (!full || !owners.has(task)) continue;
    try {
      owners.get(task).m.locked.unlock(full);
      n++;
    } catch (e) {
      console.warn(`Не удалось открыть «${task}»:`, e);
    }
  }
  return n;
}

// Код Pro или код разработчика. После активации открываем всё, что было скрыто, и перерисовываем экран.
export async function activate(code) {
  const r = await activateCode(code);
  if (r.admin) settings.devCode = code.trim();
  else {
    settings.proToken = r.token;
    settings.proUntil = r.until;
  }
  saveSettings();
  try {
    await unlockAll();
  } catch (e) {
    toast(`Pro активирован, но открыть прошлые результаты не удалось: ${e.message}`, "error");
  }
  // С кодом разработчика сервер отдаёт в конфиге свои модели и уровень логов.
  if (r.admin) await fetchConfig();
  emit("app:plan-changed");
  return r;
}

export function openPaywall() {
  const cfg = serverConfig() || {};
  document.querySelector("dialog.paywall")?.remove();
  const dlg = document.createElement("dialog");
  dlg.className = "paywall";
  dlg.innerHTML = `
    <button type="button" class="x" data-close aria-label="Закрыть">×</button>
    <h2>Capsula Pro</h2>
    ${cfg.price ? `<p class="price">${esc(cfg.price)}</p>` : ""}
    <ul class="features">${FEATURES.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <p class="muted">Результаты, которые вы уже получили, откроются целиком сразу после активации, без повторного анализа.</p>
    ${
      cfg.payUrl
        ? `<a class="btn primary wide" href="${esc(cfg.payUrl)}" target="_blank" rel="noopener noreferrer">Купить Pro</a>
           <p class="muted small">После оплаты придёт код. Введите его ниже.</p>`
        : `<p class="hint">Онлайн-оплата скоро появится. Сейчас Pro открывается по коду доступа.</p>`
    }
    <label class="field wide"><span>Код доступа</span><input data-code autocomplete="off" spellcheck="false" placeholder="Например, CAPSULA-XXXX"></label>
    <div class="row"><button type="button" class="primary" data-activate>Активировать</button></div>
    <div data-msg></div>`;
  document.body.appendChild(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.querySelector("[data-close]").onclick = close;
  dlg.addEventListener("cancel", () => setTimeout(() => dlg.remove(), 0));
  dlg.addEventListener("click", (e) => e.target === dlg && close());
  const input = dlg.querySelector("[data-code]");
  const btn = dlg.querySelector("[data-activate]");
  const msg = dlg.querySelector("[data-msg]");
  const go = async () => {
    if (!input.value.trim()) return input.focus();
    btn.disabled = true;
    msg.innerHTML = "";
    try {
      const r = await activate(input.value);
      close();
      toast(r.admin ? "Режим разработчика включён" : `Pro активирован до ${new Date(r.until).toLocaleDateString("ru-RU")}`);
    } catch (e) {
      msg.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = go;
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  dlg.showModal();
  input.focus();
}

export async function disableDevMode() {
  settings.devCode = "";
  saveSettings();
  await fetchConfig();
  emit("app:plan-changed");
}

export const proUntilText = () =>
  settings.devCode ? "режим разработчика" : isPro() ? `до ${new Date(settings.proUntil).toLocaleDateString("ru-RU")}` : "";
