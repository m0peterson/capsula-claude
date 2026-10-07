# T2. Kernel: module contract, registry, slice store, events, extension points

|                       |                      |
| --------------------- | -------------------- |
| Depends on            | nothing              |
| Runs in parallel with | T1, T4               |
| Unblocks              | T3                   |
| Size                  | medium, all new code |

Read first: `docs/architecture/target.md` sections 5, 6, 7 and 8.

## Goal

Build the DOM-free part of the kernel as new files, fully covered by Node tests with fake modules. **Nothing in the running app uses it yet**; T3 wires it in. This makes the risky storage logic testable in isolation before any real data goes through it.

To stay independent of T1, files in `core/` written by this task import nothing outside `core/`. If you need `isRecord`, inline the one-liner; T3 deduplicates.

## Files

### `core/module.js`

`defineModule(manifest)` validates and returns `Object.freeze(manifest)`. It throws an `Error` naming the module and the problem when:

- `id` doesn't match `/^[a-z][a-z-]*$/`;
- `requires` is present and is not an array of strings;
- `slice` is present and was not created by `defineSlice`, or `slice.id !== id`;
- `route` is present without a string `label`, a finite `order` and a function `render`;
- `init` is present and is not a function;
- the manifest has any other key (catches typos such as `require`).

### `core/registry.js`

`async start(modules)`:

1. Throws on a duplicate id, or on a `requires` entry that is not listed **earlier** in `modules`. That also rules out cycles.
2. `await load(modules.filter((m) => m.slice).map((m) => ({ slice: m.slice, requires: m.requires ?? [] })))`.
3. Calls the store's `start()` (flush listeners).
4. Calls each `init()` in order, after **all** slices are loaded.
5. Returns `{ routes: [{ id, label, order, render }] }`, sorted by `order`.

T3 adds settings loading to this function. Leave a clear spot for it, not a TODO comment.

### `core/store.js`

Implements target.md section 6 exactly. Public surface:

```js
defineSlice(id, { version, initial, migrate, fromLegacy? }) // → Slice; throws on duplicate id or bad spec
// Slice: { id, version, get data(), save(), replace(next) }. Before load(), data is initial().
async load(entries)          // entries: [{ slice, requires }], in module order
start()                      // registers pagehide / visibilitychange flush, guarded by typeof addEventListener
flush()                      // writes every dirty slice in one backend write; returns a Promise
async resetAll()
exportBackup()               // → string, JSON.stringify(obj, null, 1)
async importBackup(text)     // → { notes: { [key]: number } }
useBackend(backend)          // tests and fallback
memoryBackend(initial = {})  // → backend with a `writes` counter
idbBackend()                 // IndexedDB "capsula" v1, object store "kv"
resetForTests()              // forget all slices, dirty flags, timers and backend
```

Backend interface, so memory and IndexedDB behave the same:

```js
{ async getMany(keys) /* → { [key]: value } for keys that exist */, async write({ put = {}, del = [] }) /* atomic */ }
```

Details that matter:

- `load` reads `mod:<id>` for every slice plus `state`. The legacy split runs only when **none** of the `mod:` keys exist and `state` is a plain object. It ends with one `write({ put: { ...allModKeys, "legacy:state": state }, del: ["state"] })`.
- `migrate` receives `{ from, deps, note }`. `deps.get(id)` returns the loaded data of a slice in this entry's `requires` and throws for anything else. If `migrate` throws, warn with `console.warn` naming the slice and use `initial()`.
- `fromLegacy` missing: the slice gets `initial()` on legacy split and is untouched on v1 import.
- Default backend: `idbBackend()` when `typeof indexedDB !== "undefined"`. If opening fails or `indexedDB` is missing, warn `IndexedDB недоступен, данные не сохранятся` (today's message) and use `memoryBackend()`.
- `save()` throttles at 50 ms (the first `save()` starts the timer, later ones don't push it back). A failed write logs `Не удалось сохранить` like today and keeps the slices dirty for the next flush.
- `importBackup` error message for anything that isn't a backup: `Это не файл резервной копии Capsula`. A file is a backup if it is a JSON object with `version: 2` and a plain-object `slices`, or with a plain-object `state` (version 1).
- `importBackup` and `resetAll` emit `app:data-replaced` through `core/events.js` after the write.

### `core/events.js`

`on(name, fn)` → unsubscribe function; `emit(name, payload)` synchronous; a throwing listener is reported with `console.error` and doesn't stop the others; `clear()` for tests.

### `core/extensions.js`

`contribute(point, item)` (item needs a non-empty string `id`; a duplicate `(point, id)` throws), `list(point)` (sorted by `order ?? 100`, then by registration order; returns a new array), `clear()`. The HTML helpers `actionsHtml` and `bindActions` are added in T5, not here.

## Tests (`test/kernel.test.mjs`, or split per file)

Test files must **not** stub `globalThis.addEventListener`, `document` or `indexedDB`. Importing `core/*` must work in bare Node.

1. `defineModule` rejects each invalid case listed above, with a message naming the module.
2. `start` rejects duplicate ids, an unknown `requires`, and a `requires` listed later.
3. `init` runs in module order and sees loaded slice data.
4. Fresh boot with an empty backend: every slice has `initial()` data and nothing is written until `save()`.
5. Two `save()` calls on two slices in the same tick produce **one** backend write that contains both.
6. Legacy split: a memory backend holding `state` produces the right data per slice (`from: 0`), and exactly one write that puts every `mod:` key and `legacy:state` and deletes `state`.
7. No legacy split when at least one `mod:` key exists, even if `state` also exists.
8. `deps.get` works for a required slice and throws for one not required. A throwing `migrate` falls back to `initial()` and warns.
9. The stored version reaches `migrate` as `from`.
10. Export produces the version 2 shape. A round trip `importBackup(exportBackup())` leaves the data unchanged.
11. Version 2 import: present slices replaced, absent slices untouched, unknown slice ids ignored, `note()` counters returned, one write, `app:data-replaced` emitted.
12. Version 1 import goes through `fromLegacy`; a slice without `fromLegacy` stays untouched.
13. Import rejects non-JSON, `{}` and `{"state":"строка"}` with the exact message.
14. `resetAll` restores `initial()` everywhere, deletes `legacy:state`, writes once, emits `app:data-replaced`.
15. A backend whose `write` rejects: warning logged, slices stay dirty, the next successful flush writes them.
16. Events: a throwing listener doesn't block the next one; unsubscribe works.
17. Extensions: duplicate id throws; ordering by `order`, then registration order.

Use `resetForTests()`, `clear()` and fake timers or a short `await` between tests. Don't let one test's slices leak into the next.

## Acceptance criteria

1. `npm test` green: the existing 113 tests plus the new ones.
2. No file under `public/js/core/` touches DOM globals at import time, and none imports outside `core/`.
3. No existing file changed except `package.json` if the test glob needs it (it shouldn't).

## Out of scope

`core/settings.js`, `core/ai.js`, `core/tasks.js`, `core/shell.js` (T3). Wiring into `app.js` (T3). Real module slices (T3).
