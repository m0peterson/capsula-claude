// Логи dev-сервера (.logs/api.jsonl) в читаемом виде.
//   npm run logs                     последние 5 задач
//   npm run logs -- 20               последние 20 задач
//   npm run logs -- <код запроса>    одна задача, код есть в ошибке в приложении и на вкладке «Логи»
//   npm run logs -- --errors         только задачи с ошибкой
//   npm run logs -- --full           с промптами и ответами модели
//   npm run logs -- -f               следить за новыми событиями
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, watchFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prettyLine } from "../server/log.mjs";

const file = process.env.LOG_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".logs", "api.jsonl");
const args = process.argv.slice(2);
const full = args.includes("--full");
const follow = args.includes("-f") || args.includes("--follow");
const errorsOnly = args.includes("--errors");
const rest = args.filter((a) => !a.startsWith("-"));
const last = rest.find((a) => /^\d{1,4}$/.test(a));
const rid = rest.find((a) => /^[0-9a-f]{6,}$/i.test(a) && a !== last);

if (!existsSync(file)) {
  console.log(`Файла ${file} нет. Он появится после первой задачи в npm run dev.`);
  process.exit(0);
}

const parse = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const show = (e) => {
  if (!full && (e.type === "task.prompt" || e.type === "llm.raw")) return;
  console.log(prettyLine(e.rid, e.task || "?", e));
};

const all = parse(readFileSync(file, "utf8"));
let rids = [...new Set(all.map((e) => e.rid))];
if (rid) rids = rids.filter((r) => r.startsWith(rid));
if (errorsOnly) rids = rids.filter((r) => all.some((e) => e.rid === r && e.type === "task" && !e.ok));
if (!rid) rids = rids.slice(-Number(last || 5));
const keep = new Set(rids);
for (const e of all) if (keep.has(e.rid)) show(e);
if (!keep.size) console.log(rid ? `Задачи с кодом ${rid} в ${file} нет.` : "Подходящих задач нет.");

if (follow) {
  let pos = statSync(file).size;
  let tail = "";
  console.log(`— жду новые события в ${file} (Ctrl+C, чтобы выйти) —`);
  watchFile(file, { interval: 300 }, () => {
    const size = statSync(file).size;
    if (size < pos) pos = 0; // файл удалили или обрезали
    if (size === pos) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    const text = tail + buf.toString("utf8");
    const cut = text.lastIndexOf("\n");
    tail = text.slice(cut + 1);
    for (const e of parse(text.slice(0, cut + 1))) if (!rid || e.rid?.startsWith(rid)) if (!errorsOnly || e.type === "task") show(e);
  });
}
