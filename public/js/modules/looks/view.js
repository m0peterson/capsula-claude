import { runServerTask } from "../../core/api.js";
import { runTask, isRunning, RUNNING_NOTE } from "../../core/tasks.js";
import { proCard } from "../../core/paywall.js";
import { esc } from "../../lib/html.js";
import { arr } from "../../lib/coerce.js";
import { count } from "../../lib/plural.js";
import { thumb, emptyState, safeHtml } from "../../ui/components.js";
import * as profile from "../profile/api.js";
import * as wardrobe from "../wardrobe/api.js";
import { slice, commitLooks } from "./model.js";
import { normalizeLooks } from "./schema.js";

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

function looksHtml(looks, lock) {
  const byId = wardrobe.byId();
  const hidden = lock?.looks || 0;
  return (
    (looks.length ? looks.map((l) => lookCard(l, byId)).join("") : emptyState("Образов пока нет.")) +
    (hidden
      ? proCard(
          `Ещё ${count(hidden, "образ", "образа", "образов")} уже готовы`,
          "Они собраны из ваших вещей вместе с этими. Откроются сразу, без повторного подбора.",
        )
      : "")
  );
}

export function render(root) {
  const n = wardrobe.count();
  root.innerHTML = `
  <section class="card">
    <h2>Образы из вашего гардероба</h2>
    ${
      n < 3
        ? `<p class="hint">В гардеробе ${n} вещ. Для образов нужно хотя бы 3-4 вещи разных категорий. <a href="#wardrobe">Добавить вещи</a></p>`
        : `<p class="muted">Приложение составит образы только из ваших ${n} вещей с учётом цветотипа, фигуры и пожеланий.</p>`
    }
    <label class="field wide"><span>Пожелания по стилю и поводу</span>
      <textarea data-wishes rows="3" placeholder="Например: офис три дня в неделю, выходные в стиле smart casual, без юбок">${esc(profile.wishes())}</textarea>
    </label>
    <label class="field"><span>Сколько образов</span><input type="number" data-count min="3" max="12" value="6"></label>
    <div class="row"><button type="button" class="primary" data-run ${n < 2 ? "disabled" : ""}>Составить образы</button></div>
    <div data-status data-task="looks"></div>
  </section>
  <div class="looks" data-looks></div>`;
  const looksEl = root.querySelector("[data-looks]");
  looksEl.innerHTML = safeHtml(() => looksHtml(slice.data.list, slice.data.lock?.locked));

  root.querySelector("[data-wishes]").addEventListener("input", (e) => profile.setWishes(e.target.value));

  const btn = root.querySelector("[data-run]");
  if (isRunning("looks")) {
    btn.disabled = true;
    root.querySelector("[data-status]").innerHTML = RUNNING_NOTE;
  }
  btn.addEventListener("click", async () => {
    const want = Math.min(12, Math.max(3, Number(root.querySelector("[data-count]").value) || 6));
    const ok = await runTask(root.querySelector("[data-status]"), [btn], async ({ signal, onProgress, setLabel }) => {
      setLabel("Собираю образы");
      const r = await runServerTask(
        "looks",
        { profile: profile.forServer(), wardrobe: wardrobe.forServer(), wishes: profile.wishes(), count: want },
        { sealed: profile.sealed(), signal, onProgress },
      );
      const looks = normalizeLooks(r.data, wardrobe.ids());
      if (!looks.length) throw new Error("Модель не вернула ни одного образа из ваших вещей. Попробуйте ещё раз.");
      const html = looksHtml(looks, r.locked);
      commitLooks(looks, r.locked, r.sealed);
      return html;
    });
    if (typeof ok === "string" && looksEl.isConnected) looksEl.innerHTML = ok;
  });
}
