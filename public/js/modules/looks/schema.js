// Форма образов из гардероба: общий контракт сервера (server/modules/looks.mjs) и браузера.
import { records, text, ids } from "../../lib/coerce.js";

export function normalizeLooks(data, validIds) {
  return records(data?.looks)
    .map((l) => ({
      name: text(l.name) || "Образ",
      occasion: text(l.occasion),
      season: text(l.season),
      item_ids: [...new Set(ids(l.item_ids).filter((id) => validIds.has(id)))],
      description: text(l.description),
      tips: text(l.tips),
      missing: text(l.missing),
    }))
    .filter((l) => l.item_ids.length >= 2);
}
