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

**A form that hides a control still reads it back.**
The Work page's item sheet draws no People checkboxes for work on a
handoff, because the run decides who holds it. Save then read those
checkboxes back - none - and sent `assign: []`, un-seating the baton
holder on every edit. The type editor did the same in the other
direction: it rebuilt the type from the four fields it showed and
`set()` dropped `track` and `workflowId`, turning the handoff off for any
type whose fields were ever edited.
*Rule:* a save that rebuilds a whole document carries every field it
does not show, or it does not rebuild. `itemSave()` now re-reads the
document before the engine rebuilds it, so a side write in between (the
overdue chase, a run stamping its id) survives a save from a page-old
copy - the general form of "A rebuild from a stale in-memory copy".
*Guard:* `tests/ui.test.mjs` presses Save on a tracked item and on an
edited type; `tests/flow.test.mjs` stamps a document behind a page's back
and saves from the old copy.

**Two things that mint the same id in the same collection.**
The "Just tasks" pack shipped a type with id `task`. That is the id the
Assign composer's mirror reads (`MIGRATE_TASK_TYPE`), so in an org that
applied the pack first, the mirror found the pack's type, its statuses
had no `open`, validation refused every row, and a `console.warn` was the
only trace. Nobody's assignments reached the new queue.
*Rule:* an id that two writers can choose is a collision waiting on
order. Reserve the legacy ids and test that nothing else claims them.
*Guard:* `tests/packs.test.mjs` checks every pack type against the
migrate ids; `tests/flow.test.mjs` applies the pack in a fresh org and
then mirrors an assignment.

**Sign-out reset the shift and forgot the organization.**
`auth.js` cleared `S`, the queue rows and the directory on sign-out, and
never `orgInvalidate()`. `orgEnsure()` hands back whatever it holds, so
the next account on the same device answered "which org, which role,
which permissions" with the previous person's - the client half of the
two gates disagreeing with the server half.
*Rule:* anything cached from a signed-in account is reset in the ONE
sign-out branch, and the repo guard reads that branch for the resets.

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

### Messaging

**Every writer of a row has to feed the mirror, not just the first one.**
`itemsMirrorAssignments()` had one caller: the composer's create path.
Accepting a hand-off, reclaiming a declined one and editing an existing
assignment all wrote `assignments` and nothing else - while the
dashboard reads Items. "Added to your queue" was true of a collection
nobody looks at. The mirror now updates a row it already holds rather
than re-creating it, so an edit keeps the run and the stamps the Item
carried.
*Rule:* when a collection gains a mirror, grep every writer of the
original, not the one you were looking at.
*Guard:* `tests/flow.test.mjs` accepts a hand-off and edits an
assignment against the fake, and looks for the Item.

**An offer the rules will refuse is not an offer.**
A member's Done sheet promised "@tag someone and they get a hand-off".
The fan-out batched the offer with a `toRole:"admin"` doc the rules deny
a member, so the batch died and the offer with it; and had it landed,
Accept writes to `assignments`, which the rules keep for Ez Agency's
team. Two refusals deep, all silent. Members now get a plain comment
box and the dispatcher writes nothing for them.
*Rule:* before drawing a control, know that the server will accept
what it does - for THIS role, not the one you tested with.

### The UI

**An empty list must say why it is empty.**
"You're all caught up" was a lie when the account was in no organization
and the work could not reach the list at all — and a lie nobody can
debug from the screen, which is how an afternoon went. The queue records
WHY it is empty. It also has to distinguish "in no org" from "could not
reach the org", because the first version of this fix told somebody to
get themselves added to an org they were already in.

**Work made before its steps existed was on nobody's list, and the
home said nothing.** 2026-09-13: the owner built a seven-step flow for
a kind called TEST and the people on step 1 got nothing. The engine,
the blueprint, the run start and the queue query were all right - the
fake database walks the exact shape green, even after it was made to
refuse `undefined` the way the real SDK does. What was wrong was the
gap AROUND them: work of a tracked kind with no run (created before
the steps were saved, or whose run failed to start) is held by nobody,
so no list shows it, and the one self-heal (`itemsFinishFromQueue`)
sits behind a Finish that nobody can press. Three fixes, all shape 1
and shape 6: saving the steps starts every waiting piece of that kind
(`itemsStartStuck`, and the toast says how many); the composer waits
for the run to start before it says "started → step 1", and says
"saved, but the steps did not start" when it did not
(`itemsCreateFromComposer` returns `unstarted`); and the admin home
lists what is stuck by kind with a Start button - AND what is with the
admin themself, because an owner lands on the Admin home and "assigned
to me" lives on the Me screen behind a switch, which read as "I got
nothing". Guards: `tests/flow.test.mjs` "work created before the steps
existed", "saving the steps sends that work to step 1", "the composer
tells the truth"; `tests/admin.test.mjs` "the home says what is with
you". Rule: a state the app can detect and cannot show is a bug
report waiting to be filed; every place that can see it says it.

**The fake now refuses `undefined` in a write.** The real SDK fails
the whole set() or update() on an `undefined` anywhere in the data
("Unsupported field value"); `JSON.stringify` dropped the key and let
the write through, which is the quiet success `fakedb.mjs` exists to
refuse. It also refuses an array directly inside an array. Reads stay
lenient (a missing document's data() is `undefined`).

**A rule that can only name what already exists cannot say what should
happen next.** The check step's route target listed the other steps and
Done, so "If they pick Approve go to" offered "1. Do the work" and
"Done" - and the owner read the picture as "after the manager approves,
it is finished", when what they meant was "approved means the next
person takes it". The way to add that person existed (the + between
the cards) and nowhere near the question. Now the target list ends
with "Someone else (adds a step after this one)", "Otherwise → Done"
carries the same offer, and a ready-made shape shows the three-step
form. Rule: where a control asks "and then what?", the answer that is
not built yet has to be one of the options, next to the ones that are.
Guard: `tests/builder.test.mjs` "a route can point at a step that does
not exist yet". (Same day: the step's "Mark the work as" chips read as
an action - "mark it done and it is done" - when they are the label the
work wears while it waits there. Renamed to say so.)

**A correct action that looks like a dead button is not correct enough.**
Finishing a stop whose next stop holds the same person is a correct
handoff that changes nothing on screen. The row has to show the change.

**Name the thing, do not describe its absence.**
"The work type is missing" sends somebody to devtools. Name the type,
name who can fix it.

**A new kind of row breaks every consumer written before it existed.**
The redesign's IDLE segment (`task: null`) was added to the shift and
proved in `clock.test.mjs`, which reads segments the new way. Nothing
re-ran the OLD readers with the new data. `taskTally()` emitted an
entry with a null task; `taskLabel()` called `.toUpperCase()` on it;
and the wrap-up sheet - Clock out - threw before it opened, for anyone
who had finished a deck task that day. The dock read "Resume · null".
Three private copies of the tally loop in `js/team.js` would have
crashed the Excel export the same way. And `resume()` rebuilt the
segment without its `itemId`, so a lunch break turned running work back
into "Start task".
*Rule:* when a data shape gains a new case, grep for every reader of
the OLD shape and run it against the new one. The pure suite for the
new reader proves nothing about the old readers.
*Guard:* `tests/shift.test.mjs` drives clock-out, the dock, the report,
switch and resume with an idle segment in the shift. `taskTally()` is
the one place idle is skipped, and `js/team.js` now calls it rather
than keeping copies that would each need the same fix.

**A control with no label asks a question nobody can answer.**
The handoff editor drew four controls per stop side by side - a name
box, a role menu, a status menu and a days box - with nothing over any
of them. The status menu's only explanation was its first entry, "Leave
the status alone", and the owner's first message about the editor was
a screenshot of that menu and "what does that mean". Every string on it
was accurate; none of it said what the control was FOR. The words did
not help either: "stop" reads as a halt, "holds" as possession, and the
intro explained the mechanism ("chased", "assigned to me comes to mean
my turn") rather than the shape.
*Rule:* every control gets a label that says what it decides, in the
words the person would use ("Who does it", "Days to finish", "Mark the
work as"), and a form that builds a sequence reads the sequence back as
one plain sentence ("Write the draft (Staff) → Check it (Manager) →
done") - four menus per row are a decision nobody can check without it.
A blank form offers a shape, because an owner asked to invent one from
four empty controls will not. On screen the model's "stop" is a "step",
everywhere - the deck, the composer, the Work page - one word for one
thing.
*Guard:* `tests/ui.test.mjs` lists the labels of every control in a
step, refuses a status menu whose first entry says "alone", proves one
press of a ready-made shape fills the steps, and reads the sentence
back after typing. `hoDescribe()` is the pure half, in
`tests/handoff.test.mjs`. `npm run shots` photographs the editor blank,
filled, and at phone width.

**Four sections for one decision is four places to be confused.**
The steps editor was labelled and plain, and the owner still could not
set a pipeline up: the steps were behind a button inside a fold on the
kinds-of-work section, the rules were in another section, the roles in
a third and the people in a fourth - and "who does step 2" is all four
at once (a role, the people in it, what they may do, what happens when
it reaches them). Each section was right; reading them together was
the work, and it was left to the owner.
*Rule:* when one decision is spread over several sections, draw it once
as a picture and let it be edited where it is seen. The picture must
invent no model: it edits the same documents through the same write
path, or it is a second app with a second set of bugs.
*Guard:* `tests/builder.test.mjs` drives the Flow builder; `orgTrackCommit()`
is the one write both editors use, and `tests/ui.test.mjs` still drives
the sheet through it.

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

**A card drawn from a snapshot ignored the shift.** The deck redraws
when the assignments snapshot fires. Start task writes the SHIFT — a new
segment in `appState/{uid}` — and touches no assignment, so nothing ever
told the deck to redraw. The card went on offering **Start task** on work
that was already running, and the Running pill never appeared; the clock
had moved and the only screen that says what you are working on had not.
Every deck assertion passed, because each one rendered once and looked at
the result.
*Rule:* when a view is fed by one source and reads a second, name the
second one's caller. Here the deck is drawn from the queue and reads the
shift, so `render()` — the one function that sees a shift change — asks
it to redraw.
*Guard:* `tests/deck.test.mjs` starts a task and re-renders, asserting the
left button became **Put down**; a second assertion reads `js/render.js`
and fails if nothing there calls `dkRefresh()`, because a redraw nobody
calls is written-never-read.

**A stub that was missing swallowed the rest of the function.** The deck
harness never defined `render()`, so every `dkStart()` in it threw the
moment it finished its real work — silently, as a rejected promise. The
assertions still passed: the state they checked was already set on the
line before. Anything the action did AFTER that point was untested and
would have stayed untested.
*Rule:* if an action is called in a test, it has to reach its end. An
async action that throws mid-way fails nothing by default.
*Guard:* the harness stubs `render()`, so the whole of `dkStart` runs.

**A bar scaled to the week's best day lied about every short week.** The
week row drew each day as a share of the week's TALLEST day, so a
twenty-minute Tuesday in an otherwise empty week filled the whole band
and read as a full shift. The fixture that photographed it had an
eight-hour day in it, so the picture looked right; the person's real
week did not. The bar answered "how does this day compare to the others"
when the question on the screen is "how much of a day was this".
*Rule:* a bar that stands for time has a fixed unit for full height —
here the same 8h lap as the shift ring — and does not rescale to its
neighbours. Relative scaling is for comparing categories, not for hours.
*Guard:* `tests/week.test.mjs` proves a lone twenty-minute day is a
sliver and a ten-hour day tops out at full, and the jsdom half measures
the drawn height of a one-hour bar.

**Thirty cards stuttered where three did not.** The deck's spring never
stopped asking for animation frames, so every card was restyled sixty
times a second all day, moving nothing. And a card two back sits at
opacity 0 - nothing of it to see - but it was still a full-size glass
pane with a backdrop blur, a 3D transform and a 60px shadow that the
browser composited on every one of those frames. Three cards hid it;
a real week's worth of work did not. The front card, 97.5% opaque,
carried a backdrop blur too, which made the browser render everything
behind it into a texture first for a difference nobody could see.
*Rule:* an animation loop runs while something MOVES and stops when it
is at rest. Anything at opacity 0 is `visibility:hidden` as well, so it
leaves the compositor rather than costing a layer. A property the frame
loop writes must not also carry a CSS transition, or every write re-aims
a tween and the element is always a beat behind.
*Guard:* `tests/deck.test.mjs` steps a faked frame scheduler over a
thirty-card deck: the loop must stop within a few frames at rest,
restart on a move, settle, and leave only the visible cards painted.

**A redraw kept the memory of a stack it had thrown away.** Pressing
Start task writes the shift, `render()` rebuilds the deck, and the
rebuilt cards came up as blurred glass with no front card at all. The
cards were new; `dkSettled` was not - it still said "index 1 is
settled", and `dkLayout` only marks a card as front when that number
CHANGES. A redraw onto the same index therefore marked nothing. The test
harness had hidden it for weeks: its `front()` helper fell back to the
first `.dk-card` when no card was marked, so every assertion passed on a
deck with no front.
*Rule:* state that describes the DOM is reset when the DOM is rebuilt.
And a test helper must not paper over the absence of the thing it is
there to find - a fallback in a helper is an assertion that never runs.
*Guard:* `dkRender` resets `dkSettled`; `tests/deck.test.mjs` finds the
front card strictly and proves a redraw onto the same index marks it.

**A spring stepped per frame ran twice as fast on a 120Hz screen.** The
deck's and the stack's springs moved 16% of the way each animation frame
and bled 10% off a fling each frame. Tuned on a 60Hz display that felt
right; on a 120Hz laptop every motion took half the time, and under a
heavy tab it crawled. Frames are not a unit of time.
*Rule:* an animation loop integrates by the wall-clock time the frame
took (`requestAnimationFrame`'s timestamp), scaled to the rate it was
tuned at, with a missing or absurd delta counting as one frame.
*Guard:* `tests/deck.test.mjs` drives the spring over the same 200ms as
twelve frames and as twenty-four and requires the same position.

**Glass that changed every frame was repainted every frame.** To make
the deck's glass move with the motion, its depth was fed into the
gradient's alpha, the border colour, the shadow and the backdrop blur
radius. Each of those is a PAINT: every visible card was rasterised
again and its backdrop re-blurred on every frame the stack moved, and
the deck lagged the wheel by a visible beat. The look was right; the
property was wrong.
*Rule:* a number written per frame may only reach `transform`, `opacity`
and `filter` - what the compositor changes on the GPU without a repaint.
Anything painted (backgrounds, borders, shadows, backdrop radii) is
static, and is faded or slid by a promoted pseudo-element's opacity or
transform instead.
*Guard:* `tests/deck.test.mjs` reads `css/ios.css` and fails if `--d`,
`--o` or `--v` appears in any other property.

**A card faded before the thing it announced had happened.** Pressing
Done on the deck faded the card to nothing at once - then opened the
sheet that asks for a comment and actually finishes the task. Cancel the
sheet and the card stayed invisible until the next snapshot. Confirm it
and the snapshot removed the card before the eye caught up, so "done"
had no moment at all.
*Rule:* a control's feedback follows the WRITE, not the press. Until the
write lands nothing on screen may claim it did; once it lands, the
picture is held long enough to be seen before the new state applies.
*Guard:* `tests/deck.test.mjs` proves the press changes nothing, that a
hold keeps the snapshot's rows waiting while the strike draws, and that
`finishAssignment()` arms, strikes and releases on both of its paths.

### Cuts

**Campaigns was cut, not migrated (2026-09-09).**
docs/dashboard-v6-spec.md §12a decided it; the owner confirmed it. The
page, its stylesheet, the public client-review page and every hook -
the queue's baton rows, the team pane's campaign rows, the composer's
load count, the notification click, the retired-route flag - are gone.
The `campaigns`, `campaignTemplates` and `clientReviews` DATA and their
rules are untouched, and "Import campaigns" on the Organization page
still brings old campaigns into Work at the stage they were on. The
deck's "Send back", whose only implementation was the campaigns page,
became "Put down": it closes the task's segment into an idle one, which
the clock math (`clkTaskTotal`) already sums back when the card is
started again.

**The legacy Workflows page went with it.**
Same decision, same day: the drawflow builder, the runs board and the
effect dispatcher read top-level `blueprints`/`runs`/`nodeRuns`, Ez
Agency's pre-tenancy collections, and the org handoff (a track compiled
by `js/handoff.js`, run by `js/items.js`) is the one pipeline now.
`js/workflow-engine.js` stays: the handoff runs on it. The four suites
that loaded the page verbatim went with the page; the engine's own suite
stays. The "Take it / Not me" offer and "Work this stop" row had one
taker each and are gone; a claimed stop's assignment is a plain row.
The legacy rules and data are untouched.

**The Cloud Function was deleted, not kept as a switch.**
`functions/commitItem` would have run the item engine server-side. It
was never deployed (Blaze was never turned on), `CONFIG.serverCommit`
was never flipped, and the switch's own path had drifted - it skipped
automations, notifications and the handoff start until this audit. A
door nobody can open is a door that rots. It is gone with its deploy
workflow, its copies of the engine, the guard that kept the copies
honest, and the SDK every page load fetched for it. `docs/platform-spec.md`
still describes the phase; if it comes back, it comes back with tests.

### Infrastructure

**The test that never ran was green for months.**
`ci.yml` ran one step per suite, so a suite added to `package.json` and
not to the workflow ran on every laptop and never in CI. Eight were
missing - the whole redesign and the flag test the lessons file itself
holds up as the guard. A list copied into a second place is a second
place to forget.
*Rule:* CI runs `npm test`, the same command a person runs, and nothing
else names the suites.

**Quirks mode, for the app's whole life.**
`index.html` had no doctype: a BOM, then `<meta charset>`. Every browser
laid the app out in quirks mode, and so did every jsdom test and every
screenshot, so nothing could notice. Adding it is a layout change to
look at, not a formality - `npm run shots` before and after.

**Two units for one field.**
The legacy builder saved `dueAfter` in hours; the engine adds it to
`now` as milliseconds; the org track editor and the migration already
spoke milliseconds. Nothing read the legacy deadline, so it was wrong
for as long as it existed without anyone seeing 48ms. The builder now
converts at the edge, as the track editor does.
*Rule:* a number that crosses a file boundary carries its unit in its
name or its comment, and one producer is checked against the reader.

### Process

**Walk the whole flow before declaring it done.** The A-to-Z run found
the reported bug in its first minute and a second one underneath it.
Shipping one fix at a time, per screenshot, is how three rounds of
screenshots happen.

**Do not claim a property you did not verify.** A commit message once
said a transaction was atomic while the code ran a query inside it. If a
comment names a mechanism, check the mechanism exists — an automation
comment named a `causationDepth` field that never existed.

### Clock layout after clock-in

**A flexible hero row can shrink through its own labels.** The v6 clock
track used `minmax(0,1fr)` with `min-height:0`, while clock-in added a
second row of large controls and paused-task chips. Its centered contents
could paint outside that collapsed row. Old pane widths and margins also
survived into the new grid. Preserve the clock's min-content height, reset
those inherited dimensions, and let a short desktop scroll. Keep controls
at a compact 48px minimum, with auto height for wrapped labels.

**Seconds sized in em followed the wrapper, not the main digits.** The
`.42em` seconds were based on a 16px parent and rendered at about 7px.
Use an explicit responsive 16–22px size for the redesigned clocks.
*Guard:* `tests/shots.mjs` checks actual ring/control geometry, button
heights, and seconds sizes across seven desktop/tablet/phone viewports,
then captures the active, idle, and classic dashboards.

### Reviews

**A denial that unexpectedly succeeded poisoned every assertion after it.**
The rules suite for reviews showed five failures; four were legitimate
transitions refused with PERMISSION_DENIED and one was a "must be
DENIED" write that had gone through. Only the last was the bug: the
rules let a resubmission append an invented closed round to `history`
(they checked that history grew by one, not what it grew by), so that
write landed, bumped `version`, and every genuine write after it was a
version behind. Bisecting the rules in isolation showed each clause
sound; the cascade was in the fixture. The rule now requires the
appended round to equal `{ round, submission, decision }` of the
document it replaces (`rvRoundClosed()`).
*Rule:* when a suite shows one assertion that passed where it should
have failed, read that one first — an accepted write that should have
been refused changes the state every later assertion stands on.
*Guard:* `tests/firestore-rules.test.mjs` > "a resubmission that
rewrites history DENIED", and the "rewritten in history" cases after
the step-round write.

**A rating with no words is a number nobody can act on.** The first
review feature let a checker rate the step before with three scores and
an optional note. The rubric's whole value is the explanation — why a 5
is a 5 — so every decision now requires feedback, on the deck's finish
sheet, on the Work page and in the rules, and a step rating without a
note is refused rather than recorded (`rvRecordFromStep`, the flow test
"a rating with no words is refused").

**Protected and enforced-in-the-browser are different words, and the
screen says which.** The review's decision, scores, history, version
and who-may-decide are checked by `firestore.rules`. Which step the
work is on, and whether a person may finish it, is still the item
engine running in the browser under the knowingly-permissive
items/runs rules. A review therefore records a judgement the server
protects about work whose movement it does not yet — `js/reviews.js`
says so at the top, so nobody reads the rules for reviews and assumes
the run behind them is held to the same standard.
