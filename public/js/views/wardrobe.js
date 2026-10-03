import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { WARDROBE_SYSTEM } from "../prompts.js";
import { esc, arr, uid, fileToDataUrl, safeImage } from "../util.js";
import { recognizedItems } from "../normalize.js";
import { runTask, thumb, toast, readImages, CATEGORIES, emptyState, isRunning, RUNNING_NOTE } from "../ui.js";

const BATCH = 6;

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
    const problem = slotProblem(settings.vision);
    if (problem) return toast(problem, "error");
    const done = await runTask(statusEl, [recBtn], async ({ signal, onProgress, setLabel, notice }) => {
      const pending = items.filter((w) => !w.recognized);
      // Вещь без годной картинки (например, после импорта копии) распознать нельзя: пустой image_url провайдер отклонит.
      const queue = pending.filter((w) => safeImage(w.image));
      if (queue.length < pending.length)
        notice(`У вещей без фото распознавание пропущено: ${pending.length - queue.length}. Заполните их вручную.`);
      if (!queue.length) throw new Error("Нет вещей с фото для распознавания.");
      let recognized = 0;
      for (let i = 0; i < queue.length; i += BATCH) {
        const batch = queue.slice(i, i + BATCH);
        setLabel(`Распознаю вещи ${i + 1}-${i + batch.length} из ${queue.length}`);
        const { data } = await chatJson({
          slot: settings.vision,
          system: WARDROBE_SYSTEM,
          user: `Распознай вещи на ${batch.length} фото. Фото идут по порядку, начиная с 1.`,
          images: batch.map((w) => w.image),
          expect: ["items"],
          signal,
          onProgress,
          onNotice: notice,
        });
        // Только осмысленные записи: мусор не должен помечать вещь распознанной.
        for (const { target, item } of recognizedItems(data, batch.length)) {
          Object.assign(batch[target], item);
          recognized++;
        }
        save();
        paintList();
      }
      if (!recognized) throw new Error("Модель не вернула ни одной распознанной вещи. Попробуйте ещё раз или смените модель.");
    });
    paintList(); // runTask включает кнопку в finally: возвращаем ей правильное состояние
    if (done) {
      const left = items.filter((w) => !w.recognized).length;
      if (left) toast(`Не удалось распознать вещей: ${left}`, "error");
    }
  });
}
