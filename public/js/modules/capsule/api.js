// Публичный API капсулы для других модулей. Без DOM.
import { arr } from "../../lib/coerce.js";
import { slice } from "./model.js";

/** Что докупить: [{ id, name, category, color, color_hex, description, price_range, priority, search_query, ... }]. */
export const buyList = () => arr(slice.data.result?.buy);

/** @param {string} id */
export const buyItem = (id) => buyList().find((b) => b.id === id) || null;
