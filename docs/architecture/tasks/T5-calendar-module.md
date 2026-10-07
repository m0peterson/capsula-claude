# T5. Calendar module: slice, UI, integration with looks and capsule

|                       |                          |
| --------------------- | ------------------------ |
| Depends on            | T3 and T4 merged         |
| Runs in parallel with | nothing in this plan     |
| Unblocks              | T6 (optional)            |
| Size                  | medium. Most of it is UI |

Read first: all of `docs/architecture/calendar.md`, then `docs/architecture/target.md` sections 5 and 7.

## Goal

Ship the calendar as described in calendar.md: a new module `calendar`, a "В календарь" action on every look card in Образы and Капсула, and the looks and capsule modules offering their looks to the calendar's picker. Looks and capsule must not import anything from `calendar`.

## Work items

### Kernel and shared UI

1. `core/extensions.js`: add `actionsHtml(point, key)` and `bindActions(container, point, resolve)` exactly per target.md section 7.3. Labels go through `esc`. `bindActions` attaches one delegated listener on the `container` passed in, ignores clicks on other points, and passes `resolve`'s result to `run` unchanged, including `null`.
2. `ui/components.js`: add `placeholderThumb(item)`, today's `buyThumb` from the capsule view (color plus category label). Switch the capsule view to it.

### Looks and capsule

3. `looks/model.js`: `toSnapshot(look, wardrobeById)` per calendar.md section 6. `looks/index.js` `init`: contribute `look.sources` `{ id: "looks", label: "Из образов", order: 10, list }`, where `list()` maps the saved looks through `toSnapshot` and drops `null`s.
4. `capsule/model.js`: `toSnapshot(capsuleLook, wardrobeById, buyById)`. `capsule/index.js` `init`: contribute `look.sources` `{ id: "capsule", label: "Из капсулы", order: 20, list }`. Empty when there is no capsule.
5. Both views: render `actionsHtml("look.actions", i)` at the bottom of each look card. Each view keeps `let shown` (looks: the looks array; capsule: the capsule object, whose `looks` and `buy` the resolver needs) and calls `bindActions(container, "look.actions", (i) => toSnapshot(shown…[i], …))` once per `render()`. The container is the element that holds the cards (looks: `[data-looks]`; capsule: `[data-result]`), **never** the `root` argument of `render`. Every code path that writes cards into the container sets `shown` right next to the `innerHTML` assignment: the initial render and the paint after a finished generation. The resolver reads `shown` at click time. With no contributions, `actionsHtml` returns `""` and the cards look exactly as before.

### Calendar module (`modules/calendar/`)

6. `model.js`: add `slice = defineSlice("calendar", { version: 1, initial, migrate })` with no `fromLegacy`, plus wrappers that pass `slice.data` to T4's pure functions and call `slice.save()`.
7. `api.js`: `entriesBetween`, `entriesOn`, `wearStats` (calendar.md section 5).
8. `index.js`: `requires: ["wardrobe"]`, `route: { label: "Календарь", order: 35, render }`. `init` contributes `look.actions` `{ id: "calendar.plan", label: "В календарь", run: (snapshot) => (snapshot ? openPlanDialog({ snapshot }) : toast("В образе не осталось вещей", "error")) }`. The pick step is opened only by `openPlanDialog({ pick: true, date })` from the calendar view (calendar.md section 7).
9. `dialog.js`: the pick and form steps from calendar.md section 7, "Plan dialog", including the form step's edit mode (`Изменить` must update the entry, never create a second one).
10. `view.js`: route parsing, month grid, day panel, the unconfirmed list, the next 14 days and the entry card actions, per calendar.md section 7. Day and month changes use `history.replaceState`, not `location.hash`.
11. `public/js/modules.js`: add `calendar` at the end.
12. `public/styles.css`: a `/* Календарь */` section, every class prefixed `cal-`, only existing tokens.
13. `README.md`: add the calendar to the feature list (in Russian, matching the existing style) and state that calendar data lives in the browser like everything else and is included in backups.

UI copy: use exactly the Russian strings in calendar.md. If you need a string the doc doesn't define, keep it short and in the same tone, and list it in the PR.

## Tests

1. `test/calendar-module.test.mjs`, no globals stubbed:
   - `start(modules)` on an empty memory backend: `list("look.sources")` has `looks` and `capsule`; `list("look.actions")` has `calendar.plan`.
   - `looks` `toSnapshot`: a look with a deleted item id gives a snapshot without it; a look whose items are all gone gives `null`.
   - `capsule` `toSnapshot`: a buy ref gives `{ ref: null, toBuy: true }` with the purchase's name, category, color and `color_hex`; a wardrobe ref gives `{ ref: id, toBuy: false }` with the wardrobe item's `color_hex`; an unknown ref is skipped. A look with only unknown refs gives `null`.
   - Plan through the wrappers, then `flush()`: the backend holds `mod:calendar`. Then `exportBackup()` contains `slices.calendar`.
   - A v1 backup import leaves the calendar untouched. A v2 import without `calendar` leaves it untouched. `resetAll()` empties it.
   - Removing a wardrobe item leaves calendar entries unchanged.
2. `test/architecture.test.mjs` passes with the new module, and confirms looks and capsule don't import calendar.
3. `actionsHtml` with no contributions returns `""`, and with two contributions renders them in `order`. `bindActions` calls the right `run` with the resolved payload. A minimal fake element is enough here, or test `actionsHtml` only and cover `bindActions` in the browser check.

## Manual verification in a browser (required, report it in the PR)

Use Playwright with the preinstalled Chromium at viewport widths 375 and 1280, in light and dark color schemes. Seed data through IndexedDB as in T3 (a wardrobe with photos, saved looks, a capsule) so you don't need an API key.

1. Образы: every card has "В календарь". Plan a look for tomorrow; the toast names the date.
2. Капсула: plan a capsule look containing a purchase; in the calendar the purchase renders as a placeholder with `(докупить)`.
3. Календарь: tomorrow's cell shows a ring marker; the day panel shows the entry as `Запланирован`; "Ближайшие 14 дней" lists it.
4. "Добавить образ" on a past day, then "Собрать из гардероба" with 2 items: the entry is `Надет` and the marker is filled.
5. Seed an entry for yesterday with status `planned`: it shows as `Не отмечен` and in "Не отмечены", and its marker is a clearly visible ring in `--no` in both color schemes. `Надет` moves it to worn.
6. Delete a wardrobe item used in an entry: the entry shows the placeholder and `Вещи больше нет в гардеробе`.
7. Month navigation doesn't scroll the page to the top; reloading keeps the selected month and day.
8. No horizontal scroll at 375 px. Screenshots of the month view at both widths in the PR.
9. Export a backup, delete all data, import it: the calendar is restored.
10. Switch between Образы and Капсула five times, then click "В календарь" once: exactly one dialog opens, for the look you clicked.
11. Seed a capsule whose look references only a deleted wardrobe item: "В календарь" shows the toast `В образе не осталось вещей` and no dialog opens. (Not a Node test: `toast` needs `document`.)
12. With an API key, if you have one: generate looks, then click "В календарь" on a new card without leaving the tab. The dialog shows the new look, not one from before the generation.

## Acceptance criteria

1. `npm test` green.
2. Every item in calendar.md sections 1 (in scope), 6, 7 and 8 works, as shown by the browser checklist.
3. Deleting `modules/calendar/` and its line in `modules.js` leaves looks and capsule working with no "В календарь" button. For this local check also delete `test/calendar-core.test.mjs` and `test/calendar-module.test.mjs`; `npm test` must then be green. Mention the check in the PR; don't commit the deletion.

## Out of scope

Everything in calendar.md under "Not in v1". Wear history in prompts (T6). Wear counts on wardrobe cards.
