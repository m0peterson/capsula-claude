// Приведение произвольных данных (ответ модели, старая копия, ручная правка) к простым типам.
// Модель может вернуть строку вместо списка, null внутри массива, число вместо текста. Всё это отсекается здесь,
// до сохранения: иначе один кривой ответ ломает вкладку и после перезагрузки.
// Общий для браузера и сервера: без DOM и без знания о приложении.

export const arr = (v) => (Array.isArray(v) ? v : []);

// Обычный объект (не массив, не null).
export const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const records = (v) => arr(v).filter(isRecord);

const HEX_IN_TEXT = /#[0-9a-f]{3,8}\b/i;

export function text(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  // Массив строк вместо строки (например, «ткани» списком): не стираем, склеиваем.
  if (Array.isArray(v)) {
    // «;» между предложениями даёт «.;», поэтому после знака конца предложения склеиваем пробелом.
    return v
      .map(text)
      .filter(Boolean)
      .reduce((acc, x) => (acc ? acc + (/[.!?…]$/.test(acc) ? " " : "; ") + x : x), "");
  }
  return "";
}

// hex только если он настоящий: выдуманный серый в промпты и данные не пишем.
export const validHex = (h) => (/^#[0-9a-f]{3,8}$/i.test(text(h)) ? text(h) : "");

// Список строк: массив строк, либо строка через «;» или перенос строки.
export function list(v) {
  if (Array.isArray(v)) return v.map(text).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

// Список id: строки или объекты вида {id} / {ref}.
export function ids(v) {
  return arr(v)
    .map((x) => (isRecord(x) ? text(x.id) || text(x.ref) : text(x)))
    .filter(Boolean);
}

export function colors(v) {
  return arr(v)
    .map((c) => {
      if (isRecord(c)) {
        const hex = text(c.hex) || text(c.color_hex);
        const name = text(c.name) || text(c.color) || hex;
        return name ? { name, hex: validHex(hex), role: text(c.role) } : null;
      }
      const s = typeof c === "string" ? c.trim() : "";
      if (!s) return null;
      const m = s.match(HEX_IN_TEXT);
      const name = s
        .replace(HEX_IN_TEXT, "")
        .replace(/[()\s]+$/, "")
        .trim();
      return { name: name || s, hex: validHex(m?.[0]), role: "" };
    })
    .filter(Boolean);
}
