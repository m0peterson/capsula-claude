// Долгие задачи модулей: блокировка кнопок, прогресс, отмена, ошибка. Ключ задачи это id модуля
// (атрибут data-task у блока статуса).
import { esc } from "../lib/html.js";
import { toast } from "../ui/components.js";
import { emit } from "./events.js";

// Сырой ответ модели для отладки: начало и конец, чтобы видеть, обрезан ли он и чем испорчен.
function rawDetails(e) {
  const part = (t) => (t.length > 2400 ? `${t.slice(0, 1600)}\n…[пропущено ${t.length - 2400} зн.]…\n${t.slice(-800)}` : t);
  const blocks = [e.raw && ["Ответ модели", e.raw], e.raw2 && ["Ответ на повторный запрос", e.raw2]].filter(Boolean);
  if (!blocks.length) return "";
  return `<details class="raw"><summary>Показать ответ модели (${blocks.map(([, t]) => t.length).join(" и ")} зн.)</summary>${blocks
    .map(([title, t]) => `<p class="meta">${title}</p><pre>${esc(part(t))}</pre>`)
    .join("")}</details>`;
}

// Какие модули сейчас считают. Нужно, чтобы экран, на который пользователь вернулся посреди расчёта,
// не показывал активную кнопку и не позволял запустить дубль.
const running = new Set();
export const isRunning = (key) => running.has(key);
export const RUNNING_NOTE = `<div class="progress"><span class="spinner"></span><span>Расчёт ещё идёт. Результат появится здесь, когда он закончится.</span></div>`;

// Запускает долгую задачу: блокирует кнопки, показывает прогресс и кнопку отмены, выводит ошибку.
// fn получает { signal, onProgress, notice, setLabel }. Результат fn возвращается, при ошибке или отмене null.
export async function runTask(statusEl, buttons, fn) {
  const ctl = new AbortController();
  const started = Date.now();
  const key = statusEl.dataset?.task;
  if (key) running.add(key);
  let progress = { chars: 0, thought: 0 };
  let label = "";
  buttons.forEach((b) => b && (b.disabled = true));
  statusEl.innerHTML = `<div class="progress"><span class="spinner"></span><span data-msg></span><button type="button" class="link" data-cancel>Отмена</button></div>`;
  const msg = statusEl.querySelector("[data-msg]");
  statusEl.querySelector("[data-cancel]").onclick = () => ctl.abort();
  const paint = () => {
    const sec = Math.round((Date.now() - started) / 1000);
    const parts = [`${label || "Модель работает"} · ${sec} с`];
    if (progress.thought) parts.push(`рассуждает: ${progress.thought} зн.`);
    if (progress.chars) parts.push(`ответ: ${progress.chars} зн.`);
    msg.textContent = parts.join(" · ");
  };
  paint();
  const tick = setInterval(paint, 1000);
  try {
    const result = await fn({
      signal: ctl.signal,
      onProgress: (p) => (progress = p),
      notice: (m) => toast(m),
      setLabel: (l) => {
        label = l;
        progress = { chars: 0, thought: 0 };
      },
    });
    statusEl.innerHTML = "";
    return result ?? true;
  } catch (e) {
    statusEl.innerHTML =
      e.name === "AbortError"
        ? `<div class="note">Отменено.</div>`
        : `<div class="error"><strong>Ошибка.</strong> ${esc(e.message)}${rawDetails(e)}</div>`;
    return null;
  } finally {
    clearInterval(tick);
    buttons.forEach((b) => b && (b.disabled = false));
    if (key) {
      running.delete(key);
      // Пользователь ушёл с вкладки и вернулся: её экран собран до конца расчёта, пусть перерисуется с итогом.
      if (!statusEl.isConnected) emit("app:task-finished", { module: key });
    }
  }
}
