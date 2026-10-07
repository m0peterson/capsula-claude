# T6 (optional). Wear history in stylist prompts

| -          | -                                                               |
| ---------- | --------------------------------------------------------------- |
| Depends on | T5 merged                                                       |
| Size       | small in code. The real cost is checking prompt quality by hand |

Read first: `docs/architecture/calendar.md` section 10 and `docs/architecture/target.md` section 7.3.

## Goal

Looks and capsule generation take into account what the client actually wore, through a new extension point `stylist.context`, so neither module imports calendar.

This changes what is sent to the model, and it only helps once the calendar holds some history. Without history the **user** messages don't change. Each **system** prompt always gains one sentence that starts with «Если передана история носки», so that sentence has no effect when no history is sent.

## Work items

1. Document the `stylist.context` point (`{ id, order?, lines(): string[] }`) in target.md section 7.3 if it isn't there already.
2. `looks/prompts.js` and `capsule/prompts.js`: after the client brief, append `\n\nИстория носки (из календаря):\n` and the lines from `list("stylist.context")`, only when at least one line exists. A contribution that throws is skipped with `console.warn`.
3. `calendar/index.js`: contribute `{ id: "calendar.history", lines }`, producing exactly the lines in calendar.md section 10.
4. Add the two prompt sentences from calendar.md section 10 to `LOOKS_SYSTEM` and `CAPSULE_SYSTEM`.
5. README privacy section: one sentence saying that wear history from the calendar is sent to the stylist model when looks or a capsule are generated.

## Tests

1. With no history: the looks and capsule `user` messages are byte-identical to the T3 prompt fixtures. `system` differs only by the added sentence.
2. Update T3's prompt-builder tests: the expected `LOOKS_SYSTEM` and `CAPSULE_SYSTEM` strings gain exactly the new sentence; every other expected string stays unchanged. This is an allowed assertion change; note it in the PR.
3. With fixed calendar data and an injected `now`: the exact history block, including the 14-entry cap, newest first, and the "Давно не надевали" line appearing only when the oldest worn entry is 30 or more days old.
4. A throwing contribution doesn't break prompt building.

## Manual evaluation (required, report it in the PR)

With a real model: 3 looks generations with history and 3 without, on the same wardrobe. Report whether looks worn in the last 7 days were repeated, and whether long-unworn items appeared more often. If the effect isn't visible or quality drops, say so plainly and propose dropping or rewording the prompt sentences. A merged prompt change nobody checked is worse than no change.

## Out of scope

A UI toggle to switch history off (possible follow-up), and wear counts on wardrobe cards.
