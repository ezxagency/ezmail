# Platform Spec — the base model

Status: **phase 1 in progress.** Landed so far: the permission grammar
and its catalog (`js/permissions.js`, 29 assertions); the tenancy rules
for `orgs/{orgId}` with members, roles and the `memberOf` pointer (32
assertions); and the Organization page (`js/org.js`) where an owner
creates the org, edits roles, and invites people into it — invitations
live at `orgs/{orgId}/invites/{token}` so the tenant comes from the path
rather than a field, which is what keeps listing them to a single
membership check. All additive — no existing page reads
an org, so an agency that never opens the screen behaves exactly as
before. Still open in phase 1: `orgId` on existing documents, and
custom claims (which need the server from phase 3).

**Phase 2 in progress.** `js/items.js` holds the pure core — the eleven
field types, validation, facet derivation, and `itemCommit()`, the one
place an Item changes (43 assertions). It never writes: it returns the
next Item and the events the change produced, which is what lets the
same decision run client-side today and server-side in phase 3.
Authorization arrives as an injected `allow` callback rather than a
global, so the file stays standalone under Node. Still to come in phase
2: Firestore persistence behind `commit()`, the ItemType builder UI, and
collapsing assignments/campaigns onto the Item. Phases 3–5 remain spec
only.
This is the source of truth for turning EZ Clock In from one agency's tool
into a base model any organization can configure. Re-read it fully before
touching platform work in any session.

Companion docs: `docs/workflow-builder-spec.md` (the engine that already
exists and does not change here), `CLAUDE.md` (conventions), `README.md`
(what ships today).

## What this is trying to do

Today the app is Ez Agency's. Every list that decides behaviour — clients,
tasks, who is admin — is a literal in `js/config.js` or `firestore.rules`.
That is correct for one agency and fatal for a product.

The goal is a **base model**: a small set of primitives general enough that
a restaurant, a clinic, a YouTube channel and an agency are all expressible
as *configuration* rather than as code branches. A restaurant's shift-swap
request, a clinic's discharge checklist, a channel's video and this agency's
campaign are the same object with different schemas riding different tracks.

The measure of success: **adding support for a new industry means writing a
JSON file, not writing code.**

## Ground rules

1. **Config is data, never code.** The moment `if (industry === 'restaurant')`
   appears anywhere, the model has failed. Industries are template packs
   (see below), not branches.
2. **One Item collection.** Every unit of work is an Item. A second work
   object forks automations, permissions, search and the activity feed —
   permanently.
3. **One write chokepoint.** Every mutation goes through `commit(intent)`.
   It may run client-side at first; moving it server-side must be a change
   to one function's guts, never a rewrite.
4. **The event log is append-only.** Events are never updated and never
   deleted. Audit, automation and analytics all derive from it.
5. **The field type set is closed.** Eleven types (below). Each new one
   multiplies UI, validation, filtering and automation surface. Adding a
   twelfth needs a reason that survives an argument.
6. **The workflow engine does not change shape.** `js/workflow-engine.js`
   stays pure — plain objects in, plain objects out, runnable under Node.
   It gains features (see "Engine changes required"), never dependencies.

## The primitive set

Six objects. Everything else is derived.

### 1. Item — the universal unit of work

```js
items/{id} = {
  orgId,                 // tenant. On EVERY document, no exceptions.
  typeId,                // → itemTypes/{id}: fields, statuses, workflow
  title,
  status,                // a key from the type's status set
  fields: { ... },       // custom values, typed by the ItemType
  facets: [ ... ],       // denormalized filter keys — see "The facets pattern"
  assigneeIds: [],
  watcherIds: [],
  parentId,              // one tree covers subtasks, checklists, phases, sends
  workflowRunId,         // set when this Item rides a blueprint
  dueAt, startAt,
  createdAt, updatedAt, createdBy
}
```

`parentId` is load-bearing and cheap: subtasks, checklists, an epic's
children and the composer's "one send, many rows" all reduce to one tree.

### 2. ItemType — the schema. This is the horizontal unlock.

```js
orgs/{orgId}/itemTypes/{id} = {
  name,                  // "Shift Swap" | "Video" | "Campaign" | "Task"
  icon, color,
  fields: [{ key, label, type, required, options?, default? }],
  statuses: [{ key, label, color, category }],   // open | active | done
  workflowId,            // optional: the blueprint Items of this type ride
  roleOverrides: { }     // optional per-role permission narrowing
}
```

An org defines its own types. A pack ships them pre-made.

### 3. Role — permissions as data

```js
orgs/{orgId}/roles/{id} = {
  name,                  // "Editor" | "Shift Lead" | "Viewer"
  permissions: [ "item:create:org", "item:update:assigned", ... ],
  isOwner                // exactly one role per org; cannot be deleted
}
```

Grammar is `resource:action:scope`.

- **resource** — `item`, `itemType`, `workflow`, `automation`, `member`,
  `role`, `shift`, `report`
- **action** — `create`, `read`, `update`, `delete`, `publish`, `invite`
- **scope** — `own`, `assigned`, `org`, `none`

**Three scopes, deliberately.** Anything richer stops being reasonable for
a non-technical admin to hold in their head, which defeats the point.

### 4. Workflow — unchanged

Blueprints and runs exactly as `docs/workflow-builder-spec.md` describes.
An Item points at its run through `workflowRunId`; the run keeps its frozen
`blueprintSnapshot`. Nothing about the engine's contract changes.

### 5. Event — the spine

```js
events/{id} = {
  orgId, actorId, at,
  verb,                  // "item.created" | "item.status_changed" | ...
  subject: { kind, id }, // { kind: "item", id } | { kind: "shift", id }
  data: { from, to, ... }
}
```

Append-only. Never updated, never deleted. Three things fall out of it for
free: an audit trail that makes "check and balance" provable rather than
claimed, the trigger surface every automation reads, and analytics.

Time tracking is **not** an Item (see "What is deliberately not an Item"),
but it does emit events — `shift.clocked_in`, `shift.clocked_out`. That is
what lets an automation say *"when someone clocks in, create today's
checklist and assign it to them."* It is the seam that joins the attendance
half of the app to the automation half.

### 6. Automation — trigger / condition / action

```js
orgs/{orgId}/automations/{id} = {
  name, enabled,
  trigger:    { verb, typeId? },
  conditions: [{ field, op, value }],     // op: eq|ne|lt|gt|contains|empty
  actions:    [{ kind, ... }]
}
```

Action kinds, initial set: `assign`, `set_field`, `set_status`,
`create_item`, `start_workflow`, `notify`, `email`, `webhook`.

Conditions reuse `wfEvalCondition()` from the engine rather than growing a
second expression evaluator. One condition language for the whole product.

**Loop guard:** an automation action emits events like any other write, so
automations can trigger each other. Every commit carries a `causationDepth`;
past 10 the chain stops and logs. The workflow engine's hop cap is the same
idea and the precedent to copy.

## The eleven field types

`text` · `longtext` · `number` · `money` · `date` · `select` ·
`multiselect` · `user` · `checkbox` · `url` · `file`

Each needs: an input control, a read-only renderer, a filter control, a
validator, an automation condition mapping and an automation set-action.
Six surfaces per type. Eleven types is already 66 pieces — which is exactly
why the set is closed.

## The facets pattern

Custom fields mean customers filtering by fields we have never seen.
Firestore is worst at precisely this: composite indexes cap at 200 (1,000
with billing) and must be **declared in advance**, so per-org-per-field
indexes are impossible.

Every Item therefore carries a denormalized array, written by `commit()`:

```js
facets: ["type:shiftswap", "status:review", "priority:high", "client:acme"]
```

One `array-contains` index serves every equality filter any customer ever
invents. Rules:

- Written only by `commit()`, never by hand.
- `"key:value"`, lowercased, value slugified.
- Only `select`, `multiselect`, `user`, `checkbox` and status/type produce
  facets. Ranges (number, date, money) stay real fields and get the small
  number of composite indexes we can afford.
- Full-text search and range-heavy filtering need a search service
  (Typesense/Meilisearch) later. Facets buy the runway to defer it.

**Do this from the very first Item written.** Backfilling facets across a
live multi-tenant database is miserable.

## Template packs — how one model fits every industry

A pack is one JSON file, versioned in the repo, importable into any org:

```js
{
  key: "restaurant", name: "Restaurant", version: 1,
  itemTypes: [ ... ], roles: [ ... ], workflows: [ ... ], automations: [ ... ]
}
```

Onboarding becomes *"pick your pack."* Everything after is editing. A pack
is content, not code: adding an industry touches no application source, and
customers can build and share their own.

### Worked example — `restaurant`

**ItemType "Shift Swap"**
| field | type | notes |
|---|---|---|
| `requestedBy` | user | required |
| `shiftDate` | date | required |
| `coverBy` | user | filled by whoever accepts |
| `reason` | longtext | |
| `managerNote` | text | |

statuses: `open` → `claimed` → `approved` / `denied`

**Workflow "Shift swap approval"**
```
TRIGGER
  → ROLE   [any Shift Lead: claim the shift]   outputs { claimed: boolean }
  → LOGIC  [claimed == true]
      true  → ROLE [Manager: approve]  outputs { approved: boolean }
                → LOGIC [approved == true]
                    true  → ACTION [notify both parties, set status approved]
                    false → ACTION [notify requester, set status denied]
      false → ACTION [notify requester nobody claimed it]
```

**Automation** — trigger `item.created` on type Shift Swap → action
`notify` all members holding the Shift Lead role.

**Roles** — Owner, Manager, Shift Lead, Staff.

Nothing in that pack is restaurant *code*. Swap the nouns and it is a
clinic's shift cover or an agency's brief reassignment.

## What is deliberately NOT an Item

- **Shifts / time tracking.** A shift is not work that travels between
  people; it is a time record with its own invariant (`js/config.js`:
  exactly one open seg while ACTIVE). Forcing it into Items would corrupt
  both models. It stays its own collection and *emits events*.
- **Users, orgs, roles, types, automations.** Configuration, not work.
- **Messages / comments.** They hang off an Item; they do not travel.

## Migration — how today's three systems collapse

| today | becomes |
|---|---|
| `assignments/{id}` (one doc per person × store × task, tied by `groupId`) | Item of type `task`; `groupId` → `parentId` on a container Item representing the send. Per-row completion is preserved because each row stays its own Item. |
| `campaigns/{id}` (stages, baton, approvals, budgets) | Item of type `campaign` + a workflow run over a linear chain of ROLE nodes. Stage owners → node assignees. Stage budget → node SLA. Multi-owner approval → node `completionPolicy: "all"`. Client review link → an ACTION node. |
| `runs` / `nodeRuns` | Unchanged. The Item points at the run. |

The campaign mapping is the proof the model holds: the richest of the three
systems reduces to Item + existing engine with **one** engine addition.

Migration is additive and reversible: write Items alongside the old
collections, read from Items behind a flag, delete the old collections only
once every org is migrated and verified.

## Engine changes required

Small, and all inside `js/workflow-engine.js`'s existing contract:

1. **`completionPolicy` on ROLE nodes** — `"any"` (default, today's
   behaviour) or `"all"`. `waitFor` governs incoming *edges*; this governs
   incoming *people*. Campaigns' multi-owner approval needs it and there is
   no way to express it today.
2. **Node SLA** — `dueAfter` (ms from arrival) on any node, so a stop can be
   overdue. Campaigns' stage budgets become this.
3. **Condition context reads Item fields** — `wfEvalCondition` already reads
   task fields and earlier nodeRun outputs; the Item's `fields` map joins
   that context under a `field.` prefix.

Each ships with tests in the existing suite. None changes the reconcile
model, the frozen-snapshot rule or the hop cap.

## Security model

Two gates today (`js/config.js` for UI, `firestore.rules` for the database)
become three, because rules alone cannot express this model — they allow a
single return statement and cap at 10 document reads per evaluation.

1. **Custom claims** carry `orgId` and `roleId`. Rules check tenant
   isolation and coarse role on every read and write with zero document
   reads: `request.auth.token.orgId == resource.data.orgId`.
2. **Rules** enforce tenant isolation, immutability of the event log, and
   field allowlists — the pattern `runs/{id}` already demonstrates.
3. **The server** (`commit()` behind a callable) enforces everything
   scope-dependent: "is this person the current stage owner", "may this
   role move this item to this status".

Today `nodeRuns` allows any team member to write any node run, and
`campaigns` allows any member to write the whole document — both documented
as "the trusted-team tradeoff". That tradeoff is correct for one agency and
must not survive into multi-tenant. It ends when `commit()` moves server-side.

## Phases

| # | Phase | Contents | Done when |
|---|---|---|---|
| 1 | **Tenancy** | `orgId` on every document; roles as data; custom claims; rules rewritten around the claim | Two orgs coexist and cannot see each other |
| 2 | **The Item** | Item + ItemType + eleven field types + facets + `commit()` chokepoint; the three systems collapse | A custom type built in the UI runs end to end |
| 3 | **Events + server** | Append-only log; `commit()` flips to a callable; client writes revoked in rules | Devtools cannot forge a transition |
| 4 | **Automations** | Trigger/condition/action over the event log; causation depth cap | Restaurant pack's notify rule fires |
| 5 | **Packs** | Pack format, importer, 15–20 packs, onboarding | New industry ships with no code change |

Phases 1 and 2 are the bulk. After phase 3 the pace increases sharply,
because 4 and 5 are configuration over machinery that already exists.

## Open decisions

- **ES modules for new code.** `<script type="module">` needs no bundler and
  keeps rule 4 in `CLAUDE.md` intact. "Load order is the dependency graph"
  works at 16k lines; it will not at 40k. Decide before phase 2 adds files.
- **Where `commit()` runs in phase 2.** Client-side is faster to build and
  the chokepoint makes the move cheap — but every day it stays client-side
  is a day the trusted-team tradeoff is shipping to strangers.
- **`appState` must die in phase 1 or 2.** One JSON blob per user holding
  unbounded `history[]`, rewritten on every punch. It caps a user's tenure
  and taxes every write. Shifts become their own collection.
- **Firestore beyond phase 5.** Facets defer the reckoning; they do not
  cancel it. Range filters on custom fields and full-text search will force
  either a search service or Postgres. Revisit with real customer data.
