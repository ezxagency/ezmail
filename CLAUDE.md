# EZ Clock In — working notes

A static, no-build shift tracker for Ez Agency, served as-is from GitHub
Pages at `ezclockn.com`. Firebase (Auth + Firestore) is the only backend.
Read `README.md` for the feature tour and the file-by-file map; this file
is the stuff that bites you if you don't know it.

## Memory between sessions

Sessions do not remember each other. Everything this app got wrong was
found by somebody USING it, and more than one of those was found twice —
so what a session learns is written down before the session ends.

- **`docs/lessons.md`** is the log: every bug that cost real time, with
  the cause, the rule it produced, and the guard that keeps it. Read the
  entry for an area BEFORE you change that area, and read its "Failure
  shapes" list before writing anything — nearly every bug here is an
  instance of one of the seven.
- **After fixing a bug, add an entry and a test.** The test keeps the
  fix; the entry keeps the reason, which is the half a test cannot
  state. A fix without both is a fix the next session undoes.
- `.claude/hooks/session-memory.sh` prints that digest and the branch
  state into every new session, so none of this depends on anybody
  thinking to look. `.claude/hooks/session-start.sh` installs the test
  dependencies in the background at the same time.

## Hard rules

These are enforced by `tests/repo-guards.test.mjs` — CI fails if you break
one, so you don't have to remember them. (Rule 4 is the one convention
no test states.)

1. **`timeclock-v2.html` is a byte-for-byte copy of `index.html`.** After
   editing the HTML: `cp index.html timeclock-v2.html`. Two files, one app.
2. **Every local `css/`/`js/` reference carries the same `?v=N`.** Bump N
   on *any* css/js change. A missed bump serves fresh HTML with stale
   cached JS — the exact bug the convention exists to prevent.
3. **`ADMIN_EMAILS` / `ASSIGNER_EMAILS` in `js/config.js` must match
   `isDesignatedAdminEmail()` / `isAssignerEmail()` in `firestore.rules`.**
   See "Two gates" below for why this one matters most.
4. **No bundler, no framework, no npm at runtime.** Edit, refresh, push.
   `tests/` is the only place with dependencies. (A Cloud Function that
   would have run the item engine server-side lived in `functions/`; it
   was never deployed and was deleted on 2026-09-09. If it comes back,
   its copies of `js/item-engine.js` and `js/permissions.js` need a
   byte-for-byte guard again.)

## Two gates, one truth

Authorization is enforced twice, and the two halves are separate files:

- `js/config.js` gates the **UI** — which buttons render.
- `firestore.rules` gates the **database** — what the server will accept.

Hiding a button is not security. If you remove someone's access, change
both, or they keep full access to anything they can reach with a direct
Firestore call. Guard 3 above fails the build if the two lists disagree.

**`ADMIN_EMAILS` is not "owns this organization".** It means "works for
the company that runs this platform" — a different thing, and conflating
them is what once left a customer unable to reach the page managing their
own org. Ownership is an org role (`orgIsOwner()`), which is data. The
email list stays for Ez Agency's own legacy pages and nothing else.

## Three roles, two doors

`users/{uid}.role` is about **Ez Agency's own team**, and it decides which
door a signup came through:

- `admin` / `worker` — Ez Agency staff. `isTeam()` in the rules, which
  guards the pre-tenancy data: blueprints, runs, nodeRuns, clientReviews.
- `member` — a customer running their own organization here. Deliberately
  **not** in `isTeam()`: none of that legacy data is org-scoped, so a
  member who counted as team would read another company's work. A member's
  access is their org membership and nothing besides.
- `pending` — signed up, waiting on approval. Reaches nothing.

An invite's `kind` picks the door: `team` (the original — a hire who lands
in the approval queue) or `founder` (a member, who approves with nobody and
goes straight to creating their org). Invites minted before founder links
existed carry no `kind` at all, and `inviteKind()` defaults them to `team`
so every one of them still works.

## Load order is the architecture

`js/` files are **classic scripts sharing one global scope** — no modules,
no imports. The `<script>` order in `index.html` *is* the dependency graph:
`config.js` defines `CONFIG`, `S`, `Store`, `$`, `esc` and the time helpers
that everything downstream assumes already exist. Same for `css/` — the
order is the cascade. Never shuffle either. `premium.css` and `premium.js`
load last on purpose: they standardize motion over everything before them.

One consequence bites harder than it looks: **a `const` at the top of any
`js/` file is a global**. A local-looking one-letter helper (`S`, `F`, `R`)
silently collides with something already there — `S` is the live shift
state — and the file that loses is whichever loads second. Prefix helpers
that only serve one file (`pkField`, `orgTypeKeyFor`). The jsdom suite
catches this, because it loads the real files into one scope the way the
browser does.

## The shift invariant

`S.shift` holds `segs` and `breaks`. A segment is either a **task**
segment (`itemId` and `task` set) or an **idle** one (`task: null`) —
clocked in with nothing running, which finishing a task leaves you in.
The invariant, stated in `js/config.js` and relied on throughout:

> While ACTIVE, exactly one open seg, of EITHER kind. While ON_BREAK,
> none. Therefore `sum(all segs) === net working time`, always, and
> `sum(task segs) === time actually spent on work`. The difference is
> idle time.

Anything that opens or closes a segment must preserve this. The
arithmetic lives in `js/clock.js` so it can be tested under Node, and
two rules keep it honest: a task's time is the **sum of its segments**
found by `itemId`, never a counter kept beside them (a second copy of a
fact the segments already carry drifts the first time a save fails); and
a segment with **no** `itemId` behaves exactly as it always did, so the
classic dashboard does not move. `taskClockMs()` still refuses to sum
EVERY segment — that would reproduce the shift clock digit for digit and
the second ring would say nothing — but summing ONE task's segments is a
different number, and the one "pick the task back up" asks for.

The whole design this serves is `docs/dashboard-v6-spec.md`.

## Testing

```
cd tests
npm ci          # once
npm test        # 644 assertions, node + jsdom, seconds
npm run test:rules   # 304 rules assertions (needs Java + firebase-tools)
npm run test:all     # both
```

`npm test` covers the workflow engine, the permission grammar, the item engine, automations,
the template packs, the repo guards, and — in jsdom, with the real files
loaded into one shared global scope exactly as `index.html` arranges
them — the generated UI. That last suite exists because the pure ones
prove what the engine DECIDES and cannot prove that a control the app
draws is a control the app can read back; that round trip only exists in
a document. It earns its keep: it is what caught `js/packs.js` declaring
a helper called `S` on top of the live shift state.

`flow.test.mjs` is the one that matters most and was added last. It runs
the WHOLE sequence — apply a template, seat two people, create tracked
work, watch the run start, finish a stop, watch the baton reach the next
person — against `fakedb.mjs`, an in-memory Firestore. It exists because
every bug a person found in this app lived in the GLUE between a decision
and a write, and every other suite tests decisions. Its fake `update()`
throws on a missing document exactly as Firestore does, because a fake
that quietly succeeded would hide the very bugs it is here to catch. It
found two the hour it was written.

`npm run shots` is not part of `npm test` and is not an assertion: it
boots the real page in Chromium with Firebase stubbed, sets the state by
hand and photographs it (`tests/.shots/`). It exists because three
slices of the redesign shipped green and visibly wrong — see
`docs/lessons.md` > "Looking at it". Anything that changes how something
LOOKS gets looked at.

`packs.test.mjs` is the odd one out and worth understanding. It validates
every pack in `js/packs.js` against the REAL engines, and then proves the
validator actually refuses things — because a validator that always says
yes would pass the first half and mean nothing.
`test:rules` runs the full allow/deny matrix against the Firestore
emulator across six actor types — admin, assigner, worker, pending
stranger, unverified signup, and the unauthenticated client-link holder —
plus the tenancy matrix, where the property under test is that no role
reaches through an org boundary. All 948 pass as of this writing — a
failure is a real regression, not a flake.

## The redesign lives behind a flag

The new staff dashboard is now the DEFAULT: a plain visit gets it, and
`?ui=classic` is the way back. That choice is remembered and outranks the
default — somebody who picks the classic screen keeps it rather than
being quietly returned to the new one, which is why the flag's answer is
three-valued (`asked` / `stored` / `never chose`) and not a boolean.
`?ui=next` still forces it on. `UI_NEXT_DEFAULT` in `js/config.js` is the
one line that flips it back if the new screen has to be pulled. The query may sit
before the hash (`?ui=next#/`) or inside the route (`#/?ui=next`).
`applyUiFlag()` in `js/config.js` puts a `ui-next` class on `<body>`, and
every new piece hangs off that class — so a team mid-shift keeps the
screen they know until the whole thing is ready.

First piece landed: the **shift scrubber**, the bar under the clocks.
`js/scrubber.js` splits in half on purpose — `sbPlan()` is pure and
tested under Node, `sbRender()` is the only part that touches the
document. It spans the SCHEDULED shift, which is
`orgs/{orgId}/members/{uid}.shiftMinutes`, set on a person's seat by an
owner or by any role holding `member:hours` (the seeded Manager has it).
With none set it spans **eight hours** — the owner's decision, made in
as many words on 2026-09-12 — and the header carries a `default` tag so
the screen never claims a schedule nobody configured. The fill runs from
the left edge and grows with the clocked-in time; there is no playhead
dot, only the live time under the fill's end.
`firestore.rules` pins that delegated write to that one field: without
the pin, the update that sets somebody's hours is the same update that
sets their `roleId`, and the rules suite proves it by failing four
assertions the moment the pin comes out. The bar is ticked every second
but REBUILT only when its structure changes — a block started or closed,
the schedule, another hour of overtime — and otherwise moved in place,
which is what lets the playhead glide and the live block's light run
instead of restarting each second. Every block carries what it was
(`label`, `itemId`, `live`), so hovering one says the task and its span,
and pressing one brings that task to the front of the deck.

Second piece: the **assigned deck**. `js/deck.js` turns the same rows the
queue has always produced into one card at a time — the wheel, the arrows
or the arrow keys move one card per notch, and the next two peek behind.
Four kinds of work wear the SAME card and only the action changes, which
is the part `tests/deck.test.mjs` spends most of its assertions on: an
assignment offers Done, a
workflow stop routes to its stop, and work whose type was deleted offers
nothing and says why. `dkPick()` is the pure half, and it exists because
finishing the front card removes it from the snapshot — what shows next
has to be the work that took its place, not card one. Done has a MOMENT:
`finishAssignment()` arms `dkHold()` before it writes, so the snapshot's
rows wait; on success `dkStrike()` draws a line through the middle of the
title and the deck keeps that picture for under a second before the rows
apply; on failure `dkRelease()` puts everything back. Nothing changes on
the press itself — `docs/lessons.md` > "A card faded before".

Third piece: the **week row** under the wordmark. `js/week.js` derives
this week's hours, seven day bars and the clock-in streak from
`S.history` — the closed shifts already sitting in `appState/{uid}` — so
it costs no read, no query and no index. The open shift is added live,
because a row that ignored the hours you are working right now would be
wrong all day and right only after clock-out. `wr` prefix, not `wk`:
`js/work.js` already owns `wk` in the one shared scope.

Fourth piece: the **left rail**, which replaces the hamburger. It keeps
no list of pages — `js/rail.js` builds it from the drawer's own items and
re-reads their `.hidden` and `.active` on every sync, so which pages a
person gets is still answered once, by the role gating in `js/auth.js`.
That is also the answer to the comp's six icons against the app's eight
routes: the rail carries whatever the drawer carries, so Work keeps a
seat instead of quietly becoming unreachable.

Fifth piece: the **ground and the chips**. The comp's background is the
same marble under a heavy even veil rather than the classic left-to-right
gradient, which exists to keep white text legible over the bright half of
the photo — a problem the darker treatment does not have. And "pick up
where you left off" (`js/hero.js`) is this shift's PAUSED tasks: work
with a closed segment that is not the one running now, each chip naming
the task and the time already spent on it, and pressing one opens a fresh
segment for it. `clkPaused()` says what was put down; it cannot know what
was FINISHED, since "done" lives on the Item — so `hrOffer()` narrows the
list to the work still on the deck, which also means an unloaded queue
offers nothing rather than offering work nobody can complete.

Sixth piece: the **started stack**, the column between the clocks and
the deck on a window 1600px or wider (`css/v6.css` reserves the column
whether or not anything is started, so the rings do not jump the first
time somebody presses Start task). `js/started.js` turns this shift's
segments into one landscape card per task — grouped by `itemId`, so a
segment without one (classic tasks, the idle gap) is not a started task.
A new task lands at the bottom, three fit, and past three the stack
scrolls one card per wheel notch on the deck's spring. `stPlan()` is the
pure half; its one opinion is that a task whose segments are all closed
is FINISHED only once the deck has loaded and no longer carries it — and a
finished task LEAVES the stack (the owner's ask); before that snapshot the
honest word is Paused, and the card stays. The card redraws only when a
task's identity or state changes; the running card's digits are written
in place every second, because rebuilding the stack once a second would
restart the spring under the reader's wheel.

Seventh piece: the **iOS layer**, `css/ios.css`, loaded after `v6.css`
and scoped to `.ui-next` throughout. It lays nothing out — it retunes
what the other sheets draw, in four ideas the file is organised by: glass
(a translucent fill over a heavy blur, one thin stroke, a 1px highlight
along the top edge), colour (iOS's secondary-label grey, and system tints
used sparingly: blue is THE action, green is time running, orange the
streak, red late), motion (one ease, springs that settle, a press that
shrinks the whole control, surfaces that rise in on first paint) and
shape (continuous corners, capsules for small things). It redefines the
kit's own tokens — `--wk-green`, `--wk-white-60`, `--pz-ease` — under
`body.ui-next`, so every older rule that used them picks up the palette
without being rewritten. The deck's glass is a function of DEPTH: `dkLayout()`
writes `--d` (how far back), `--o` (which side) and `--v` (how fast) onto
every card each frame, and the card's blur, and the opacity and slide of the
two pseudo-elements that carry the front card's light, are `calc()`s of
those — and ONLY those three kinds of property, because anything painted
(the tint, the border, the shadow, the backdrop radius) driven per frame
repaints every card per frame; `docs/lessons.md` > "Glass that changed
every frame", and a guard in `tests/deck.test.mjs`. Both
springs step by wall-clock time (`dkFrames()`), not per frame — see
`docs/lessons.md` > "A spring stepped per frame". Two things it
deliberately does not do: it never
transitions `transform` or `opacity` on the deck's or the stack's cards,
because their springs write those every frame; and it never adds a
backdrop blur to something that is hidden or opaque, because each one is
a layer the browser re-renders behind (`docs/lessons.md` > "Thirty
cards"). The classic screen is untouched, and `tests/shots.mjs` proves it
with `classic-unchanged.png` every run.

Eighth piece: **Admin mode**, `js/admin.js` + `css/admin.css`. An admin
used to get everything a worker gets plus the admin furniture, all at
once. Now an account with something to administer (`amCapable()`: an Ez
admin, an assigner, an org owner or hours-manager) has a switch in the
rail (and in the drawer on a phone) between two views. **Me** is the
worker's screen, gated exactly as a worker's. **Admin** replaces the
whole stage with the admin home: "Needs you" (approvals, completions to
acknowledge, overdue work, handoff gaps — each row carrying its action),
"Team now" (who is on shift, live), today's numbers, and quick actions;
the rail carries Home, Team, Work, Organization. Admin is the default and
the choice is remembered per account on the device. `amApply()` is the
ONE place that decides what the screen holds — `enterFullApp()` calls it
instead of toggling drawer items itself, `applyRoute()` asks
`amRouteAllowed()`, and the queue and notifications ask `amAdminHere()`
where they used to ask `isAdmin`. Two things it does not touch: what the
account may WRITE (still `isAdmin`, `canAssignTasks`, the org role, and
`firestore.rules`), and the classic screen, where `amOn()` is always
false and the role decides as before. Every read the home makes is one
the account already makes on the Team or Org page, behind the same
predicate, and a read that fails is shown as "could not reach", never as
"nothing to do". Two rows the home carries for an org member: what is
WITH them (a count, pointing at the Me screen, because an owner lands
here and "assigned to me" is behind the switch) and, for the owner,
tracked work on no step by kind with a Start button (`itemsStuckOf`,
`itemsStartStuck`) - see `docs/lessons.md` > "Work made before its
steps existed".

Ninth piece: the **Flow builder**, `js/flow.js` + `css/flow.css`, route
`#/flow`, the same door as Organization (`amRouteAllowed`). The
Organization page answers "what do we have" in four sections; this page
draws one kind of work as ONE picture, left to right - start, the steps
as cards, the end - with the rules for that kind in a lane beneath and
the people and roles beside it, and everything is edited where it is
seen: a step's name is typed on the card, its role is a chip, its
people are avatars to tick, a person is dragged from the panel onto a
step to give it to them, cards are dragged to reorder (arrows too, for a
phone), the + between two cards inserts one. It invents NO model: the
canvas edits the same `track` the steps sheet edits and saves it through
`orgTrackCommit()` in `js/org.js`, the one write path both screens
share (which also starts every open piece of that kind that is on no
run yet, and says how many - work made before the steps were saved is
otherwise held by nobody); the builder's bar calls that PUBLISH, the
owner's word: it saves, makes the steps live, sends waiting work to
step 1, and a live kind reads "Live · new Task follows these steps"
with a "Start a Task" button that opens the composer on that kind
(`openComposer(null, null, null, typeId)`); rules are the same automations documents (the lane offers a
kind's own statuses and fields where the Organization sheet asks for a
key typed exactly); a role's permissions, a kind's fields and an invite
open the sheets that already exist. Those sheets call `enterOrgPage()`
when they save, and it yields to `enterFlowPage()` when the builder is
the page on screen. `flS` is the page's state (`draft`, `dirty`, `drag`);
`flMove()`, `flGive()`, `flToggle()` and `flRuleWords()` are the pure
half. Owner-only for changes, like the sheets it fronts; anyone through
the door sees the picture. `tests/builder.test.mjs` drives it in jsdom.
The canvas reads top to bottom and AT A GLANCE: a step is one line -
who does it (or an orange "nobody yet"), the days, what it marks the
work as, its choices - until it is pressed open (`flS.open`, one at a
time; a new step opens itself). A rule is one sentence with a switch
("When a Task is marked Review, tell whoever holds it"), edited in a
sheet that asks three things: WHEN (created / marked a status / given
to someone / edited - "is marked X" is the `item.status_changed` verb
plus a `task.status == X` condition, because the bare verb fires on
every change and says nothing), ONLY IF (one field of the kind, from
its own options), THEN (tell people - a role, whoever holds it, or
whoever created it via `toWhom` - mark it, give it to someone, set a
field). `flRuleBuild()` is the pure half the preview and the save both
read; `flRuleProblem()` names what an empty rule still needs. Rules for
every kind of work show in the lane too, tagged. Approved is not
finished: a route's target list ends with "Someone else", which adds a
step right after this one and points the rule at it (`flAddAfter`),
the "Otherwise → Done" line offers the same, and the fourth ready-made
shape is "…approves it and hands it to someone else" - Approve goes to
a third step with nobody guessed into it, so the card says "Nobody
chosen" until the owner picks. The status chips are labelled for what
they are: the status the work shows WHILE it sits at that step
(`hoStatus` copies the active stop's `status` onto the item); steps
move work, statuses only describe it.

Tenth piece: **task review and reviewed quality**, `js/rating.js`
(pure: the math, the words, what a review IS) + `js/reviews.js` (the
writes, the sheets, the Reviews & Feedback page, the live watch) +
`css/reviews.css`, and the "Team performance" panel on the admin home
(`amQualityHTML()` in `js/admin.js`). The flow: a person presses
**Submit for review** on a card (a link and/or a handoff note, judged
against the deadline on THEIR clock at submission - `rvDueAt`, stored,
never recomputed); the reviewer opens it from Needs your review (admin
home or the Reviews page) and sees the brief, the submission, the
person and the task together, then either **Request changes** (feedback
required) or **Approve & rate** (three whole scores 1..5 AND feedback,
the form showing the rubric word and an example under each point); the
person is told, reads it on the card or the page, and after changes
**submits a revision**. An approval is the go-ahead, not the finish: the
card's Done button reads "Pass on · approved" and the block names it,
so the next action is explicit and the run/assignment is never touched
by the review. ONE document per contribution at
`orgs/{orgId}/reviews/{itemId}:{nodeId|work}:{aboutUid}` (`rvKey`):
parallel steps and co-assignees are separate documents; every round of
one contribution lives in that document, the closed rounds in `history`
in order and never rewritten, so four rounds are one rating with
`revisions: 3`. A step re-entered by a loop is a new pass
(`handoff.stop.iteration`), and an approval given to an earlier pass is
`stale` - offered a fresh submission, never reused. The math, once:
`weightedTenths = q×5 + b×3 + h×2`, a contribution is tenths ÷ 10, a
person is the mean of their approved contributions' tenths ÷ 10, full
precision inside and two places on screen. Filters: This week (Monday
start) / This month / All time, role, work type - a member with no role
is "No role", never invented into one. Ranked from `RT_MIN_REVIEWS` (8)
in the chosen period ("Building data · 3 of 8", a starting line, not a
proof); every percentage carries its count; "on time" is only over work
that had a deadline; unreviewed work is nothing, never zero; hours never
enter it. Who decides: the owner, a role granted `review:decide:org`
(the seeded Manager, the packs' manager and lead), or the teammate an
owner names on the document (`reviewerUid`) - never the person, who
also cannot choose their reviewer or touch a score. A step marked
`rates` still rates the work it received, through `rvRecordFromStep()`,
into the SAME document a submission would use, and now refuses without
feedback. Every write is a transaction that checks the state the screen
showed (`version`), so two decisions on one submission end in "changed",
not a silent overwrite; `firestore.rules` holds the same line from the
server side - version +1, history prefix immutable and the closed round
exactly what it replaces, valid integer scores with the exact tenths,
the decider's own name, no self-rating, delegation pinned to one field.
Said plainly: the RATING data is server-protected; which step the work
is on is still the browser-side item engine under the permissive
items/runs rules the platform spec documents. `tests/rating.test.mjs`
pins the math and the filters; `tests/flow.test.mjs` walks submit,
changes, resubmit, delegate, approve, complete, the loop and parallel
steps against the fake database; `tests/reviews.test.mjs` draws the
card, the sheets and the page in jsdom (including escaping);
`tests/firestore-rules.test.mjs` holds the transitions; `tests/admin.test.mjs`
draws the board; `npm run shots` photographs all of it at 1920 and 390.

**A track can branch, and it is still the engine's own blueprint.** A
stop may carry `choices` (what the person picks when they finish -
Approve / Send back), `routes` (`[{ when, to }]`, first match wins:
`when` reads a choice or a field on the work, `to` is another stop's
`id` or `"done"`; the list order is the "otherwise") and `together`
(runs at the same time as the stop before it; consecutive ones form a
group and the stop after the group waits for all of them). Stops carry
stable `id`s for this - `hoStopIds()` gives legacy tracks theirs from
their position - because a route names the stop it goes to and "step 3"
stops being step 3 when a card is dragged. `hoBuildBlueprint()` compiles
a choice into a declared output (`choice`, so the engine refuses to
finish the stop without one), routes into a `route` split with an else
branch, a group into a `parallel` split whose members all point at the
next entry (two incoming lines IS the engine's merge). Loops are just a
route that points backwards; the engine's arrival bookkeeping makes a
re-entry a fresh iteration. `hoAfter()` follows the graph the way the
engine will, and `hoSummary()` puts `stop.choices` (each with where it
sends the work) and `next.also` (steps that start together) on the
Item, so the deck's finish sheet and the Work page ask for the decision
before the note; `itemsFinishFromQueue(id, comment, output)` carries it
and the engine's refusal comes back as `needs-choice`. The Organization
sheet cannot draw any of this and KEEPS it on read-back
(`Object.assign` over the draft), saying what the builder set. Every
branch shape runs through the real engine in `tests/handoff.test.mjs`
and end to end in `tests/flow.test.mjs`.

**Work travels with its note.** The composer speaks work types
(`cxKind`, the KIND row): a Task is the classic assignment, any other
kind is an Item of that kind made by `itemsCreateFromComposer()`. A kind
with a track takes no people — creation starts its run and the first
stop's holders get it, which is what the track is for; the composer
shows the track (VIA) in place of TO. The composer's brief, store and
sender ride on the Item top-level (`brief`, `store`, `fromName`), because
a kind's fields may have no slot for them. On every run sync
`hoSummary()` copies the hand-off onto the Item as `handoff` — which stop
(n of N), who passed it and the note they wrote (the finish comment,
which the run has recorded as `output.comment` since the first build),
and who is next — so the deck reads it without reading the run. The card
draws it, Done reads "Pass on" (or "Finish" at the last stop), the Done
sheet is "Pass it on" naming the next people and asking for a note, and
the next person's "assigned to you" notification carries the note.
`tests/flow.test.mjs` walks the whole of it. On screen a stop is a **step**,
everywhere - the editor (`orgTrackRender()`, every control labelled, a
blank track offered two ready-made shapes, the line read back as one
sentence by `hoDescribe()`), the deck, the composer and the Work page;
the code keeps `track` and `stop`. `docs/lessons.md` > "A control with
no label" says why.

**A temporary testing aid lives on the Organization page**: "Reset this
organization to fresh" (`orgResetOrg()` → `itemsResetOrg()`), owner-only,
two taps, then a reload. It deletes every kind of work, track, rule,
custom role and all work and runs, puts the seed roles back as seeded,
keeps every seat (reseating anyone in a deleted role as Staff) and never
touches the event log. The owner asked for it on 2026-09-12 to test by
hand; it is meant to come out once that testing is over, and
`tests/flow.test.mjs` proves exactly what it does and does not delete
until then.

The deck reads the shift as well as the queue — the Running pill, Paused ·
23m, and whether the left button says Start task or Put down — but it is
only DRAWN when the assignments snapshot fires. `dkRefresh()` is the
redraw for the other half, and `render()` is its one caller.

The rings are deliberately NOT affected. They keep their fixed 8h lap
because they answer "how long have you been at it", not "how much of
your day is left" — two different questions, and one of them is the
bar's.

## Deploys

**Standing approval to merge.** The owner has said, in as many words, to
stop asking every time. So: work on the feature branch, and once the full
suite passes locally, merge to `main` and push without waiting. Report
what shipped rather than requesting permission.

Three things still get asked first, because they are not the same kind of
decision: anything **destructive or irreversible** (deleting live data,
rewriting history, force-pushing); anything that is a **judgment call
about the business** rather than the code (who may sign up, what a
customer is charged); and **any merge whose tests do not pass** — a red
suite is not a thing to seek permission for, it is a thing to fix.

- **App**: GitHub Pages serves the repo directly. Push to `main` ships it.
  There is no build step to wait for — only the browser cache, which is
  what rule 2 is about.
- **Firestore rules + indexes**: `.github/workflows/deploy-rules.yml` ships
  them on any push to `main` that touches `firestore.rules` or
  `firestore.indexes.json` — but only after the 304-assertion suite passes
  against the edited rules. Never paste rules into the Firebase console by
  hand; the console and the repo drift apart the moment you do, and the
  repo is the version that gets tested.

## Keys in `js/config.js`

The Firebase `apiKey` and the EmailJS `publicKey` are **meant** to be
public — they identify the project, they don't authorize anything. What
actually protects them is elsewhere and must stay in place:

- Firestore rules (in this repo, tested) are what stop unauthorized reads
  and writes. The API key is not a secret and never was.
- EmailJS quota is protected by the domain allowlist in
  EmailJS → Account → Security, not by hiding the key.

A real secret — a service account, a private key — must never land in this
repo. Those belong in GitHub Actions secrets.
