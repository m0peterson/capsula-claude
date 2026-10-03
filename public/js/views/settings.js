import { state, settings, saveSettings, resetAll, exportData, importData } from "../store.js";
import { EFFORTS, MODEL_SUGGESTIONS } from "../llm.js";
import { esc } from "../util.js";
import { toast } from "../ui.js";

const PROVIDER_NAMES = { openrouter: "OpenRouter", "opencode-go": "OpenCode Go", custom: "Свой провайдер (OpenAI-совместимый)" };

function slotHtml(name, title, hint) {
  const s = settings[name];
  return `<section class="card">
    <h2>${title}</h2>
    <p class="muted">${hint}</p>
    <div class="form">
      <label class="field"><span>Провайдер</span>
        <select data-slot="${name}" data-k="provider">${Object.entries(PROVIDER_NAMES)
          .map(([k, v]) => `<option value="${k}" ${k === s.provider ? "selected" : ""}>${v}</option>`)
          .join("")}</select></label>
      <label class="field"><span>Модель</span>
        <input data-slot="${name}" data-k="model" value="${esc(s.model)}" list="models-${name}" autocomplete="off" spellcheck="false">
        <datalist id="models-${name}">${(MODEL_SUGGESTIONS[s.provider] || []).map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
      <label class="field"><span>Режим рассуждения (effort)</span>
        <select data-slot="${name}" data-k="effort">${EFFORTS.map((e) => `<option value="${e}" ${e === s.effort ? "selected" : ""}>${e || "не передавать"}</option>`).join("")}</select></label>
      <label class="field"><span>Лимит ответа, токенов (0 = не передавать)</span>
        <input type="number" min="0" step="1000" data-slot="${name}" data-k="maxTokens" value="${esc(s.maxTokens ?? "")}" placeholder="0 = не передавать"></label>
    </div>
    <p class="muted">Лимит ответа включает рассуждения. При effort <code>xhigh</code> часть провайдеров отдаёт рассуждениям до 95% лимита, поэтому ставьте с большим запасом (от 32000) или оставьте 0.</p>
  </section>`;
}

export function render(root, ctx) {
  const sc = ctx.serverConfig;
  const pilot =
    sc &&
    Object.entries(sc.serverKeys)
      .filter(([, v]) => v)
      .map(([k]) => PROVIDER_NAMES[k]);
  const p = settings.providers;

  root.innerHTML = `
  <section class="card">
    <h2>Ключи API</h2>
    <p class="muted">Ключи хранятся только в этом браузере (localStorage) и передаются через ваш прокси к провайдеру. Если ключ не указан, используется токен пилота с сервера.</p>
    ${pilot?.length ? `<p class="hint">На сервере настроен токен пилота: ${pilot.join(", ")}.${sc.accessCodeRequired ? " Нужен код доступа." : ""}</p>` : `<p class="hint">Токен пилота на сервере не настроен. Добавьте свой ключ ниже.</p>`}
    ${sc?.accessCodeRequired ? `<label class="field wide"><span>Код доступа к пилоту</span><input type="password" data-access value="${esc(settings.accessCode)}" autocomplete="off"></label>` : ""}
    <div class="form">
      <label class="field"><span>OpenRouter API key</span><input type="password" data-key="openrouter" value="${esc(p.openrouter.apiKey)}" placeholder="sk-or-..." autocomplete="off"></label>
      <label class="field"><span>OpenCode Go API key</span><input type="password" data-key="opencode-go" value="${esc(p["opencode-go"].apiKey)}" autocomplete="off"></label>
      <label class="field"><span>Свой провайдер: Base URL</span><input data-base value="${esc(p.custom.baseUrl)}" placeholder="https://api.example.com/v1"></label>
      <label class="field"><span>Свой провайдер: ключ</span><input type="password" data-key="custom" value="${esc(p.custom.apiKey)}" autocomplete="off"></label>
    </div>
  </section>
  ${slotHtml("vision", "Модель для фото", "Получает фотографии: анализ клиента и распознавание вещей. Нужна модель с поддержкой изображений.")}
  ${slotHtml("stylist", "Модель стилиста", "Работает с текстом: образы, капсула, поиск. Веб-поиск доступен только через OpenRouter.")}
  <section class="card warn">
    <h3>Приватность</h3>
    <p>Модели с суффиксом <code>-contributor</code> дешевле, потому что провайдер вправе использовать запросы и ответы для обучения. Фото клиентов и их данные лучше отправлять на обычные версии моделей. Для пилота с реальными клиентами это обязательно проверить.</p>
  </section>
  <section class="card">
    <h2>Данные</h2>
    <p class="muted">Фото, гардероб и результаты лежат в этом браузере. Если очистить данные сайта, они пропадут, поэтому сохраняйте копию.</p>
    <div class="row">
      <button type="button" data-export>Скачать копию</button>
      <label class="btn"><input type="file" accept="application/json" hidden data-import>Загрузить копию</label>
      <button type="button" class="danger" data-reset>Удалить все данные</button>
    </div>
  </section>`;

  root.querySelector("[data-access]")?.addEventListener("input", (e) => {
    settings.accessCode = e.target.value.trim();
    saveSettings();
  });
  root.querySelectorAll("[data-key]").forEach((el) =>
    el.addEventListener("input", () => {
      settings.providers[el.dataset.key].apiKey = el.value.trim();
      saveSettings();
    }),
  );
  root.querySelector("[data-base]").addEventListener("input", (e) => {
    settings.providers.custom.baseUrl = e.target.value.trim();
    saveSettings();
  });
  root.querySelectorAll("[data-slot]").forEach((el) =>
    el.addEventListener("change", () => {
      if (el.type === "number") {
        // Лимит токенов: целое, не меньше нуля. 0 значит «не передавать».
        const n = Math.max(0, Math.floor(Number(el.value) || 0));
        el.value = n;
        settings[el.dataset.slot][el.dataset.k] = n;
      } else {
        settings[el.dataset.slot][el.dataset.k] = el.value.trim();
      }
      saveSettings();
      if (el.dataset.k === "provider") render(root, ctx); // обновить подсказки моделей
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
      await importData(await file.text());
      toast("Копия загружена");
    } catch (err) {
      toast(`Не удалось загрузить: ${err.message}`, "error");
    }
  });
  root.querySelector("[data-reset]").addEventListener("click", async () => {
    if (!confirm("Удалить фото, гардероб и все результаты из этого браузера? Настройки и ключи останутся.")) return;
    await resetAll();
    toast("Данные удалены");
  });
}
