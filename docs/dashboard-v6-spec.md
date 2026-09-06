# Dashboard v6 — the task deck, and what it does to the clock

> **Status:** the redesign is the DEFAULT dashboard as of this writing,
> at the owner's instruction and against my recommendation to wait for
> the three-column layout and the real card. What is live is five pieces
> on the OLD layout. `?ui=classic` is the way back and
> `UI_NEXT_DEFAULT` in `js/config.js` flips it wholesale.

The prototype (`ezdashboardv6switcher.html`) replaces the Figma frame
`142:1102` as the design of record. This file is the part a mock cannot
carry: what the app must DO, and which of its existing guarantees change.

Written before the code, same as `docs/platform-spec.md` and
`docs/handoff-spec.md`. Anything below marked **OPEN** is a decision
still owed; everything else is settled and answerable from this file.

---

## 1. The shift invariant, restated

This is the load-bearing change and the reason the spec exists. Today
`js/config.js` states:

> While ACTIVE, exactly one open seg. While ON_BREAK, none.
> Therefore `sum(segs) === net working time`, always.

That holds only because every second of a shift belongs to a task. The
new dashboard breaks that: finishing a task leaves somebody clocked in
with nothing running, and the comp draws that time in its own colour.

**The new statement:**

> A segment is either a TASK segment (`itemId` and `task` set) or an
> IDLE segment (`task: null`).
> While ACTIVE, exactly one open segment, of either kind.
> While ON_BREAK, none.
> Therefore `sum(all segs) === net working time`, and
> `sum(task segs) === time actually spent on work`. The difference is
> idle — clocked in, nothing running.

The old invariant survives word for word if "segs" is read as *all*
segments, which is what makes this a generalisation rather than a
replacement: `netMs()`, `breakMs()` and the shift clock are untouched.

Three kinds of time, and the bar's three colours:

| On the bar | What it is | Where it comes from |
|---|---|---|
| white | working a task | task segments |
| grey | clocked in, no task running | idle segments |
| black | on a break | `breaks[]` |
| track | not yet worked | the remainder of the scheduled shift |

**The shift clock does not change.** It counts elapsed minus breaks, so
idle time still counts as being at work — because it is. The TASK clock
is the one that distinguishes them.

**OPEN 1** — does idle time count toward the scheduled shift, so that
sitting idle for an hour brings the 6h target an hour closer? Assumed
YES below, because the shift clock already counts it and two answers to
one question is how screens start disagreeing.

## 2. Segments carry the work they belong to

`segs[]` entries gain `itemId` — the Item the segment was worked
against, or `null` for idle. `task` stays as the human-readable name so
closed shifts already in `S.history` keep rendering exactly as they do.

`via` gains three values: `"task"` (started from a card), `"pickup"`
(resumed from the paused row), `"idle"` (nothing running). The existing
`"start" | "switch" | "resume"` keep their meanings.

Nothing is written that is not read: `itemId` is what the per-task
accumulation in §4 sums by, and the tests must prove it survives a
save-and-reload rather than only existing in memory.

## 3. Start task

`Start task` on the card for Item X, by current status:

| Status | What happens |
|---|---|
| IDLE (clocked out) | Clock in AND open a task segment for X. **No sheet.** The store comes from the card, and the task from the card, because the assigner already chose both — a copywriter opening a copy task should not be asked what they are about to do. |
| ACTIVE, on another task | Close that segment (it becomes PAUSED, §4) and open one for X. |
| ACTIVE, already on X | Nothing. The card shows it is running rather than offering to start it again. |
| ON_BREAK | End the break and open a task segment for X, in one press. |

## 4. Paused tasks, and the row under the dock

A task is **paused** when it has at least one closed segment in this
shift, is not the open one, and is not finished.

Its time is the SUM of its segments in this shift, found by `itemId` —
not a counter kept on the side. A running total stored separately is a
second copy of a fact the segments already carry, and the two drift the
first time a save fails.

The row of chips under the dock — what the comp calls "pick up where you
left off" — is that list. Each chip is the task's own name and its
accumulated time (`Design review · 23m`), so the row changes as the day
does. Pressing one opens a fresh segment for that task.

**The task clock therefore shows the ACCUMULATED time of the open task,
not the length of the open segment.** Somebody who worked 23 minutes,
switched away and came back sees 23m and counting, which is the whole
point of the feature. `taskClockMs()` changes accordingly, and its
existing comment — which warns against summing EVERY segment, since that
would reproduce the shift clock — still stands: this sums one task's
segments, not all of them.

With no paused tasks the row is not drawn. It is not a permanent button.

## 4a. The card's two buttons, and the pair that changes

The footer holds two buttons, and the LEFT one swaps once the work is
running:

| Card state | Left button | Right button |
|---|---|---|
| not started | **Start task** | **Done** |
| running (this task holds the clock) | **Send back** | **Done** |

That is what makes Send back reachable without a third button: you start
the work, read it, find the copy wrong, and send it back to whoever had
it before you. It is deliberately not offered before starting — sending
work back you have not opened is a guess.

A card whose task is PAUSED (started, then another task started over it)
shows **Start task** again, because pressing it is how you come back to
it — the same act the paused row under the dock performs.

## 5. Done

`Done` on a card does what finishing already does — routes by what the
row IS: a plain assignment closes, a handoff advances to the next stop,
untracked work takes its type's done status. None of that changes.

What is added: the open task segment closes and an IDLE segment opens.
The task clock resets to zero and begins counting idle time, which paints
grey. The card leaves the deck.

## 6. The scrubber

One track, whose own background is the time not yet worked. Segments
laid out as percentages, left to right, in the order they happened.

**Overtime shrinks the scheduled part rather than overflowing.** At 7h
worked on a 6h shift the bar stays the same width: the scheduled 6h now
occupies six sevenths of it and overtime the last seventh, and overtime
keeps growing and squeezing as the day runs on.

A 2px divider marks where the TASK changed between two adjacent worked
stretches. Hovering the track dims every segment except the one under
the cursor, and each carries its own tooltip:
`Copy pass · 10:50–12:20 · 1h 30m`.

## 7. Who may set the shift length

The sign-in page asks, before anything else, whether this is for
**personal** use or for a **team**. That answer is stored on the account
(`users/{uid}.accountType`, `"personal" | "team"`) and decides two
things:

- **personal** — a plain clock. They set their own shift length. No
  workflows, no automations, no org. They still get the deck: **they
  assign work to themselves**, which is the whole product for a student
  tracking their own assignments. So the right column is not empty for
  them and is not hidden — it is a deck they fill.
- **team** — they name their organization and its size, and pay for it.
  Their shift length is set by an owner, or by a role holding
  `member:hours` (§ CLAUDE.md). **An employee cannot set their own**,
  which is the whole reason the field is delegated rather than personal.

That completes the rule already shipped: `orgs/{orgId}/members/{uid}
.shiftMinutes` stays exactly as it is for teams, and a personal account
keeps its own length on itself, since it has no org to hang it from.

**OPEN 2** — pricing, tiers and the payment step are named in the brief
and are not specified here. Nothing below assumes them.

## 8. Attachments

Work carries files as it moves. The chain that matters:

> Pz assigns → Prashanna attaches the direction doc → Chokki writes the
> copy and attaches it → the designer receives the task WITH both →
> the embedder receives it with all three.

So attachments live on the **Item**, accumulate, and travel with it.
Everyone in the chain sees everything attached before them.

**Two phases, and the first needs no infrastructure:**

1. **Links.** A pasted URL with a title, who added it, and when. Figma,
   Docs, Notion, anything. No storage, no bucket, no console change.
2. **Uploads.** Real files. Needs Firebase Storage switched on in the
   console, which is the owner's action, not something this repo can do.
   Rules for it get written and tested the way `firestore.rules` is —
   scoped so one org's files are unreachable from another.

**Removal: you may remove what you attached, and nothing else.** A
designer who finds the copy wrong does not delete the copywriter's file;
they **send it back**, which returns the work to the previous person in
the line. That already exists as the campaign's Send back. Letting
whoever holds the work delete anything would make the trail editable by
the last person to touch it, which is the opposite of what it is for.

## 8a. Opening an attachment

Clicking one opens it **inline, in place** — a preview over the deck,
the way Arc or ClickUp does it — with an explicit "open in new tab"
control inside that preview. Not a bare new-tab jump: the point of the
chain is that the designer reads the copywriter's file without leaving
the card that carries it.

Inline preview is easy for an image and a PDF, and impossible for a
Figma or Notion URL, which refuse to be framed. So a link whose target
cannot be embedded shows what it is and opens in a new tab, and says
that is what it will do rather than presenting a preview that will not
come.

## 9. The checklist

A card's brief can carry a checklist: `[{ text, done, byUid, atMs }]` on
the Item. Ticking saves for everybody, and records who ticked it.

**OPEN 3** — who WRITES the items? Assumed: whoever creates or assigns
the work, on the same screen where they write the brief. If instead the
holder should be able to add their own steps, that is a different
screen and worth saying so.

## 10. Layout

Three columns: `104px rail | 1.32fr hero | 0.78fr work`, becoming
`116px | 1fr | 580px` above 1700px, and stacking to two columns with the
deck full-width below 1240px.

The **Daily Mission card leaves the dashboard.** Its page stays, on the
rail. The middle column is one flex stack: wordmark, rule, name, state,
week strip, mode pills, rings, the big button, the paused-task row, and
the scrubber. The right column is the deck, bare on the stone — no
panel behind it.

Rail: Home, Mission, History, **Links** (not "Camps"), Team, Flows, and
Work — which the comp omits but which staff can reach today, and which
`js/rail.js` keeps by mirroring the drawer rather than deciding for
itself.

## 11. The deck

An iOS app-switcher: cards stacked in 3D, neighbours rotated away and
pushed back, travel compressing so it never runs off the edge however
many tasks there are.

Moved by **drag** (with velocity and a spring settle), by the **wheel**
one card per notch, by the arrows, by the arrow keys, and by the dots.
Both drag and wheel, not one or the other.

The card: store pill, a green due pill or a red overdue one, title,
who assigned it and when, then a scrolling body of blocks — Brief,
checklist, Attached — and two buttons: **Start task** and **Done**.

The counts above it follow the Figma: a sentence,
`3 tasks · ● 1 overdue · 1 due today`, with the red dot on the overdue
count only.

**The empty deck is a card, not an absence.** With nothing assigned the
stack holds one card reading "No tasks assigned" — so the column keeps
its shape rather than collapsing. It still has to distinguish "nothing
assigned" from "could not reach your organization", which is the
distinction §1 of docs/lessons.md exists for.

## 12a. One mechanism: the whole app is a chain of stages

The decision that collapses four things into one.

> A company sets up a chain of stages once. Anyone with permission to
> assign creates work. The work moves along those stages by itself.

There is no separate Campaigns product in that sentence, and there does
not need to be one in the app. **The Campaigns page goes.** Its idea —
work that passes person to person — is not lost; it is the whole model
now, and it is the model the org already has:

- A **work type** carries a **track**: an ordered line of stops, each
  held by a role (`js/handoff.js`, `docs/handoff-spec.md`).
- Creating work of a tracked type **starts its run**.
- Whoever holds the current stop sees that work on their deck.
- Finishing hands it to the next stop. There is nothing else to press.

So the dashboard is not "the home page beside a campaign page". It is
the campaign page, for the one person looking at it — their stops, one
card at a time.

**What this deletes from the card.** The four kinds the deck carries
today (a plain assignment, a campaign baton, a workflow stop, orphaned
work) stop being four kinds:

| Was | Is now |
|---|---|
| `Done` on an assignment | **Done** — finish my stage |
| `Pass forward` on a baton | **Done** — same act, same button |
| `Send back` on a baton | **Send back** — §4a, the left button while running |
| `Open` on a baton | the card IS the detail; nothing to open |
| `Work this stop` on a workflow stop | **Start task**, then **Done** |

Work with no track behind it still exists — a one-off nobody chains —
and Done simply closes it, because there is no next stop to hand it to.
That is the same button doing the same thing with a shorter chain, not a
second kind of work.

**Orphaned work stays the exception**, and keeps its no-button card: its
type was deleted, so there is no track to move along and no status to
take. Saying so is the whole content of that card.

**Decided: cut, not migrate.** No conversion of existing campaigns into
tracked work. Two things that decision does NOT mean, and both matter:

1. **Nothing is deleted.** "Cut" is a decision about where effort goes,
   not an instruction to destroy data. The `campaigns` collection, its
   documents and its rules stay exactly where they are. The page stops
   being reachable; the rows keep existing, and a future session with a
   reason can still read them.
2. **The cut follows the replacement — it does not lead it.** Hiding
   Campaigns today would take the baton page away from a team whose
   replacement is not built yet, mid-flight, for no gain. So the page is
   hidden **under `ui-next` only**: the new dashboard has no Campaigns,
   the classic one keeps it, and the last of it goes when the flag does.
   That is the same discipline the whole redesign runs on and it costs
   nothing to honour here.

## 12b. Links — the rail's fourth seat

The slot that was Campaigns becomes **Links**: where an organization
connects the outside tools its work already leans on. Proposed here
rather than instructed, so treat this section as a proposal.

**Why it belongs in this app at all.** Every card in the deck carries
attachments, and those attachments are mostly other people's tools — a
Figma file, a Google Doc, a Notion page. Today a pasted URL is a string.
Links is what turns it into a thing with a name and an icon, and later
into a thing that can act.

`orgs/{orgId}/connections/{id}` — org-scoped like everything else, so
one company's connections cannot be seen by another.

**Three phases, deliberately in this order, because the value arrives
before the risk does.**

1. **Recognition.** A connection maps a domain to a name and an icon:
   `figma.com` → Figma, `docs.google.com` → Google Docs. No credentials,
   no network, no secrets. It makes every attachment row in the deck
   read properly and is worth shipping on its own.
2. **Notifying out.** A connection holds a webhook — Slack, Discord, a
   WhatsApp bridge — and work arriving at somebody's stop can announce
   itself where that team actually looks. The app already notifies
   in-app and by email; this is the same event reaching one more place.
   A webhook URL IS a credential, so it goes in behind the same rule
   as §3 below.
3. **AI and apps that act.** A connection to a model or a service that
   an automation rule can call — summarise this brief, draft this copy.
   Last, because it is the only one that needs secrets held properly.

**The constraint that decides the order.** A customer's API key or
webhook URL must never sit in a document every member of the org can
read, and must never reach the browser. Firestore rules cannot hide a
field from a reader who is allowed the document. So anything holding a
credential is written through a Cloud Function and read only by one —
the client sees that a connection EXISTS and what it is called, never
what it holds. Phase 1 needs none of that, which is exactly why it is
phase 1.

## 13. Measurements

Read out of the Figma file `WvOrne82eXwKCeBk7MaQCV`, frame `1:2152`
(1920×1080), rather than scaled off a picture. Where the prototype and
the file disagree, the file wins — it is the later artifact.

**The three columns.** `116 | 1184 | 620`. The prototype's fractional
grid lands within a few pixels of this at 1920, so the fractions stay
for other widths and these are what 1920 must produce.

**Rail** (116 wide). Badge 44×44 at y28. Nav items 44 wide, 61 tall,
81 apart, icons 21×21, label 15 tall beneath. The active item carries a
3×34 bar on the left edge. Avatar 36×36 and a 28×28 sign-out at y968.

**Middle** (1184, 48px inset both sides → 1088 of content).
Brand block 113.5 tall: wordmark 43, a 360×3 rule under it, the name row
22.5, then the status line. Week row 80 tall: the hours block 100.6
wide on the left, seven 52-wide bars 63 apart in the centre (tallest 58),
the streak pill 124.3×35 on the right.
Hero: pill switcher 307×43, two 232px rings 288 apart (8px stroke), the
CLOCK IN button **520×98**, then the chips row 450.8 wide.
Scrubber block 109 tall at y939: title row, a **34px** bar, then
timestamps and legend.

**Right panel** (620 wide, 32px inset → 556 of content).
Header 63.5 tall: "YOUR WORK" 25 tall, two 38×38 round arrow buttons at
the top right. Subtitle row underneath.
The stack: **front card 470×840**, flat and centred at x43. Behind it a
left card 367×743 at x0.2/y85.6 and a right card 367×652 at x191/y131 —
different sizes and offsets, which is the perspective doing the work
rather than a uniform stack.
Card interior: 25px padding, 420 of content. Store pill 105.9×27.3 and
the due pill 95×27 on the top row; title 28 tall; sub-meta 20; hairline
dividers; BRIEF; a checklist of 19.5-tall rows with 18×18 boxes 30px
from their text; ATTACHED with 40.75-tall file rows.
Footer: **START TASK 304×52** beside **DONE 104×52**, 12px apart.
Pagination under the stack: a 26×6 pill for the current card, then 6×6
dots.

**Three places the file and your instructions differ**, resolved your
way because you said so after the file was made:

- The rail reads **CAMPS**; you said use **Links**. Links.
- The rail has six items and no **Work**; you said keep everything.
  Work stays.
- The subtitle is a sentence — `3 tasks · ● 1 overdue · 1 due today` —
  with a single red dot on the overdue count, where the live app draws
  three coloured pips. The sentence is what gets built, since it is the
  newer drawing, and the one dot keeps the colour you asked to keep.

## 12. What this does NOT change

The rings. They keep their fixed 8h and 1h laps and their second-lap
fill. They answer "how long have you been at it", and the bar answers
"how much of the day is left" — two questions, and only one of them
belongs to the schedule.
