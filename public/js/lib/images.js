// Работа с картинками в браузере. DOM трогается только при вызове, поэтому файл импортируется и в Node.

function canvasOf(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

// Открывает файл с учётом EXIF-поворота. Битмап нужно закрыть (close) после использования.
export async function openImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Не удалось открыть «${file.name}». Поддерживаются JPG, PNG, WebP.`);
  }
}

// Сжимает фото до maxSide и возвращает JPEG data URL.
export async function fileToDataUrl(file, maxSide = 1024, quality = 0.85) {
  const bitmap = await openImage(file);
  try {
    return bitmapToDataUrl(bitmap, maxSide, quality);
  } finally {
    bitmap.close?.();
  }
}

function scaled(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const { canvas, ctx } = canvasOf(w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

export const bitmapToDataUrl = (bitmap, maxSide, quality) => scaled(bitmap, maxSide).toDataURL("image/jpeg", quality);

// То же в Blob: держать в памяти десяток сжатых JPEG дешевле, чем десяток открытых фото по 12 Мп.
export const bitmapToBlob = (bitmap, maxSide, quality) =>
  new Promise((resolve, reject) =>
    scaled(bitmap, maxSide).toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сжать фото"))), "image/jpeg", quality),
  );

// Прямоугольник вырезки в пикселях по рамке модели [ymin, xmin, ymax, xmax] в координатах 0-1000.
// Рамку расширяем на pad с каждой стороны: модели ставят её впритык и срезают края вещи.
// null, если рамка вырожденная.
export function cropRect(box, width, height, pad = 0.06) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const [y0, x0, y1, x1] = box.map((v) => Math.min(1000, Math.max(0, v)));
  if (y1 - y0 < 5 || x1 - x0 < 5) return null;
  const px = ((x1 - x0) * pad * width) / 1000;
  const py = ((y1 - y0) * pad * height) / 1000;
  const left = Math.max(0, Math.floor((x0 * width) / 1000 - px));
  const top = Math.max(0, Math.floor((y0 * height) / 1000 - py));
  const right = Math.min(width, Math.ceil((x1 * width) / 1000 + px));
  const bottom = Math.min(height, Math.ceil((y1 * height) / 1000 + py));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, width: right - left, height: bottom - top } : null;
}

// Вырезает вещь из открытого фото и возвращает JPEG data URL не больше maxSide. null, если рамка негодная.
export function cropToDataUrl(bitmap, box, maxSide = 480, quality = 0.82) {
  const r = cropRect(box, bitmap.width, bitmap.height);
  if (!r) return null;
  const scale = Math.min(1, maxSide / Math.max(r.width, r.height));
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const { canvas, ctx } = canvasOf(w, h);
  ctx.drawImage(bitmap, r.left, r.top, r.width, r.height, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось открыть картинку"));
    img.src = src;
  });
}

// Таблица картинок с подписями в углу клетки, одной JPEG-картинкой. Модель берёт за картинку фиксированную цену
// независимо от размера, поэтому 36 миниатюр одной таблицей стоят как одно фото, а не как 36.
// entries: [{ image, label }], картинки это data URL.
export async function contactSheet(entries, { tile = 160, cols = 6, quality = 0.82 } = {}) {
  const rows = Math.max(1, Math.ceil(entries.length / cols));
  const { canvas, ctx } = canvasOf(cols * tile, rows * tile);
  const fontSize = Math.max(14, Math.round(tile / 7));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "top";
  for (const [i, e] of entries.entries()) {
    const x = (i % cols) * tile;
    const y = Math.floor(i / cols) * tile;
    try {
      const img = await loadImage(e.image);
      const s = Math.min((tile - 6) / img.width, (tile - 6) / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, x + (tile - w) / 2, y + (tile - h) / 2, w, h);
    } catch {
      /* битая миниатюра: клетка остаётся пустой, подпись всё равно рисуем */
    }
    ctx.strokeStyle = "#999";
    ctx.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
    const tw = ctx.measureText(e.label).width;
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, tw + 8, fontSize + 6);
    ctx.fillStyle = "#fff";
    ctx.fillText(e.label, x + 4, y + 3);
  }
  return canvas.toDataURL("image/jpeg", quality);
}
