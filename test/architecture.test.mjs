// Правила зависимостей между слоями и модулями (docs/architecture/README.md). Нарушение здесь значит, что модуль
// перестал быть отдельным: агент, которому дали один модуль, сломает чужой.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const client = path.join(root, "public/js");
const server = path.join(root, "server");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "vendor") walk(p, out);
    } else if (/\.m?js$/.test(f)) out.push(p);
  }
  return out;
}
const files = [...walk(client), ...walk(server)];

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [...src.matchAll(/^\s*(?:import|export)\s(?:[^"';]*?\sfrom\s)?["']([^"']+)["']/gm)].map((m) => m[1]);
  return { src, deps: specs.map((s) => rel(path.resolve(path.dirname(file), s))) };
}

const modulesDir = path.join(client, "modules");
const moduleIds = readdirSync(modulesDir).filter((d) => statSync(path.join(modulesDir, d)).isDirectory());
const { default: manifests } = await import(pathToFileURL(path.join(client, "modules.js")).href);
const requiresOf = Object.fromEntries(manifests.map((m) => [m.id, m.requires]));

const under = (p, dir) => p.startsWith(dir + "/");
const moduleOf = (p) => p.match(/^public\/js\/modules\/([^/]+)\//)?.[1] ?? null;
const serverModuleOf = (p) => p.match(/^server\/modules\/([^/]+)\.mjs$/)?.[1] ?? null;

// Можно ли файлу from импортировать to. Возвращает причину запрета или null.
function violation(from, to) {
  const L = (d) => under(to, `public/js/${d}`);
  const pure = L("lib") || L("shared");
  if (to.startsWith("public/js/vendor/")) return from.startsWith("public/js/lib/") ? null : "vendor подключается только из lib/";

  if (from.startsWith("public/js/lib/")) return L("lib") ? null : "lib/ импортирует только lib/";
  if (from.startsWith("public/js/shared/")) return pure ? null : "shared/ импортирует только lib/ и shared/";
  if (from.startsWith("public/js/ui/")) return pure || L("ui") ? null : "ui/ импортирует только lib/, shared/, ui/";
  if (from.startsWith("public/js/core/")) return pure || L("ui") || L("core") ? null : "core/ не знает конкретных модулей";
  if (from === "public/js/modules.js")
    return /^public\/js\/modules\/[^/]+\/index\.js$/.test(to) ? null : "modules.js импортирует только index.js модулей";
  if (from === "public/js/app.js")
    return L("core") || to === "public/js/modules.js" ? null : "app.js импортирует только core/ и modules.js";

  const X = moduleOf(from);
  if (X) {
    const file = path.basename(from);
    // schema.js общий с сервером: только чистые помощники, иначе сервер потянет за собой браузерное ядро.
    if (file === "schema.js")
      return pure || to === `public/js/modules/${X}/schema.js` ? null : "schema.js импортирует только lib/ и shared/";
    // api.js, model.js без DOM: их вызывают другие модули и тесты в Node.
    if ((file === "api.js" || file === "model.js") && (L("ui") || /\/(view|tasks|shell|paywall)\.js$/.test(to)))
      return `${file} не зависит от интерфейса`;
    if (pure || L("ui") || L("core")) return null;
    const Y = moduleOf(to);
    if (Y === X) return null;
    if (Y && to === `public/js/modules/${Y}/api.js`) return requiresOf[X]?.includes(Y) ? null : `модуль ${X} не указал ${Y} в requires`;
    return `модуль ${X} может брать из другого модуля только его api.js`;
  }

  if (from.startsWith("server/")) {
    if (to.startsWith("public/js/")) {
      if (pure) return null;
      const S = serverModuleOf(from);
      return S && to === `public/js/modules/${S}/schema.js`
        ? null
        : "сервер берёт из public/js только lib/, shared/ и schema.js своего модуля";
    }
    const S = serverModuleOf(from);
    if (S) {
      const T = serverModuleOf(to);
      if (to === "server/kit.mjs") return null;
      if (T) return requiresOf[S]?.includes(T) ? null : `серверный модуль ${S} не может брать из ${T}: его нет в requires`;
      return "серверный модуль берёт только kit.mjs и модули из requires";
    }
    if (serverModuleOf(to)) return from === "server/tasks.mjs" ? null : "серверные модули подключает только tasks.mjs";
    return null;
  }
  return null;
}

test("импорты между слоями и модулями соблюдают правила", () => {
  const bad = [];
  for (const f of files) {
    const from = rel(f);
    const { src, deps } = importsOf(f);
    if (/\bimport\s*\(/.test(src)) bad.push(`${from}: динамический import() запрещён`);
    for (const to of deps) {
      if (!to.startsWith("public/") && !to.startsWith("server/")) continue;
      assert.ok(existsSync(path.join(root, to)), `${from} импортирует несуществующий ${to}`);
      const why = violation(from, to);
      if (why) bad.push(`${from} → ${to}: ${why}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("каждая папка модуля указана в modules.js, id совпадает с папкой, есть README", () => {
  assert.deepEqual([...moduleIds].sort(), manifests.map((m) => m.id).sort());
  for (const id of moduleIds) {
    assert.ok(existsSync(path.join(modulesDir, id, "index.js")), `${id}: нет index.js`);
    assert.ok(existsSync(path.join(modulesDir, id, "README.md")), `${id}: нет README.md`);
  }
});

test("каждый файл, кроме app.js, импортируется в Node без браузерных глобалов", async () => {
  for (const f of files) {
    if (rel(f) === "public/js/app.js") continue;
    await assert.doesNotReject(import(pathToFileURL(f).href), rel(f));
  }
  assert.equal(typeof globalThis.document, "undefined");
});

test("модуль, который никто не требует, удаляется без поломки остальных", async () => {
  const { boot } = await import("./helpers.mjs");
  const needed = new Set(manifests.flatMap((m) => m.requires));
  for (const m of manifests.filter((x) => !needed.has(x.id))) {
    const rest = manifests.filter((x) => x !== m);
    await assert.doesNotReject(boot({}, rest), `без модуля ${m.id}`);
  }
});
