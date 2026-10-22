import { state, save } from "../store.js";
import { runServerTask, serverConfig, isLimited } from "../api.js";
import { SHOPS } from "../shops.js";
import { esc, arr, safeUrl, isRecord } from "../util.js";
import { normalizeSearch } from "../normalize.js";
import { runTask, toast, catLabel, emptyState, safeHtml, isRunning, RUNNING_NOTE } from "../ui.js";
import { openPaywall } from "../pro.js";

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
  // Если пришли из капсулы по ссылке, берём запрос вещи. Иначе показываем тот, по которому искали в прошлый раз.
  const queryDefault = wanted?.search_query || state.searchLast || selected?.search_query || "";
  const webSearch = serverConfig()?.webSearch !== false;

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
    <h3>Найти конкретные модели с помощью ИИ ${isLimited() ? `<span class="tag pro">Pro</span>` : ""}</h3>
    <p class="muted">ИИ сам ищет в интернете и приносит ссылки на товары под ваш цветотип и бюджет. ${webSearch ? "" : `<strong>На этом сервере веб-поиск не подключён.</strong>`}</p>
    <div class="row"><button type="button" class="primary" data-ai ${webSearch ? "" : "disabled"}>Искать с ИИ</button></div>
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
    if (isLimited()) return openPaywall();
    const item = current();
    const ok = await runTask(root.querySelector("[data-status]"), [btn], async ({ signal, onProgress, setLabel }) => {
      setLabel("Ищу в интернете");
      const palette = arr(state.profile.analysis?.color_type?.best_colors)
        .filter(isRecord)
        .map((c) => c.name);
      let r;
      try {
        r = await runServerTask(
          "search",
          { query: text, item, palette, budget: state.profile.inputs.budget, city: state.profile.inputs.city },
          { signal, onProgress },
        );
      } catch (e) {
        if (e.code === "pro_required") openPaywall();
        throw e;
      }
      state.search[text] = { results: normalizeSearch(r.data?.results), verified: Boolean(r.data?.verified), at: Date.now() };
      state.searchLast = text;
      save();
    });
    if (ok && resultsEl.isConnected) paintResults();
  });
}
