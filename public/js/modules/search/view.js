import { runServerTask, serverConfig, isLimited } from "../../core/api.js";
import { runTask, isRunning, RUNNING_NOTE } from "../../core/tasks.js";
import { openPaywall } from "../../core/paywall.js";
import { esc, safeUrl } from "../../lib/html.js";
import { arr, isRecord } from "../../lib/coerce.js";
import { catLabel } from "../../shared/catalog.js";
import { toast, emptyState, safeHtml } from "../../ui/components.js";
import * as profile from "../profile/api.js";
import { buyList } from "../capsule/api.js";
import { slice, remember } from "./model.js";
import { normalizeSearch } from "./schema.js";
import { SHOPS } from "./shops.js";

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
  const buy = buyList();
  const wanted = (ctx.param && buy.find((b) => b.id === ctx.param)) || null;
  const selected = wanted || buy[0] || null;
  // Если пришли из капсулы по ссылке, берём запрос вещи. Иначе показываем тот, по которому искали в прошлый раз.
  const queryDefault = wanted?.search_query || slice.data.last || selected?.search_query || "";
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
    resultsEl.innerHTML = safeHtml(() => resultsHtml(slice.data.cache[q.value.trim()]));
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
      const palette = profile.palette();
      let r;
      try {
        r = await runServerTask(
          "search",
          { query: text, item, palette, budget: profile.inputs().budget, city: profile.inputs().city },
          { signal, onProgress },
        );
      } catch (e) {
        if (e.code === "pro_required") openPaywall();
        throw e;
      }
      remember(text, normalizeSearch(r.data?.results), Boolean(r.data?.verified));
    });
    if (ok && resultsEl.isConnected) paintResults();
  });
}
