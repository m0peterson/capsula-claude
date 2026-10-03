import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { ANALYSIS_SYSTEM } from "../prompts.js";
import { esc, arr, fileToDataUrl } from "../util.js";
import { runTask, swatches, toast, readImages, safeHtml } from "../ui.js";
import { normalizeAnalysis } from "../normalize.js";

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

export function renderAnalysis(a) {
  if (!a) return "";
  const c = a.color_type || {};
  const b = a.body || {};
  const conf = { low: "низкая", medium: "средняя", high: "высокая" };
  return `
  <section class="card">
    <h2>Цветотип: ${esc(c.season || "не определён")}</h2>
    <p class="meta">Подтон: ${esc(c.undertone)} · Контраст: ${esc(c.contrast)} · Уверенность: ${esc(conf[c.confidence] || c.confidence)}</p>
    <p>${esc(c.reasoning)}</p>
    <h3>Ваши цвета</h3>${swatches(c.best_colors)}
    <h3>Нейтральная база</h3>${swatches(c.neutrals)}
    <h3>Лучше избегать</h3>${swatches(c.avoid_colors)}
    <p><strong>Металлы и фурнитура:</strong> ${esc(c.metals)}</p>
  </section>
  <section class="card">
    <h2>Фигура и пропорции</h2>
    <p class="meta">${esc(b.figure_type)} · ${esc(b.height_category)}${b.height_cm ? ` · ${esc(b.height_cm)} см` : ""} · Уверенность: ${esc(conf[b.confidence] || b.confidence)}</p>
    <p>${esc(b.proportions)}</p>
    ${
      arr(b.goals).length
        ? `<h3>Что балансируем</h3><ul>${arr(b.goals)
            .map((g) => `<li>${esc(g)}</li>`)
            .join("")}</ul>`
        : ""
    }
    ${b.notes ? `<p class="muted">${esc(b.notes)}</p>` : ""}
  </section>
  <section class="card">
    <h2>Подходящие стили</h2>
    <div class="cols">${arr(a.styles)
      .map((s) => `<div class="mini"><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><p class="muted">${esc(s.why)}</p></div>`)
      .join("")}</div>
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
    ${a.fabrics_prints ? `<h3>Ткани и принты</h3><p>${esc(a.fabrics_prints)}</p>` : ""}
  </section>
  <section class="card accent"><h2>Итог</h2><p>${esc(a.summary)}</p></section>`;
}

export function render(root) {
  const { profile } = state;
  root.innerHTML = `
  <section class="card">
    <h2>Ваше фото</h2>
    <p class="muted">Нужно 1-3 фото при дневном свете без фильтров: лицо крупно и в полный рост. Чем честнее свет, тем точнее цветотип. Фото хранятся только в вашем браузере и уходят к модели лишь при анализе.</p>
    <div class="photos">
      ${profile.photos.map((p, i) => `<div class="photo"><img src="${p}" alt="Фото ${i + 1}"><button type="button" class="x" data-rm="${i}" aria-label="Удалить">×</button></div>`).join("")}
      ${profile.photos.length < MAX_PHOTOS ? `<label class="drop small"><input type="file" accept="image/*" multiple hidden data-photos><span>+ Фото</span></label>` : ""}
    </div>
    <div class="form">${FIELDS.map(fieldHtml).join("")}</div>
    <label class="field wide"><span>Пожелания по стилю</span>
      <textarea data-wishes rows="3" placeholder="Например: деловой кэжуал, минимализм, без каблуков, хочу выглядеть выше">${esc(state.wishes)}</textarea>
    </label>
    <div class="row"><button type="button" class="primary" data-analyze>Проанализировать</button></div>
    <div data-status></div>
  </section>
  <div data-result>${safeHtml(() => renderAnalysis(profile.analysis))}</div>`;

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
  btn.addEventListener("click", async () => {
    const status = root.querySelector("[data-status]");
    const problem = slotProblem(settings.vision);
    if (problem) return toast(problem, "error");
    if (!profile.photos.length) return toast("Добавьте хотя бы одно фото", "error");
    const result = await runTask(status, [btn], async ({ signal, onProgress, setLabel, notice }) => {
      setLabel("Анализирую фото");
      const form = Object.entries(profile.inputs)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const { data } = await chatJson({
        slot: settings.vision,
        system: ANALYSIS_SYSTEM,
        user: `Анкета клиента:\n${form || "не заполнена"}\n\nПожелания по стилю: ${state.wishes || "нет"}\n\nФото клиента во вложении (${profile.photos.length} шт.).`,
        images: profile.photos,
        expect: ["color_type", "body"],
        signal,
        onProgress,
        onNotice: notice,
      });
      // Сначала приводим к форме и отрисовываем, и только потом сохраняем: кривой ответ не должен затереть прежний анализ.
      const analysis = normalizeAnalysis(data);
      const html = renderAnalysis(analysis);
      profile.analysis = analysis;
      save();
      return html;
    });
    // Узел берём из замыкания: за время анализа пользователь мог уйти на другую вкладку.
    if (typeof result === "string" && resultEl.isConnected) resultEl.innerHTML = result;
  });
}
