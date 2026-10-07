# T4. Calendar core: dates, look snapshots, calendar domain logic

|                       |                                    |
| --------------------- | ---------------------------------- |
| Depends on            | T1 merged                          |
| Runs in parallel with | T2, T3                             |
| Unblocks              | T5                                 |
| Size                  | small to medium, all new pure code |

Read first: `docs/architecture/calendar.md` sections 2, 3, 4 and 8. Then `docs/architecture/target.md` section 4, for the import rules your files must follow.

## Goal

Everything the calendar needs that has no UI and no kernel dependency, as pure functions with thorough Node tests. T5 then only does wiring and UI.

## Files

| File                                  | Contents                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `public/js/lib/dates.js`              | the functions in calendar.md section 3, "Dates"                                                                                |
| `public/js/lib/plural.js`             | `plural(n, forms)`                                                                                                             |
| `public/js/shared/look-snapshot.js`   | `normalizeSnapshot(raw)` and the JSDoc typedefs `SnapshotItem` and `LookSnapshot`; `MAX_ITEMS = 12`                            |
| `public/js/modules/calendar/model.js` | `initial()`, `migrate(raw)`, and the functions in calendar.md section 4, as pure functions taking `data` as the first argument |

Allowed imports: `lib/*` and `shared/*` only (`lib/coerce.js`, `lib/ids.js`, `shared/catalog.js`, and your new files). **Don't** import `core/` and don't call `defineSlice`. T5 adds the slice to `model.js`, so keep `initial` and `migrate` exported with those names and the signature `migrate(raw)`; T5 adapts it.

Determinism: every function that needs the current time or a new id takes `{ now = new Date(), newId = () => uid("c") }` as its last argument.

Errors thrown by `plan`, `setStatus` and `update` carry Russian messages a user can read, because T5 shows them in a toast:

- invalid date: `Некорректная дата`
- invalid snapshot: `В образе не осталось вещей`
- worn or skipped in the future: `Нельзя отметить образ надетым заранее`
- unknown id: `Запись не найдена`

## Tests (`test/calendar-core.test.mjs`)

No globals stubbed. At minimum:

### Dates

1. `todayISO` uses local date parts. With `TZ=Europe/Moscow` set for the test process, `new Date("2026-10-06T22:30:00Z")` gives `2026-10-07`. If setting `TZ` inside the test is unreliable, build `now` from local parts with `new Date(2026, 9, 7, 0, 30)` and assert on that.
2. `isISODate`: accepts `2024-02-29`, rejects `2026-02-29`, `2026-13-01`, `2026-1-01`, `2026-01-01T00:00`, `1899-12-31`, `2101-01-01`, non-strings. `isISOMonth`: accepts `2026-10`, `1900-01`, `2100-12`; rejects `2026-13`, `2026-00`, `2026-1`, `0050-03` (`Date.UTC` would map year 50 to 1950), `2101-01`, non-strings.
3. `addDays` across month and year ends and a leap day. `addMonths` across a year end.
4. `monthGrid("2026-10")`: the first cell is Monday `2026-09-28`, there are 5 weeks, every week has 7 cells, `inMonth` is right. `monthGrid("2026-02")`: 5 weeks, the first cell is `2026-01-26` (1 February 2026 is a Sunday). `monthGrid("2027-02")`: exactly 4 weeks (starts on a Monday, 28 days). `monthGrid("2026-08")`: 6 weeks, the last cell is `2026-09-06`.
5. `formatDay("2026-10-07") === "7 октября"`, `formatDayLong` ends with `, среда`, `formatMonth("2026-10") === "Октябрь 2026"`.
6. `plural` for 0, 1, 2, 5, 11, 12, 14, 21, 22, 25, 101, 111.

### Snapshots

7. Garbage in (`null`, a string, `{}`, items that aren't objects or have no name) gives `null`.
8. Strings trimmed and capped (name 120, description 1000), unknown category becomes `"other"`, invalid hex becomes `""`, `toBuy: true` forces `ref: null`, more than 12 items cut to 12.
9. Idempotent: `normalizeSnapshot(normalizeSnapshot(x))` deep-equals `normalizeSnapshot(x)`.

### Calendar

10. `migrate`: drops entries with bad dates or empty looks, fixes an unknown status to `planned`, regenerates duplicate ids, sorts by date then `createdAt`. Total on garbage (`null`, `[]`, `{ entries: "x" }`).
11. `plan`: default status `worn` for a past date and `planned` for today and the future; the entry gets an id and timestamps from the injected `now` and `newId`. `plan` with `status: "worn"` on a future date throws `Нельзя отметить образ надетым заранее`.
12. `setStatus` to `worn` on a future date throws the message above. On a past date it works and updates `updatedAt`.
13. `update` moving a worn entry to a future date resets it to `planned`, and the list stays sorted.
14. `repeat` copies the snapshot (a deep copy: mutating the new one doesn't change the old one) with a new id.
15. `effectiveStatus`: `planned` yesterday gives `unconfirmed`; `planned` today gives `planned`.
16. `upcoming`, `unconfirmed`, `entriesBetween` boundaries (inclusive and exclusive edges as calendar.md specifies).
17. `wearStats` counts only `worn` entries with `date <= today` and a non-null `ref`, and `last` is the latest date.

## Acceptance criteria

1. `npm test` green.
2. New files import only `lib/*` and `shared/*`.
3. No UI, no slice, no changes to existing files.

## Out of scope

The slice, the API, the UI, and the integration with looks and capsule (all T5).
