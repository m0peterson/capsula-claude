# T1. Foundation: extract `lib/`, `ai/`, `shared/`, `ui/`

|                       |                                     |
| --------------------- | ----------------------------------- |
| Depends on            | nothing                             |
| Runs in parallel with | T2                                  |
| Unblocks              | T3, T4                              |
| Size                  | small to medium, mostly moving code |

Read first: `docs/architecture/target.md` sections 3, 4 and 9.

## Goal

Move every pure helper out of `util.js`, `normalize.js`, `llm.js` and `ui.js` into the target layers, and make the LLM client independent of `store.js`. **No behavior change.** The app, the requests sent to `/api/llm` and every error message stay identical.

## Move map

| From                | Symbols                                                                                                                                                              | To                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `util.js`           | `esc`, `safeHex`, `safeImage`, `safeUrl`                                                                                                                             | `lib/html.js`                                                                   |
| `util.js`           | `arr`, `isRecord`                                                                                                                                                    | `lib/coerce.js`                                                                 |
| `util.js`           | `uid`                                                                                                                                                                | `lib/ids.js`                                                                    |
| `util.js`           | `fileToDataUrl`                                                                                                                                                      | `lib/images.js`                                                                 |
| `util.js`           | `parseModelJson`, `extractJson` and their private helpers (`balancedEnd`, `jsonError`, `startsOf`, `fencedBlocks`, `stripThink`, `pickBest`, constants)              | `ai/parse-json.js`                                                              |
| `util.js`           | `shrinkDataUrl`                                                                                                                                                      | delete (never called)                                                           |
| `normalize.js`      | `text`, `list`, `records`, `colors` (with its private `HEX_IN_TEXT`), and `validHex` and `ids` (now exported, unchanged; looks and capsule both need `ids` after T3) | `lib/coerce.js`                                                                 |
| `normalize.js`      | `incomplete` (now exported, unchanged; builds the user-facing "Модель вернула неполный результат" error that profile and capsule both throw after T3)                | `shared/errors.js`                                                              |
| `normalize.js`      | `CATEGORY_KEYS`                                                                                                                                                      | `shared/catalog.js`, derived as `Object.keys(CATEGORIES)` (same order as today) |
| `ui.js`             | `CATEGORIES`, `catLabel`                                                                                                                                             | `shared/catalog.js`                                                             |
| `ui.js`             | `toast`                                                                                                                                                              | `ui/toast.js`                                                                   |
| `ui.js`             | `swatches`, `thumb`, `emptyState`, `readImages`, `safeHtml`                                                                                                          | `ui/components.js`                                                              |
| `llm.js`            | `chat`, `chatJson`, `cutError`, `userContent`, `resetLearned`, `fetchServerConfig` and private helpers                                                               | `ai/client.js`                                                                  |
| `llm.js`            | `EFFORTS`, `MODEL_SUGGESTIONS`                                                                                                                                       | `ai/providers.js`                                                               |
| `views/settings.js` | `PROVIDER_NAMES`                                                                                                                                                     | `ai/providers.js`                                                               |
| `llm.js`            | `slotProblem`                                                                                                                                                        | replaced, see below                                                             |

Stays where it is until T3: domain normalizers in `normalize.js` (with their private helpers `idRoles` and `PRIORITIES`, which T3 moves to the capsule module), everything in `store.js` and `prompts.js`, and in `ui.js` only `runTask`, `isRunning`, `RUNNING_NOTE`, `rawDetails` and `PRIORITY`. Delete `util.js` and `llm.js` once they're empty.

## Decouple the client from settings

`ai/client.js` must not import `store.js`. Replace the `slot` parameter of `chat` and `chatJson` with `endpoint`, an object already resolved from settings:

```js
/**
 * @typedef {object} Endpoint
 * @property {"openrouter" | "opencode-go" | "custom"} provider
 * @property {string} model
 * @property {string} effort      "" means "don't send"
 * @property {number} maxTokens   0 means "don't send"
 * @property {string} apiKey      user's own key, "" when the server key is used
 * @property {string} accessCode  pilot access code from settings, or ""
 * @property {string} baseUrl     only for "custom", "" otherwise
 */
```

- `headersFor(endpoint)`: `x-provider`; `x-api-key` when `apiKey` is set, otherwise `x-access-code` when `accessCode` is set; `x-base-url` for `custom`. Same as today.
- The learned-parameters cache key stays `${provider}|${provider === "custom" ? baseUrl : ""}|${model}|${effort}|${maxTokens}`.
- `ai/providers.js` exports `endpointProblem(endpoint)` with today's two messages from `slotProblem`, unchanged.

Temporary bridge until T3 moves it to `core/settings.js`: add to `store.js`

- `endpointFor(slotName)` for `"vision"` or `"stylist"`, built from `settings[slotName]` and `settings.providers[...]` and `settings.accessCode`;
- `slotProblem(slotName)` returning `endpointProblem(endpointFor(slotName))`.

Then update the call sites in the views: `slotProblem(settings.vision)` becomes `slotProblem("vision")`, and `chatJson({ slot: settings.stylist, ... })` becomes `chatJson({ endpoint: endpointFor("stylist"), ... })`. `views/search.js` also checks `settings.stylist.provider === "openrouter"`; leave that as is.

## Tests

- Update import paths in `test/*.mjs`. Where a test calls a moved helper through a namespace (`N.text(...)`, `N.colors(...)` in `test/normalize.test.mjs`), import it from its new file and call it directly; don't add re-exports to `normalize.js` to keep old names working. No assertion may change, except in `test/llm.test.mjs`, where `slot` + mutating `settings.providers` becomes an `endpoint` object. For example `const endpoint = () => ({ provider: "openrouter", model: "m/x", effort: "xhigh", maxTokens: 16000, apiKey: "sk-test", accessCode: "", baseUrl: "" })`. The custom-provider test passes two endpoints with base URLs `a` and `b` instead of mutating settings in between.
- `test/llm.test.mjs` should no longer import `store.js`. Drop its `globalThis` stubs if nothing else needs them.
- The 113 existing tests pass. Count them in the PR description.

## Acceptance criteria

1. `npm test` is green with the same number of tests (113) and unchanged assertions, apart from the `endpoint` change above.
2. No file in `lib/`, `ai/`, `shared/` or `ui/` imports `store.js`, `prompts.js`, `normalize.js` or anything in `views/`.
3. `lib/`, `ai/` and `shared/` follow the import table in target.md section 4.
4. `git grep -n shrinkDataUrl` returns nothing.
5. `npm run dev`, then in a browser: every tab renders, and the settings tab saves a key. If you have an API key, run one look generation. Otherwise rely on the payload test in `test/llm.test.mjs` and say so in the PR.

## Out of scope

Kernel, modules, storage, `store.js` structure, prompt texts, CSS. Don't rename functions beyond `slot` → `endpoint`. Don't fix unrelated issues; list them in the PR description instead.
