// Локальный сервер без зависимостей: статика из public/ и API /api/*.
// Запуск: npm run dev (порт 8888). Переменные берутся из окружения, а тех, что там нет, из файла .dev.vars
// (тот же формат KEY=VALUE, что у wrangler dev). Файл в .gitignore: ключи в репозиторий не попадают.
//
// Логи (подробно в README, раздел «Логи и отладка»):
//   терминал    каждый запрос к модели: параметры, статус, время, токены, цена, ошибки (LOG_LEVEL=debug, LOG_FORMAT=pretty);
//               LOG_LEVEL=trace ещё и промпты с ответами модели;
//   .logs/api.jsonl  всё то же плюс промпты и ответы модели, одна строка JSON на событие, при любом LOG_LEVEL;
//   вкладка «Логи» в приложении после ввода кода разработчика (по умолчанию dev).
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync, createWriteStream } from "node:fs";
import { Readable, pipeline } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "../server/api.mjs";

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(base, "public");
const port = Number(process.env.PORT || 8888);

function readDevVars(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return {};
  }
}

// Умолчания только для локальной разработки: подробные читаемые логи и код разработчика «dev».
// Сервер слушает только 127.0.0.1, поэтому код разработчика здесь никому, кроме вас, не доступен.
const DEV_DEFAULTS = { LOG_LEVEL: "debug", LOG_FORMAT: "pretty", ADMIN_CODE: "dev" };
// DEV_VARS_FILE и LOG_FILE меняют пути (пустая строка отключает): так тесты не читают ваши ключи и не пишут в ваш лог.
const devVarsFile = process.env.DEV_VARS_FILE ?? path.join(base, ".dev.vars");
const devVars = devVarsFile ? readDevVars(devVarsFile) : {};
const getEnv = (name) => process.env[name] ?? devVars[name] ?? DEV_DEFAULTS[name];

// Файл со всеми событиями трассы. Фото в нём нет, промпты и ответы модели есть: он только на вашем компьютере.
const logFile = process.env.LOG_FILE ?? path.join(base, ".logs", "api.jsonl");
let writeLog;
if (logFile) {
  await mkdir(path.dirname(logFile), { recursive: true });
  const logStream = createWriteStream(logFile, { flags: "a" });
  writeLog = (entry) => logStream.write(`${JSON.stringify(entry)}\n`);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer(async (req, res) => {
  try {
    // Путь вида «//localhost/api/task» URL разбирает как адрес с другим хостом, поэтому принимаем только «/путь».
    if (!req.url.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(400).end("Bad request");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      // Защита от DNS rebinding: на этот API ходит только страница с localhost. Хост берём из заголовка Host.
      let hostname = "";
      try {
        hostname = new URL(`http://${req.headers.host}`).hostname;
      } catch {
        /* битый Host */
      }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
        res.writeHead(403).end("Forbidden host");
        return;
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      // Клиент закрыл соединение до конца ответа: отменяем запрос к провайдеру, как это делает платформа.
      const ctl = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) ctl.abort();
      });
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: "half",
        signal: ctl.signal,
      });
      const response = await handleApi(request, getEnv, { log: writeLog });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // pipeline, а не pipe: при обрыве потока провайдера закрывает res, а не роняет процесс необработанным 'error'.
      if (response.body) pipeline(Readable.fromWeb(response.body), res, () => {});
      else res.end();
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") res.writeHead(404).end("Not found");
    else res.writeHead(500).end(String(e.message));
  }
});

// Только loopback: сервер использует ключи из окружения, их нельзя раздавать всей локальной сети.
server.listen(port, "127.0.0.1", () => {
  const keys = ["OPENROUTER_API_KEY", "OPENCODE_GO_API_KEY"].filter((k) => getEnv(k));
  console.log(`http://localhost:${port}`);
  console.log(
    `ключи: ${keys.join(", ") || "нет (задайте в окружении или в .dev.vars)"}; провайдер: ${getEnv("LLM_PROVIDER") || "по ключу"}`,
  );
  console.log(`логи: этот терминал (LOG_LEVEL=${getEnv("LOG_LEVEL")})${logFile ? `, файл ${path.relative(process.cwd(), logFile)}` : ""}`);
  console.log(`вкладка «Логи»: Настройки → Ввести код → ${getEnv("ADMIN_CODE") === "dev" ? "dev" : "ваш ADMIN_CODE"}`);
});
