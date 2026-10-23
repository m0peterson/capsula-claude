import { runTask, isRunning, RUNNING_NOTE } from "../../core/tasks.js";
import { esc } from "../../lib/html.js";
import { count } from "../../lib/plural.js";
import { fileToDataUrl } from "../../lib/images.js";
import { CATEGORIES } from "../../shared/catalog.js";
import { thumb, toast, readImages, emptyState } from "../../ui/components.js";
import { slice, addItems, removeItem, undoLastImport } from "./model.js";
import { importOutfits, MAX_OUTFIT_PHOTOS } from "./outfits.js";
import { recognizePending } from "./recognize.js";

function card(w, isNew) {
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
      ${w.recognized ? "" : `<span class="tag no">не распознано</span>`}${isNew ? `<span class="tag ok">новая</span>` : ""}
    </div>
    <button type="button" class="x" data-del aria-label="Удалить вещь">×</button>
  </article>`;
}

function reportHtml(r) {
  if (!r) return "";
  const parts = [`Из ${count(r.photos, "фото", "фото", "фото")} в гардероб добавлено: ${count(r.added.length, "вещь", "вещи", "вещей")}.`];
  if (r.repeats) parts.push(`Одни и те же вещи на разных фото склеены: ${count(r.repeats, "повтор", "повтора", "повторов")}.`);
  if (r.known) parts.push(`Уже были в гардеробе и не добавлены: ${r.known}.`);
  return `<div class="note import-report"><p>${parts.join(" ")} Проверьте названия ниже, лишнее удалите крестиком.</p>
    <button type="button" class="link" data-undo>Отменить импорт</button></div>`;
}

export function render(root) {
  const data = slice.data;
  const items = data.items; // меняем только на месте (splice, push) или через команды модели
  const fresh = items.filter((w) => !w.recognized);
  root.innerHTML = `
  <section class="card">
    <h2>Гардероб <span class="count">${items.length}</span></h2>
    <div class="import-hero">
      <h3>Соберите гардероб из своих фото</h3>
      <p class="muted">Загрузите до ${MAX_OUTFIT_PHOTOS} фото в полный рост: селфи в зеркале, снимки с прогулок и поездок. Приложение найдёт на них вещи, вырежет каждую и уберёт повторы: одни и те же джинсы с пяти фото станут одной вещью. То, что уже есть в гардеробе, второй раз не добавится.</p>
      <label class="btn primary"><input type="file" accept="image/*" multiple hidden data-outfits>Выбрать фото образов</label>
    </div>
    <div data-status data-task="wardrobe"></div>
    <div data-report></div>
    <details class="single-items"${fresh.length ? " open" : ""}><summary>Или сфотографируйте вещи по одной</summary>
      <p class="muted">На ровном фоне, по одной вещи в кадре. Приложение определит категорию, цвет, ткань и сезон, результат можно поправить вручную.</p>
      <div class="row">
        <label class="drop small"><input type="file" accept="image/*" multiple hidden data-add><span>+ Фото вещей</span></label>
        <button type="button" data-recognize ${fresh.length ? "" : "disabled"}>Распознать новые (${fresh.length})</button>
      </div>
    </details>
  </section>
  <div data-list></div>`;

  // Узлы берём один раз: задачи идут десятки секунд, а пользователь может уйти на другую вкладку.
  const listEl = root.querySelector("[data-list]");
  const statusEl = root.querySelector("[data-status]");
  const reportEl = root.querySelector("[data-report]");
  const recBtn = root.querySelector("[data-recognize]");
  const outfitsInput = root.querySelector("[data-outfits]");
  const countEl = root.querySelector(".count");

  function paintReport() {
    if (!reportEl.isConnected) return;
    reportEl.innerHTML = reportHtml(slice.data.lastImport);
    reportEl.querySelector("[data-undo]")?.addEventListener("click", () => {
      const n = undoLastImport();
      toast(`Импорт отменён, убрано ${count(n, "вещь", "вещи", "вещей")}`);
      paintAll();
    });
  }

  function paintList() {
    if (!listEl.isConnected) return;
    const added = new Set(slice.data.lastImport?.added || []);
    listEl.innerHTML = items.length
      ? `<section class="items">${items.map((w) => card(w, added.has(w.id))).join("")}</section>`
      : emptyState("Гардероб пока пуст. Проще всего начать с фото, где вы в полный рост: вещи с них появятся здесь.");
    const left = items.filter((w) => !w.recognized).length;
    recBtn.textContent = `Распознать новые (${left})`;
    recBtn.disabled = !left || isRunning("wardrobe");
    outfitsInput.disabled = isRunning("wardrobe");
    countEl.textContent = items.length;
    listEl.querySelectorAll(".item").forEach((el) => {
      const w = items.find((x) => x.id === el.dataset.id);
      el.querySelectorAll("[data-f]").forEach((input) =>
        input.addEventListener("change", () => {
          w[input.dataset.f] = input.value;
          slice.save();
        }),
      );
      el.querySelector("[data-del]").addEventListener("click", () => {
        removeItem(w.id);
        paintAll();
      });
    });
  }
  const paintAll = () => {
    paintReport();
    paintList();
  };
  paintAll();
  if (isRunning("wardrobe")) statusEl.innerHTML = RUNNING_NOTE;

  readImages(outfitsInput, async (files) => {
    if (isRunning("wardrobe")) return;
    if (files.length > MAX_OUTFIT_PHOTOS) toast(`За один раз берём ${MAX_OUTFIT_PHOTOS} фото, остальные загрузите следующим заходом`);
    const report = await runTask(statusEl, [recBtn], async (t) => {
      outfitsInput.disabled = true;
      return importOutfits(files, t);
    });
    outfitsInput.disabled = false;
    paintAll();
    if (report && report.added && !report.added.length)
      toast(report.known ? "Все найденные вещи уже есть в гардеробе" : "Новых вещей не нашлось");
  });

  readImages(root.querySelector("[data-add]"), async (files) => {
    const failed = [];
    const list = [];
    for (const f of files) {
      try {
        list.push({ image: await fileToDataUrl(f, 640, 0.8), name: "Вещь", category: "other", recognized: false });
      } catch (e) {
        failed.push(e.message);
      }
    }
    addItems(list);
    paintList();
    if (failed.length) toast(failed[0], "error");
  });

  recBtn.addEventListener("click", async () => {
    const done = await runTask(statusEl, [recBtn], (t) => recognizePending(t, paintList));
    paintList(); // runTask включает кнопку в finally: возвращаем ей правильное состояние
    if (done) {
      const left = items.filter((w) => !w.recognized).length;
      if (left) toast(`Не удалось распознать вещей: ${left}`, "error");
    }
  });
}
