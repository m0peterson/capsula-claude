// Форма результатов поиска: общий контракт сервера (server/modules/search.mjs) и браузера.
import { records, text } from "../../lib/coerce.js";

export function normalizeSearch(data) {
  return records(Array.isArray(data) ? data : data?.results)
    .map((r) => ({ title: text(r.title) || text(r.name), shop: text(r.shop), url: text(r.url), price: text(r.price), why: text(r.why) }))
    .filter((r) => r.url);
}
