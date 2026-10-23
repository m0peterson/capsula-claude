// Форма капсулы: общий контракт сервера (server/modules/capsule.mjs) и браузера.
import { arr, isRecord, records, text, ids, colors, validHex } from "../../lib/coerce.js";
import { CATEGORY_KEYS, PRIORITIES, incomplete } from "../../shared/catalog.js";

// keep ждёт role, drop ждёт reason: модель может перепутать, поэтому сохраняем оба поля одним текстом.
function idRoles(v, validIds) {
  return arr(v)
    .map((x) => {
      if (!isRecord(x)) return { id: text(x), role: "", reason: "" };
      const why = text(x.role) || text(x.reason);
      return { id: text(x.id), role: why, reason: text(x.reason) || why };
    })
    .filter((x) => validIds.has(x.id));
}

export function normalizeCapsule(data, validIds) {
  if (!isRecord(data)) throw incomplete("нет капсулы");
  const taken = new Set();
  const buy = records(data.buy)
    .map((b) => ({ ...b, name: text(b.name) }))
    .filter((b) => b.name)
    .map((b, i) => {
      let id = text(b.id);
      if (!id || taken.has(id) || validIds.has(id)) id = `b${i + 1}`;
      while (taken.has(id) || validIds.has(id)) id += "x";
      taken.add(id);
      const category = text(b.category).toLowerCase();
      const priority = text(b.priority).toLowerCase();
      return {
        id,
        name: b.name.slice(0, 160),
        category: CATEGORY_KEYS.includes(category) ? category : "other",
        color: text(b.color),
        color_hex: validHex(b.color_hex),
        description: text(b.description),
        why: text(b.why),
        pairs_with: ids(b.pairs_with),
        price_range: text(b.price_range),
        priority: PRIORITIES.includes(priority) ? priority : "medium",
        search_query: text(b.search_query) || b.name,
      };
    });
  const keep = idRoles(data.keep, validIds);
  if (!buy.length && !keep.length) throw incomplete("в капсуле нет ни вещей из гардероба, ни покупок");

  return {
    concept: text(data.concept),
    palette: colors(data.palette),
    keep,
    drop: idRoles(data.drop, validIds),
    buy,
    looks: records(data.looks)
      .map((l) => ({
        name: text(l.name) || "Образ",
        occasion: text(l.occasion),
        refs: ids(l.refs ?? l.items),
        description: text(l.description),
      }))
      .filter((l) => l.refs.length),
    notes: text(data.notes),
  };
}
