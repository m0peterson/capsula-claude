import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { WARDROBE_SYSTEM } from "../prompts.js";
import { esc, arr, uid, fileToDataUrl } from "../util.js";
import { runTask, thumb, toast, readImages, CATEGORIES, emptyState } from "../ui.js";

const BATCH = 6;

function card(w) {
  const cats = Object.entries(CATEGORIES)
    .map(([k, v]) => `<option value="${k}" ${k === w.category ? "selected" : ""}>${v}</option>`)
    .join("");
  return `<article class="item" data-id="${w.id}">
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

function normalize(raw) {
  const category = raw.category in CATEGORIES ? raw.category : "other";
  const f = Number(raw.formality);
  return {
    name: String(raw.name || "Вещь").slice(0, 120),
    category,
    color: raw.color || "",
    color_hex: raw.color_hex || "",
    material: raw.material || "",
    style: raw.style || "",
    seasons: arr(raw.seasons),
    formality: Number.isFinite(f) ? Math.min(5, Math.max(1, f)) : null,
    notes: raw.notes || "",
    recognized: true,
  };
}

export function render(root) {
  const items = state.wardrobe;
  const fresh = items.filter((w) => !w.recognized);
  root.innerHTML = `
  <section class="card">
    <h2>Гардероб <span class="count">${items.length}</span></h2>
    <p class="muted">Фотографируйте вещи по одной на ровном фоне. Приложение определит категорию, цвет, ткань и сезон. Результат можно поправить вручную.</p>
    <div class="row">
      <label class="drop small"><input type="file" accept="image/*" multiple hidden data-add><span>+ Добавить фото вещей</span></label>
      <button type="button" class="primary" data-recognize ${fresh.length ? "" : "disabled"}>Распознать новые (${fresh.length})</button>
    </div>
    <div data-status></div>
  </section>
  <div data-list></div>`;
  paintList();

  function paintList() {
    const list = root.querySelector("[data-list]");
    list.innerHTML = items.length
      ? `<section class="items">${items.map(card).join("")}</section>`
      : emptyState("Гардероб пока пуст. Добавьте фото вещей, чтобы получить образы и капсулу.");
    const fresh = items.filter((w) => !w.recognized).length;
    const rec = root.querySelector("[data-recognize]");
    rec.textContent = `Распознать новые (${fresh})`;
    rec.disabled = !fresh;
    root.querySelector(".count").textContent = items.length;
    list.querySelectorAll(".item").forEach((el) => {
      const w = items.find((x) => x.id === el.dataset.id);
      el.querySelectorAll("[data-f]").forEach((input) =>
        input.addEventListener("change", () => {
          w[input.dataset.f] = input.value;
          save();
        }),
      );
      el.querySelector("[data-del]").addEventListener("click", () => {
        state.wardrobe = state.wardrobe.filter((x) => x.id !== w.id);
        // Убираем вещь из сохранённых образов, чтобы не было битых ссылок.
        for (const l of state.looks) l.item_ids = arr(l.item_ids).filter((id) => id !== w.id);
        save();
        paintList();
      });
    });
  }

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

  const btn = root.querySelector("[data-recognize]");
  btn.addEventListener("click", async () => {
    const problem = slotProblem(settings.vision);
    if (problem) return toast(problem, "error");
    const status = root.querySelector("[data-status]");
    const done = await runTask(status, [btn], async ({ signal, onProgress, setLabel }) => {
      const queue = items.filter((w) => !w.recognized);
      for (let i = 0; i < queue.length; i += BATCH) {
        const batch = queue.slice(i, i + BATCH);
        setLabel(`Распознаю вещи ${i + 1}-${i + batch.length} из ${queue.length}`);
        const { data } = await chatJson({
          slot: settings.vision,
          system: WARDROBE_SYSTEM,
          user: `Распознай вещи на ${batch.length} фото. Фото идут по порядку, начиная с 1.`,
          images: batch.map((w) => w.image),
          signal,
          onProgress,
        });
        const list = arr(data.items ?? data);
        list.forEach((raw, pos) => {
          const idx = Number.isInteger(raw.index) ? raw.index - 1 : pos;
          const target = batch[idx];
          if (target) Object.assign(target, normalize(raw));
        });
        save();
        paintList();
      }
    });
    if (done) {
      const left = items.filter((w) => !w.recognized).length;
      if (left) toast(`Не удалось распознать вещей: ${left}`, "error");
    }
  });
}
