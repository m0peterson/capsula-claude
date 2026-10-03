import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { LOOKS_SYSTEM, profileBrief, wardrobeBrief } from "../prompts.js";
import { esc, arr } from "../util.js";
import { runTask, thumb, toast, emptyState, safeHtml } from "../ui.js";
import { normalizeLooks } from "../normalize.js";

export function lookCard(look, byId) {
  const items = arr(look.item_ids)
    .map((id) => byId.get(id))
    .filter(Boolean);
  return `<article class="look card">
    <header><h3>${esc(look.name)}</h3><p class="meta">${esc(look.occasion)}${look.season ? ` · ${esc(look.season)}` : ""}</p></header>
    <div class="look-items">${items.map((w) => `<figure>${thumb(w)}<figcaption>${esc(w.name)}</figcaption></figure>`).join("")}</div>
    <p>${esc(look.description)}</p>
    ${look.tips ? `<p class="muted"><strong>Как носить:</strong> ${esc(look.tips)}</p>` : ""}
    ${look.missing ? `<p class="hint"><strong>Не хватает:</strong> ${esc(look.missing)}</p>` : ""}
  </article>`;
}

function looksHtml(looks) {
  const byId = new Map(state.wardrobe.map((w) => [w.id, w]));
  return looks.length ? looks.map((l) => lookCard(l, byId)).join("") : emptyState("Образов пока нет.");
}

export function render(root, ctx) {
  const n = state.wardrobe.length;
  root.innerHTML = `
  <section class="card">
    <h2>Образы из вашего гардероба</h2>
    ${
      n < 3
        ? `<p class="hint">В гардеробе ${n} вещ. Для образов нужно хотя бы 3-4 вещи разных категорий. <a href="#wardrobe">Добавить вещи</a></p>`
        : `<p class="muted">Приложение составит образы только из ваших ${n} вещей с учётом цветотипа, фигуры и пожеланий.</p>`
    }
    <label class="field wide"><span>Пожелания по стилю и поводу</span>
      <textarea data-wishes rows="3" placeholder="Например: офис три дня в неделю, выходные в стиле smart casual, без юбок">${esc(state.wishes)}</textarea>
    </label>
    <label class="field"><span>Сколько образов</span><input type="number" data-count min="3" max="12" value="6"></label>
    <div class="row"><button type="button" class="primary" data-run ${n < 2 ? "disabled" : ""}>Составить образы</button></div>
    <div data-status></div>
  </section>
  <div class="looks" data-looks></div>`;
  const looksEl = root.querySelector("[data-looks]");
  looksEl.innerHTML = safeHtml(() => looksHtml(state.looks));

  root.querySelector("[data-wishes]").addEventListener("input", (e) => {
    state.wishes = e.target.value;
    save();
  });

  const btn = root.querySelector("[data-run]");
  btn.addEventListener("click", async () => {
    const problem = slotProblem(settings.stylist);
    if (problem) return toast(problem, "error");
    const count = Math.min(12, Math.max(3, Number(root.querySelector("[data-count]").value) || 6));
    const ok = await runTask(root.querySelector("[data-status]"), [btn], async ({ signal, onProgress, setLabel, notice }) => {
      setLabel("Собираю образы");
      const { data } = await chatJson({
        slot: settings.stylist,
        system: LOOKS_SYSTEM,
        user: `Клиент:\n${profileBrief(state)}\n\nГардероб (id: описание):\n${wardrobeBrief(state.wardrobe)}\n\nПожелания: ${state.wishes || "нет"}\n\nСоставь ${count} образов.`,
        expect: ["looks"],
        signal,
        onProgress,
        onNotice: notice,
      });
      const looks = normalizeLooks(data, new Set(state.wardrobe.map((w) => w.id)));
      if (!looks.length) throw new Error("Модель не вернула ни одного образа из ваших вещей. Попробуйте ещё раз.");
      const html = looksHtml(looks);
      state.looks = looks;
      save();
      return html;
    });
    if (typeof ok === "string" && looksEl.isConnected) looksEl.innerHTML = ok;
  });
}
