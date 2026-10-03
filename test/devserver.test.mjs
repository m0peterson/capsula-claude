import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/broken-upstream.mjs", import.meta.url));

async function startServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", preload, "scripts/dev-server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), OPENROUTER_API_KEY: "k" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = null;
  child.on("exit", (code) => (exited = code));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/llm`);
      if (r.ok) return { port, child, exited: () => exited };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error("dev-сервер не запустился");
}

test("dev-сервер переживает обрыв потока провайдера, клиент видит обрыв, а не нормальный конец", async () => {
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

test("dev-сервер отклоняет чужой Host (DNS rebinding) и не слушает внешние интерфейсы", async () => {
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
