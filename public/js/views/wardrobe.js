import { state, save } from "../store.js";
import { runServerTask } from "../api.js";
import { esc, arr, uid, fileToDataUrl, safeImage } from "../util.js";
import { normalizeItem } from "../normalize.js";
import { runTask, thumb, toast, readImages, CATEGORIES, emptyState, isRunning, RUNNING_NOTE } from "../ui.js";

const BATCH = 6;
const PARALLEL = 3;

function card(w) {
  const cats = Object.entries(CATEGORIES)
    .map(([k, v]) => `<option value="${k}" ${k === w.category ? "selected" : ""}>${v}</option>`)
    .join("");
  return `<article class="item" data-id="${esc(w.id)}">
    ${thumb(w)}
    <div class="item-body">
      <input data-f="name" value="${esc(w.name)}" aria-label="Название">
      <select data-f="category" aria-label="Категория">${cats}</select>
      <input data-f="color" value="${esc(w.color || "")}" placeholder="Цвет" aria-label="Цвет">
      <input data-f="notes" value="${esc(w.notes || "")}" placeholder="Заметки: крой, ткань, сезон" aria-label="Заметки">
      ${w.recognized ? "" : `<span class="tag no">не распознано</span>`}
    </div>
    <button type="button" class="x" data-del aria-label="Удалить вещь">×</button>
  </article>`;
}

export function render(root) {
  const items = state.wardrobe; // меняем только на месте (splice, push): state.wardrobe не переприсваиваем
  const fresh = items.filter((w) => !w.recognized);
  root.innerHTML = `
  <section class="card">
    <h2>Гардероб <span class="count">${items.length}</span></h2>
    <p class="muted">Фотографируйте вещи по одной на ровном фоне. Приложение определит категорию, цвет, ткань и сезон. Результат можно поправить вручную.</p>
    <div class="row">
      <label class="drop small"><input type="file" accept="image/*" multiple hidden data-add><span>+ Добавить фото вещей</span></label>
      <button type="button" class="primary" data-recognize ${fresh.length ? "" : "disabled"}>Распознать новые (${fresh.length})</button>
    </div>
    <div data-status data-task="wardrobe"></div>
  </section>
  <div data-list></div>`;

  // Узлы берём один раз: распознавание идёт минутами, а пользователь может уйти на другую вкладку.
  const listEl = root.querySelector("[data-list]");
  const statusEl = root.querySelector("[data-status]");
  const recBtn = root.querySelector("[data-recognize]");
  const countEl = root.querySelector(".count");

  function paintList() {
    if (!listEl.isConnected) return;
    listEl.innerHTML = items.length
      ? `<section class="items">${items.map(card).join("")}</section>`
      : emptyState("Гардероб пока пуст. Добавьте фото вещей, чтобы получить образы и капсулу.");
    const left = items.filter((w) => !w.recognized).length;
    recBtn.textContent = `Распознать новые (${left})`;
    recBtn.disabled = !left || isRunning("wardrobe");
    countEl.textContent = items.length;
    listEl.querySelectorAll(".item").forEach((el) => {
      const w = items.find((x) => x.id === el.dataset.id);
      el.querySelectorAll("[data-f]").forEach((input) =>
        input.addEventListener("change", () => {
          w[input.dataset.f] = input.value;
          save();
        }),
      );
      el.querySelector("[data-del]").addEventListener("click", () => {
        items.splice(items.indexOf(w), 1);
        // Убираем вещь из сохранённых образов, чтобы не было битых ссылок.
        for (const l of state.looks) l.item_ids = arr(l.item_ids).filter((id) => id !== w.id);
        save();
        paintList();
      });
    });
  }
  paintList();
  if (isRunning("wardrobe")) statusEl.innerHTML = RUNNING_NOTE;

  readImages(root.querySelector("[data-add]"), async (files) => {
    const failed = [];
    for (const f of files) {
      try {
        items.push({ id: uid("w"), image: await fileToDataUrl(f, 640, 0.8), name: "Вещь", category: "other", recognized: false });
      } catch (e) {
        failed.push(e.message);
      }
    }
    save();
    paintList();
    if (failed.length) toast(failed[0], "error");
  });

  recBtn.addEventListener("click", async () => {
    const done = await runTask(statusEl, [recBtn], async ({ signal, setLabel, notice }) => {
      const pending = items.filter((w) => !w.recognized);
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
          save();
          paintList();
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
    });
    paintList(); // runTask включает кнопку в finally: возвращаем ей правильное состояние
    if (done) {
      const left = items.filter((w) => !w.recognized).length;
      if (left) toast(`Не удалось распознать вещей: ${left}`, "error");
    }
  });
}
