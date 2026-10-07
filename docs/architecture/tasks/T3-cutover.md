# T3. Cutover: features become modules, the app boots on the kernel

|                       |                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Depends on            | T1 and T2 merged                                                                               |
| Runs in parallel with | T4                                                                                             |
| Unblocks              | T5                                                                                             |
| Size                  | large, the critical path. Mostly moving code, with the storage migration as the one risky part |

Read first: all of `docs/architecture/target.md`. Section 9 (invariants) is your checklist.

## Goal

Every feature becomes a module under `modules/`, `app.js` boots through `core/registry.js` and `core/shell.js`, and storage moves from the single `state` blob to per-module slices. Afterwards `store.js`, `prompts.js`, `normalize.js`, `ui.js`, `shops.js` and `views/` no longer exist. **Observable behavior stays the same**, with these allowed exceptions:

- Backups are exported in version 2. Version 1 files still import.
- After a backup import or "Удалить все данные", the current tab re-renders (`app:data-replaced`).

## Do it in this order, keeping every commit green

1. **Characterization fixtures, before touching anything.** Write `test/fixtures/legacy-state.json`: a realistic legacy blob with 3 wardrobe items (tiny valid `data:image/jpeg;base64,...` images, one item with a non-data-URL image), a profile with 2 photos and an analysis, `wishes` ending with a newline (it must survive unchanged), 2 looks (one referencing a missing item id), a capsule with `keep`, `drop`, `buy` and `looks`, `capsuleOptions`, a `search` cache with one garbage entry, and `searchLast`. Run **today's** `migrate()` on a copy and save the result as `test/fixtures/legacy-state.expected.json` together with its `droppedImages` count. Commit the fixtures only, not the script.
2. **Prompt builder fixtures.** For each AI call (analysis, recognition batch, looks, capsule, search), compute the exact `system` and `user` strings today's code sends for a fixed state. The user messages are template literals inside today's views, so evaluate those literals with the fixed state in a throwaway script, or run the app in the browser with `fetch` mocked and read the request bodies. Store the results as literal expected strings for the tests in step 6.
3. **New core files, additive:** `core/settings.js`, `core/ai.js`, `core/tasks.js`, `core/shell.js` per target.md section 8. Move `endpointFor` and `slotProblem` from `store.js` (T1's bridge) into `core/settings.js`. Replace T2's inlined `isRecord` with `lib/coerce.js`. Add settings loading (`loadSettings()`, localStorage only) to `registry.start`.
4. **Modules, additive** (nothing imports them yet), per the map below. Add `shared/persona.js` with `BASE`.
5. **Switch:** `public/js/modules.js` (module list), new `app.js`: `const { routes } = await start(modules); await loadServerConfig(); startShell({ routes });`. Today's `app.js` awaits the server config before the first render; keep it that way. Delete the old files.
6. **Tests:** move existing tests to the new import paths. Four storage tests are ported rather than moved (see the end of «New tests»). Delete every stub of `addEventListener`, `document` and `indexedDB`, but keep the `globalThis.fetch` mocks in `test/llm.test.mjs` and `test/proxy.test.mjs`. Add the new tests listed below.
7. **README:** update the «Структура» section (in Russian) to the new layout and link `docs/architecture/`.

## Module map

Each module gets the files from target.md section 5. Required behavior per module:

### `settings` (no slice, `route: { label: "Настройки", order: 90 }`)

`view.js` ← `views/settings.js`. It uses `core/settings.js` for settings and server config, `ai/providers.js` for the constants, and `exportBackup`, `importBackup`, `resetAll` from `core/store.js`. The import toast reads `notes.droppedImages`; the messages don't change.

### `profile` (`requires: []`, order 10)

- `model.js`: slice `profile` v1, `initial: { photos: [], inputs: {}, analysis: null, wishes: "" }`. `migrate` does today's profile part of `migrate()`: keep only `safeImage` photos and `note("droppedImages", n)`; `inputs` must be a plain object; `analysis`: `null` when falsy, otherwise through `normalizeAnalysis`, `null` with a warning on throw (today's `if (st.profile.analysis)` guard, so users without an analysis get no warning); `wishes` kept **verbatim** when it is a string, otherwise `""`. Today's `migrate()` doesn't touch `wishes`, and `text()` would trim it on every boot and change the prompts. `fromLegacy: (l) => ({ ...l.profile, wishes: l.wishes })`. Also `normalizeAnalysis` and the commands (add or remove a photo, set an input, `setAnalysis`, `setWishes`).
- `prompts.js`: `ANALYSIS_SYSTEM`, the user-message builder, `brief(data)` (today's `profileBrief`, taking slice data instead of the whole `state`).
- `service.js`: `analyze(task)` → normalized analysis. Doesn't save.
- `api.js`: `brief()`, `analysis()`, `inputs()`, `palette()` (names of `best_colors`), `wishes()`, `setWishes(text)`.
- `view.js`: today's view. Invariant 1: inside the function passed to `runTask`, `analyze(t)`, then `renderAnalysis(result)`, then `setAnalysis(result)`, returning the HTML; after `runTask`, paint if connected. Never commit after `await runTask(...)` (target.md section 9, invariant 1).

### `wardrobe` (`requires: []`, order 20)

- `model.js`: slice `wardrobe` v1, `initial: { items: [] }`. `migrate` does today's wardrobe part (plain objects only, `id` coerced to string, `safeImage`, `note("droppedImages", n)`). `fromLegacy: (l) => ({ items: l.wardrobe })`. Also `normalizeItem`, `recognizedItems`, and the commands: add items, update a field, `removeItem(id)` (splice, then `emit("wardrobe:item-removed", { id })`, then save), apply recognition results to a batch.
- `prompts.js`: `WARDROBE_SYSTEM`, the batch message, `brief(items)` (today's `wardrobeBrief`).
- `service.js`: `recognizePending(task, { onBatchDone })`: today's loop (`BATCH = 6`, skipping items without an image, the same notices and errors), applying and saving after every batch, calling `onBatchDone()` so the view repaints.
- `api.js`: `items()`, `byId()`, `ids()`, `brief(list = items())`. Don't name the parameter `items`: it would shadow the function and its own default would throw a `ReferenceError`.
- `view.js`: today's view, minus the direct edit of `state.looks`.

### `looks` (`requires: ["profile", "wardrobe"]`, order 30)

- `model.js`: slice `looks` v1, `initial: { list: [] }`. `migrate: normalizeLooks({ looks: raw?.list }, ids from deps.get("wardrobe").items)`. `fromLegacy: (l) => ({ list: l.looks })`. Also `normalizeLooks`, `pruneItem(id)` (today's filter of `item_ids`, nothing else), `setLooks(list)`.
- `index.js` `init`: `on("wardrobe:item-removed", ({ id }) => pruneItem(id))`.
- `prompts.js`, `service.js` (`generate(task, { count })`, same "no looks" error), `view.js` (wishes textarea writes through `profile.setWishes`; render and `setLooks` inside the `runTask` callback, as in profile).

### `capsule` (`requires: ["profile", "wardrobe"]`, order 40)

- `model.js`: slice `capsule` v1, `initial: { result: null, options: { size: 15, season: SEASONS[0], budget: "", useWardrobe: true } }`. `migrate`: `result` is `null` when falsy, otherwise through `normalizeCapsule` with wardrobe ids, `null` with a warning on throw (today's `if (st.capsule)` guard); `options` merged over the defaults without clamping (today's behavior). `fromLegacy: (l) => ({ result: l.capsule, options: l.capsuleOptions })`. Also `normalizeCapsule` with its private helpers `idRoles` and `PRIORITIES` (from `normalize.js`; `ids` and `incomplete` come from `lib/coerce.js` and `shared/errors.js` after T1), `SEASONS`, `PRIORITY` (moved from `ui.js`), `setResult(c)` (sets, then `emit("capsule:rebuilt", {})`, then saves), `setOption(k, v)`.
- `api.js`: `buyList()`, `buyItem(id)`.
- `prompts.js`, `service.js` (`build(task, { options, useWardrobe })`), `view.js` (render and `setResult` inside the `runTask` callback, as in profile).

### `search` (`requires: ["profile", "capsule"]`, order 50)

- `model.js`: slice `search` v1, `initial: { cache: {}, last: "" }`. `migrate`: today's search part (entries must be plain objects, results through `normalizeSearch`); `last` through `text()`. `fromLegacy: (l) => ({ cache: l.search, last: l.searchLast })`. Also `normalizeSearch`, `keepCited(results, annotations)` (today's citation filter as a pure function returning `{ results, verified }`), `setResult(query, entry)`, `clear()`.
- `index.js` `init`: `on("capsule:rebuilt", clear)`.
- `shops.js` moves here unchanged. The OpenRouter-only check becomes `capabilities("stylist").webSearch`.
- `prompts.js`, `service.js` (`find(task, { query, item })`), `view.js` (`setResult` inside the `runTask` callback, as today's `views/search.js` does; paint after).

## New tests

1. **`test/legacy-migration.test.mjs`**: memory backend preloaded with `{ state: legacy-state.json }`, `await start(modules)`. Every slice's data equals the expected fixture mapped to the new shapes (`wardrobe` → `wardrobe.items`, `profile` + `wishes` → `profile`, `looks` → `looks.list`, `capsule` → `capsule.result`, `capsuleOptions` → `capsule.options`, `search` → `search.cache`, `searchLast` → `search.last`). The backend now holds every `mod:` key, and `state` still deep-equals `legacy-state.json`. Then `await resetAll()` and `importBackup` of a v1 file with the same blob, into the now empty store: every slice again equals the expected fixture (looks and capsule `keep`/`drop` intact, which proves `deps.get` reads the imported wardrobe), and `notes.droppedImages` equals the recorded count.
2. **`test/modules.test.mjs`**: after `start(modules)`, `removeItem(id)` prunes looks through the event and both slices go out in one backend write (`await flush()`, then check the memory backend's `writes`); `setResult` on the capsule clears the search cache; `exportBackup()`, then `resetAll()`, then `importBackup(...)` of the exported text restores identical data. Use the registry's `resetForTests()` between cases that need a fresh `start(modules)`.
3. **Prompt builders**: for each builder, the exact `system` and `user` strings from step 2.
4. **`test/architecture.test.mjs`**, enforcing target.md section 4:
   - walk `public/js` (excluding `vendor/`), extract specifiers from `import ... from "x"`, `import "x"` and `export ... from "x"`, resolve them, and check them against the table and extra rules 1 to 3;
   - fail on any `import(` in `public/js` (excluding `vendor/`);
   - for `modules/X → modules/Y/api.js`, read `requires` from X's manifest and require Y to be in it;
   - the order in `modules.js` satisfies every `requires`;
   - every file except `app.js` imports in bare Node without throwing, and the test file stubs no globals (rule 4).

   A folder under `modules/` that isn't in `modules.js` yet (T4 adds `modules/calendar/model.js` before T5 wires it) is only checked for import rules, not for a manifest.

Every test that exists when T3 starts keeps its assertions. Only import paths and names change (`profileBrief` becomes profile `prompts.js` `brief`, `wardrobeBrief` becomes wardrobe `prompts.js` `brief`, `swatches` and `safeHtml` come from `ui/components.js`, and so on). The exceptions, which you list in the PR:

- `brief` takes the profile slice data, so `profileBrief({ profile: X })` becomes `brief(X)` (`test/normalize.test.mjs`, 4 calls).
- Four tests in `test/normalize.test.mjs` use `migrate`, `defaultState`, `importData` or the global `state` from `store.js`, which no longer exist: «миграция: сохранённое в кривой форме…», «миграция чистит чужие картинки и id вещей», «importData проходит миграцию и отклоняет не-копии» and «картинки: jpg принимается, миграция и импорт сообщают, сколько отброшено». Port them to the kernel. Call `useBackend(memoryBackend())` and `await start(modules)` once at the top of the file. Each `migrate(st)` becomes `const { notes } = await importBackup(JSON.stringify({ version: 1, state: input }))`, where `input` is the same object without the `...defaultState()` spread (`fromLegacy` and `migrate` fill in the defaults). Each `importData(text)` becomes `importBackup(text)` with the same text; a versionless `{ state }` file stays versionless, since it is still a v1 backup. Assert the same values on slice data (`wardrobe.items`, `profile.photos`, `profile.inputs`, `profile.analysis`, `looks.list`, `capsule.result`, `search.cache`) and read `droppedImages` from `notes.droppedImages`. Drop the `globalThis.indexedDB = undefined` lines and the IndexedDB try/catch. The rejection checks keep their regex.

The number of pre-existing tests stays the same. State it and the new total in the PR.

## Manual verification in a browser (required, report it in the PR)

Chromium and Playwright are preinstalled in the cloud environment (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Use a throwaway script outside the repo.

1. `npm run dev`. Open `http://localhost:8888`, write `legacy-state.json` into IndexedDB `capsula` / `kv` under key `state` and delete every `mod:*` key, then reload.
2. Every tab shows the fixture data: wardrobe count and names, look names, capsule concept and purchases, the search query and cached results, profile inputs and wishes.
3. IndexedDB now holds `mod:profile`, `mod:wardrobe`, `mod:looks`, `mod:capsule`, `mod:search`, and the original `state`, unchanged.
4. Delete a wardrobe item used in a look: the look loses that item after a reload.
5. "Скачать копию" produces `version: 2`. "Удалить все данные" empties every tab and leaves only `mod:` keys with initial data in IndexedDB (`state` is gone). Importing the downloaded file restores everything.
6. Restart with `OPENROUTER_API_KEY=dummy PILOT_ACCESS_CODE=x npm run dev` and a clean browser profile (no keys in settings). On the very first render the missing-key banner is hidden, and the settings tab says `На сервере настроен токен пилота: OpenRouter. Нужен код доступа.` and shows the access-code field. That proves the server config is loaded before the first render.
7. Type in the looks wishes field, switch to Профиль: the same text is there.
8. With an API key, if you have one: start a looks generation, switch tabs, come back, and check the result appears (invariants 3 and 4). Without a key, say so in the PR.

## Acceptance criteria

1. `npm test` green, including the four new test groups.
2. `store.js`, `prompts.js`, `normalize.js`, `ui.js`, `shops.js` and `views/` are gone. Nothing in `public/js` mentions `capsula:refresh`.
3. The browser checklist above passes and is reported in the PR.
4. Every invariant in target.md section 9 holds. If one doesn't, explain it in the PR under **Deviations from architecture**.

## Out of scope

The calendar (T4, T5). `look.actions` and `look.sources` rendering (T5). New features, prompt changes, CSS changes, fixing pre-existing bugs (list them in the PR instead).
