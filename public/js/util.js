export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const uid = (p = "w") => p + Math.random().toString(36).slice(2, 9);

export const safeHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(String(h || "").trim()) ? h.trim() : "#cccccc");

export const safeUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

export const arr = (v) => (Array.isArray(v) ? v : []);

// Достаёт JSON из ответа модели: убирает ```-обёртку и текст вокруг.
export function extractJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start < 0) throw new Error("В ответе модели нет JSON");
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end <= start) throw new Error("JSON в ответе модели оборван");
  return JSON.parse(t.slice(start, end + 1));
}

// Сжимает фото до maxSide и возвращает JPEG data URL. Учитывает EXIF-поворот.
export async function fileToDataUrl(file, maxSide = 1024, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Не удалось открыть «${file.name}». Поддерживаются JPG, PNG, WebP.`);
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

// Уменьшает уже готовый data URL (для миниатюр вещей).
export function shrinkDataUrl(dataUrl, maxSide = 420, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Не удалось уменьшить изображение"));
    img.src = dataUrl;
  });
}
