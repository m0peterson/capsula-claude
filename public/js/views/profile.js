import { state, save } from "../store.js";
import { runServerTask } from "../api.js";
import { esc, arr, fileToDataUrl } from "../util.js";
import { runTask, swatches, toast, readImages, safeHtml, isRunning, RUNNING_NOTE } from "../ui.js";
import { safeImage } from "../util.js";
import { normalizeAnalysis } from "../normalize.js";
import { lockedBlock, lockedNote, proCard, count } from "../pro.js";

const MAX_PHOTOS = 3;

const FIELDS = [
  ["gender", "Пол", "select", ["", "Женский", "Мужской", "Другое"]],
  ["age", "Возраст", "number"],
  ["height", "Рост, см", "number"],
  ["size", "Размер одежды", "text", null, "например 44 или M"],
  ["city", "Город или климат", "text", null, "Москва, умеренный"],
  ["budget", "Бюджет на покупки", "text", null, "до 50 000 ₽"],
];

function fieldHtml([key, label, type, options, placeholder]) {
  const v = state.profile.inputs[key] ?? "";
  const input =
    type === "select"
      ? `<select data-input="${key}">${options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input data-input="${key}" type="${type}" value="${esc(v)}" placeholder="${esc(placeholder || "")}">`;
  return `<label class="field"><span>${label}</span>${input}</label>`;
}

// Что именно скрыто, словами: в карточке Pro обещаем только то, что действительно есть в полном разборе.
function lockedList(L) {
  const parts = [
    (L.best_colors || L.neutrals || L.avoid_colors || L.metals) && "вся палитра с нейтралями и металлами",
    L.body && "пропорции и что балансировать",
    L.silhouettes && "силуэты по зонам",
    L.styles && "ещё стили",
    L.fabrics_prints && "ткани и принты",
    L.summary && "итог стилиста",
  ].filter(Boolean);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// lock: что скрыто в бесплатном плане (null, если результат полный).
export function renderAnalysis(a, lock = null) {
  if (!a) return "";
  const c = a.color_type || {};
  const b = a.body || {};
  const L = lock || {};
  const conf = { low: "низкая", medium: "средняя", high: "высокая" };
  const colorsSection = (title, list, hidden, what) =>
    hidden ? lockedBlock(title, what, "swatches") : arr(list).length ? `<h3>${title}</h3>${swatches(list)}` : "";
  return `
  <section class="card">
    <h2>Цветотип: ${esc(c.season || "не определён")}</h2>
    ${c.neighbor_season ? `<p class="meta">Рядом: ${esc(c.neighbor_season)}. Внешность на границе двух сезонов встречается часто, цвета обоих вам подойдут лучше остальных.</p>` : ""}
    <p class="meta">Подтон: ${esc(c.undertone)} · Контраст: ${esc(c.contrast)} · Уверенность: ${esc(conf[c.confidence] || c.confidence)}</p>
    <p>${esc(c.reasoning)}</p>
    <h3>Ваши цвета</h3>${swatches(c.best_colors)}
    ${L.best_colors ? lockedNote(`Ещё ${count(L.best_colors, "цвет", "цвета", "цветов")} в Pro`) : ""}
    ${colorsSection("Нейтральная база", c.neutrals, L.neutrals, "Нейтральная база в Pro")}
    ${colorsSection("Лучше избегать", c.avoid_colors, L.avoid_colors, "Какие цвета вам не идут, в Pro")}
    ${L.metals ? lockedNote("Металлы и фурнитура в Pro") : c.metals ? `<p><strong>Металлы и фурнитура:</strong> ${esc(c.metals)}</p>` : ""}
  </section>
  <section class="card">
    <h2>Фигура и пропорции</h2>
    <p class="meta">${esc(b.figure_type)} · ${esc(b.height_category)}${b.height_cm ? ` · ${esc(b.height_cm)} см` : ""} · Уверенность: ${esc(conf[b.confidence] || b.confidence)}</p>
    ${
      L.body
        ? lockedBlock("", "Пропорции и что балансировать, в Pro")
        : `<p>${esc(b.proportions)}</p>
    ${
      arr(b.goals).length
        ? `<h3>Что балансируем</h3><ul>${arr(b.goals)
            .map((g) => `<li>${esc(g)}</li>`)
            .join("")}</ul>`
        : ""
    }
    ${b.notes ? `<p class="muted">${esc(b.notes)}</p>` : ""}`
    }
    ${b.confidence === "low" && !b.notes ? `<p class="hint">Для точного анализа фигуры добавьте фото в полный рост в облегающей одежде и запустите анализ снова.</p>` : ""}
  </section>
  <section class="card">
    <h2>Подходящие стили</h2>
    <div class="cols">${arr(a.styles)
      .map((s) => `<div class="mini"><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><p class="muted">${esc(s.why)}</p></div>`)
      .join("")}</div>
    ${L.styles ? lockedNote(`Ещё ${count(L.styles, "стиль", "стиля", "стилей")} в Pro`) : ""}
  </section>
  <section class="card">
    <h2>Силуэты одежды</h2>
    ${arr(a.silhouettes)
      .map(
        (s) => `<div class="sil"><h3>${esc(s.zone)}</h3>
          <p><span class="tag ok">Да</span> ${esc(s.recommend)}</p>
          <p><span class="tag no">Нет</span> ${esc(s.avoid)}</p></div>`,
      )
      .join("")}
    ${L.silhouettes ? lockedBlock("", `Силуэты по ${count(L.silhouettes, "зоне", "зонам", "зонам")} в Pro`) : ""}
    ${L.fabrics_prints ? lockedNote("Ткани и принты в Pro") : a.fabrics_prints ? `<h3>Ткани и принты</h3><p>${esc(a.fabrics_prints)}</p>` : ""}
  </section>
  ${L.summary ? `<section class="card accent"><h2>Итог</h2>${lockedBlock("", "Итог стилиста в Pro")}</section>` : a.summary ? `<section class="card accent"><h2>Итог</h2><p>${esc(a.summary)}</p></section>` : ""}
  ${lock ? proCard("Полный разбор уже готов", `${lockedList(L)}. Откроется сразу, без повторного анализа.`) : ""}`;
}

export function render(root) {
  const { profile } = state;
  root.innerHTML = `
  <section class="card">
    <h2>Ваше фото</h2>
    <p class="muted">Нужно 1-3 фото: лицо крупно у окна при дневном свете, без фильтров и яркого макияжа, лучше в белой или серой одежде, и одно фото в полный рост. Цвет одежды, помады и тёплый свет лампы сбивают цветотип. Фото хранятся в вашем браузере, на сервер уходят только на время анализа и там не сохраняются.</p>
    <div class="photos">
      ${profile.photos.map((p, i) => `<div class="photo"><img src="${esc(safeImage(p))}" alt="Фото ${i + 1}"><button type="button" class="x" data-rm="${i}" aria-label="Удалить">×</button></div>`).join("")}
      ${profile.photos.length < MAX_PHOTOS ? `<label class="drop small"><input type="file" accept="image/*" multiple hidden data-photos><span>+ Фото</span></label>` : ""}
    </div>
    <div class="form">${FIELDS.map(fieldHtml).join("")}</div>
    <label class="field wide"><span>Пожелания по стилю</span>
      <textarea data-wishes rows="3" placeholder="Например: деловой кэжуал, минимализм, без каблуков, хочу выглядеть выше">${esc(state.wishes)}</textarea>
    </label>
    <div class="row"><button type="button" class="primary" data-analyze>Проанализировать</button></div>
    <div data-status data-task="profile"></div>
  </section>
  <div data-result>${safeHtml(() => renderAnalysis(profile.analysis, state.locks.analysis?.locked))}</div>`;

  readImages(root.querySelector("[data-photos]") || document.createElement("input"), async (files) => {
    try {
      for (const f of files.slice(0, MAX_PHOTOS - profile.photos.length)) profile.photos.push(await fileToDataUrl(f, 1024, 0.85));
      save();
      render(root);
    } catch (e) {
      toast(e.message, "error");
    }
  });
  root.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      profile.photos.splice(Number(b.dataset.rm), 1);
      save();
      render(root);
    }),
  );
  root.querySelectorAll("[data-input]").forEach((el) =>
    el.addEventListener("change", () => {
      profile.inputs[el.dataset.input] = el.value;
      save();
    }),
  );
  root.querySelector("[data-wishes]").addEventListener("input", (e) => {
    state.wishes = e.target.value;
    save();
  });

  const btn = root.querySelector("[data-analyze]");
  const resultEl = root.querySelector("[data-result]");
  if (isRunning("profile")) {
    btn.disabled = true;
    root.querySelector("[data-status]").innerHTML = RUNNING_NOTE;
  }

  btn.addEventListener("click", async () => {
    const status = root.querySelector("[data-status]");
    if (!profile.photos.length) return toast("Добавьте хотя бы одно фото", "error");
    const result = await runTask(status, [btn], async ({ signal, onProgress, setLabel }) => {
      setLabel("Анализирую фото");
      const r = await runServerTask(
        "analysis",
        { photos: profile.photos, inputs: profile.inputs, wishes: state.wishes },
        { signal, onProgress },
      );
      // Сначала приводим к форме и отрисовываем, и только потом сохраняем: кривой ответ не должен затереть прежний анализ.
      const analysis = normalizeAnalysis(r.data);
      const html = renderAnalysis(analysis, r.locked);
      profile.analysis = analysis;
      if (r.locked) state.locks.analysis = { locked: r.locked, sealed: r.sealed };
      else delete state.locks.analysis;
      save();
      return html;
    });
    // Узел берём из замыкания: за время анализа пользователь мог уйти на другую вкладку.
    if (typeof result === "string" && resultEl.isConnected) resultEl.innerHTML = result;
  });
}
