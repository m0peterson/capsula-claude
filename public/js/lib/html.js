// Безопасная подстановка данных в HTML. Всё, что пришло от модели, из хранилища или из копии, проходит через эти функции.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const safeHex = (h) => {
  const s = String(h ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : "#cccccc";
};

// Картинки приложения это только data URL растровых форматов. Всё остальное (в том числе из импортированной копии)
// нельзя подставлять в src: через кавычку в значении можно дописать атрибут и выполнить свой скрипт.
export const safeImage = (u) => (typeof u === "string" && /^data:image\/(?:jpe?g|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : "");

export const safeUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};
