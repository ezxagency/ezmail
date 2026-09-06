# Handoff — work that moves person to person

Status: **built.** `js/handoff.js` (28 assertions), org-scoped runs in
`firestore.rules` (10), the track editor and the baton on the Work page
(10 in jsdom). What is NOT built is listed at the bottom.

Companion to `docs/platform-spec.md` (the Item model) and
`docs/workflow-builder-spec.md` (the engine, which does not change).

---

## The gap this closes

> "the work has to be sent over people and they should do the work and
> pass on to the next person"

That is not what the app does today. Putting three people on an Item means
*these three are on it* — all at once, all seeing the same screen, nobody
holding it. Status moves only because a human picks a new one from a
dropdown. **Assignees are a list, not a queue.**

Meanwhile a complete baton-pass engine already exists in
`js/workflow-engine.js`: blueprints with role stops, runs, per-stop
completion, conditions, merges, multi-owner approval. It works. It is
simply not connected to work.

The connection was designed and never built. Both halves are already in
the data, written as `null` and read by nothing:

| field | on | meant to hold |
|---|---|---|
| `workflowId` | ItemType | which blueprint this kind of work rides |
| `workflowRunId` | Item | the run this particular piece is on |
| `taskId` | Run | the Item the run is about |

Three null pointers is the entire gap.

---

## The shape

An ItemType may name a blueprint. Creating an Item of that type starts a
run of it. The run's active role stops decide **who holds the work right
now**. Completing a stop advances the baton, tells whoever is next, and
moves the Item's status with it.

```
Sponsorship created
  └─ run starts, first stop is ROLE[Producer]
       Item: status "talking", assigned to the Producers, "with you"
     Producer marks their stop done
  └─ engine advances, next stop is ROLE[Editor]
       Item: status "agreed", assigned to the Editors, they are told
     ...
  └─ last stop completes → run-completed → Item reaches its final status
```

---

## Six decisions, and why

### 1. The run drives the status. Not the reverse.

A blueprint node may declare a `status`. Arriving at that node sets the
Item's status. A node that declares none leaves the status alone.

**While a run is active, the status dropdown is read-only.** Two ways to
move the same work is two sources of truth, and they will disagree — on a
Tuesday, in front of a customer. The blueprint is the truth about where
the work is; the status is how that truth is spelled in this type's own
vocabulary.

Rejected: keeping status independent. It reads as freedom and is actually
a promise the app cannot keep.

### 2. `assigneeIds` becomes derived, not typed.

While a run is active, an Item's assignees ARE the people holding its
active stops. Not hand-edited.

This is the decision that fixes the reported confusion. "Assigned to me"
starts meaning **it is my turn**, which is what everyone already assumes
it means. Three things then work for free:

- the assigned-work list already queries `facets: assignee:<uid>`
- the "you have been handed work" notification already fires on the
  assignee change
- "who has this?" stops being a question anyone has to ask

When no run is active — an Item of a type with no blueprint — assignees
stay hand-edited exactly as now. Both modes, one field.

### 3. Only the holder advances it. And an owner, always.

You may complete a stop if you hold the role it is assigned to. An org
owner may complete any stop, because work gets stuck for reasons no
model predicts and somebody has to be able to unstick it — but an owner
doing so is recorded as an override in the event log, not disguised as
the holder having done it.

Everyone else with `item:update` may still edit the Item's fields. Editing
the work and advancing the work are different powers, and conflating them
is what makes a baton meaningless.

### 4. Runs move under the org.

Today `runs` and `nodeRuns` are top-level and gated on `isTeam()` — Ez
Agency's own pre-tenancy collections. A customer's run cannot live there.
They move to `orgs/{orgId}/runs` and `orgs/{orgId}/nodeRuns`, tenant-scoped
like everything else an org owns.

The existing top-level collections stay exactly as they are, still serving
the Workflows page for Ez Agency's own legacy runs. No migration, no
rewrite; the new path is additive, which is how tenancy was introduced in
the first place.

### 5. Advancing is a client transaction. No Cloud Function.

`wfAdvance()` is pure and deterministic — its own docstring says it is
built so the glue can run it inside a Firestore transaction and retry
safely. So: read run + nodeRuns, advance, write, in one transaction.

**This is not blocked on the billing problem.** It is the largest piece of
value still available without a server, which is why it should come before
anything that needs one.

### 6. The blueprint builder does not change.

Blueprints are drawn on the Workflows page as they are today. The open
canvas with drag-and-drop nodes is explicitly out of scope here and comes
after this works — a nicer way to draw a thing that already runs is worth
building; a nicer way to draw a thing that does not run is not.

---

## What a person sees

**Holding it.** The Item says *"Your turn"* and offers one control: mark
this stop done. If the node collects an output (approved yes/no), that is
the same control with a choice attached.

**Not holding it.** The Item says *"With Priya"*, or *"With the Editors"*
when the stop belongs to a role with several people and any of them may
take it.

**The trail.** Who held it, how long, what they answered — read from
`nodeRuns`, which already records exactly this and is currently shown to
nobody.

---

## The failure modes, designed for

Everything below is a way for this to fail *silently*, which is the only
kind of failure worth designing against in advance. This session has
already shipped two bugs of exactly this shape — a rule notifying a role
nobody could read, and assignment notifying nobody at all — and both were
found by a person using the app, not by anyone reading the code.

| what happens | why it is silent | the answer |
|---|---|---|
| A stop's role has nobody in it | The run stalls. No error, no holder, no notification — it simply stops. | Refuse to start a run whose first stop has no people, and surface a stalled run on the Organization page. A run with no holder is a visible fault, never a quiet one. |
| The holder leaves the org mid-run | Their seat is gone; the stop still names them. | The stop belongs to a ROLE, not a person, so removing somebody re-derives the holders. If that empties the role, it is the row above. |
| The blueprint is edited mid-run | Running work would change shape under people. | Already solved: runs carry a frozen `blueprintSnapshot`. Nothing to do, worth stating so nobody "fixes" it. |
| The Item is deleted mid-run | An orphan run advancing forever against nothing. | Deleting an Item cancels its run, in the same commit. |
| Two people complete the same stop at once | Last write wins, one person's answer vanishes. | The transaction in decision 5 makes the second one a no-op against the already-completed stop, and it says so rather than silently succeeding. |
| A run completes and nobody notices | The work is done and sits looking active. | `run-completed` sets the Item's final status and notifies whoever created it. |

---

## Open questions

Not blockers, but they change what gets built. Answers wanted before code.

1. **May a stop be reassigned to one specific person?** A role stop says
   "any Editor". Sometimes the answer is "Priya, specifically". Supporting
   it means a stop can carry an override assignee; not supporting it keeps
   roles as the only vocabulary. Recommendation: support it, because real
   teams do this constantly and the alternative is people inventing a role
   with one person in it.

2. **Can work go backwards?** A reviewer wanting changes is the commonest
   thing a pipeline does. The engine's LOGIC nodes can already branch on an
   output, so "approved? no → back to the writer" is expressible today
   without a new concept. Recommendation: use that, add nothing.

3. **What starts a run other than creating an Item?** A status reaching a
   value, an automation action, a person pressing start. Recommendation:
   creation only, at first. Every extra entrance is another way for two
   runs to exist for one Item.

4. **Does an Item on a run still allow field edits by anyone?** Probably
   yes — the person holding the baton is not the only person with facts to
   add. Flagged because it is the kind of thing that is obvious until the
   first argument about it.

---

## Build order

1. Runs under the org, rules and tests. Nothing user-visible.
2. The link: type names a blueprint, creation starts a run, `taskId` and
   `workflowRunId` point at each other. Still nothing visible.
3. Derived assignees and status. The Work page starts telling the truth.
4. The holder's control, and the trail.
5. Stalled-run surfacing, and the failure modes above.

Each step is shippable and none of them needs the server.


---

## What shipped, and what did not

**Shipped.** A track — a straight line of stops, each held by a role —
compiles to a real blueprint that `wfValidate()` accepts and `wfStartRun()`
runs. Creating work of a tracked type starts its run. Holders are derived
from current role membership on every read. Finishing a stop moves the work
on, tells whoever is next (through the same assignment notification any
handed work uses), and moves the status with it. The Work page shows whose
turn it is, one control if it is yours, and the trail of where it has been.
A stop nobody can act on is reported as **stuck**, by name, rather than
looking like work in progress.

**Decisions kept exactly as specced:** the run drives the status and the
assignees (both controls go read-only while a run is active); only the
holder advances, with an owner override recorded as an override; runs live
under the org; advancing is a client transaction, so none of this needed
the server.

**Not built.**

- **Named-person stops.** Open question 1 is still open — a stop names a
  role, not "Priya, specifically". `hoHolders()` already honours an explicit
  person if one is on the stop, so the data path exists; the editor does not
  offer it.
- **Backwards.** Open question 2 — a reviewer sending work back. The engine's
  LOGIC nodes can express it; a straight track cannot draw it.
- **Starting a run any other way** than creating the work.
- **A stuck run is only visible on the work itself.** The spec wanted stalled
  runs surfaced on the Organization page, where somebody would notice without
  opening anything. That is the most valuable of these four.
- **Packs ship no tracks yet.** Every pack could now carry one, which would
  make a template arrive as a working pipeline rather than a set of stages.
