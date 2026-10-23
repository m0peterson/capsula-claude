import { runServerTask } from "../../core/api.js";
import { runTask, isRunning, RUNNING_NOTE } from "../../core/tasks.js";
import { lockedNote, proCard } from "../../core/paywall.js";
import { esc, safeHex } from "../../lib/html.js";
import { arr } from "../../lib/coerce.js";
import { count } from "../../lib/plural.js";
import { catLabel, PRIORITY } from "../../shared/catalog.js";
import { thumb, swatches, safeHtml } from "../../ui/components.js";
import * as profile from "../profile/api.js";
import * as wardrobe from "../wardrobe/api.js";
import { slice, commitCapsule, SEASONS } from "./model.js";
import { normalizeCapsule } from "./schema.js";

function refOf(ref, own, buy) {
  return own.get(ref) || buy.get(ref) || null;
}

function buyThumb(b) {
  return `<div class="thumb ph buy" style="background:${safeHex(b.color_hex)}" title="${esc(b.color)}"><span>${esc(catLabel(b.category))}</span></div>`;
}

function capsuleView(c, lock = null) {
  const L = lock || {};
  const own = wardrobe.byId();
  const buy = new Map(arr(c.buy).map((b) => [b.id, b]));
  const keep = arr(c.keep).filter((k) => own.has(k.id));
  const drop = arr(c.drop).filter((k) => own.has(k.id));
  const label = (ref) => refOf(ref, own, buy)?.name;

  return `
  <section class="card accent"><h2>Концепция</h2><p>${esc(c.concept)}</p>${swatches(c.palette)}</section>
  ${
    keep.length
      ? `<section class="card"><h2>Берём из вашего гардероба <span class="count">${keep.length}</span></h2>
    <div class="items">${keep
      .map((k) => {
        const w = own.get(k.id);
        return `<article class="item">${thumb(w)}<div class="item-body"><strong>${esc(w.name)}</strong><span class="muted">${esc(k.role)}</span></div></article>`;
      })
      .join("")}</div></section>`
      : ""
  }
  <section class="card"><h2>Что докупить <span class="count">${arr(c.buy).length + (L.buy || 0)}</span></h2>
    <div class="items">${arr(c.buy)
      .map(
        (b) => `<article class="item buy-item">${buyThumb(b)}<div class="item-body">
          <strong>${esc(b.name)}</strong>
          <span class="meta">${esc(catLabel(b.category))} · ${esc(b.color)} · ${esc(b.price_range || "цена не указана")} · <span class="tag prio-${esc(b.priority)}">${esc(PRIORITY[b.priority] || b.priority)}</span></span>
          <span>${esc(b.description)}</span>
          <span class="muted">${esc(b.why)}</span>
          ${
            arr(b.pairs_with).length
              ? `<span class="muted">Сочетается с: ${arr(b.pairs_with)
                  .map((r) => esc(label(r) || ""))
                  .filter(Boolean)
                  .join(", ")}</span>`
              : ""
          }
          <a class="btn small" href="#search/${esc(b.id)}">Найти в магазинах</a>
        </div></article>`,
      )
      .join("")}</div>
    ${L.buy ? lockedNote(`Ещё ${count(L.buy, "вещь", "вещи", "вещей")} в списке покупок, в Pro`) : ""}</section>
  ${
    L.buy || L.looks
      ? proCard(
          `Капсула целиком: ещё ${[L.buy && count(L.buy, "покупка", "покупки", "покупок"), L.looks && count(L.looks, "образ", "образа", "образов")].filter(Boolean).join(" и ")}`,
          "Полный список покупок с парами, образы капсулы и заметки по её развитию уже готовы и откроются сразу.",
        )
      : ""
  }
  ${
    arr(c.looks).length
      ? `<section class="card"><h2>Образы капсулы <span class="count">${arr(c.looks).length}</span></h2>
    ${arr(c.looks)
      .map((l) => {
        // Покупка или своя вещь определяется по принадлежности к списку покупок, а не по наличию фото.
        const parts = arr(l.refs)
          .map((r) => (buy.has(r) ? { item: buy.get(r), isBuy: true } : own.has(r) ? { item: own.get(r), isBuy: false } : null))
          .filter(Boolean);
        return `<article class="look"><h3>${esc(l.name)}</h3><p class="meta">${esc(l.occasion)}</p>
        <div class="look-items">${parts
          .map(
            ({ item, isBuy }) =>
              `<figure>${isBuy ? buyThumb(item) : thumb(item)}<figcaption>${esc(item.name)}${isBuy ? " (докупить)" : ""}</figcaption></figure>`,
          )
          .join("")}</div><p>${esc(l.description)}</p></article>`;
      })
      .join("")}</section>`
      : ""
  }
  ${drop.length ? `<section class="card"><h2>Пока не берём</h2><ul>${drop.map((d) => `<li><strong>${esc(own.get(d.id).name)}</strong>: ${esc(d.reason)}</li>`).join("")}</ul></section>` : ""}
  ${c.notes ? `<section class="card"><h2>Заметки</h2><p>${esc(c.notes)}</p></section>` : ""}`;
}

export function render(root) {
  const o = slice.data.options;
  const n = wardrobe.count();
  root.innerHTML = `
  <section class="card">
    <h2>Капсульный гардероб</h2>
    <p class="muted">Соберём палитру и набор вещей, которые сочетаются друг с другом, и покажем, что докупить. ${profile.hasAnalysis() ? "Учтём ваш цветотип и фигуру." : `Анализ фото ещё не сделан, поэтому ориентируемся на анкету. <a href="#profile">Сделать анализ</a>`}</p>
    <div class="form">
      <label class="field"><span>Размер капсулы, вещей</span><input type="number" min="6" max="40" data-o="size" value="${esc(o.size)}"></label>
      <label class="field"><span>Сезон</span><select data-o="season">${SEASONS.map((s) => `<option ${s === o.season ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Бюджет на докупку</span><input data-o="budget" value="${esc(o.budget)}" placeholder="например 60 000 ₽"></label>
    </div>
    <label class="check"><input type="checkbox" data-o="useWardrobe" ${o.useWardrobe ? "checked" : ""} ${n ? "" : "disabled"}> Использовать мой гардероб (${n} вещ.)</label>
    <label class="field wide"><span>Пожелания по стилю</span>
      <textarea data-wishes rows="3" placeholder="Например: минимализм, спокойные цвета, работа в офисе и путешествия">${esc(profile.wishes())}</textarea></label>
    <div class="row"><button type="button" class="primary" data-run>${slice.data.result ? "Пересобрать капсулу" : "Собрать капсулу"}</button></div>
    <div data-status data-task="capsule"></div>
  </section>
  <div data-result>${slice.data.result ? safeHtml(() => capsuleView(slice.data.result, slice.data.lock?.locked)) : ""}</div>`;

  root.querySelectorAll("[data-o]").forEach((el) =>
    el.addEventListener("change", () => {
      o[el.dataset.o] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      slice.save();
    }),
  );
  root.querySelector("[data-wishes]").addEventListener("input", (e) => profile.setWishes(e.target.value));

  const btn = root.querySelector("[data-run]");
  const resultEl = root.querySelector("[data-result]");
  const statusEl = root.querySelector("[data-status]");
  if (isRunning("capsule")) {
    btn.disabled = true;
    statusEl.innerHTML = RUNNING_NOTE;
  }

  btn.addEventListener("click", async () => {
    const useW = o.useWardrobe && n > 0;
    const ok = await runTask(statusEl, [btn], async ({ signal, onProgress, setLabel }) => {
      setLabel("Собираю капсулу");
      const r = await runServerTask(
        "capsule",
        {
          profile: profile.forServer(),
          wardrobe: useW ? wardrobe.forServer() : [],
          useWardrobe: useW,
          options: { size: o.size, season: o.season, budget: o.budget },
          wishes: profile.wishes(),
        },
        { sealed: profile.sealed(), signal, onProgress },
      );
      // Нормализуем и рисуем до сохранения: кривой ответ не должен затереть прежнюю капсулу.
      const capsule = normalizeCapsule(r.data, wardrobe.ids());
      const html = capsuleView(capsule, r.locked);
      commitCapsule(capsule, r.locked, r.sealed);
      return html;
    });
    if (typeof ok === "string") {
      if (resultEl.isConnected) resultEl.innerHTML = ok;
      if (btn.isConnected) btn.textContent = "Пересобрать капсулу";
    }
  });
}
