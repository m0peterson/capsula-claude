// Публичный API гардероба для других модулей. Без DOM. Возвращает живые объекты: не меняйте их.
import { items as all } from "./model.js";
import { itemForServer } from "./schema.js";

/** Все вещи: [{ id, image, name, category, color, color_hex, material, style, seasons, formality, notes }]. */
export const items = () => all();

export const count = () => all().length;

/** Map id → вещь. */
export const byId = () => new Map(all().map((w) => [w.id, w]));

/** Set id всех вещей. */
export const ids = () => new Set(all().map((w) => w.id));

/** Гардероб для запроса к серверу: без фото. */
export const forServer = () => all().map(itemForServer);
