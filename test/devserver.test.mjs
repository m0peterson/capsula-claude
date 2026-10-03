import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/broken-upstream.mjs", import.meta.url));

const hanging = fileURLToPath(new URL("./fixtures/hanging-upstream.mjs", import.meta.url));

// Окружение задаём явно: переменные разработчика (PILOT_ACCESS_CODE и т. п.) не должны влиять на тест.
async function startServer(fixture = preload) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", fixture, "scripts/dev-server.mjs"], {
    cwd: root,
    env: { PATH: process.env.PATH, PORT: String(port), OPENROUTER_API_KEY: "k" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = null;
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("exit", (code) => (exited = code));
  for (let i = 0; i < 50 && exited === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/llm`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { port, child, exited: () => exited, output: () => out };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error("dev-сервер не запустился");
}

const rawRequest = (port, path, host) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host }, timeout: 3000 }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("таймаут запроса")));
    req.end();
  });

test("dev-сервер переживает обрыв потока провайдера, клиент видит обрыв, а не нормальный конец", { timeout: 30000 }, async () => {
  const { port, child, exited } = await startServer();
  try {
    // Обрыв виден клиенту либо сразу (соединение закрыто до заголовков), либо при чтении тела. Нормального конца быть не должно.
    const outcome = await fetch(`http://127.0.0.1:${port}/api/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    })
      .then((r) => r.text())
      .then(
        () => "нормальный конец",
        () => "обрыв",
      );
    assert.equal(outcome, "обрыв");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(exited(), null, "процесс не упал");
    const alive = await fetch(`http://127.0.0.1:${port}/api/llm`);
    assert.equal(alive.status, 200, "следующие запросы обслуживаются");
  } finally {
    child.kill();
  }
});

test("dev-сервер отклоняет чужой Host (DNS rebinding) и не слушает внешние интерфейсы", { timeout: 30000 }, async () => {
  const { port, child } = await startServer();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/llm", headers: { host: "evil.example.com" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);

    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (external) {
      const refused = await new Promise((resolve) => {
        const sock = net.connect({ host: external.address, port, timeout: 1500 });
        sock.on("connect", () => {
          sock.destroy();
          resolve(false);
        });
        sock.on("error", () => resolve(true));
        sock.on("timeout", () => {
          sock.destroy();
          resolve(true);
        });
      });
      assert.ok(refused, `порт доступен по внешнему адресу ${external.address}`);
    }
  } finally {
    child.kill();
  }
});

test("проверка Host не обходится путём вида //localhost/api/llm", { timeout: 30000 }, async () => {
  const { port, child } = await startServer();
  try {
    for (const path of ["//localhost/api/llm", "//127.0.0.1/api/llm", "///localhost/api/llm", "http://localhost/api/llm"]) {
      const status = await rawRequest(port, path, "evil.example.com");
      assert.ok([400, 403].includes(status), `${path} -> ${status}`);
    }
    assert.equal(await rawRequest(port, "//localhost/api/llm", `localhost:${port}`), 400, "и с хорошим Host такой путь не принимается");
    assert.equal(await rawRequest(port, "/api/llm", `localhost:${port}`), 200);
    assert.equal(await rawRequest(port, "/api/llm", `[::1]:${port}`), 200);
    assert.equal(await rawRequest(port, "/api/llm", "evil.example.com:80"), 403);
    assert.equal(await rawRequest(port, "/api/llm", "localhost.evil.com"), 403);
  } finally {
    child.kill();
  }
});

test("отмена клиентом доходит до провайдера (dev-сервер отменяет запрос при закрытии соединения)", { timeout: 30000 }, async () => {
  const { port, child, output } = await startServer(hanging);
  try {
    const ctl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
      signal: ctl.signal,
    }).catch((e) => e.name);
    for (let i = 0; i < 50 && !output().includes("UPSTREAM_STARTED"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(output(), /UPSTREAM_STARTED/, "запрос дошёл до провайдера");
    assert.doesNotMatch(output(), /UPSTREAM_ABORTED/);
    ctl.abort();
    assert.equal(await pending, "AbortError");
    for (let i = 0; i < 60 && !output().includes("UPSTREAM_ABORTED"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(output(), /UPSTREAM_ABORTED/, "отмена дошла до провайдера");
  } finally {
    child.kill();
  }
});
