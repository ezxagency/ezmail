# Dashboard v6 — the task deck, and what it does to the clock

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
  workflows, no automations, no org.
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

The counts above it stay as the three coloured pips the app already
draws (`0 open`, `2 overdue`, `0 due today`), not a plain sentence.

## 12. What this does NOT change

The rings. They keep their fixed 8h and 1h laps and their second-lap
fill. They answer "how long have you been at it", and the bar answers
"how much of the day is left" — two questions, and only one of them
belongs to the schedule.
