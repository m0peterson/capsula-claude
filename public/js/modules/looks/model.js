// Данные образов: последний подбор из гардероба и, для бесплатного плана, конверт с полным подбором.
import { defineSlice } from "../../core/store.js";
import { arr, isRecord } from "../../lib/coerce.js";
import { normalizeLooks } from "./schema.js";

const lockOf = (l) => (isRecord(l) && isRecord(l.locked) && typeof l.sealed === "string" ? { locked: l.locked, sealed: l.sealed } : null);
const wardrobeIds = (w) => new Set(arr(w?.items).map((x) => x.id));

export const slice = defineSlice("looks", {
  version: 1,
  initial: () => ({ list: [], lock: null }),
  fromLegacy: (s) => ({ list: s.looks, lock: isRecord(s.locks) ? s.locks.looks : null }),
  migrate(raw, { get }) {
    const d = isRecord(raw) ? raw : {};
    const list = normalizeLooks({ looks: d.list }, wardrobeIds(get("wardrobe")));
    return { list, lock: list.length ? lockOf(d.lock) : null };
  },
});

export function commitLooks(list, locked = null, sealed = null) {
  slice.data.list = list;
  slice.data.lock = locked ? lockOf({ locked, sealed }) : null;
  slice.save();
}

// Вещь удалили из гардероба: убираем её из образов, чтобы не было битых ссылок.
export function pruneItem(id) {
  for (const l of slice.data.list) l.item_ids = arr(l.item_ids).filter((x) => x !== id);
  slice.save();
}
