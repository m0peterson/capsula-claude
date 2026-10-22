// Данные профиля: фото, анкета, анализ, пожелания по стилю. Пожелания общие для образов и капсулы, владелец здесь.
import { defineSlice } from "../../core/store.js";
import { arr, isRecord } from "../../lib/coerce.js";
import { safeImage } from "../../lib/html.js";
import { normalizeAnalysis } from "./schema.js";

// lock: { locked, sealed } для урезанного бесплатным планом анализа. locked говорит, сколько и чего скрыто,
// sealed это зашифрованный полный результат: после покупки Pro его вскрывает сервер.
export const lockOf = (l) =>
  isRecord(l) && isRecord(l.locked) && typeof l.sealed === "string" ? { locked: l.locked, sealed: l.sealed } : null;

export const slice = defineSlice("profile", {
  version: 1,
  initial: () => ({ photos: [], inputs: {}, analysis: null, wishes: "", lock: null }),
  fromLegacy: (s) => ({ ...(isRecord(s.profile) ? s.profile : {}), wishes: s.wishes, lock: isRecord(s.locks) ? s.locks.analysis : null }),
  migrate(raw, { note }) {
    const p = isRecord(raw) ? raw : {};
    const photos = arr(p.photos).filter((x) => safeImage(x));
    if (arr(p.photos).length > photos.length) note("droppedImages", arr(p.photos).length - photos.length);
    let analysis = null;
    if (p.analysis) {
      try {
        analysis = normalizeAnalysis(p.analysis);
      } catch (e) {
        console.warn("Сохранённый результат «анализ» повреждён и сброшен:", e.message);
      }
    }
    return {
      photos,
      inputs: isRecord(p.inputs) ? p.inputs : {},
      analysis,
      wishes: typeof p.wishes === "string" ? p.wishes : "",
      lock: analysis ? lockOf(p.lock) : null,
    };
  },
});

export const data = () => slice.data;

export function setWishes(text) {
  slice.data.wishes = String(text ?? "");
  slice.save();
}

// Новый анализ: полный или урезанный бесплатным планом (тогда с конвертом).
export function commitAnalysis(analysis, locked = null, sealed = null) {
  slice.data.analysis = analysis;
  slice.data.lock = locked ? lockOf({ locked, sealed }) : null;
  slice.save();
}

// После покупки Pro: полный анализ из конверта вместо урезанного.
export function unlock(full) {
  commitAnalysis(normalizeAnalysis(full));
}
