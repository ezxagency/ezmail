# Workflow Builder — feature spec

Status: **spec only — no feature code written yet.**
This is the source of truth for the Workflow Builder. Re-read it fully before
touching the feature in any session.

## Ground rules (clean room)

Do **NOT** read or depend on `js/campaigns.js` / `css/campaigns.css`. This
feature is clean-room and must not touch the campaigns feature in any way.

## Hard constraints

- **Zero-build vanilla JS.** Classic scripts, one shared global scope, fixed
  load order. No framework, no bundler, no ES modules. New CSS/JS files are
  appended at the correct point in the ordered `<link>`/`<script>` lists in
  **BOTH** `index.html` and `timeclock-v2.html` (kept byte-identical —
  re-copy after editing).
- **Never reorder existing css/js load lines.** The order IS the cascade.
- **Escape all user text** rendered into HTML with the existing `esc()`
  helper from `js/config.js`.
- **Use the global `db`/`auth`** from `js/config.js`. No server; the engine
  is client-side + Firestore.
- The feature is a **hash-routed page** (`data-route="workflow"`), reached
  from the drawer, following the same pattern existing pages use
  (`PAGE_IDS` + `applyRoute()` in `js/nav.js`, a `.admin-page.fpage` screen
  div in the HTML, a drawer item).

## What we are building

A screen where an admin draws how work moves through the team (a
**BLUEPRINT**), and once published, real tasks (**RUNS**) ride those tracks:
each task stops at each block, a person acts, and it advances until the end.
Non-technical users build it by dragging blocks and drawing lines.

Keep two things strictly separate in code, DB, and UI:

- **BLUEPRINT** — the drawing/template.
- **RUN** — one real task travelling through a **FROZEN copy** of a
  blueprint. Editing a blueprint must **NEVER** change runs already in
  flight — a run stores its own `blueprintSnapshot`.

## Six block types (nothing else exists)

| Type | Color | Behavior |
|---|---|---|
| **TRIGGER** | yellow | The one starting block. Exactly one per blueprint, no incoming lines. |
| **ROLE** | red | A human does work here; the task waits until they mark it complete. |
| **SPLIT** | green | One path becomes many. Mode `route` = take exactly one branch by rule (must have one `else` branch). Mode `parallel` = activate all branches at once. |
| **LOGIC** | blue | A yes/no gate on one path (approval/quality). `onTrue` / `onFalse`; `onFalse` commonly loops back to an earlier ROLE for rework. |
| **VAULT** | black | Storage checkpoint — save the deliverable, stamp it, then KEEP MOVING. Not a merge block, not an end. |
| **ACTION** | purple | The system does something automatically (notify, mark complete, email, webhook). Usually last, can be anywhere. |

## Connections & merging

- Lines run top→bottom (downward = forward), output handle → input handle.
- A block may have multiple incoming lines — that **IS** the merge; there is
  no merge block.
- A block with multiple incoming lines has a `waitFor`: `"all"` (default) or
  `"any"`.

## Data model → Firestore collections

- `blueprints/{id}`:
  `{ orgId, ownerId, name, version, status(draft|published), nodes[],
  edges[], createdAt, updatedAt }`
  - Node = `{ id, type, position:{x,y}, config }`
  - Edge = `{ id, from, fromHandle?, to }`
- `runs/{id}`:
  `{ blueprintId, blueprintSnapshot (frozen full blueprint), taskId, orgId,
  status, activeNodeIds[], startedAt, completedAt }`
- `nodeRuns/{id}`:
  `{ runId, nodeId, nodeType,
  status(pending|waiting|in_progress|completed|skipped|failed), assigneeId?,
  arrivedAt, completedAt, output:{files, note} }`
- Add an `orgId` field everywhere (default this agency) so multi-org is
  POSSIBLE later, but do **NOT** build org management now — today it's one
  org (Ez Agency) with roles.

## Two engine rules that are easy to get wrong — build them in from the start

1. **`waitFor:"all"` means "all incoming paths that are actually LIVE in
   this run"**, not all edges on the diagram. When a route SPLIT picks a
   branch, the un-picked branches must emit a **skip token** that propagates
   downstream (dead-path elimination) so a later `waitFor:"all"` join
   doesn't deadlock waiting for a branch that never ran.
2. **Conditions (SPLIT route + LOGIC) can read BOTH task fields AND the
   outputs of earlier nodeRuns in the same run** (e.g. `approved == true`,
   `wordCount > 500`). Persist enough on each nodeRun for this.

## Validation before publish

Friendly inline errors, not a wall:

- Exactly one TRIGGER, with no incoming lines.
- Every non-trigger block has ≥1 incoming (no floats).
- Every path reaches an end block (no dangling).
- SPLIT has ≥2 outgoing; route-SPLIT has exactly one `else`.
- LOGIC has both true + false outputs.
- ROLE has an assignee/role.
- ACTION has an actionType.

Loops are allowed, but a run has a max hop count (default 100). Drafts save
while broken; only publishing runs the checks.

## Acceptance test (the target for Phase 5)

The builder can reproduce this exact flow and a task can run through it to
the final ACTION:

```
TRIGGER → SPLIT[route]
  ├─ branch A,B,C → ROLE → SPLIT[parallel] → ROLE + ROLE → VAULT
  └─ branch else  → ROLE → ROLE → VAULT
both branches → ROLE[final, waitFor:"all"] → ACTION
```

---

## Appendix: codebase integration notes (observed 2026-08-15)

Recorded so future sessions don't have to re-derive them; verify against the
code if much time has passed.

- **App shell**: `index.html` (and its byte-identical copy
  `timeclock-v2.html`). All CSS `<link>`s at top, all `<script>`s at bottom,
  every one carrying the same `?v=N` cache-buster — **bump N everywhere on
  any css/js change** (currently `?v=115`).
- **Router** (`js/nav.js`): `PAGE_IDS` maps route → screen element id;
  `applyRoute()` toggles `.hidden` on screens, marks the active
  `.drawer-item`, and calls the page's render/enter function. Pages are
  `.admin-page.fpage` divs with an `.admin-page-inner` column, an
  `.admin-page-head` (eyebrow + `.admin-page-title` + `.page-back`
  `data-back` button), and an empty body div the JS fills. A click on the
  gutter around the column goes back to the dashboard. Keyboard: number keys
  jump to pages; Esc walks layers back. Role guards live at the top of
  `applyRoute()`.
- **Drawer**: `.drawer-item` anchors with `href="#/route"` +
  `data-route="route"`, an SVG icon, `.drawer-txt` with a `<small>`
  subtitle, optional `.drawer-badge`, and a `<kbd class="drawer-kbd">`
  shortcut number.
- **Boot/teardown** (`js/boot.js`): `startWorkerApp()` runs once per login;
  anything that outlives one render (timers, `onSnapshot` subscriptions)
  registers a cleanup with `onSessionEnd(fn)` so sign-out tears it down.
  `isAdmin` / `canAssignTasks` are module-level globals set by auth.
- **Firestore patterns** (`js/assign.js` is the reference — NOT
  campaigns.js): `db.collection(...).where(...).onSnapshot(...)` watchers
  started from `startWorkerApp()`, unsubscribed via `onSessionEnd`;
  `db.batch()` for multi-doc writes; timestamps are `Date.now()` numbers;
  ids like `Date.now().toString(36) + Math.random().toString(36).slice(2,7)`
  (see `personal.js`).
- **UI primitives** (`js/ui.js`): `openSheet(html, setup, opts)` /
  `closeSheet()` bottom sheet, `toast(msg, action?)`, `chipGroup` /
  `wireChipsIn`, `wheelRender` numeric wheel. `$` is `getElementById`.
  Markup is built as JS template strings with `esc()` on all user text
  (quotes included — user text lands in double-quoted attributes).
- **CSS**: per-feature file appended to the ordered list (before
  `login.css`/`premium.css`; premium.css must stay last). Design tokens in
  `base.css`; page scaffolding classes (`fpage-*`, `stat-*`, `admin-page-*`)
  in `pages.css`; sheets/chips in `sheets.css`.
- **Rules**: `firestore.rules` gates on `isAdmin()` / `isTeam()` helpers
  (role read from `users/{uid}`); new collections need matching rules.
- **Deploy**: static GitHub Pages — edit, bump `?v=`, re-copy
  `timeclock-v2.html`, push.
