// Данные поиска: кэш результатов ИИ-поиска по запросу и последний запрос.
import { defineSlice } from "../../core/store.js";
import { isRecord } from "../../lib/coerce.js";
import { normalizeSearch } from "./schema.js";

export const slice = defineSlice("search", {
  version: 1,
  initial: () => ({ cache: {}, last: "" }),
  fromLegacy: (s) => ({ cache: s.search, last: s.searchLast }),
  migrate(raw) {
    const d = isRecord(raw) ? raw : {};
    const cache = {};
    for (const [k, v] of Object.entries(isRecord(d.cache) ? d.cache : {}))
      if (isRecord(v)) cache[k] = { ...v, results: normalizeSearch(v.results) };
    return { cache, last: typeof d.last === "string" ? d.last : "" };
  },
});

export function remember(query, results, verified) {
  slice.data.cache[query] = { results, verified, at: Date.now() };
  slice.data.last = query;
  slice.save();
}

// Капсулу пересобрали: старые результаты относятся к прежнему списку покупок.
export function clearCache() {
  slice.data.cache = {};
  slice.save();
}
