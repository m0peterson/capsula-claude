// Данные капсулы: последний результат, параметры сборки и, для бесплатного плана, конверт с полной капсулой.
import { defineSlice } from "../../core/store.js";
import { emit } from "../../core/events.js";
import { arr, isRecord } from "../../lib/coerce.js";
import { normalizeCapsule } from "./schema.js";

export const SEASONS = ["Круглый год", "Весна-лето", "Осень-зима", "Зима", "Лето"];

const lockOf = (l) => (isRecord(l) && isRecord(l.locked) && typeof l.sealed === "string" ? { locked: l.locked, sealed: l.sealed } : null);
const defaultOptions = () => ({ size: 15, season: SEASONS[0], budget: "", useWardrobe: true });

function optionsOf(o) {
  const d = defaultOptions();
  if (!isRecord(o)) return d;
  const size = Math.floor(Number(o.size));
  return {
    size: Number.isFinite(size) && size >= 6 && size <= 40 ? size : d.size,
    season: typeof o.season === "string" && o.season ? o.season : d.season,
    budget: typeof o.budget === "string" ? o.budget : "",
    useWardrobe: o.useWardrobe !== false,
  };
}

export const slice = defineSlice("capsule", {
  version: 1,
  initial: () => ({ result: null, options: defaultOptions(), lock: null }),
  fromLegacy: (s) => ({ result: s.capsule, options: s.capsuleOptions, lock: isRecord(s.locks) ? s.locks.capsule : null }),
  migrate(raw, { get }) {
    const d = isRecord(raw) ? raw : {};
    let result = null;
    if (d.result) {
      try {
        result = normalizeCapsule(d.result, new Set(arr(get("wardrobe")?.items).map((w) => w.id)));
      } catch (e) {
        console.warn("Сохранённый результат «капсула» повреждён и сброшен:", e.message);
      }
    }
    return { result, options: optionsOf(d.options), lock: result ? lockOf(d.lock) : null };
  },
});

export function commitCapsule(result, locked = null, sealed = null) {
  slice.data.result = result;
  slice.data.lock = locked ? lockOf({ locked, sealed }) : null;
  slice.save();
  emit("capsule:rebuilt");
}
