// Общие кусочки интерфейса. Без состояния: только разметка и мелкие DOM-помощники.
import { esc, safeHex, safeImage } from "../lib/html.js";
import { arr, isRecord } from "../lib/coerce.js";

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

export const swatches = (list, size = "") =>
  `<div class="swatches ${size}">${arr(list)
    .filter(isRecord)
    .map(
      (c) =>
        `<div class="swatch" title="${esc(c.name)} ${esc(c.hex)}"><span class="chip" style="background:${safeHex(c.hex)}"></span><span class="sw-name">${esc(c.name)}</span></div>`,
    )
    .join("")}</div>`;

// Вещи, вырезанные из фото образов, бывают любой формы (сумка широкая, брюки узкие): показываем целиком, без обрезки.
export const thumb = (w, cls = "") =>
  safeImage(w?.image)
    ? `<img class="thumb ${w?.source === "outfit" ? "fit " : ""}${cls}" src="${esc(safeImage(w.image))}" alt="${esc(w.name)}" loading="lazy">`
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
