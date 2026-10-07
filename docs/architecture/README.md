# Capsula: modular architecture and calendar

Architecture for moving the client from one global state with tab views to feature modules on a small kernel, then adding a calendar of past and planned looks. Code is written by agents from the briefs in `tasks/`. This folder is the source of truth for those tasks.

| File                                  | What it is                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target.md`                           | Target architecture: layers, import rules, module contract, storage and migration, events, extension points, invariants. Every brief refers to it. |
| `calendar.md`                         | Design of the calendar module: data model, dates, domain functions, UI, integration, edge cases.                                                   |
| `tasks/T1-foundation.md`              | Move pure helpers into `lib/`, `ai/`, `shared/`, `ui/`; decouple the LLM client from settings.                                                     |
| `tasks/T2-kernel.md`                  | Kernel as new, Node-tested code: module contract, registry, slice store with legacy migration and backup v2, events, extension points.             |
| `tasks/T3-cutover.md`                 | Features become modules; the app boots on the kernel; storage switches to per-module slices.                                                       |
| `tasks/T4-calendar-core.md`           | Calendar domain without UI: dates, look snapshots, calendar functions.                                                                             |
| `tasks/T5-calendar-module.md`         | Calendar module, UI, and integration with looks and capsule.                                                                                       |
| `tasks/T6-wear-history-in-prompts.md` | Optional: wear history from the calendar in the stylist prompts.                                                                                   |

## Task graph

```
T1 foundation ──┬──────────────► T3 cutover ──┐
T2 kernel ──────┘                             ├──► T5 calendar module ──► T6 (optional)
T1 ─────────────► T4 calendar core ───────────┘
```

| Wave | Tasks that can run at the same time |
| ---- | ----------------------------------- |
| 1    | T1, T2                              |
| 2    | T3 (needs T1 and T2), T4 (needs T1) |
| 3    | T5 (needs T3 and T4)                |
| 4    | T6, optional                        |

T3 is the critical path and the largest task. It can't be split by feature: storage is shared by every feature, and cutting it over one feature at a time would mean running two storage systems side by side on real user data (see target.md section 11). Give it to your strongest agent and review it hardest.

## Rules for every task

1. **Read before coding.** The brief, then the sections of `target.md` and `calendar.md` it lists.
2. **One task, one PR.** Branch from the default branch after the task's dependencies have merged. Don't stack tasks in one PR.
3. **No behavior change unless the brief says so.** T1 to T3 are refactors; target.md section 9 lists the invariants.
4. **No dependencies, no build step.** Native ES modules, `node --test`, Node 20+.
5. **Match the codebase.** Russian comments and UI copy, the existing naming and comment density, Prettier with `.prettierrc` (print width 140). Use the exact Russian strings the docs give.
6. **Tests before "done".** `npm test` green in every commit. Existing assertions don't change except where a brief says so. State the test count in the PR.
7. **Browser check for UI work.** `npm run dev` plus the preinstalled Chromium and Playwright, with a throwaway script outside the repo. Report what you checked in the PR.
8. **Deviations are flagged, not hidden.** If the docs are wrong or impossible, make the smallest sensible deviation and explain it in the PR under **Deviations from architecture**. If the deviation changes a contract other tasks rely on (anything in target.md sections 4 to 7 or calendar.md sections 3 to 6), stop and ask instead.
9. **Out of scope means out of scope.** List bugs you find in the PR description; don't fix them on the side.

## PR description template

```
## What
<one paragraph>

## Brief
docs/architecture/tasks/<file>

## Tests
npm test: <N> passed. New tests: <list>.

## Browser check
<what you clicked, at which widths; screenshots for UI tasks>

## Deviations from architecture
<none, or each one with the reason>

## Found but not fixed
<bugs or smells outside the scope>
```
