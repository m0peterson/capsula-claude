import { devlogEntries, clearDevlog } from "../../core/devlog.js";
import { serverConfig } from "../../core/api.js";
import { esc } from "../../lib/html.js";
import { count } from "../../lib/plural.js";
import { toast } from "../../ui/components.js";

// Открытые записи и фильтр переживают перерисовку: журнал обновляется на каждое событие задачи.
const view = { root: null, open: new Set(), openMore: new Set(), errorsOnly: false };

const sec = (ms) => (ms == null ? "?" : ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);
const usd = (v) => (v == null || v === "" ? "" : `$${Number(v).toFixed(Number(v) < 0.01 ? 5 : 3)}`);
const time = (at) => new Date(at).toLocaleTimeString("ru-RU");
const pre = (text) => `<pre>${esc(text)}</pre>`;
const json = (v) => JSON.stringify(v, null, 2);

const STATUS = {
  running: ["идёт", "run"],
  ok: ["готово", "ok"],
  error: ["ошибка", "no"],
  cancelled: ["отменено", ""],
  interrupted: ["прервано", ""],
};

function usageText(u) {
  if (!u) return "";
  const parts = [`${u.in ?? u.prompt_tokens ?? "?"} → ${u.out ?? u.completion_tokens ?? "?"} ток.`];
  const r = u.reasoning ?? u.completion_tokens_details?.reasoning_tokens;
  if (r) parts.push(`рассуждения ${r}`);
  if (u.cost != null) parts.push(usd(u.cost));
  return parts.join(", ");
}

const callTag = (e) => (e.call && e.call !== "main" ? ` [${e.call}]` : "");

// Одна строка ленты событий.
function describe(e) {
  switch (e.type) {
    case "client.request":
      return `браузер → сервер, попытка ${e.attempt}: HTTP ${e.status} за ${sec(e.ms)}, ${e.kb} КБ${e.rid ? `, код ${e.rid}` : ""}`;
    case "client.retry":
      return `браузер повторяет задачу: ${e.reason}`;
    case "task.start":
      return `${e.provider} · ${e.model}${e.fallback ? ` (запасная ${e.fallback})` : ""} · effort ${e.effort || "-"} · план ${e.plan}${e.dataCollection ? ` · data_collection ${e.dataCollection}` : ""}${e.images ? ` · фото: ${e.images.join(", ")}` : ""} · промпт ${e.systemChars}+${e.userChars} зн.`;
    case "task.prompt":
      return "промпт собран (ниже)";
    case "llm.request": {
      const p = e.params || {};
      const flags = Object.keys(p)
        .filter((k) => !["model", "messages", "input", "instructions", "stream"].includes(k))
        .map((k) => `${k}=${typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k]}`)
        .join(" ");
      return `→ ${e.protocol} #${e.attempt} ${p.model} · ${e.kb} КБ · ${flags}`;
    }
    case "llm.response":
      return `← #${e.attempt} HTTP ${e.status} за ${sec(e.ms)}`;
    case "llm.retry":
      return `↻ #${e.attempt} повтор через ${sec(e.waitMs)}: ${e.reason}${e.status ? ` (${e.status})` : ""}`;
    case "llm.adjust":
      return `⚙ #${e.attempt} ${e.change}: ${e.because}`;
    case "llm.error":
      return `✗ #${e.attempt} ${e.status ? `HTTP ${e.status}: ` : ""}${e.error}`;
    case "llm.done":
      return `✓ модель ответила за ${sec(e.ms)} (первый токен ${sec(e.firstTokenMs)}) · ${e.chars} зн.${e.thought ? `, рассуждения ${e.thought} зн.` : ""} · finish ${e.finish}${e.truncated ? " · ОБРЕЗАН" : ""}${e.annotations ? ` · источников ${e.annotations}` : ""} · ${usageText(e.usage)}${e.model && e.model !== e.requested ? ` · ответила ${e.model}` : ""}${e.served ? ` [${e.served}]` : ""}`;
    case "llm.raw":
      return `ответ модели: ${e.text?.length ?? 0} зн. (ниже)`;
    case "parse":
      return `${e.ok ? "JSON разобран" : "JSON не разобран"}${e.repaired ? ", починен" : ""}${e.nested ? ", вложенный" : ""}${e.error ? `: ${e.error}` : ""}`;
    case "shape":
      return `ответ не подошёл интерфейсу: ${e.error}`;
    case "notice":
      return `уведомление: ${e.message}`;
    case "task":
      return `${e.ok ? "■ готово" : "■ ошибка"} за ${sec(e.ms)}${e.usage ? ` · ${usageText(e.usage)}` : ""}${e.error ? ` · ${e.error}` : ""}`;
    default:
      return `${e.type} ${JSON.stringify(e)}`;
  }
}

function entryHtml(x) {
  const [label, cls] = STATUS[x.status] || [x.status, ""];
  const ev = x.events || [];
  const prompt = ev.find((e) => e.type === "task.prompt");
  const raws = ev.filter((e) => e.type === "llm.raw");
  const requests = ev.filter((e) => e.type === "llm.request");
  const errors = ev.filter((e) => e.type === "llm.error" && e.detail);
  const head = [
    `<span class="tag ${cls}">${label}</span>`,
    `<strong>${esc(x.task)}</strong>`,
    esc(time(x.at)),
    x.ms != null ? sec(x.ms) : "",
    esc(x.served || x.model || ""),
    esc(usageText(x.usage)),
    x.rids?.length ? `<code>${esc(x.rids.join(", "))}</code>` : "",
  ].filter(Boolean);
  const details = (key, title, body) =>
    `<details class="log-more" data-more="${esc(`${x.id}|${key}`)}" ${view.openMore.has(`${x.id}|${key}`) ? "open" : ""}><summary>${title}</summary>${body}</details>`;
  return `<details class="log-entry" data-id="${esc(x.id)}" ${view.open.has(x.id) ? "open" : ""}>
    <summary>${head.join(" · ")}</summary>
    <div class="log-body">
      ${x.error ? `<div class="error">${esc(x.error)}</div>` : ""}
      ${
        ev.length
          ? `<table class="log-timeline"><tbody>${ev
              .map(
                (e) =>
                  `<tr class="${/error|retry/.test(e.type) || e.ok === false ? "bad" : ""}"><td>+${sec(e.at ?? e.t)}</td><td>${esc(describe(e))}${esc(callTag(e))}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : `<p class="muted">Событий от сервера нет: задача не дошла до модели или сервер старой версии.</p>`
      }
      ${prompt ? details("system", `Промпт: system (${prompt.system.length} зн.)`, pre(prompt.system)) : ""}
      ${prompt ? details("user", `Промпт: user (${prompt.user.length} зн.)`, pre(prompt.user)) : ""}
      ${raws.map((r) => details(`raw-${r.call}-${r.attempt}`, `Ответ модели${esc(callTag(r))}, попытка ${r.attempt} (${r.text?.length ?? 0} зн.)`, pre(r.text || ""))).join("")}
      ${errors.map((r) => details(`err-${r.call}-${r.attempt}`, `Ошибка провайдера${esc(callTag(r))}, попытка ${r.attempt}`, pre(r.detail))).join("")}
      ${requests.length ? details("params", "Параметры запросов к модели", pre(json(requests.map((r) => r.params)))) : ""}
      ${details("input", "Вход задачи (фото заменены размером)", pre(json(x.input)))}
      <div class="row"><button type="button" class="btn small" data-copy="${esc(x.id)}">Скопировать запись</button></div>
    </div>
  </details>`;
}

function statsHtml(list) {
  const done = list.filter((x) => x.status === "ok" || x.status === "error");
  if (!done.length) return "";
  const errors = done.filter((x) => x.status === "error").length;
  const cost = done.reduce((s, x) => s + (Number(x.usage?.cost) || 0), 0);
  const times = done.map((x) => x.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  return `<p class="meta">${count(done.length, "задача", "задачи", "задач")}, ошибок ${errors}, медиана ${sec(median)}${cost ? `, всего ${usd(cost)}` : ""}</p>`;
}

function serverHtml() {
  const d = serverConfig()?.dev;
  if (!d) return "";
  const slots = d.slots?.[d.provider] || {};
  const line = Object.entries(slots)
    .map(([k, s]) => `${k}: ${s.model}${s.effort ? ` (${s.effort})` : ""}`)
    .join(" · ");
  return `<p class="meta">Сервер: ${esc(d.provider)} · ${esc(line)} · LOG_LEVEL=${esc(d.logLevel || "info")}</p>`;
}

// Перерисовывает журнал, только если вкладка «Логи» сейчас на экране: корень общий у всех вкладок.
function paint() {
  const listEl = view.root?.querySelector("[data-devlog-list]");
  if (!listEl?.isConnected) return;
  const all = devlogEntries();
  const list = view.errorsOnly ? all.filter((x) => x.status === "error") : all;
  view.root.querySelector("[data-devlog-stats]").innerHTML = statsHtml(all);
  listEl.innerHTML = list.length
    ? list.map(entryHtml).join("")
    : `<div class="empty"><p>${all.length ? "Ошибок нет." : "Пока пусто. Запустите любую задачу: анализ, гардероб, образы, капсулу или поиск."}</p></div>`;
}

export function refresh() {
  paint();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Скопировано");
  } catch {
    toast("Не удалось скопировать: браузер не дал доступ к буферу обмена", "error");
  }
}

export function render(root, { param } = {}) {
  view.root = root;
  root.innerHTML = `
  <section class="card">
    <h2>Логи</h2>
    <p class="muted">Последние задачи из этого браузера: промпт, каждый запрос к модели, статусы, повторы, токены, цена и сырой ответ. Фото в журнал не попадают.
    Логи сервера: терминал <code>npm run dev</code> и файл <code>.logs/api.jsonl</code>; на Cloudflare <code>npx wrangler tail &lt;воркер&gt;</code>. Найти строку можно по коду запроса.</p>
    ${serverHtml()}
    <div data-devlog-stats></div>
    <div class="row">
      <label class="check"><input type="checkbox" data-errors ${view.errorsOnly ? "checked" : ""}> только ошибки</label>
      <button type="button" class="btn small" data-copy-all>Скопировать всё</button>
      <button type="button" class="btn small" data-download>Скачать JSON</button>
      <button type="button" class="btn small danger" data-clear>Очистить</button>
    </div>
  </section>
  <div data-devlog-list class="log-list"></div>`;

  // Ссылка #logs/<код запроса> из ошибки открывает нужную запись.
  if (param) {
    const hit = devlogEntries().find((x) => x.rids?.includes(param) || x.id === param);
    if (hit) view.open.add(hit.id);
  }
  paint();
  if (param) root.querySelector(".log-entry[open]")?.scrollIntoView({ block: "start" });

  root.querySelector("[data-errors]").addEventListener("change", (e) => {
    view.errorsOnly = e.target.checked;
    paint();
  });
  root.querySelector("[data-copy-all]").addEventListener("click", () => copy(json(devlogEntries())));
  root
    .querySelector("[data-download]")
    .addEventListener("click", () =>
      download(`capsula-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`, json(devlogEntries())),
    );
  root.querySelector("[data-clear]").addEventListener("click", () => {
    if (!confirm("Очистить журнал в этом браузере?")) return;
    view.open.clear();
    clearDevlog();
  });
  const list = root.querySelector("[data-devlog-list]");
  list.addEventListener(
    "toggle",
    (e) => {
      const el = e.target;
      const [set, id] = el.classList?.contains("log-entry") ? [view.open, el.dataset.id] : [view.openMore, el.dataset?.more];
      if (!id) return;
      if (el.open) set.add(id);
      else set.delete(id);
    },
    true,
  );
  list.addEventListener("click", (e) => {
    const id = e.target.closest?.("[data-copy]")?.dataset.copy;
    const x = id && devlogEntries().find((y) => y.id === id);
    if (x) copy(json(x));
  });
}
