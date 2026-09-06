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
global, so the file stays standalone under Node. `js/items.js` is its Firestore glue and decides nothing — it
loads what the decision needs, calls the engine, and writes back what
comes out, so phase 3 changes only the middle of `itemSave()`. The
collections (`itemTypes`, `items`, `events`) live under the org, with
the log append-only against everyone including owners (19 assertions).
The ItemType builder lives on the Organization
page and the Work page (`js/work.js`) generates every control from the
type — there is no hand-written form for any industry anywhere, which is
the test of ground rule 1. An end-to-end test runs this document's own
restaurant example through the engine: requested, claimed, assigned,
approved, with the facets a manager would filter on appearing without any
index being declared for a type that did not exist an hour earlier. The collapse has begun at the data layer:
`js/migrate.js` holds the built-in `task` and `campaign` types and the
pure mappers that turn today's rows into intents (22 assertions), and an
owner-only import on the Organization page brings them across. It is
additive, one-way and safe to run twice — item ids are derived from the
source document, so a second run skips what it already made. Nothing is
deleted and neither the assign composer nor the campaigns page changes
behaviour. The campaign chain is now a workflow too:
`migrateCampaignBlueprint()` turns a saved chain into a publishable
blueprint, and the three engine additions it needed are built and tested
— `completionPolicy:"all"` for a stage with several owners,
`dueAfter` for a stage budget, and `source:"field"` conditions that read
an Item's own values. A test passes a baton down a generated track and
proves it waits at the two-owner stage until both have acted.

Chains arrive as **drafts**, and an in-flight campaign is deliberately
NOT fast-forwarded into a half-finished run: that would mean writing
approvals nobody gave into a log whose only value is that it never lies.
Old work keeps the honest snapshot the import made of it; new work rides
the track from its first stop.

The cutover has started from the WRITE side. The composer still writes
its own rows exactly as before, and now mirrors each one into an Item
under the same derived id the import uses — so the model stays true
instead of going stale the moment somebody assigns anything new.
Completions and undos mirror too, since a row brought back on one screen
that stays finished on the other is a drift nobody would notice until
they trusted the wrong one.

The mirror is written so it cannot break assigning: it runs after the
commit and after the person has been told it worked, it never re-throws,
and a jsdom test proves it resolves quietly even when every database call
fails. A missing mirror row is recoverable — the import picks it up. A
composer that threw after assigning real work is not.

**The read cutover is ON** (`CONFIG.itemsRead`), and safe to have on
mid-migration: an account not yet seated in the org silently gets the
assignments path, because an empty task list looks exactly like having no
work and a person who has work would believe it. The queue reads Items and adapts them back to the row shape it
has always produced, so not one line of its rendering changes — only
where the rows come from. Writes still go to `assignments`, and the
mirror keeps the model current, so the flag is a switch rather than a
one-way door.

Two things made it safe rather than hopeful. Everything that happens
after a snapshot lands — the toasts, the grouping, the receipt, the
render — was extracted into `assignedRowsLanded()` and is now shared by
both sources, so proving the ROWS are equivalent proves the SCREEN is.
And a round-trip test names every field the queue reads and asserts it
survives assignment → Item → row, so a field added to that screen later
without being carried through the model fails in CI rather than
disappearing off somebody's task list.

Turning it on found three fields the model did not carry (`snote`,
`fromEmail`, `groupSize`) and one that would have caused a write on every
snapshot (`seenAt`, the receipt). All four are now part of the built-in
task type, and an existing type gains them automatically. **Phase 3 written, not yet deployable.** `functions/index.js` is the
`commitItem` callable: it runs the same engine the browser runs — the
copies under `functions/shared/` are byte-identical, and a repo guard
fails the build if they drift — inside a Firestore transaction, so two
people finishing the same item cannot both win. Two things a caller
cannot assert reach it: **who it is** (the verified auth uid) and **which
org it is in** (read from the membership document). `CONFIG.serverCommit`
is the switch, and it stays `false` until the function is live.

**Cloud Functions requires the Firebase Blaze plan**, which this project
is not on — it uses EmailJS precisely to avoid it. Phase 3 therefore ends
in two steps that need a billing account:

1. Deploy the function, flip `CONFIG.serverCommit` to `true`, verify.
2. Only then narrow the `items` rule to reject client writes. Doing that
   first breaks every write; doing it never leaves the door open.

**Phase 4 is built.** `js/automation.js` plans; `js/items.js` carries the
plan out; the Organization page writes the rules. Conditions are evaluated
by `wfEvalCondition()` — the workflow gates' own grammar — because a
second expression language is a second set of bugs and two different
answers to "is this field empty".

Automations apply through `itemSave()`, so a rule is held to exactly the
permissions and validation a person is: it cannot move work its own
author is not allowed to touch. Termination has two layers, and the good
one is that a rule writing a value already set produces no event, so the
commonest loop dies on its second lap; `causationDepth` is only the guard
of last resort.

**Phase 5 is built.** `js/packs.js` holds eight packs and the validator;
`itemsApplyPack()` in `js/items.js` applies one in a single batch;
the Organization page has the picker. `tests/packs.test.mjs` validates
every shipped pack against the real engines and then proves the validator
refuses bad ones, which is what makes "no code change" a property rather
than a promise.

Two deliberate deviations from the sketch below, both kept because the
alternative was worse:

- **Packs ship statuses, not workflow graphs.** A blueprint's ROLE stops
  need people, and a pack lands before anyone is seated - so a shipped
  workflow would arrive as a draft that cannot be published, on a page
  the org has not opened yet. Statuses plus rules carry the same shape
  and work on day one. The pack format has room for `workflows` when
  role binding can survive an empty roster.
- **No pack defines an owner role.** Whoever created the org holds it
  already, and a template quietly redefining who owns the place is the
  worst surprise available. A test enforces it.
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

Every collection an org owns lives **under** the org, so tenancy is
structural rather than a field each query has to remember: a query cannot
cross tenants, and listing costs one membership check at any row count.
(This spec's first draft put Items at the top level keyed by an `orgId`
field. Building `invites` that way proved it wrong — per-row membership
checks blow Firestore's ten-read query cap — so the paths moved. The
`orgId` field stays on the document as a second check the engine can
make, never as the only one.)

```js
orgs/{orgId}/items/{id} = {
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
orgs/{orgId}/events/{id} = {
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

A pack is data in `js/packs.js`, versioned in the repo, applicable to any
org:

```js
{
  key: "restaurant", name: "Restaurant", version: 1, blurb: "...",
  roles: [ { id, name, permissions[] } ],
  itemTypes: [ { id, name, statuses[], fields[] } ],
  automations: [ { name, trigger, conditions[], actions[] } ]
}
```

Onboarding becomes *"pick your pack."* Everything after is editing: what a
pack creates is an ordinary role, type or rule the moment it lands, and
nothing downstream knows where it came from.

**Applying is additive and idempotent, and those are the same property.**
`packPlan(pack, existing)` skips anything already present by id, so a
second application creates nothing and a pack can be applied to a running
org without disturbing it. An org that already has a `manager` keeps ITS
manager, permissions and all — a template must never quietly hand an
existing role different powers. It lands in one batch, because half a pack
(rules pointing at types that do not exist) is worse than none.

**A broken pack cannot ship.** `packValidate()` runs against the real
engines — the same `ITEM_FIELD_TYPES` the item engine enforces, the same
grammar `permParse` reads, the same `AUTO_ACTION_KINDS` the planner runs —
so a pack cannot be valid here and rejected there. It also catches the
failure no type check would: a rule that is well-formed and can never
fire, because it waits on a status its type never reaches. Silence is the
worst bug an automation can have.

**Security needs nothing new.** A pack writes only to `roles`,
`itemTypes` and `automations`, all owner-only in `firestore.rules`
already, so a non-owner applying one is refused by the database and not
merely by a hidden button.

Shipped: restaurant, agency, clinic, construction, retail, content,
property, and `simple` — one kind of work and three stages, for whoever
recognizes none of the others.

### Worked example — `restaurant`

**ItemType "Shift swap"**
| field | type | notes |
|---|---|---|
| `shiftDate` | date | required |
| `shift` | select | Morning / Evening / Late |
| `coveredBy` | user | filled by whoever takes it |
| `reason` | longtext | |

statuses: `open` → `claimed` → `approved` / `denied`

There is no `requestedBy` field, deliberately: every Item already records
`createdBy`, and a second copy of the same fact is a second thing that can
be wrong.

**ItemType "Maintenance issue"** — `area` (select), `urgent` (checkbox),
`detail` (longtext); `reported` → `in hand` → `fixed`.

**Automations**
- `item.created` on Shift swap → notify the Shift lead role.
- `item.created` on Maintenance issue, when `urgent` is true → notify the
  Manager. The condition reads a field with the workflow gates' own
  grammar; nothing new to learn and nothing new to get wrong.

**Roles** — Manager, Shift lead, Staff. Not Owner: the org already has one.

Nothing in that pack is restaurant *code*. Swap the nouns and it is a
clinic's cover or an agency's brief reassignment — which is not a claim,
it is `clinic` and `agency` in the same file.

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

1. ~~**`completionPolicy` on ROLE nodes**~~ — **built.** `"any"`
   (default, unchanged) or `"all"`. `waitFor` governs incoming *edges*; this governs
   incoming *people*. Campaigns' multi-owner approval needs it and there is
   no way to express it today.
2. ~~**Node SLA**~~ — **built.** `dueAfter` (ms from arrival) on any node, so a stop can be
   overdue. Campaigns' stage budgets become this.
3. ~~**Condition context reads Item fields**~~ — **built.** `wfEvalCondition` already reads
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
| 4 | **Automations** | Trigger/condition/action over the event log; causation depth cap | Restaurant pack's notify rule fires ✅ |
| 5 | **Packs** | Pack format, validator, importer, 8 packs, onboarding | New industry ships with no code change ✅ |

Phases 1 and 2 are the bulk. After phase 3 the pace increases sharply,
because 4 and 5 are configuration over machinery that already exists.

## The self-serve door

Tenancy made a second company *possible*; it did not make one able to sign
up. Three separate bolts stood in the way, and only one of them was the
one everybody notices:

1. **Signup** required an invite token minted on Ez Agency's Team page.
2. **Approval** — even with a token, the account sat `pending`.
3. **The Organization page** was gated on `ADMIN_EMAILS`, so an owner who
   was not Ez Agency staff could not reach the page managing their own org.

Bolt 3 was the conflation this spec has warned about from phase 1:
`ADMIN_EMAILS` means "works for the company that runs the platform", and it
had been standing in for "owns this organization". Those are different
facts about different people, and only the second is data.

The door is now **invite-only self-serve**: a founder link is minted on the
Team page, and whoever opens it becomes a `member` — their own org, no
approval, no code change. Deliberately not open signup: an open door on
this Firebase project is an abuse and cost surface that wants rate limiting
first, and invite-only is the right shape while the first customers are
being found by hand anyway.

The load-bearing detail is that a member is **not** a `worker`. `isTeam()`
guards Ez Agency's own pre-tenancy collections — blueprints, runs,
nodeRuns, clientReviews — none of which carry an `orgId`. A founder handed
the worker role would have read another company's work. That boundary is
five rules assertions, because it is the one mistake here that would be a
real breach rather than a bug.

**The directory came with the door.** `directory/{uid}` holds every user's
name and email, and its rule was `allow read: if request.auth != null`.
That was a true-enough statement while signup was invite-only and approved
by hand — everyone with an account worked here, so the whole directory
described one company. Opening the founder door falsified it: a customer
would read Ez Agency's staff, and two customers would read each other's.

An entry now names its org and is readable by that org's members. Entries
written before this carry no `orgId` and stay readable by Ez Agency's own
team — which is exactly who they describe — until an owner stamps them.
That clause is a migration ramp, not a hole: a member is not team. The
stamping is self-healing in `orgLoad()`, the same shape as the `memberOf`
pointer it already repairs, and an owner may write `orgId` and nothing
else, because holding a roster is not a licence to rename people.

The general lesson is worth keeping: **every "any signed-in account" rule
is a statement about who can hold an account.** That premise changed the
day the founder door opened, and any rule resting on it had to be re-read.

### The audit that followed

Every rule in `firestore.rules` was re-read against the changed premise.
Three rested on it; the rest hold for reasons that survive.

**Corrected**

- `directory` read — was `request.auth != null`. Now tenant-scoped (above).
- `notifications` create — was `request.auth != null`. A customer could put
  arbitrary text into Ez Agency's bell with `toRole: 'admin'`: no leak, but
  a phishing surface. Now three ways in and no fourth — Ez Agency's team by
  the legacy @mention and hand-off paths, anybody reaching somebody in
  their own org, and a fresh signup ringing the approval bell, pinned to
  `kind: 'signup'` so it cannot carry anything else.
- `assignments` create — the self-addressed branch let anyone write into Ez
  Agency's pre-tenancy queue. Accepting a hand-off is a team action, so it
  now says so.

**Checked and sound**

- `blueprints`, `versions`, `runs`, `nodeRuns` — `isTeam()`, and a member is
  deliberately not team.
- `campaigns` — admin, or named in `memberUids`, which no customer is.
- `users`, `appState` — own row, or admin.
- `mail` — a non-admin may queue mail only to their own verified address,
  with a key allowlist that stops `cc`/`bcc`/`replyTo` turning the
  project's sender into a relay. This one was already written defensively.
- `invites`, `clientReviews` — `allow get: if true` is the capability
  pattern: the unguessable token in the link *is* the credential, and
  listing is gated so tokens cannot be harvested.
- `memberOf` — self-asserted and authorizes nothing on its own. Anything
  trusting it must re-check the seat, which `sharesMyOrg()` does; there is
  an assertion proving a lying pointer buys nothing.

**Noted, not changed.** A burned invite exposes the `usedEmail`/`usedName`
of whoever spent it to anyone still holding that token — pre-existing, and
the holder is whoever it was sent to. And `notifications` remains a
top-level collection when tenancy says it should hang under the org; the
rule is correct now, but moving it is the cleaner shape.

Still open: nothing is time-based, and billing, seats and a plan on the org
document remain unwritten.

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
