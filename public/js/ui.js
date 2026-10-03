import { esc, safeHex, arr, isRecord, safeImage } from "./util.js";

export const CATEGORIES = {
  top: "Верх",
  bottom: "Низ",
  dress: "Платья",
  outerwear: "Верхняя одежда",
  shoes: "Обувь",
  bag: "Сумки",
  accessory: "Аксессуары",
  other: "Другое",
};

export const catLabel = (c) => CATEGORIES[c] || CATEGORIES.other;

export const PRIORITY = { high: "Купить первым", medium: "Желательно", low: "Позже" };

export function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// Сырой ответ модели для отладки: начало и конец, чтобы видеть, обрезан ли он и чем испорчен.
function rawDetails(e) {
  const part = (t) => (t.length > 2400 ? `${t.slice(0, 1600)}\n…[пропущено ${t.length - 2400} зн.]…\n${t.slice(-800)}` : t);
  const blocks = [e.raw && ["Ответ модели", e.raw], e.raw2 && ["Ответ на повторный запрос", e.raw2]].filter(Boolean);
  if (!blocks.length) return "";
  return `<details class="raw"><summary>Показать ответ модели (${blocks.map(([, t]) => t.length).join(" и ")} зн.)</summary>${blocks
    .map(([title, t]) => `<p class="meta">${title}</p><pre>${esc(part(t))}</pre>`)
    .join("")}</details>`;
}

// Какие экраны сейчас считают (ключ задаётся атрибутом data-task у блока статуса). Нужно, чтобы экран,
// на который пользователь вернулся посреди расчёта, не показывал активную кнопку и не позволял запустить дубль.
const running = new Set();
export const isRunning = (key) => running.has(key);
export const RUNNING_NOTE = `<div class="progress"><span class="spinner"></span><span>Расчёт ещё идёт. Результат появится здесь, когда он закончится.</span></div>`;

// Запускает долгую задачу: блокирует кнопки, показывает прогресс и кнопку отмены, выводит ошибку.
export async function runTask(statusEl, buttons, fn) {
  const ctl = new AbortController();
  const started = Date.now();
  const key = statusEl.dataset?.task;
  if (key) running.add(key);
  let progress = { chars: 0, thought: 0 };
  let label = "";
  buttons.forEach((b) => b && (b.disabled = true));
  statusEl.innerHTML = `<div class="progress"><span class="spinner"></span><span data-msg></span><button type="button" class="link" data-cancel>Отмена</button></div>`;
  const msg = statusEl.querySelector("[data-msg]");
  statusEl.querySelector("[data-cancel]").onclick = () => ctl.abort();
  const paint = () => {
    const sec = Math.round((Date.now() - started) / 1000);
    const parts = [`${label || "Модель работает"} · ${sec} с`];
    if (progress.thought) parts.push(`рассуждает: ${progress.thought} зн.`);
    if (progress.chars) parts.push(`ответ: ${progress.chars} зн.`);
    msg.textContent = parts.join(" · ");
  };
  paint();
  const tick = setInterval(paint, 1000);
  try {
    const result = await fn({
      signal: ctl.signal,
      onProgress: (p) => (progress = p),
      notice: (m) => toast(m),
      setLabel: (l) => {
        label = l;
        progress = { chars: 0, thought: 0 };
      },
    });
    statusEl.innerHTML = "";
    return result ?? true;
  } catch (e) {
    statusEl.innerHTML =
      e.name === "AbortError"
        ? `<div class="note">Отменено.</div>`
        : `<div class="error"><strong>Ошибка.</strong> ${esc(e.message)}${rawDetails(e)}</div>`;
    return null;
  } finally {
    clearInterval(tick);
    buttons.forEach((b) => b && (b.disabled = false));
    if (key) {
      running.delete(key);
      // Пользователь ушёл с вкладки и вернулся: её экран собран до конца расчёта, пусть перерисуется с итогом.
      if (!statusEl.isConnected) window.dispatchEvent(new CustomEvent("capsula:refresh", { detail: { tab: key } }));
    }
  }
}

export const swatches = (list, size = "") =>
  `<div class="swatches ${size}">${arr(list)
    .filter(isRecord)
    .map(
      (c) =>
        `<div class="swatch" title="${esc(c.name)} ${esc(c.hex)}"><span class="chip" style="background:${safeHex(c.hex)}"></span><span class="sw-name">${esc(c.name)}</span></div>`,
    )
    .join("")}</div>`;

export const thumb = (w, cls = "") =>
  safeImage(w?.image)
    ? `<img class="thumb ${cls}" src="${esc(safeImage(w.image))}" alt="${esc(w.name)}" loading="lazy">`
    : `<div class="thumb ph ${cls}" style="background:${safeHex(w?.color_hex)}"></div>`;

export const emptyState = (text, actionHtml = "") => `<div class="empty"><p>${text}</p>${actionHtml}</div>`;

export function readImages(input, handler) {
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) await handler(files);
  });
}

// Рисует сохранённый результат. Если данные из старой версии повреждены, показываем понятное сообщение,
// а не пустую вкладку без кнопок.
export function safeHtml(render) {
  try {
    return render();
  } catch (e) {
    console.warn("Не удалось показать сохранённый результат:", e);
    return `<div class="error"><strong>Сохранённый результат повреждён.</strong> Запустите расчёт заново, он заменит его.</div>`;
  }
}
