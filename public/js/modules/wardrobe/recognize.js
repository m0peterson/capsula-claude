// Распознавание вещей, сфотографированных по одной: пачки по BATCH фото, PARALLEL пачек одновременно.
// После каждой пачки сохраняем: частичный результат переживает сбой следующих пачек.
import { runServerTask } from "../../core/api.js";
import { arr } from "../../lib/coerce.js";
import { safeImage } from "../../lib/html.js";
import { slice, items } from "./model.js";
import { normalizeItem } from "./schema.js";

const BATCH = 6;
const PARALLEL = 3;

// onBatch вызывается после каждой готовой пачки (перерисовать список).
export async function recognizePending({ signal, setLabel, notice }, onBatch) {
  const pending = items().filter((w) => !w.recognized);
  // Вещь без годной картинки (например, после импорта копии) распознать нельзя: пустой image_url провайдер отклонит.
  const queue = pending.filter((w) => safeImage(w.image));
  if (queue.length < pending.length)
    notice(`У вещей без фото распознавание пропущено: ${pending.length - queue.length}. Заполните их вручную.`);
  if (!queue.length) throw new Error("Нет вещей с фото для распознавания.");
  // Пачки идут параллельно, по PARALLEL за раз: 30 вещей распознаются за время двух запросов, а не пяти.
  const batches = [];
  for (let i = 0; i < queue.length; i += BATCH) batches.push(queue.slice(i, i + BATCH));
  let recognized = 0;
  let finished = 0;
  const errors = [];
  setLabel(`Распознаю вещи: ${queue.length} шт.`);
  const work = async (batch) => {
    try {
      const { data } = await runServerTask("wardrobe", { photos: batch.map((w) => w.image) }, { signal });
      // Только осмысленные записи: мусор не должен помечать вещь распознанной.
      for (const row of arr(data?.items)) {
        const item = normalizeItem(row?.item);
        const target = Number(row?.target);
        if (!item || !Number.isInteger(target) || target < 0 || target >= batch.length) continue;
        Object.assign(batch[target], item);
        recognized++;
      }
      slice.save();
      onBatch?.();
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      errors.push(e);
    } finally {
      finished += batch.length;
      setLabel(`Распознаю вещи: готово ${finished} из ${queue.length}`);
    }
  };
  const next = async () => {
    while (batches.length) await work(batches.shift());
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, next));
  if (!recognized && errors.length) throw errors[0];
  if (errors.length) notice(`Часть вещей не распознана: ${errors[0].message}`);
  if (!recognized) throw new Error("Модель не вернула ни одной распознанной вещи. Попробуйте ещё раз.");
}
