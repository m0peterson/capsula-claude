import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { CAPSULE_SYSTEM, profileBrief, wardrobeBrief } from "../prompts.js";
import { esc, arr, safeHex } from "../util.js";
import { runTask, thumb, toast, swatches, catLabel, PRIORITY, safeHtml, isRunning, RUNNING_NOTE } from "../ui.js";
import { normalizeCapsule } from "../normalize.js";

const SEASONS = ["Круглый год", "Весна-лето", "Осень-зима", "Зима", "Лето"];

function refOf(ref, wardrobe, buy) {
  return wardrobe.get(ref) || buy.get(ref) || null;
}

function buyThumb(b) {
  return `<div class="thumb ph buy" style="background:${safeHex(b.color_hex)}" title="${esc(b.color)}"><span>${esc(catLabel(b.category))}</span></div>`;
}

function capsuleView(c) {
  const wardrobe = new Map(state.wardrobe.map((w) => [w.id, w]));
  const buy = new Map(arr(c.buy).map((b) => [b.id, b]));
  const keep = arr(c.keep).filter((k) => wardrobe.has(k.id));
  const drop = arr(c.drop).filter((k) => wardrobe.has(k.id));
  const label = (ref) => refOf(ref, wardrobe, buy)?.name;

  return `
  <section class="card accent"><h2>Концепция</h2><p>${esc(c.concept)}</p>${swatches(c.palette)}</section>
  ${
    keep.length
      ? `<section class="card"><h2>Берём из вашего гардероба <span class="count">${keep.length}</span></h2>
    <div class="items">${keep
      .map((k) => {
        const w = wardrobe.get(k.id);
        return `<article class="item">${thumb(w)}<div class="item-body"><strong>${esc(w.name)}</strong><span class="muted">${esc(k.role)}</span></div></article>`;
      })
      .join("")}</div></section>`
      : ""
  }
  <section class="card"><h2>Что докупить <span class="count">${arr(c.buy).length}</span></h2>
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
      .join("")}</div></section>
  <section class="card"><h2>Образы капсулы <span class="count">${arr(c.looks).length}</span></h2>
    ${arr(c.looks)
      .map((l) => {
        // Покупка или своя вещь определяется по принадлежности к списку покупок, а не по наличию фото.
        const parts = arr(l.refs)
          .map((r) => (buy.has(r) ? { item: buy.get(r), isBuy: true } : wardrobe.has(r) ? { item: wardrobe.get(r), isBuy: false } : null))
          .filter(Boolean);
        return `<article class="look"><h3>${esc(l.name)}</h3><p class="meta">${esc(l.occasion)}</p>
        <div class="look-items">${parts
          .map(
            ({ item, isBuy }) =>
              `<figure>${isBuy ? buyThumb(item) : thumb(item)}<figcaption>${esc(item.name)}${isBuy ? " (докупить)" : ""}</figcaption></figure>`,
          )
          .join("")}</div><p>${esc(l.description)}</p></article>`;
      })
      .join("")}</section>
  ${drop.length ? `<section class="card"><h2>Пока не берём</h2><ul>${drop.map((d) => `<li><strong>${esc(wardrobe.get(d.id).name)}</strong>: ${esc(d.reason)}</li>`).join("")}</ul></section>` : ""}
  ${c.notes ? `<section class="card"><h2>Заметки</h2><p>${esc(c.notes)}</p></section>` : ""}`;
}

export function render(root) {
  const o = state.capsuleOptions || (state.capsuleOptions = { size: 15, season: SEASONS[0], budget: "", useWardrobe: true });
  const n = state.wardrobe.length;
  root.innerHTML = `
  <section class="card">
    <h2>Капсульный гардероб</h2>
    <p class="muted">Соберём палитру и набор вещей, которые сочетаются друг с другом, и покажем, что докупить. ${state.profile.analysis ? "Учтём ваш цветотип и фигуру." : `Анализ фото ещё не сделан, поэтому ориентируемся на анкету. <a href="#profile">Сделать анализ</a>`}</p>
    <div class="form">
      <label class="field"><span>Размер капсулы, вещей</span><input type="number" min="6" max="40" data-o="size" value="${esc(o.size)}"></label>
      <label class="field"><span>Сезон</span><select data-o="season">${SEASONS.map((s) => `<option ${s === o.season ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Бюджет на докупку</span><input data-o="budget" value="${esc(o.budget)}" placeholder="например 60 000 ₽"></label>
    </div>
    <label class="check"><input type="checkbox" data-o="useWardrobe" ${o.useWardrobe ? "checked" : ""} ${n ? "" : "disabled"}> Использовать мой гардероб (${n} вещ.)</label>
    <label class="field wide"><span>Пожелания по стилю</span>
      <textarea data-wishes rows="3" placeholder="Например: минимализм, спокойные цвета, работа в офисе и путешествия">${esc(state.wishes)}</textarea></label>
    <div class="row"><button type="button" class="primary" data-run>${state.capsule ? "Пересобрать капсулу" : "Собрать капсулу"}</button></div>
    <div data-status data-task="capsule"></div>
  </section>
  <div data-result>${state.capsule ? safeHtml(() => capsuleView(state.capsule)) : ""}</div>`;

  root.querySelectorAll("[data-o]").forEach((el) =>
    el.addEventListener("change", () => {
      o[el.dataset.o] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      save();
    }),
  );
  root.querySelector("[data-wishes]").addEventListener("input", (e) => {
    state.wishes = e.target.value;
    save();
  });

  const btn = root.querySelector("[data-run]");
  const resultEl = root.querySelector("[data-result]");
  const statusEl = root.querySelector("[data-status]");
  if (isRunning("capsule")) {
    btn.disabled = true;
    statusEl.innerHTML = RUNNING_NOTE;
  }

  btn.addEventListener("click", async () => {
    const problem = slotProblem(settings.stylist);
    if (problem) return toast(problem, "error");
    const useW = o.useWardrobe && n > 0;
    const ok = await runTask(statusEl, [btn], async ({ signal, onProgress, setLabel, notice }) => {
      setLabel("Собираю капсулу");
      const { data } = await chatJson({
        slot: settings.stylist,
        system: CAPSULE_SYSTEM,
        user: `Клиент:\n${profileBrief(state)}\n\nГардероб клиента (id: описание):\n${useW ? wardrobeBrief(state.wardrobe) : "Не используем, собираем капсулу с нуля."}\n\nЗапрос:\n- размер капсулы: до ${o.size} вещей\n- сезон: ${o.season}\n- бюджет на докупку: ${o.budget || "не ограничен"}\n- пожелания: ${state.wishes || "нет"}`,
        expect: ["buy", "keep", "concept"],
        signal,
        onProgress,
        onNotice: notice,
      });
      // Нормализуем и рисуем до сохранения: кривой ответ не должен затереть прежнюю капсулу.
      const capsule = normalizeCapsule(data, new Set(state.wardrobe.map((w) => w.id)));
      const html = capsuleView(capsule);
      state.capsule = capsule;
      state.search = {};
      save();
      return html;
    });
    if (typeof ok === "string") {
      if (resultEl.isConnected) resultEl.innerHTML = ok;
      if (btn.isConnected) btn.textContent = "Пересобрать капсулу";
    }
  });
}
