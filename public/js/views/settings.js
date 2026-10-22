import { settings, saveSettings, resetAll, exportData, importData } from "../store.js";
import { serverConfig, isPro } from "../api.js";
import { esc } from "../util.js";
import { toast } from "../ui.js";
import { activate, openPaywall, proUntilText } from "../pro.js";

const EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh"];
const PROVIDER_NAMES = { "": "как на сервере", openrouter: "OpenRouter", "opencode-go": "OpenCode Go" };
const MODEL_SUGGESTIONS = [
  "deepseek/deepseek-v4.1-flash",
  "openai/gpt-6-luna",
  "z-ai/glm-5.3-flash",
  "anthropic/claude-haiku-5.5",
  "google/gemini-4-argon",
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "qwen3.8-flash",
];

function planHtml() {
  const cfg = serverConfig();
  if (settings.devCode) {
    return `<p>Включён режим разработчика: все результаты открыты, модели можно подменять ниже.</p>
      <div class="row"><button type="button" data-dev-off>Выключить режим разработчика</button></div>`;
  }
  if (isPro()) return `<p><span class="tag pro">Pro</span> ${esc(proUntilText())}</p>`;
  if (!cfg?.paywall) return `<p class="muted">На этом сервере всё открыто бесплатно.</p>`;
  return `<p>Сейчас бесплатный план: видна часть палитры, первые два образа и три главные покупки капсулы.</p>
    <div class="row"><button type="button" class="primary" data-paywall>Получить Pro${cfg.price ? ` · ${esc(cfg.price)}` : ""}</button></div>`;
}

function devHtml() {
  if (!settings.devCode) return "";
  const d = settings.dev;
  const slot = (name, title) => `<fieldset class="form"><legend>${title}</legend>
    <label class="field"><span>Модель</span><input data-dev="${name}.model" value="${esc(d[name].model)}" list="dev-models" placeholder="как на сервере" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Effort</span><select data-dev="${name}.effort">${EFFORTS.map((e) => `<option value="${e}" ${e === d[name].effort ? "selected" : ""}>${e || "как на сервере"}</option>`).join("")}</select></label>
  </fieldset>`;
  return `<section class="card">
    <h2>Модели (разработчик)</h2>
    <p class="muted">Подмена действует только для запросов из этого браузера. Пустое поле значит «как на сервере».</p>
    <label class="field"><span>Провайдер</span><select data-dev="provider">${Object.entries(PROVIDER_NAMES)
      .map(([k, v]) => `<option value="${k}" ${k === d.provider ? "selected" : ""}>${v}</option>`)
      .join("")}</select></label>
    ${slot("vision", "Фото: анализ и распознавание вещей")}
    ${slot("text", "Текст: образы, капсула, поиск")}
    <datalist id="dev-models">${MODEL_SUGGESTIONS.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
  </section>`;
}

export function render(root) {
  root.innerHTML = `
  <section class="card">
    <h2>Подписка</h2>
    ${planHtml()}
    <details class="code-entry"><summary>Ввести код</summary>
      <div class="row"><input data-code autocomplete="off" spellcheck="false" placeholder="Код Pro или код разработчика"><button type="button" data-activate>Активировать</button></div>
    </details>
  </section>
  ${devHtml()}
  <section class="card">
    <h2>Данные</h2>
    <p class="muted">Фото, гардероб и результаты лежат только в этом браузере. Если очистить данные сайта, они пропадут, поэтому сохраняйте копию.</p>
    <div class="row">
      <button type="button" data-export>Скачать копию</button>
      <label class="btn"><input type="file" accept="application/json" hidden data-import>Загрузить копию</label>
      <button type="button" class="danger" data-reset>Удалить все данные</button>
    </div>
  </section>`;

  const codeInput = root.querySelector("[data-code]");
  const activateBtn = root.querySelector("[data-activate]");
  const go = async () => {
    if (!codeInput.value.trim()) return codeInput.focus();
    activateBtn.disabled = true;
    try {
      const r = await activate(codeInput.value);
      toast(r.admin ? "Режим разработчика включён" : `Pro активирован до ${new Date(r.until).toLocaleDateString("ru-RU")}`);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      activateBtn.disabled = false;
    }
  };
  activateBtn.addEventListener("click", go);
  codeInput.addEventListener("keydown", (e) => e.key === "Enter" && go());

  root.querySelector("[data-dev-off]")?.addEventListener("click", () => {
    settings.devCode = "";
    saveSettings();
    window.dispatchEvent(new CustomEvent("capsula:plan"));
  });
  root.querySelectorAll("[data-dev]").forEach((el) =>
    el.addEventListener("change", () => {
      const [a, b] = el.dataset.dev.split(".");
      if (b) settings.dev[a][b] = el.value.trim();
      else settings.dev[a] = el.value;
      saveSettings();
    }),
  );

  root.querySelector("[data-export]").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([exportData()], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `capsula-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  });
  root.querySelector("[data-import]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { droppedImages } = await importData(await file.text());
      toast(droppedImages ? `Копия загружена. Картинок отброшено как небезопасные или повреждённые: ${droppedImages}` : "Копия загружена");
    } catch (err) {
      toast(`Не удалось загрузить: ${err.message}`, "error");
    }
  });
  root.querySelector("[data-reset]").addEventListener("click", async () => {
    if (!confirm("Удалить фото, гардероб и все результаты из этого браузера? Подписка останется.")) return;
    await resetAll();
    toast("Данные удалены");
  });
  // Ссылка #settings/pro сразу открывает окно Pro: удобно для рекламы и рассылок.
  if (location.hash === "#settings/pro" && !isPro()) openPaywall();
}
