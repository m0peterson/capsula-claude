import { state, settings, save } from "../store.js";
import { chatJson, slotProblem } from "../llm.js";
import { SEARCH_SYSTEM } from "../prompts.js";
import { SHOPS } from "../shops.js";
import { esc, arr, safeUrl, isRecord } from "../util.js";
import { normalizeSearch } from "../normalize.js";
import { runTask, toast, catLabel, emptyState, safeHtml, isRunning, RUNNING_NOTE } from "../ui.js";

function resultsHtml(entry) {
  if (!entry) return "";
  const rows = arr(entry.results)
    .filter(isRecord)
    .map((r) => ({ ...r, href: safeUrl(r.url) }))
    .filter((r) => r.href);
  if (!rows.length) return `<p class="muted">Модель не нашла подходящих ссылок. Попробуйте магазины выше.</p>`;
  return `
  ${entry.verified ? "" : `<p class="hint">Провайдер не передал список источников веб-поиска, поэтому ссылки не проверены. Откройте и убедитесь, что товар существует.</p>`}
  <div class="results">${rows
    .map(
      (r) => `<a class="result" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer nofollow">
        <strong>${esc(r.title)}</strong>
        <span class="meta">${esc(r.shop || new URL(r.href).hostname)}${r.price ? ` · ${esc(r.price)}` : ""}</span>
        <span class="muted">${esc(r.why)}</span></a>`,
    )
    .join("")}</div>`;
}

export function render(root, ctx) {
  const buy = arr(state.capsule?.buy);
  const wanted = (ctx.param && buy.find((b) => b.id === ctx.param)) || null;
  const selected = wanted || buy[0] || null;
  const queryDefault = selected?.search_query || "";

  root.innerHTML = `
  <section class="card">
    <h2>Поиск вещей</h2>
    ${
      buy.length
        ? `<label class="field wide"><span>Вещь из капсулы</span>
      <select data-pick>${buy.map((b) => `<option value="${esc(b.id)}" ${selected?.id === b.id ? "selected" : ""}>${esc(b.name)} (${esc(catLabel(b.category))})</option>`).join("")}</select></label>`
        : emptyState(
            `Список покупок появится после сборки капсулы. Пока можно искать по своему запросу. <a href="#capsule">Собрать капсулу</a>`,
          )
    }
    <label class="field wide"><span>Поисковый запрос</span><input data-q value="${esc(queryDefault)}" placeholder="например: бежевый тренч прямой оверсайз"></label>
    <h3>Открыть в магазинах</h3>
    <div class="shops" data-shops></div>
    <h3>Найти конкретные модели с помощью ИИ</h3>
    <p class="muted">Модель сама ищет в интернете и приносит ссылки на товары с описанием. ${settings.stylist.provider === "openrouter" ? "" : `<strong>Работает только с OpenRouter, у вас в слоте стилиста выбран другой провайдер.</strong>`}</p>
    <div class="row"><button type="button" class="primary" data-ai ${settings.stylist.provider === "openrouter" ? "" : "disabled"}>Искать с ИИ</button></div>
    <div data-status data-task="search"></div>
    <div data-results></div>
  </section>`;

  const q = root.querySelector("[data-q]");
  const paintShops = () => {
    const text = q.value.trim();
    root.querySelector("[data-shops]").innerHTML = text
      ? SHOPS.map((s) => `<a class="btn" href="${esc(s.url(text))}" target="_blank" rel="noopener noreferrer">${s.name}</a>`).join("")
      : `<span class="muted">Введите запрос.</span>`;
  };
  const current = () => buy.find((b) => b.id === root.querySelector("[data-pick]")?.value) || selected;
  const resultsEl = root.querySelector("[data-results]");
  const paintResults = () => {
    resultsEl.innerHTML = safeHtml(() => resultsHtml(state.search[q.value.trim()]));
  };
  paintShops();
  paintResults();
  q.addEventListener("input", () => {
    paintShops();
    paintResults();
  });
  root.querySelector("[data-pick]")?.addEventListener("change", () => {
    q.value = current()?.search_query || "";
    paintShops();
    paintResults();
  });

  const btn = root.querySelector("[data-ai]");
  if (isRunning("search")) {
    btn.disabled = true;
    root.querySelector("[data-status]").innerHTML = RUNNING_NOTE;
  }
  btn.addEventListener("click", async () => {
    const text = q.value.trim();
    if (!text) return toast("Введите запрос", "error");
    const problem = slotProblem(settings.stylist);
    if (problem) return toast(problem, "error");
    const item = current();
    const ok = await runTask(root.querySelector("[data-status]"), [btn], async ({ signal, onProgress, setLabel, notice }) => {
      setLabel("Ищу в интернете");
      const palette = arr(state.profile.analysis?.color_type?.best_colors)
        .filter(isRecord)
        .map((c) => c.name)
        .join(", ");
      const { data, annotations } = await chatJson({
        slot: settings.stylist,
        system: SEARCH_SYSTEM,
        user: `Запрос: ${text}\n${item?.description ? `Описание вещи: ${item.description}\n` : ""}${item?.color ? `Цвет: ${item.color}\n` : ""}Цвета клиента: ${palette || "не определены"}\nБюджет: ${item?.price_range || state.profile.inputs.budget || "не указан"}\nРегион и магазины: ${state.profile.inputs.city || "Россия"}, нужны магазины с доставкой туда.`,
        extra: { plugins: [{ id: "web", max_results: 10 }] },
        expect: ["results"],
        signal,
        onProgress,
        onNotice: notice,
      });
      let results = normalizeSearch(data);
      const key = (u) => {
        const href = safeUrl(u);
        if (!href) return "";
        const x = new URL(href);
        return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "");
      };
      const cited = new Set(
        arr(annotations)
          .filter(isRecord)
          .map((a) => key(a.url_citation?.url || a.url))
          .filter(Boolean),
      );
      // Если источники известны, оставляем только ссылки из реальной выдачи поиска.
      // Если после фильтра ничего не осталось, показываем всё, но помечаем как непроверенное.
      const confirmed = results.filter((r) => cited.has(key(r.url)));
      const verified = confirmed.length > 0;
      if (verified) results = confirmed;
      state.search[text] = { results, verified, at: Date.now() };
      save();
    });
    if (ok && resultsEl.isConnected) paintResults();
  });
}
