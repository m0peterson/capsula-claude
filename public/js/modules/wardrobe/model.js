// Данные гардероба: вещи с фото. Менять вещи может только этот модуль; другие узнают об удалении из события
// «wardrobe:item-removed».
import { defineSlice } from "../../core/store.js";
import { emit } from "../../core/events.js";
import { arr, isRecord, text } from "../../lib/coerce.js";
import { safeImage } from "../../lib/html.js";
import { uid } from "../../lib/ids.js";

export const slice = defineSlice("wardrobe", {
  version: 1,
  // lastImport: отчёт последнего импорта из фото образов, чтобы его можно было отменить одной кнопкой.
  initial: () => ({ items: [], lastImport: null }),
  fromLegacy: (s) => ({ items: s.wardrobe }),
  migrate(raw, { note }) {
    const d = isRecord(raw) ? raw : {};
    const seen = new Set();
    const items = arr(d.items)
      .filter(isRecord)
      .map((w) => {
        const image = safeImage(w.image);
        if (w.image && !image) note("droppedImages");
        let id = text(w.id);
        if (!id || seen.has(id)) id = uid("w");
        seen.add(id);
        return { ...w, id, image };
      });
    return { items, lastImport: importReport(d.lastImport, seen) };
  },
});

function importReport(r, ids) {
  if (!isRecord(r)) return null;
  const added = arr(r.added).filter((id) => ids.has(id));
  if (!added.length) return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { added, photos: n(r.photos), found: n(r.found), repeats: n(r.repeats), known: n(r.known), at: n(r.at) };
}

export const items = () => slice.data.items;

// Новые вещи. first: в начало списка, чтобы пользователь сразу их увидел.
export function addItems(list, { first = false } = {}) {
  const fresh = list.map((w) => ({ ...w, id: w.id || uid("w") }));
  if (first) slice.data.items.unshift(...fresh);
  else slice.data.items.push(...fresh);
  slice.save();
  return fresh;
}

export function removeItem(id) {
  const list = slice.data.items;
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return;
  list.splice(i, 1);
  const r = slice.data.lastImport;
  if (r) {
    r.added = r.added.filter((x) => x !== id);
    if (!r.added.length) slice.data.lastImport = null;
  }
  slice.save();
  emit("wardrobe:item-removed", { id });
}

export function setLastImport(report) {
  slice.data.lastImport = report;
  slice.save();
}

// Отмена последнего импорта: убираем добавленные им вещи.
export function undoLastImport() {
  const r = slice.data.lastImport;
  if (!r) return 0;
  const ids = [...r.added];
  for (const id of ids) removeItem(id);
  slice.data.lastImport = null;
  slice.save();
  return ids.length;
}
