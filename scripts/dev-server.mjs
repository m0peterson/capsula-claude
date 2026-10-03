// Локальный сервер без зависимостей: статика из public/ и /api/llm.
// Запуск: npm run dev (порт 8888, переменные окружения читаются как есть).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable, pipeline } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleLlm } from "../lib/proxy-core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.env.PORT || 8888);

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
    // Путь вида «//localhost/api/llm» URL разбирает как адрес с другим хостом, поэтому принимаем только «/путь».
    if (!req.url.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(400).end("Bad request");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/llm") {
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
      const response = await handleLlm(request, (name) => process.env[name]);
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
server.listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
