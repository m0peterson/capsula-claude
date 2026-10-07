# Calendar module: past and planned looks

Module id `calendar`. Built in T4 (pure domain) and T5 (module, UI, integration). T6 is an optional follow-up that feeds wear history into the stylist prompts.

## 1. What it does

A dated record of looks:

- **Future**: plan a look for a date (today or later).
- **Past**: log what was worn on a date, or confirm that a planned look was worn.

Looks come from three places: saved looks (Образы tab), capsule looks (Капсула tab), or put together by hand from wardrobe items.

### In scope (v1)

- Plan a look on a date from any look card ("В календарь") or from the calendar itself ("Добавить образ").
- Compose a look by hand from wardrobe items.
- Mark an entry as worn or not worn, change its date, occasion and note, repeat it on another date, delete it.
- Month grid, day panel, the next 14 days, and a list of past entries nobody confirmed.
- Wear statistics per wardrobe item, exposed through the API (used by T6, not shown in v1 UI).
- Included in backup export and import, and cleared by "Удалить все данные".

### Not in v1

AI planning ("plan my week"), weather, reminders and notifications, recurring entries, `.ics` export, editing the items of a saved entry, wear counts on wardrobe cards, sync between devices.

## 2. Key decision: entries store a snapshot, not a reference

Looks have no ids and the whole list is replaced every time looks are regenerated. Capsule looks are replaced when the capsule is rebuilt. Wardrobe items can be deleted. A calendar is history: what was worn on 12 September must not change because the looks were regenerated on 1 October.

So each entry copies the look at the moment it is planned: name, occasion, description, and for every item its wardrobe id (if owned), name, category, color and `color_hex`. `color_hex` matters: grid markers and placeholders are painted with it. **Images are not copied.** A wardrobe photo is a JPEG data URL of tens of kilobytes, and copying it into every entry would grow IndexedDB and backup files without limit.

Rendering rule for an item in an entry:

- `ref` points to an item still in the wardrobe: render the live item (its current photo and name).
- `ref` is set but the item is gone: render a color placeholder from the snapshot, captioned with the snapshot name and `Вещи больше нет в гардеробе`.
- `toBuy` is true (a capsule purchase): render the placeholder the capsule uses for purchases, captioned `(докупить)`.

Consequences, accepted: a deleted item loses its photo in the calendar; a renamed item shows its new name.

## 3. Data model

### LookSnapshot (`shared/look-snapshot.js`, T4)

Shared because looks and capsule build it and calendar consumes it.

```js
/**
 * @typedef {object} SnapshotItem
 * @property {string|null} ref   wardrobe item id, or null for an item to buy
 * @property {string} name       ≤ 120 chars, required
 * @property {string} category   one of CATEGORY_KEYS, default "other"
 * @property {string} color      ≤ 60 chars
 * @property {string} color_hex  validated "#rgb".."#rrggbbaa" or ""
 * @property {boolean} toBuy
 *
 * @typedef {object} LookSnapshot
 * @property {"looks"|"capsule"|"manual"} source
 * @property {string} name        ≤ 120, default "Образ"
 * @property {string} occasion    ≤ 120
 * @property {string} description ≤ 1000
 * @property {SnapshotItem[]} items  1..12
 */
export function normalizeSnapshot(raw) // → LookSnapshot | null (null when no valid item is left)
```

`normalizeSnapshot` is total and idempotent: garbage in gives `null` or a valid snapshot, never a throw. Items without a name are dropped. More than 12 items are cut to 12. `toBuy: true` forces `ref: null`.

### Calendar slice (version 1)

```js
/**
 * @typedef {object} Entry
 * @property {string} id          uid("c"), unique within the slice
 * @property {string} date        "YYYY-MM-DD", local calendar date
 * @property {"planned"|"worn"|"skipped"} status
 * @property {LookSnapshot} look
 * @property {string} note        ≤ 500 chars
 * @property {number} createdAt   ms since epoch
 * @property {number} updatedAt   ms since epoch
 */
// slice data: { entries: Entry[] }, kept sorted by date, then createdAt
```

`migrate(raw)` keeps entries with a valid date and a non-null `normalizeSnapshot(look)`. Unknown status becomes `"planned"`. Duplicate or missing ids get a new id. Non-numeric timestamps become `0`. The result is sorted. The slice has no `fromLegacy`, since the old app had no calendar.

### Dates

Dates are local calendar dates stored as `"YYYY-MM-DD"` strings. Never timestamps, never `toISOString()`: that returns the UTC date, which in Moscow (UTC+3) is yesterday between 00:00 and 03:00. String comparison orders ISO dates correctly.

`lib/dates.js` (T4), all pure, every function that needs "now" takes it as an optional argument:

| Function                     | Result                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `todayISO(now = new Date())` | local date of `now`                                                                                              |
| `isISODate(s)`               | strict `YYYY-MM-DD`, real day (rejects `2026-02-30`), year 1900 to 2100                                          |
| `isISOMonth(s)`              | strict `YYYY-MM`, month 01 to 12, year 1900 to 2100 (same range as `isISODate`)                                  |
| `monthOf(iso)`               | `"YYYY-MM"`                                                                                                      |
| `addDays(iso, n)`            | arithmetic with `Date.UTC` on parsed parts, so DST never shifts a day                                            |
| `addMonths(ym, n)`           | `"YYYY-MM"`                                                                                                      |
| `monthGrid(ym)`              | `{ month, weeks: [[{ date, inMonth }] × 7] }`, Monday first, only weeks that contain a day of the month (4 to 6) |
| `formatDay(iso)`             | `7 октября`                                                                                                      |
| `formatDayLong(iso)`         | `7 октября, среда`                                                                                               |
| `formatMonth(ym)`            | `Октябрь 2026`                                                                                                   |
| `WEEKDAYS_SHORT`             | `["Пн","Вт","Ср","Чт","Пт","Сб","Вс"]`                                                                           |

Month and weekday names are hard-coded arrays (nominative and genitive months), not `Intl`, so output does not depend on the ICU build.

`lib/plural.js`: `plural(n, ["образ", "образа", "образов"])` with Russian rules: `n % 10 === 1 && n % 100 !== 11` gives form 1 (1, 21, 101); `n % 10` in 2..4 and `n % 100` not in 12..14 gives form 2 (2, 3, 24); everything else gives form 3 (0, 5, 11, 12, 14, 25).

## 4. Domain functions (`modules/calendar/model.js`)

T4 writes them as pure functions over `data` (the slice data object) so they can be tested without the kernel. They mutate `data.entries` in place, keep it sorted, and return the affected entry. `now` and `newId` are injectable for tests. T5 adds the slice and thin wrappers that pass `slice.data` and call `slice.save()`.

| Function                                                     | Behavior                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan(data, { date, look, status?, note? }, { now, newId })` | Validates the date and the snapshot (throws `Error` with a Russian message when either is invalid). Default status: `"worn"` if `date < today`, otherwise `"planned"`. An explicit `status` follows the `setStatus` rule: `worn` or `skipped` with `date > today` throws `Нельзя отметить образ надетым заранее`. |
| `setStatus(data, id, status, { now })`                       | `"worn"` and `"skipped"` are only allowed for `date <= today`; otherwise it throws.                                                                                                                                                                                                                               |
| `update(data, id, { date?, occasion?, note? }, { now })`     | Moving an entry to a future date resets `worn` or `skipped` to `planned`. Re-sorts.                                                                                                                                                                                                                               |
| `remove(data, id)`                                           | Returns the removed entry or `null`.                                                                                                                                                                                                                                                                              |
| `repeat(data, id, date, { now, newId })`                     | New entry with a copy of the snapshot. Status follows the `plan` default.                                                                                                                                                                                                                                         |
| `effectiveStatus(entry, today)`                              | `"unconfirmed"` for `planned` with `date < today`, otherwise the stored status. Display only, never stored.                                                                                                                                                                                                       |
| `entriesBetween(data, from, to)`                             | Inclusive range, sorted.                                                                                                                                                                                                                                                                                          |
| `entriesOn(data, date)`                                      | Entries of one day.                                                                                                                                                                                                                                                                                               |
| `upcoming(data, today, days = 14)`                           | `today <= date < today + days`.                                                                                                                                                                                                                                                                                   |
| `unconfirmed(data, today, days = 30)`                        | `planned` entries with `today - days <= date < today`.                                                                                                                                                                                                                                                            |
| `wearStats(data, today)`                                     | `Map<ref, { count, last }>` over `worn` entries with `date <= today` and a non-null `ref`.                                                                                                                                                                                                                        |

The occasion lives in `entry.look.occasion`. The dialog writes the edited value into its copy of the snapshot before calling `plan`, and `update` writes it into the stored snapshot. That is the only snapshot field that can change after planning.

Status values never depend on the clock at storage time. "Unconfirmed" is derived when rendering, so changing the system clock or timezone cannot corrupt data.

## 5. Public API (`modules/calendar/api.js`, T5)

```js
entriesBetween(from, to); // Entry[]
entriesOn(date); // Entry[]
wearStats(); // Map<ref, { count, last }>, today = todayISO()
```

Read-only. Nothing in v1 requires `calendar`, so this API exists for T6 and future modules.

## 6. Integration

| What                                                          | Mechanism                                                                                                                                                                                                                                                           | Owner of the code                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "В календарь" button on every look card in Образы and Капсула | calendar contributes `look.actions` item `{ id: "calendar.plan", label: "В календарь", run(snapshot) }`; looks and capsule views render `actionsHtml("look.actions", i)` on each card and `bindActions(...)` resolving index `i` to a snapshot of the rendered look | calendar: the contribution and dialog. looks and capsule: rendering the point and `toSnapshot`   |
| Picking a saved or capsule look inside the calendar           | looks and capsule contribute `look.sources` items `{ id, label, list() }` returning snapshots                                                                                                                                                                       | looks: `{ id: "looks", label: "Из образов" }`. capsule: `{ id: "capsule", label: "Из капсулы" }` |
| Thumbnails and manual composition                             | `requires: ["wardrobe"]`, wardrobe `api.items()` and `api.byId()`                                                                                                                                                                                                   | calendar                                                                                         |
| Backup, reset                                                 | automatic via the slice                                                                                                                                                                                                                                             | kernel                                                                                           |
| Navigation                                                    | `route: { label: "Календарь", order: 35, render }`                                                                                                                                                                                                                  | calendar                                                                                         |

Snapshot builders live with the module that knows the source format:

- `looks/model.js` `toSnapshot(look, wardrobeById)`: items from `item_ids` that still exist, each `{ ref: id, name, category, color, color_hex, toBuy: false }` taken from the wardrobe item; `source: "looks"`.
- `capsule/model.js` `toSnapshot(capsuleLook, wardrobeById, buyById)`: refs found in `buy` become `{ ref: null, toBuy: true }` with the purchase's name, category, color and `color_hex`; refs found in the wardrobe become `{ ref: id, toBuy: false }`; unknown refs are skipped. `source: "capsule"`.

Both pass the result through `normalizeSnapshot`, so `toSnapshot` may return `null` (for example, a capsule look whose wardrobe items were all deleted; capsule refs are never pruned). `bindActions` passes `null` through unchanged, and the calendar's `run` handles it: it calls `toast("В образе не осталось вещей", "error")` and opens no dialog.

Calendar does not listen to `wardrobe:item-removed` or `capsule:rebuilt`. Snapshots make that unnecessary.

## 7. UI

### Route

| Hash                                                             | Shows                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `#calendar`                                                      | current month, today selected                                          |
| `#calendar/2026-10`                                              | that month; today selected if it falls in the month, otherwise the 1st |
| `#calendar/2026-10-07`                                           | that month, that day selected                                          |
| anything invalid (including a month or day outside 1900 to 2100) | same as `#calendar`                                                    |

Month navigation and day selection re-render the view in place and update the URL with `history.replaceState(null, "", "#calendar/<date>")`. They must not set `location.hash`: that fires `hashchange`, and the shell then scrolls to the top on every click. The `‹` and `›` buttons are disabled at `1900-01` and `2100-12`.

The view never adds listeners to `root` itself. The shell reuses one `<main>` element for every route, so a listener on it survives tab switches and piles up with every in-place re-render. Listeners go on the child elements the render creates.

### Layout (top to bottom)

1. **Card "Календарь образов"**: `‹`, the month name, `›`, and a `Сегодня` button. Below that a 7-column grid with `WEEKDAYS_SHORT` headers. Each day cell is a `<button>` showing the day number and up to 3 markers, then `+N`. Classes: `.cal-day`, `.today`, `.selected`, `.out` for days outside the month. `aria-label` is like `7 октября: 2 образа`, and the selected cell has `aria-pressed="true"`. Below the grid, a legend.
2. **Card for the selected day**: the title from `formatDayLong`, a `Добавить образ` button, then entry cards. Empty: `Ничего не запланировано`.
3. **Card "Не отмечены"**, only when `unconfirmed()` is not empty: each entry with `Надет` and `Не надет` buttons.
4. **Card "Ближайшие 14 дней"**: compact list of date, look name and status. Empty: `Ничего не запланировано`.

Markers: a dot colored with the `color_hex` of the entry's first item that has one, falling back to `var(--muted)`. `worn` is a filled dot, `planned` a ring, `unconfirmed` a ring in `var(--no)` (the only foreground warning color; `--warn-bg` is a pale background and would be invisible), `skipped` a small muted dot. Status also appears as text in the day panel, because color alone is not accessible.

The grid sits inside a `.card` (14 px padding at widths ≤ 520 px, 1 px border, inside the 16 px page gutters), so at a 375 px viewport it has 313 px, about 44 px per column. Use `grid-template-columns: repeat(7, minmax(0, 1fr))` and give `.cal-day` `padding: 4px 0; min-width: 0` to override the global `button` padding (`9px 16px`), which would otherwise force the grid wider than the screen. Cells show only the day number and markers. No horizontal scroll at 375 px.

### Entry card

Name and occasion, a status chip (`Запланирован`, `Надет`, `Не надет`, `Не отмечен`), item thumbnails per the rendering rule in section 2, the note, and actions:

- `Надет`, `Не надет`: only when `date <= today` and the status differs.
- `Изменить`: the dialog in edit mode (date, occasion, note, and the "already worn" checkbox when the date is today).
- `Повторить`: the dialog with the same snapshot and today's date, creating a new entry.
- `Удалить`: after `confirm("Удалить запись из календаря?")`, then the toast `Запись удалена`.

### Plan dialog (`modules/calendar/dialog.js`)

A native `<dialog>` appended to `document.body`, opened with `showModal()`, removed on close. Escape closes it (native behavior). Focus returns to the element that opened it.

- **Pick step** (only when opened from `Добавить образ`): one section per `look.sources` contribution, listing its snapshots as compact cards with `Выбрать`, plus a `Собрать из гардероба` section: a grid of wardrobe items with checkboxes, a name field (default `Образ`) and at least one item. A source whose `list()` is empty is not shown, and neither is the compose section when the wardrobe is empty. When nothing is left to show, the pick step shows only: `Пока не из чего выбрать: нет ни сохранённых образов, ни вещей. Добавьте вещи во вкладке «Гардероб».`
- Calls: `openPlanDialog({ snapshot, date? })` opens the form step for a new entry; `openPlanDialog({ pick: true, date })` opens the pick step; `openPlanDialog({ entry })` opens the form step in edit mode for an existing entry, with the date, occasion and note prefilled and `Уже надет` checked when its status is `worn`. Never call it with a `null` snapshot (see section 6).
- **Form step**: the look name and items (read-only), `Дата` (`<input type="date">`, defaulting to the selected day or today), `Повод` (prefilled from the snapshot), `Заметка`, and an `Уже надет` checkbox shown only when the date is today. Buttons `Сохранить` and `Отмена`.
- On save, for a new entry: `plan()` (with `status: "worn"` only when the date is today and `Уже надет` is checked; for any other date the hidden checkbox is ignored and `plan` applies its default) and the toast `Образ добавлен в календарь: <formatDay(date)>`. In edit mode: `update(entry.id, { date, occasion, note })`; then, if the date is today, `setStatus(entry.id, "worn")` when `Уже надет` is checked and the entry isn't worn, or `setStatus(entry.id, "planned")` when it is unchecked and the entry was worn. Edit mode creates no new entry and shows no `Образ добавлен…` toast. Either way, if the calendar route is open, its view re-renders.

### Styles

A `/* Календарь */` section at the end of `public/styles.css`. Every class is prefixed `cal-`. Use the existing tokens (`--line`, `--soft`, `--accent`, `--muted`, `--no`, `--warn-bg`, `--radius`) so dark mode works with no extra rules.

## 8. Edge cases

| Case                                                        | Behavior                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Wardrobe item deleted                                       | Entry keeps its snapshot; the item renders as a placeholder (section 2).                  |
| Looks regenerated, capsule rebuilt                          | No effect on entries.                                                                     |
| v1 backup imported (made before the calendar existed)       | Calendar untouched (target.md 6.5).                                                       |
| v2 backup without a `calendar` slice                        | Calendar untouched.                                                                       |
| "Удалить все данные"                                        | Calendar cleared like every slice.                                                        |
| Several entries on one day                                  | Allowed, no deduplication. The day panel shows all; the cell shows 3 markers and `+N`.    |
| Planned entry whose date has passed                         | Shown as `Не отмечен`; listed under "Не отмечены" for 30 days. Never auto-marked as worn. |
| Marking a future entry as worn                              | Not offered in the UI; `setStatus` throws if called.                                      |
| Device clock or timezone changes                            | Stored dates don't move; only `today` changes.                                            |
| Year outside 1900 to 2100, malformed dates in imported data | Entry dropped by `migrate`.                                                               |

## 9. Size

About 1 KB per entry without images. A look a day for ten years is under 4 MB. No cap.

## 10. T6: wear history in stylist prompts (optional)

New extension point `stylist.context` (`{ id, order?, lines(): string[] }`). The looks and capsule user-message builders append, after the client brief:

```
История носки (из календаря):
<lines>
```

only when at least one line is contributed.

Calendar's contribution:

- Up to 14 `worn` entries from the last 14 days, newest first: `2026-10-05: «Офис» (бежевый тренч, синие джинсы)`.
- When the oldest `worn` entry is at least 30 days old: `Давно не надевали (60+ дней или ни разу с <date of first worn entry>): <names>`, at most 20 names. Without 30 days of history, every item would look "never worn", so this line is skipped.

Proposed prompt additions, to be checked by hand on 3 runs with history and 3 without before merging:

- `LOOKS_SYSTEM`: `Если передана история носки, не повторяй образы, надетые за последние 7 дней, и чаще используй вещи, которые давно не надевали.`
- `CAPSULE_SYSTEM`: `Если передана история носки, вещи, которые клиент часто надевает, сохраняй в капсуле.`

Privacy: with T6, wear history goes to the stylist model. Mention it in the README privacy section.
