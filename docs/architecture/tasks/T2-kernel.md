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

It never rejects because of storage: load failures fall back as described below. Also export `resetForTests()`, which calls the store's `resetForTests()`, `events.clear()` and `extensions.clear()`, so later tasks can call `start(modules)` more than once in one test file.

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
memoryBackend(initial = {})  // → backend with a `writes` counter; structuredClones values on write and on read, as IndexedDB does
idbBackend()                 // IndexedDB "capsula" v1, object store "kv"
resetForTests()              // see below
forgetSlicesForTests()       // T2's own tests only: drop every slice definition so fake ids can be reused
```

Backend interface, so memory and IndexedDB behave the same:

```js
{
  async getMany(keys), // → { [key]: value } for the keys that exist
  async write({ put = {}, del = [], clear = false }), // atomic; clear empties the store first, in the same transaction
}
```

Details that matter (target.md sections 6.3 to 6.5 are the full rules):

- `load` reads `mod:<id>` for every slice, and `state` only when none of them exists. The legacy split runs only when **none** of the `mod:` keys exist and `state` is a plain object. Every `fromLegacy` gets the same single `structuredClone` of `state`. The split ends with one `write({ put: allModKeys })`; `state` is never modified or deleted by the split.
- `migrate` receives `{ from, deps, note }`. `deps.get(id)` throws for an id outside this entry's `requires`. Otherwise it returns the data that slice will hold once this load or import finishes: at load, its migrated data; on import, the data computed from the file when the file provides that slice (v2: present in `slices`; v1: the slice has `fromLegacy`), otherwise the current data. Slices are computed in module order, so that data is ready in time.
- If `fromLegacy` or `migrate` throws, warn with `console.warn` naming the slice and use `initial()`.
- `fromLegacy` missing: the slice gets `initial()` on legacy split and is untouched on v1 import.
- Default backend: `idbBackend()` when `typeof indexedDB !== "undefined"`. If opening fails, `indexedDB` is missing, or the first `getMany` rejects, warn `IndexedDB недоступен, данные не сохранятся` (today's message) and use `memoryBackend()` for the rest of the session. Never write to IndexedDB after a failed read.
- If the split write rejects: warn, keep the migrated data, and keep **every** slice dirty, so the next flush retries all of them in one write.
- `save()` marks the slice dirty and starts the 50 ms timer if none is pending, even when the slice is already dirty (throttle: later calls don't push the timer back).
- `flush()` synchronously takes the dirty ids and clears the set, clones each slice's `{ v, data }` with a JSON round trip in the same tick, then awaits `backend.write`. If the write rejects, it logs `Не удалось сохранить` and adds those ids back to the dirty set. Dirty flags are never cleared after a write resolves.
- `importBackup` error message for anything that isn't a backup: `Это не файл резервной копии Capsula`. A file is a version 2 backup if it is a JSON object with `version: 2` and a plain-object `slices`. Otherwise it is a version 1 backup if it is a JSON object with a plain-object `state`, **whatever its `version`** (today's importer doesn't check it).
- `importBackup` computes every slice, swaps the data into memory, marks those slices dirty and writes all dirty slices in one write. `resetAll` sets every slice to `initial()` and writes `{ clear: true, put: <every mod: key with initial data> }`. Both emit `app:data-replaced` through `core/events.js` after the swap, whether or not the write succeeded. On a failed write they rethrow and leave the slices dirty; a failed `resetAll` also keeps the pending `clear` for the next flush.
- `resetForTests()` resets every slice created so far to `initial()` and clears the dirty set, the timer, the pending clear and the backend. Slice objects stay valid: `defineSlice` runs once per process when a module's `model.js` is imported, and later tasks' tests reload the same real slices after a reset.

`idbBackend` details: open the database once and reuse the connection. `getMany` uses one readonly transaction. `write` creates one readwrite transaction on `kv`, issues `clear`, every `put` and every `delete` synchronously with no `await` between them (otherwise the transaction auto-commits), resolves on `oncomplete`, and rejects with `tx.error` on **both** `onabort` and `onerror`. Chromium reports a full disk (`QuotaExceededError`) through `abort` only; a promise that listens only to `onerror`, as today's `idbSet` does, never settles.

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
6. Legacy split: a memory backend holding `state` produces the right data per slice (`from: 0`), and exactly one write that puts every `mod:` key. `state` afterwards deep-equals the original, even though a `migrate` mutates its input.
7. No legacy split when at least one `mod:` key exists, even if `state` also exists.
8. `deps.get` works for a required slice and throws for one not required. A throwing `migrate` and a throwing `fromLegacy` each fall back to `initial()` and warn. A `state` that is `null`, an array or a string is ignored, not split.
9. The stored version reaches `migrate` as `from`.
10. Export produces the version 2 shape. A round trip `importBackup(exportBackup())` leaves the data unchanged.
11. Version 2 import: present slices replaced, absent slices untouched, unknown slice ids ignored, `note()` counters returned, one write, `app:data-replaced` emitted.
12. Version 1 import goes through `fromLegacy`; a slice without `fromLegacy` stays untouched. A `{ state }` file with no `version` imports as version 1.
13. Import rejects non-JSON, `{}` and `{"state":"строка"}` with the exact message.
14. Import into an **empty** store (fresh boot) where slice `b` requires `a` and `b`'s `migrate` keeps only ids present in `deps.get("a")`: `b` keeps its references to `a`'s imported data, for both v1 and v2. With a v2 file that has `b` but not `a`, `b` sees `a`'s current data.
15. `resetAll` on a backend holding `state`, a `mod:` key of a removed module and the current `mod:` keys: afterwards only the current `mod:` keys exist, holding `initial()` data; one write; `app:data-replaced` emitted.
16. A backend whose `write` rejects: warning logged, slices stay dirty, the next successful flush writes them. `importBackup` with a rejecting write rejects, still emits `app:data-replaced`, and the next successful flush writes every imported slice in one write.
17. A backend whose `write` resolves on demand: `save()` on a slice while its previous write is pending gets written by the next flush.
18. The legacy-split write rejects: warning logged, slices hold the migrated data, `state` is intact, no `mod:` key exists, and the next successful flush writes **all** `mod:` keys in one write.
19. The first `getMany` rejects: warning logged, every slice has `initial()` data, and later saves never reach the failing backend.
20. A slice defined before `resetForTests()` loads and saves again after it.
21. Events: a throwing listener doesn't block the next one; unsubscribe works.
22. Extensions: duplicate id throws; ordering by `order`, then registration order.

Use `resetForTests()`, `forgetSlicesForTests()`, `clear()` and fake timers or a short `await` between tests. Don't let one test's slices leak into the next.

## Acceptance criteria

1. `npm test` green: the existing 113 tests plus the new ones.
2. No file under `public/js/core/` touches DOM globals at import time, and none imports outside `core/`.
3. No existing file changed except `package.json` if the test glob needs it (it shouldn't).

## Out of scope

`core/settings.js`, `core/ai.js`, `core/tasks.js`, `core/shell.js` (T3). Wiring into `app.js` (T3). Real module slices (T3).
