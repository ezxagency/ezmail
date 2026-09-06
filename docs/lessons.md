# Lessons — what this app already got wrong, and how it stays fixed

Append-only. One entry per bug that cost somebody real time. A session
that reads this should not have to rediscover any of it.

**How to use it.** Read the "Failure shapes" list before writing code —
those are the patterns, and nearly every entry below is an instance of
one. Read the entry for an area before you change that area. When you
fix a bug, add an entry and a test; the test is what keeps the fix, the
entry is what keeps the *reason*.

**Why the file exists.** Sessions do not remember each other. Everything
below was found by somebody USING the app, not by anybody reading it,
and several were found twice. The repo's own convention is that a rule
worth remembering gets enforced by a test so nobody has to remember it —
this file is for the part of a lesson a test cannot state.

---

## Failure shapes

The recurring ones. Check your change against these before you ship it.

1. **A screen that is confidently wrong rather than visibly unsure.**
   "You're all caught up" when the truth is the read failed. "Your role
   cannot do that" when the role does not exist. An empty state must
   distinguish *nothing to show* from *could not reach it*, and say
   which. Six bugs in one day were this shape.
2. **The glue between a decision and a write.** Every bug a person found
   here lived there, and every pure suite tests decisions. That is what
   `tests/flow.test.mjs` and `tests/fakedb.mjs` are for. A change that
   spans a decision and a database write gets a flow test, not a unit
   test.
3. **Written, never read.** A field set on an in-memory object that
   nothing saves, or saved and shown to nobody. It ships green and dead.
   If you add a field, prove in a test that it comes back out of the
   database.
4. **A mock that quietly succeeds.** `fakedb.mjs` throws on updating a
   missing document and fails a batch whole, because the real one does.
   Never soften a fake to make a test pass.
5. **Two gates answering the same question differently.** `firestore.rules`
   and the client must decide authorization from the same data. When
   they disagree the server is right and the screen is inexplicable.
6. **Offering an action that can only fail.** Ask permission before you
   draw the control, not after it is pressed.
7. **Fixing casualties instead of the cause.** When three screens break
   at once, find the one write that broke them.

---

## Entries

### Firestore

**A batch dies whole, and takes the good write with it.**
The queue stamped rows as seen in two places — the legacy assignment
document and the Item — in ONE batch. Work created in the app has no
assignment behind it, so `update()` hit a missing document, the batch
failed entirely, and the Item's stamp went down with it. Every snapshot
then re-stamped the same rows forever.
*Rule:* never batch a write to a document that may not exist alongside
one that must land. Carry the fact that decides it (`fromAssignment`) on
the row; do not infer it from a coincidence like two ids differing.

**`collectionGroup(...).where(...)` needs a declared index.**
Firestore does not create collection-group indexes the way it does
ordinary single-field ones. `orgLoad` queried `collectionGroup("members")
.where("uid","==",uid)` with no index; the query threw, `orgLoad`
returned null, and the app concluded the account was in no organization.
The OWNER worked — creating an org writes their own `memberOf` pointer —
so every invited member was broken and every test account was fine.
*Guard:* `tests/repo-guards.test.mjs` fails the build if any
`collectionGroup(...).where(...)` in `js/` has no matching
`COLLECTION_GROUP` index in `firestore.indexes.json`.
*Also:* a new index takes minutes to build after deploy, and the client
must reload once it has.

**`Transaction.get()` takes a document, never a query.**
The handoff commit read its stops with a query inside a transaction, so
that read sat OUTSIDE the isolation and was not re-run on retry — two
people finishing the same stop would both win, which is the exact race
the transaction was written for. A comment claimed the fix that was
never written.
*Rule:* if a transaction must read several things, put them in one
document. A run now carries its stops inside it.

**A delete with a mirror must delete the mirror.**
The Team page promised "this removes it for them too", deleted the
assignment document, and left the Item — which is what the worker's
dashboard actually reads. The promise in the dialog is why nobody
checked. `itemsMirrorAssignmentsDelete()` now runs wherever an
assignment is deleted.

**Deleting a type orphans its work.**
And the one screen that can clear orphans bailed out with "No work types
yet" before it looked for them — which is exactly the state you are in
after deleting the last type. The orphan scan runs first now, and the
repair tab stands on its own.

### The Item model

**A rebuild from a stale in-memory copy wipes a side update.**
`itemsSyncFromRun` wrote `workflowRunId` as a side update; the next
commit rebuilt the document from a copy that still said null. The work
travelled a run it had no record of, so Mark Done did nothing.

**Change detection that counts the wrong fields drops the rest.**
`itemCommit`'s update path counted only `title` and `fields` as changes
and returned the ORIGINAL Item when nothing "changed" — so `dueAt`,
`nudgedAt` and `workflowRunId` were set on an object nobody saved. That
silently killed two whole shipped features: an Item never remembered its
run, and a deadline never persisted, so nothing was ever late.

**Route a write by what the row IS, not what it used to be.**
Mark Done wrote to the legacy assignments document, which does not exist
for anything created in the app — "Couldn't update, check Firestore
rules". Finishing now routes on the row: a handoff advances its stop,
untracked work takes the status its type calls done, and the toast says
which rather than claiming "done" for all three.

### Permissions and tenancy

**Answer the authorization question the way the rules answer it.**
`firestore.rules` decides ownership from `members/{uid}.roleId`.
`itemActorPermissions()` instead looked up a `roles/owner` DOCUMENT and
returned `[]` when there wasn't one, so an owner held NO permissions on
the client while the server trusted them with everything. Every button
said "your role cannot", and no screen could explain it because the role
the message blamed did not exist.

**`ADMIN_EMAILS` is not "owns this organization".**
It means "works for the company that runs this platform". Conflating
them once left a customer locked out of the page managing their own org.
Ownership is an org role, which is data.

**`member` is deliberately not in `isTeam()`.**
The pre-tenancy collections are not org-scoped, so a member who counted
as team would read another company's work.

### The UI

**An empty list must say why it is empty.**
"You're all caught up" was a lie when the account was in no organization
and the work could not reach the list at all — and a lie nobody can
debug from the screen, which is how an afternoon went. The queue records
WHY it is empty. It also has to distinguish "in no org" from "could not
reach the org", because the first version of this fix told somebody to
get themselves added to an org they were already in.

**A correct action that looks like a dead button is not correct enough.**
Finishing a stop whose next stop holds the same person is a correct
handoff that changes nothing on screen. The row has to show the change.

**Name the thing, do not describe its absence.**
"The work type is missing" sends somebody to devtools. Name the type,
name who can fix it.

### Load order and globals

`js/` files are classic scripts in ONE global scope; the `<script>`
order in `index.html` is the dependency graph. A `const` at the top of
any file is a global — a one-letter helper (`S`, `F`, `R`) collides
silently, and `S` is the live shift state. Prefix file-local helpers.
`js/handoff.js` must load before `js/packs.js`, because a pack compiles
its tracks with it.

A typo in a cleanup path takes everything after it down: `ReferenceError:
list is not defined` on sign-out, where the function had declared `box`,
killed the rest of sign-out.

### Looking at it

**Three slices shipped green and wrong.** The deck's front card was
translucent enough to read the card behind it straight through its own
title. The scrubber's legend sat on top of its own timestamps, because
the thing that makes that bar narrow is the COLUMN it lives in, not the
window — so a viewport media query never fired. And the bar's note
rendered in capitals, inheriting `text-transform` from the one-line
readout it replaced. Every pure and jsdom assertion passed on all three.
*Rule:* an assertion can prove the markup is right and cannot prove the
screen is. Anything that changes how something LOOKS gets looked at.
*Guard:* `cd tests && npm run shots` boots the real page in Chromium with
Firebase stubbed, sets the state by hand and photographs it — on shift,
clocked out, and classic, which must not move.

**The flag that turned it on was never tested.** Five slices of the
redesign were photographed by adding the `ui-next` class BY HAND in the
harness. Every one looked right. Nothing ever proved that `?ui=next` —
the thing a person actually types — does anything at all. The flag did
work, but that was luck, not verification: the check that would have
caught it breaking did not exist.
*Rule:* test the switch, not just the thing it switches. A feature
reached by a URL is not verified until something loads that URL.
*Guard:* `tests/flag.test.mjs` boots real URLs and lets `config.js` run
untouched; `npm run shots` now navigates to `?ui=next` and refuses to
photograph anything if the class is absent.

### Process

**Walk the whole flow before declaring it done.** The A-to-Z run found
the reported bug in its first minute and a second one underneath it.
Shipping one fix at a time, per screenshot, is how three rounds of
screenshots happen.

**Do not claim a property you did not verify.** A commit message once
said a transaction was atomic while the code ran a query inside it. If a
comment names a mechanism, check the mechanism exists — an automation
comment named a `causationDepth` field that never existed.
