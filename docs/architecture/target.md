# Target architecture

This is the reference for every task in `tasks/`. When a brief and this file disagree, this file wins. When this file is wrong, stop and flag it in the PR under **Deviations from architecture**. Don't improvise.

## 1. Why change

Problems in the current code (as of commit `2bb1999`), each with where it lives:

| #   | Problem                                                                                  | Where                                                                                                               | Consequence                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | One global mutable `state` for every feature, persisted as one IndexedDB value `"state"` | `store.js`                                                                                                          | Every keystroke serializes all photos and results (throttled to 50 ms). One corrupted field is handled by a migration that has to know every feature. |
| P2  | Views write other features' data                                                         | `views/wardrobe.js` edits `state.looks`; `views/capsule.js` resets `state.search`; three views write `state.wishes` | No ownership. Adding a feature means editing unrelated views.                                                                                         |
| P3  | Views mix rendering, prompt building, LLM calls, normalization and persistence           | all `views/*.js`                                                                                                    | AI orchestration cannot be tested in Node; the only tests cover pure helpers.                                                                         |
| P4  | The LLM transport imports app storage                                                    | `llm.js` imports `settings` from `store.js`                                                                         | Tests have to stub browser globals and mutate global settings.                                                                                        |
| P5  | `migrate()` imports every feature's normalizer                                           | `store.js`                                                                                                          | Storage depends on all features; the import graph is a web.                                                                                           |
| P6  | Domain vocabulary is split across files                                                  | `CATEGORIES` in `ui.js`, `CATEGORY_KEYS` in `normalize.js`                                                          | Two lists that must stay in sync by hand.                                                                                                             |
| P7  | Navigation is a hard-coded tab list                                                      | `app.js` `TABS`                                                                                                     | A new feature edits the shell.                                                                                                                        |
| P8  | Side effects at import time                                                              | `store.js` calls `addEventListener` on import                                                                       | Node tests need `globalThis.addEventListener = () => {}` hacks.                                                                                       |
| P9  | Dead code                                                                                | `shrinkDataUrl` in `util.js` is never called                                                                        | Noise.                                                                                                                                                |

## 2. Constraints that do not change

- No build step, no bundler, no runtime dependencies. Native ES modules served from `public/`.
- Node 20+ `node --test` is the test runner. No test dependencies.
- Server side (`lib/proxy-core.mjs`, `netlify/`, `functions/`, `scripts/dev-server.mjs`) is out of scope. The client keeps calling `POST /api/llm` the same way.
- Rendering stays as HTML template strings plus `innerHTML`, with `esc`, `safeImage`, `safeUrl` and `safeHex` applied to everything that comes from storage or a model.
- UI copy and code comments are in Russian, matching the existing code. Prettier settings come from `.prettierrc` (print width 140).
- User data stays in the browser: IndexedDB for data, localStorage for settings and keys.

## 3. Layers

```
public/js/
  app.js            entry point: boots the kernel and the shell with the list from modules.js. Runs DOM code on import.
  modules.js        the module list, in boot order. The only file that knows every module. Importable in Node (tests use it).
  lib/              pure helpers. No DOM at import time, no state, no app knowledge.
  ai/               LLM transport for OpenAI-compatible APIs. Knows the protocol, not stylists and not settings storage.
  shared/           shared domain kernel: vocabulary several modules need. Small on purpose.
  ui/               presentational helpers. No state.
  core/             kernel: module contract, storage, events, extension points, settings, AI facade, tasks, shell.
                    Knows the module contract, never a specific module.
  modules/<id>/     one folder per feature (vertical slice).
  vendor/           third-party code (jsonrepair). Unchanged.
```

Target file map after T3 (T4 and T5 add the calendar files marked with `*`):

```
lib/coerce.js        arr, isRecord, text, list, records, colors, validHex
lib/html.js          esc, safeHex, safeImage, safeUrl
lib/ids.js           uid
lib/images.js        fileToDataUrl (touches DOM only when called)
lib/dates.js       * local calendar dates, month grid, Russian month and weekday names
lib/plural.js      * Russian plural forms
ai/client.js         chat, chatJson, cutError, userContent, resetLearned, fetchServerConfig
ai/parse-json.js     parseModelJson, extractJson
ai/providers.js      PROVIDER_NAMES, EFFORTS, MODEL_SUGGESTIONS, endpointProblem
shared/catalog.js    CATEGORIES, CATEGORY_KEYS, catLabel
shared/persona.js    BASE stylist persona prompt
shared/look-snapshot.js * LookSnapshot shape and normalizeSnapshot
ui/toast.js          toast
ui/components.js     swatches, thumb, placeholderThumb, emptyState, readImages, safeHtml
core/module.js       defineModule
core/registry.js     start(modules)
core/store.js        defineSlice, load, flush, resetAll, exportBackup, importBackup, backends
core/events.js       on, emit, clear
core/extensions.js   contribute, list, actionsHtml, bindActions, clear
core/settings.js     settings, loadSettings, saveSettings, endpointFor, slotProblem, capabilities, server config
core/ai.js           askJson, problem
core/tasks.js        runTask, isRunning, RUNNING_NOTE
core/shell.js        nav, hash router, API-key banner, re-render after background task
modules/profile/     index.js api.js model.js prompts.js service.js view.js
modules/wardrobe/    index.js api.js model.js prompts.js service.js view.js
modules/looks/       index.js        model.js prompts.js service.js view.js
modules/capsule/     index.js api.js model.js prompts.js service.js view.js
modules/search/      index.js        model.js prompts.js service.js view.js shops.js
modules/settings/    index.js                                        view.js
modules/calendar/  * index.js api.js model.js view.js dialog.js
```

## 4. Dependency rules

Allowed static imports. Everything not listed is forbidden. Dynamic `import()` is forbidden everywhere.

| From          | May import                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/*`       | `lib/*`                                                                                                                                                |
| `ai/*`        | `lib/*`, `ai/*`, `vendor/*`                                                                                                                            |
| `shared/*`    | `lib/*`, `shared/*`                                                                                                                                    |
| `ui/*`        | `lib/*`, `shared/*`, `ui/*`                                                                                                                            |
| `core/*`      | `lib/*`, `ai/*`, `shared/*`, `ui/*`, `core/*`                                                                                                          |
| `modules/X/*` | `lib/*`, `shared/*`, `ui/*`, `core/*`, `ai/providers.js` (constants only), files in `modules/X/`, and `modules/Y/api.js` when `Y` is in X's `requires` |
| `modules.js`  | `modules/*/index.js`                                                                                                                                   |
| `app.js`      | `core/*`, `modules.js`                                                                                                                                 |

Extra rules:

1. `modules/*/index.js` is imported only by `modules.js`.
2. `modules/*/api.js` must not import its own `view.js` or `dialog.js`. The public API is DOM-free.
3. Modules never import `ai/client.js`. LLM calls go through `core/ai.js`, which resolves the endpoint from settings.
4. No DOM, `window`, `document`, `localStorage` or `indexedDB` access at import time in any file except `app.js`. Every other file under `public/js` must import in plain Node without stubbed globals.
5. A module changes another module's data only by calling a command exported from that module's `api.js`. It never mutates objects returned by another module's API. Read functions return live objects for speed, so this rule is enforced by review, not by freezing.

T3 adds `test/architecture.test.mjs`, which enforces rules 1 to 4 and the table by scanning import statements and importing every file in Node.

## 5. Module anatomy

```
modules/<id>/
  index.js    manifest (default export). Wires the module: slice, route, init().
  api.js      public API for other modules. The only file other modules may import.
  model.js    slice definition, normalizers, pure domain logic and commands. DOM-free.
  prompts.js  system prompts and the user-message builder. DOM-free.
  service.js  AI orchestration: build request, call core/ai, normalize. DOM-free.
  view.js     rendering and event wiring.
```

A module with nothing to share has no `api.js`. A module without AI has no `prompts.js` or `service.js`.

Services take the helper object that `runTask` passes (`{ signal, onProgress, notice, setLabel }`) plus their own arguments. Where invariant 1 (section 9) applies (profile, looks, capsule), the service **returns** the normalized result and the view commits it after rendering. Wardrobe recognition is the exception: today it saves after every batch so partial progress survives a failure, so its service calls its own model commands per batch. A service may call commands of its own module, never of another.

### Manifest

```js
// modules/looks/index.js
import { defineModule } from "../../core/module.js";
import { on } from "../../core/events.js";
import { contribute } from "../../core/extensions.js";
import { slice, pruneItem, snapshots } from "./model.js";
import { render } from "./view.js";

export default defineModule({
  id: "looks", // matches the folder name, /^[a-z][a-z-]*$/
  requires: ["profile", "wardrobe"], // hard dependencies, must appear earlier in modules.js
  slice, // optional
  route: { label: "Образы", order: 30, render }, // optional; render(root, { param })
  init() {
    // optional; runs once after every slice is loaded. Subscribe to events and contribute to extension points here.
    on("wardrobe:item-removed", ({ id }) => pruneItem(id)); // T3
    contribute("look.sources", { id: "looks", label: "Из образов", list: snapshots }); // T5
  },
});
```

`defineModule` validates the shape and returns the object frozen. Core services are plain ES module singletons imported directly. There is no context object to thread through.

### Hard and soft dependencies

- **Hard** (`requires` + import of `api.js`): the module cannot work without the other one. Example: looks needs the wardrobe.
- **Soft** (extension points, section 7.3): the module works without the other one, and the dependency points the other way. Example: the looks tab shows an "add to calendar" button only because the calendar contributed it. Looks never imports calendar.

Test of modularity: a module nobody lists in `requires` (today: looks, search, settings, calendar) can be removed by deleting its folder and its line in `modules.js`, and the app still boots with all tests green.

## 6. State and persistence

### 6.1 Slices

Each module owns at most one slice of persistent data.

```js
// modules/looks/model.js
import { defineSlice } from "../../core/store.js";

export const slice = defineSlice("looks", {
  version: 1,
  initial: () => ({ list: [] }),
  // raw is whatever was stored (any shape, may be garbage). from is the stored version, 0 for legacy data.
  // deps.get(id) returns already-loaded data of a module listed in requires; anything else throws.
  // note(key, n) adds to a counter reported by importBackup (for example "droppedImages").
  migrate: (raw, { from, deps, note }) => ({ list: normalizeLooks({ looks: raw?.list }, idsOf(deps.get("wardrobe"))) }),
  // optional: extracts this slice's raw data from the old single-blob state. Result goes through migrate().
  fromLegacy: (legacy) => ({ list: legacy.looks }),
});

slice.data; // current data object. Only the owning module mutates it.
slice.save(); // mark dirty and schedule a write
slice.replace(next); // set data and save
```

`migrate` must be total: any input gives valid data. If it throws, the store logs a warning and uses `initial()`, the same policy as today's `attempt()` in `store.js`.

### 6.2 Storage layout

Same IndexedDB database `capsula`, version 1, object store `kv`. No schema upgrade.

| Key            | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `mod:<id>`     | `{ v: <slice version>, data: <slice data> }`                                             |
| `state`        | legacy single blob. Read once, then renamed.                                             |
| `legacy:state` | the legacy blob, kept as a safety copy after the split. Deleted by "Удалить все данные". |

Settings stay in localStorage under `capsula.settings.v1`, owned by `core/settings.js`.

### 6.3 Load sequence

1. Read `mod:<id>` for every defined slice, plus `state`. Known keys only, no prefix scan: a key left behind by a removed module is ignored.
2. If none of those `mod:` keys exists and `state` exists, this is the first boot after the refactor. For each slice in module order: `migrate(fromLegacy(state), { from: 0, ... })`. Then, in **one** IndexedDB transaction, write every `mod:*` key and rename `state` to `legacy:state`. A transaction is atomic, so a crash leaves either the old layout or the new one, never a mix.
3. Otherwise, for each slice in module order: stored record → `migrate(record.data, { from: record.v, ... })`, or `initial()` when there is no record. A stored version newer than the code's version is migrated best effort with a console warning.
4. If IndexedDB is unavailable, fall back to the in-memory backend and warn, as today.

### 6.4 Writes

`save()` marks the slice dirty. A 50 ms throttle (not debounce, same as today) flushes every dirty slice in **one** transaction, so cross-module updates in one tick (for example, a wardrobe item removed and looks pruned) are written together. Data is cloned with a JSON round-trip before writing, as today. `start()` (not import) registers flushes on `pagehide` and on `visibilitychange` to hidden.

### 6.5 Backup format

Export (version 2):

```json
{ "app": "capsula", "version": 2, "exportedAt": "2026-10-07T10:00:00.000Z", "slices": { "profile": { "v": 1, "data": {} } } }
```

Import accepts:

- **Version 2**: every known slice present in the file is migrated and replaces the current one. Unknown slice ids are ignored with a warning. **Slices absent from the file are left untouched.** This keeps calendar history when someone restores a backup made before the calendar existed.
- **Version 1** (`{ version: 1, state }`, today's format): goes through `fromLegacy` + `migrate` for every slice that has `fromLegacy`. Slices without it (calendar) are untouched.
- Anything else: throw `Это не файл резервной копии Capsula` (existing message).

Import computes every new slice first, then swaps them in and persists in one transaction, then emits `app:data-replaced`. It returns `{ notes }` with the counters collected by `note()`.

`resetAll()` sets every slice to `initial()`, deletes `legacy:state`, persists in one transaction and emits `app:data-replaced`.

## 7. Communication between modules

Three mechanisms, in order of preference.

### 7.1 Public API (reads and commands)

Synchronous functions exported from `api.js`, documented with JSDoc. Only modules that list the owner in `requires` may call them.

### 7.2 Events (notifications)

`core/events.js`: `on(name, fn)` returns an unsubscribe function; `emit(name, payload)` dispatches synchronously. A listener that throws is caught and logged and does not stop other listeners or the emitter. Names are `<module>:<past-tense>` for module events and `app:<...>` for kernel events. A module listens only to events of modules in its `requires`, plus `app:*`.

| Event                   | Emitted by | Payload      | Listeners                                                                    |
| ----------------------- | ---------- | ------------ | ---------------------------------------------------------------------------- |
| `wardrobe:item-removed` | wardrobe   | `{ id }`     | looks: drop the id from `item_ids` (today's behavior in `views/wardrobe.js`) |
| `capsule:rebuilt`       | capsule    | `{}`         | search: clear the result cache (today's `state.search = {}`)                 |
| `app:task-finished`     | core/tasks | `{ module }` | shell: re-render if that module's route is open (replaces `capsula:refresh`) |
| `app:data-replaced`     | core/store | `{}`         | shell: re-render the current route                                           |

### 7.3 Extension points (soft dependencies)

`core/extensions.js`: `contribute(point, item)` is called only from `init()`. Every item has a string `id`; a duplicate `(point, id)` throws. `list(point)` returns items sorted by `order` (default 100), then by registration order.

| Point                  | Item shape                                           | Rendered or consumed by               | Contributed by           |
| ---------------------- | ---------------------------------------------------- | ------------------------------------- | ------------------------ |
| `look.actions`         | `{ id, label, order?, run(snapshot: LookSnapshot) }` | look cards in looks and capsule views | calendar (`В календарь`) |
| `look.sources`         | `{ id, label, order?, list(): LookSnapshot[] }`      | calendar's "add look" picker          | looks, capsule           |
| `stylist.context` (T6) | `{ id, order?, lines(): string[] }`                  | looks and capsule prompt builders     | calendar (wear history)  |

Generic rendering helpers in `core/extensions.js`, so views don't each reinvent them:

- `actionsHtml(point, key)` returns `<div class="actions">` with one `<button type="button" class="btn small" data-point data-action data-key>` per contributed item, or `""` when there are none.
- `bindActions(root, point, resolve)` adds one delegated click listener. `resolve(key)` returns the payload (for `look.actions`, a `LookSnapshot`) from the **same array that was rendered**, not from state at click time.

## 8. Kernel services

- **`core/registry.js` `start(modules)`**: validates manifests (id format, unique ids, every `requires` entry listed **earlier**, which also rules out cycles; a route needs `label`, `order` and `render`). Loads settings and slices in module order, registers flush listeners, calls each `init()`, returns `{ routes }`. It does not touch the DOM.
- **`core/shell.js` `startShell({ routes })`**: builds the nav from routes sorted by `order`, routes `#<id>/<param>` (the first route is the default), shows the API-key banner, and re-renders after background tasks. The pending-refresh logic (`isEditing`, deferral on `focusout`, keeping scroll) moves here from `app.js` unchanged. Views are called as `render(root, { param })`.
- **`core/tasks.js`**: today's `runTask`, `isRunning`, `RUNNING_NOTE` and `rawDetails` from `ui.js`. The `data-task` attribute on the status element now means "module id" (it already equals the tab id). A finished task whose status element is detached emits `app:task-finished` instead of a window `CustomEvent`.
- **`core/settings.js`**: `settings`, `defaultSettings`, `loadSettings`, `saveSettings` (from `store.js`), plus:
  - `endpointFor(slot)` returns `{ provider, model, effort, maxTokens, apiKey, accessCode, baseUrl }` for `"vision"` or `"stylist"`.
  - `slotProblem(slot)` returns `endpointProblem(endpointFor(slot))`.
  - `capabilities(slot)` returns `{ webSearch: provider === "openrouter" }`.
  - `loadServerConfig()` and `serverConfig()` replace `ctx.serverConfig`.
  - `missingKeys()` drives the banner.
- **`core/ai.js`**: `askJson({ slot, system, user, images, extra, expect, signal, onProgress, onNotice })` calls `chatJson` with `endpointFor(slot)`; `problem(slot)` is `slotProblem`.

## 9. Behavioral invariants

The refactor (T1 to T3) must not change observable behavior except where a brief says so. These invariants are the checklist:

1. **Normalize, render to string, commit, paint.** An AI result is normalized (throws on garbage), rendered to an HTML string, then committed to the slice, then painted only if the target node is still connected. A bad answer never overwrites a good saved result.
2. DOM nodes used after a long task come from the closure and are checked with `isConnected`.
3. One running task per module. A view rendered while its task runs shows `RUNNING_NOTE` and a disabled button.
4. A finished background task re-renders its tab if it is open, deferred while the user is typing in a field, keeping the scroll position.
5. Saves are throttled at 50 ms and flushed on `pagehide` and `visibilitychange`.
6. Everything rendered from stored or model data goes through `esc`, `safeImage`, `safeUrl` or `safeHex`.
7. Stored data is migrated on load and on import. Unrecoverable parts are dropped with a console warning; the app never crashes on bad data.
8. If IndexedDB is unavailable, the app works in memory and warns.
9. Exact error messages, toasts and UI copy stay the same.
10. LLM request payloads stay byte-identical for the same inputs (same prompts, same parameters, same retry and parameter-dropping logic).

## 10. Module catalog

| Module     | Slice (v1 shape)                       | `fromLegacy`                                                 | Requires          | API                                                                             | Emits                   | Listens / contributes                                            |
| ---------- | -------------------------------------- | ------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `settings` | none (localStorage via core)           | n/a                                                          | none              | none                                                                            | none                    | none                                                             |
| `profile`  | `{ photos, inputs, analysis, wishes }` | `{ ...legacy.profile, wishes: legacy.wishes }`               | none              | `brief()`, `analysis()`, `inputs()`, `palette()`, `wishes()`, `setWishes(text)` | none                    | none                                                             |
| `wardrobe` | `{ items }`                            | `{ items: legacy.wardrobe }`                                 | none              | `items()`, `byId()`, `ids()`, `brief(items?)`                                   | `wardrobe:item-removed` | none                                                             |
| `looks`    | `{ list }`                             | `{ list: legacy.looks }`                                     | profile, wardrobe | none                                                                            | none                    | listens `wardrobe:item-removed`; contributes `look.sources` (T5) |
| `capsule`  | `{ result, options }`                  | `{ result: legacy.capsule, options: legacy.capsuleOptions }` | profile, wardrobe | `buyList()`, `buyItem(id)`                                                      | `capsule:rebuilt`       | contributes `look.sources` (T5)                                  |
| `search`   | `{ cache, last }`                      | `{ cache: legacy.search, last: legacy.searchLast }`          | profile, capsule  | none                                                                            | none                    | listens `capsule:rebuilt`                                        |
| `calendar` | see `calendar.md`                      | none                                                         | wardrobe          | `entriesBetween()`, `entriesOn()`, `wearStats()`                                | none                    | contributes `look.actions`; T6: `stylist.context`                |

Boot order in `modules.js`: `settings, profile, wardrobe, looks, capsule, search, calendar`. Nav order comes from `route.order`: profile 10, wardrobe 20, looks 30, calendar 35, capsule 40, search 50, settings 90.

`state.wishes` moves into the profile slice. The looks and capsule views keep their wishes textarea and write it through `profile.setWishes()`.

## 11. Decisions and trade-offs

- **ES module singletons instead of dependency injection.** The app has one instance of everything. Tests reset singletons with `clear()` and `useBackend()`. A DI container would add code and buy nothing here.
- **Static module list in `modules.js` instead of discovery.** No build step means no glob imports. One line per module is explicit and cheap.
- **Per-module storage keys.** A wardrobe edit no longer rewrites looks, capsule and search, and a corrupted slice can't take others down with it. Photos still live inside the profile and wardrobe slices, so a wardrobe edit still rewrites every wardrobe image. Splitting images into their own keys is a possible follow-up, not part of this plan.
- **Keep `legacy:state` after the split.** It costs one extra copy of the data in IndexedDB but makes the storage migration recoverable. Delete it in a later release.
- **Extension points only where the dependency would otherwise point the wrong way.** Three points, each with a real consumer. No generic plugin system.
- **Read APIs return live objects.** Copying the wardrobe (with images) on every read is wasteful. Rule 5 in section 4 covers it.
- **The refactor's critical path is sequential.** Storage is shared by every feature, so cutting it over one feature at a time would mean shipping two storage systems side by side with real data-loss risk. T3 does the cutover in one PR. Parallel work happens around it (see `README.md`).

## 12. What this does not fix

- String templates with `innerHTML` and manual event wiring stay. A component framework is a separate decision.
- No types. JSDoc `@typedef` on `api.js` exports and on `shared/look-snapshot.js` is recommended, not required.
- One global `styles.css`. New modules add a commented section with class names prefixed by the module (for example `.cal-`).
- No i18n layer. Russian strings stay inline.
