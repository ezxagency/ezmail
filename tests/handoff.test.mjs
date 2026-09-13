/* Unit tests for ../js/handoff.js — pure, so plain node:
     node tests/handoff.test.mjs

   handoff.js reads nothing global except what it is handed, but the
   tests drive it through the REAL engine - wfValidate, wfStartRun,
   wfAdvance - because the whole claim of that file is that a track is
   a blueprint the existing engine runs, not a second workflow model.
   A test that mocked the engine would prove nothing about that. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const WF = require("../js/workflow-engine.js");
const H = require("../js/handoff.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};
const plain = v => JSON.parse(JSON.stringify(v));

const TYPE = { id: "sponsor", name: "Sponsorship" };
const TRACK = [
  { label: "Agree terms", roleId: "manager", status: "agreed" },
  { label: "Deliver", roleId: "staff", status: "delivered" }
];
const ROLES = ["owner", "manager", "staff"];
const STATUSES = ["talking", "agreed", "delivered", "paid"];
const MEMBERS = [{ uid: "u1", roleId: "manager" }, { uid: "u2", roleId: "staff" },
                 { uid: "u3", roleId: "staff" }, { uid: "u9", roleId: "owner" }];
const bp = H.hoBuildBlueprint(TYPE, TRACK, { id: "bp1", orgId: "o1", now: 1 });
const start = () => WF.wfStartRun({ blueprint: bp, runId: "r1", taskId: "i1", task: {}, orgId: "o1", now: 1 });
const finish = (st, at) => {
  const nr = H.hoActiveStops(st.nodeRuns)[0];
  return WF.wfAdvance({ run: st.run, nodeRuns: st.nodeRuns }, { type: "complete", nodeRunId: nr.id }, { now: at });
};

/* ---------- a track is a real blueprint ---------- */
T("a track validates against the real engine", () => {
  assert.deepEqual(plain(WF.wfValidate(bp)), []);
});
T("a one-stop track is still a workflow", () => {
  const one = H.hoBuildBlueprint(TYPE, [{ label: "Do it", roleId: "staff" }], { now: 1 });
  assert.deepEqual(plain(WF.wfValidate(one)), []);
});
T("an empty track is nothing, not a broken blueprint", () => {
  assert.equal(H.hoBuildBlueprint(TYPE, [], {}), null);
  assert.equal(H.hoBuildBlueprint(TYPE, null, {}), null);
});
T("the track is kept on the blueprint so the editor can show it back", () => {
  assert.deepEqual(plain(bp.track), plain(H.hoStopIds(TRACK)), "the track comes back with the ids the editors need");
});
T("a stop carries the status it means, which the engine ignores", () => {
  const s0 = bp.nodes.find(n => n.id === "s0");
  assert.equal(s0.config.status, "agreed");
  assert.equal(s0.config.role, "manager");
  // and the engine still validates it, which is the whole reason this works
  assert.deepEqual(plain(WF.wfValidate(bp)), []);
});

/* ---------- what is wrong with a track ---------- */
const errs = (track) => H.hoTrackErrors(track, ROLES, STATUSES).map(e => e.message).join(" | ");
T("a track with no stops is refused", () => {
  assert.match(errs([]), /at least one step/);
});
T("a stop needs a name and a holder", () => {
  assert.match(errs([{ label: "", roleId: "" }]), /needs a name/);
  assert.match(errs([{ label: "", roleId: "" }]), /Who does this step/);
});
/* ---------- the track as one sentence ---------- */
const NAMES = { manager: "Manager", staff: "Staff" };
T("a track reads back as one plain sentence, ending in done", () => {
  assert.equal(H.hoDescribe(TRACK, id => NAMES[id]), "Agree terms (Manager) \u2192 Deliver (Staff) \u2192 done");
});
T("an unfinished track is described honestly, not tidily", () => {
  // a step with no name is numbered and one with no role says so - the
  // preview has to show what is missing, or it is a sentence that lies
  assert.equal(H.hoDescribe([{ label: "", roleId: "" }], id => NAMES[id]), "Step 1 (nobody chosen yet) \u2192 done");
  assert.equal(H.hoDescribe([{ label: "Sign", roleId: H.HO_ANY, assignees: ["u1"] }], id => NAMES[id]),
    "Sign (anyone, 1 named) \u2192 done");
  assert.equal(H.hoDescribe([], id => NAMES[id]), "");
});

T("a stop cannot name a role the org does not have", () => {
  assert.match(errs([{ label: "X", roleId: "cfo" }]), /not a role in this organization/);
});
T("a stop cannot name a status the type does not have", () => {
  // a stop that silently changes nothing is the failure this catches
  assert.match(errs([{ label: "X", roleId: "staff", status: "archived" }]), /not a status this kind of work has/);
});
T("a stop may leave the status alone", () => {
  assert.equal(H.hoTrackErrors([{ label: "X", roleId: "staff" }], ROLES, STATUSES).length, 0);
});
T('"anyone" is a holder, not a missing one', () => {
  assert.equal(H.hoTrackErrors([{ label: "X", roleId: H.HO_ANY }], ROLES, STATUSES).length, 0);
});
T("every problem is reported, not just the first", () => {
  assert.ok(H.hoTrackErrors([{ label: "", roleId: "cfo" }], ROLES, STATUSES).length >= 2);
});
T("a straight line has a sane length limit", () => {
  const many = Array.from({ length: H.HO_MAX_STOPS + 1 }, (_, i) => ({ label: "S" + i, roleId: "staff" }));
  assert.match(errs(many), /more than 12 steps/);
});

/* ---------- the baton actually passes ---------- */
T("it starts with the first stop's role holding it", () => {
  const st = start();
  assert.deepEqual(H.hoHolders(bp, st.nodeRuns, MEMBERS), ["u1"]);
  assert.equal(H.hoStatus(bp, st.nodeRuns), "agreed");
});
T("finishing a stop moves it to the next role", () => {
  const st = finish(start(), 2);
  assert.deepEqual(H.hoHolders(bp, st.nodeRuns, MEMBERS), ["u2", "u3"]);
  assert.equal(H.hoStatus(bp, st.nodeRuns), "delivered");
  assert.equal(st.run.status, "running");
});
T("finishing the last stop completes the run and nobody holds it", () => {
  const st = finish(finish(start(), 2), 3);
  assert.deepEqual(H.hoHolders(bp, st.nodeRuns, MEMBERS), []);
  assert.equal(H.hoStatus(bp, st.nodeRuns), null);
  assert.equal(st.run.status, "completed");
});
T("holders are re-derived, never frozen", () => {
  // somebody who joins the role while the work is sitting there can act;
  // somebody who left cannot. That is the difference between a stop that
  // belongs to a role and one that belongs to whoever was in it.
  const st = finish(start(), 2);
  const later = [{ uid: "u2", roleId: "staff" }, { uid: "u7", roleId: "staff" }];
  assert.deepEqual(H.hoHolders(bp, st.nodeRuns, later), ["u2", "u7"]);
});

/* ---------- narrowing a stop to some of the role ---------- */
const NARROW = [{ label: "Outreach", roleId: "staff", assignees: ["u2"] }];
const nbp = H.hoBuildBlueprint(TYPE, NARROW, { id: "bp2", orgId: "o1", now: 1 });
const nstart = () => WF.wfStartRun({ blueprint: nbp, runId: "r2", taskId: "i2", task: {}, orgId: "o1", now: 1 });

T("a narrowed stop is held by only the people picked", () => {
  // u2 and u3 are both staff; only u2 was named
  assert.deepEqual(H.hoHolders(nbp, nstart().nodeRuns, MEMBERS), ["u2"]);
});
T("an unnarrowed stop is still held by the whole role", () => {
  assert.deepEqual(H.hoHolders(bp, finish(start(), 2).nodeRuns, MEMBERS), ["u2", "u3"]);
});
T("somebody who leaves the role stops holding it, without editing the track", () => {
  // this is why narrowing keeps the role rather than replacing it with a
  // list of names - a bare list would have kept them on it forever
  const moved = [{ uid: "u2", roleId: "manager" }, { uid: "u3", roleId: "staff" }];
  assert.deepEqual(H.hoHolders(nbp, nstart().nodeRuns, moved), []);
});
T("a narrowing nobody satisfies is a gap", () => {
  assert.equal(H.hoTrackGaps(NARROW, [{ uid: "u9", roleId: "staff" }]).length, 1);
  assert.equal(H.hoTrackGaps(NARROW, MEMBERS).length, 0);
});
T("the editor is told when a narrowing has gone stale", () => {
  const stale = H.hoTrackErrors(NARROW, ROLES, STATUSES, [{ uid: "u9", roleId: "staff" }]);
  assert.match(stale.map(e => e.message).join(" "), /Nobody you ticked is in that role/);
  assert.equal(H.hoTrackErrors(NARROW, ROLES, STATUSES, MEMBERS).length, 0);
});
T("only the named people may move it on", () => {
  const nr = H.hoActiveStops(nstart().nodeRuns)[0];
  assert.equal(H.hoMayAdvance(nbp, nr, "u2", MEMBERS, false).ok, true);
  assert.equal(H.hoMayAdvance(nbp, nr, "u3", MEMBERS, false).ok, false);  // staff, but not named
});
T("a narrowed track still compiles to a blueprint the engine accepts", () => {
  assert.deepEqual(plain(WF.wfValidate(nbp)), []);
});

/* ---------- who may move it ---------- */
const stopOf = st => H.hoActiveStops(st.nodeRuns)[0];
T("the holder may move it on", () => {
  assert.deepEqual(plain(H.hoMayAdvance(bp, stopOf(start()), "u1", MEMBERS, false)), { ok: true, as: "holder" });
});
T("somebody else may not, however senior their other role", () => {
  assert.equal(H.hoMayAdvance(bp, stopOf(start()), "u2", MEMBERS, false).ok, false);
});
T("an owner may always unstick it, and it is recorded as an override", () => {
  assert.deepEqual(plain(H.hoMayAdvance(bp, stopOf(start()), "u9", MEMBERS, true)), { ok: true, as: "override" });
});
T("a stop that is already finished cannot be finished again", () => {
  const st = finish(start(), 2);
  const done = st.nodeRuns.find(n => n.nodeId === "s0");
  assert.equal(H.hoMayAdvance(bp, done, "u1", MEMBERS, true).ok, false);
});
T("nobody signed in, nobody advances", () => {
  assert.equal(H.hoMayAdvance(bp, stopOf(start()), null, MEMBERS, true).ok, false);
});

/* ---------- the silent failure ---------- */
T("a stop whose role has nobody in it is STALLED, and says so", () => {
  // the run does not error - it simply stops, and looks exactly like work
  // in progress until somebody asks why nothing happened for a week
  const nobody = [{ uid: "u2", roleId: "staff" }];
  const st = start();
  assert.deepEqual(plain(H.hoStalled(bp, st.nodeRuns, nobody)),
    { nodeId: "s0", label: "Agree terms", role: "manager" });
});
T("a stop with somebody in its role is not stalled", () => {
  assert.equal(H.hoStalled(bp, start().nodeRuns, MEMBERS), null);
});
T("a finished run is not stalled - it is finished", () => {
  assert.equal(H.hoStalled(bp, finish(finish(start(), 2), 3).nodeRuns, []), null);
});

/* ---------- the gap, found before anything gets stuck ---------- */
T("a stop whose role has nobody is a gap", () => {
  const gaps = H.hoTrackGaps(TRACK, [{ uid: "u2", roleId: "staff" }]);
  assert.deepEqual(plain(gaps), [{ at: 0, label: "Agree terms", roleId: "manager" }]);
});
T("a fully staffed track has no gaps", () => {
  assert.deepEqual(H.hoTrackGaps(TRACK, MEMBERS), []);
});
T("every empty stop is named, not just the first", () => {
  assert.equal(H.hoTrackGaps(TRACK, []).length, 2);
});
T('"anyone" needs somebody to be the anyone', () => {
  const t = [{ label: "Do it", roleId: H.HO_ANY }];
  assert.equal(H.hoTrackGaps(t, []).length, 1);
  assert.equal(H.hoTrackGaps(t, MEMBERS).length, 0);
});
T("it finds the cause where hoStalled finds the casualty", () => {
  // the same fault, seen from configuration rather than from a stuck job -
  // and this one is visible before any work has been created at all
  const thin = [{ uid: "u2", roleId: "staff" }];
  assert.equal(H.hoTrackGaps(TRACK, thin)[0].label, "Agree terms");
  assert.equal(H.hoStalled(bp, start().nodeRuns, thin).label, "Agree terms");
});
T("no track, no gaps - and no crash", () => {
  assert.deepEqual(H.hoTrackGaps(null, MEMBERS), []);
  assert.deepEqual(H.hoTrackGaps([{ label: "x" }], MEMBERS), []);
});

/* ---------- late ---------- */
const DAY = H.HO_DAY;
T("no deadline, nothing to be late for", () => {
  assert.deepEqual(plain(H.hoLate(null, 100)), { due: false, late: false, msLate: 0 });
});
T("before the deadline it is due, not late", () => {
  const r = H.hoLate(1000, 400);
  assert.equal(r.due, true); assert.equal(r.late, false); assert.equal(r.msLeft, 600);
});
T("after it, late by exactly the overrun", () => {
  const r = H.hoLate(1000, 1600);
  assert.equal(r.late, true); assert.equal(r.msLate, 600);
});
T("a track with a budget makes the stop due", () => {
  const budgeted = H.hoBuildBlueprint(TYPE, [{ label: "Agree", roleId: "manager", dueAfter: 2 * DAY }], { now: 0 });
  const st = WF.wfStartRun({ blueprint: budgeted, runId: "r9", taskId: "i9", task: {}, orgId: "o1", now: 0 });
  const d = H.hoDue(budgeted, st.nodeRuns, DAY);
  assert.equal(d.dueAt, 2 * DAY);
  assert.equal(d.late, false);
  assert.equal(H.hoDue(budgeted, st.nodeRuns, 3 * DAY).late, true);
});
T("a stop with no budget is never late", () => {
  assert.equal(H.hoDue(bp, start().nodeRuns, 9e12).due, false);
});
T("a budget has to be a number of days above zero", () => {
  assert.match(errs([{ label: "X", roleId: "staff", dueAfter: 0 }]), /number above zero/);
  assert.match(errs([{ label: "X", roleId: "staff", dueAfter: "soon" }]), /number above zero/);
  assert.equal(H.hoTrackErrors([{ label: "X", roleId: "staff", dueAfter: DAY }], ROLES, STATUSES).length, 0);
  assert.equal(H.hoTrackErrors([{ label: "X", roleId: "staff" }], ROLES, STATUSES).length, 0);
});

/* ---------- chasing it, without chasing it to death ---------- */
T("late work with no deadline is not chased", () => {
  assert.equal(H.hoNeedsNudge({ dueAt: null }, 9e12), false);
});
T("work that is merely due is not chased", () => {
  assert.equal(H.hoNeedsNudge({ dueAt: 1000 }, 500), false);
});
T("late work never chased before is chased", () => {
  assert.equal(H.hoNeedsNudge({ dueAt: 1000 }, 2000), true);
});
T("...and not again until the gap has passed", () => {
  // anyone opening the app runs this, so without the stamp the same job
  // would be chased once per person per page load
  const now = 10 * DAY;
  assert.equal(H.hoNeedsNudge({ dueAt: 1000, nudgedAt: now - 1000 }, now), false);
  assert.equal(H.hoNeedsNudge({ dueAt: 1000, nudgedAt: now - DAY }, now), true);
});

/* ---------- the trail ---------- */
T("the trail records where it has been, oldest first", () => {
  const st = finish(finish(start(), 2), 3);
  const trail = H.hoTrail(bp, st.nodeRuns);
  assert.deepEqual(plain(trail.map(t => t.label)), ["Agree terms", "Deliver"]);
  assert.deepEqual(plain(trail.map(t => t.status)), ["completed", "completed"]);
  assert.deepEqual(plain(trail.map(t => t.role)), ["manager", "staff"]);
});
T("the trail says when an owner unstuck it, not that the holder did", () => {
  // an override and the holder acting are different facts, and a trail
  // that blurred them would be worth less than no trail
  const st = finish(start(), 2);
  st.nodeRuns.find(n => n.nodeId === "s0").completedBy = "u9";
  st.nodeRuns.find(n => n.nodeId === "s0").completedAs = "override";
  const leg = H.hoTrail(bp, st.nodeRuns)[0];
  assert.equal(leg.by, "u9");
  assert.equal(leg.as, "override");
});
T("the trail shows the stop in progress as in progress", () => {
  const trail = H.hoTrail(bp, start().nodeRuns);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].status, "in_progress");
});

/* ---------- nothing falls over on nothing ---------- */
T("no run, no answers, no crash", () => {
  assert.deepEqual(H.hoActiveStops(null), []);
  assert.deepEqual(H.hoHolders(bp, null, MEMBERS), []);
  assert.deepEqual(H.hoHolders(null, null, null), []);
  assert.equal(H.hoStatus(bp, null), null);
  assert.equal(H.hoStalled(bp, null, MEMBERS), null);
  assert.deepEqual(H.hoTrail(bp, null), []);
});

/* ---------- the summary a card reads ----------
   Where the work is, who passed it and what they wrote, who is next -
   copied onto the Item so the deck never reads the run. */
T("at the first stop: no one before, the next stop and its people named", () => {
  const st = start();
  const sum = H.hoSummary(bp, st.nodeRuns, MEMBERS, uid => ({ u1: "Mia", u2: "Sam", u3: "Ada" })[uid] || "", st.run);
  assert.equal(sum.stop.label, "Agree terms"); assert.equal(sum.stop.index, 1); assert.equal(sum.stop.count, 2);
  // the step's id and pass ride along: a review is keyed by them
  assert.equal(typeof sum.stop.nodeId, "string"); assert.equal(sum.stop.iteration, 1);
  assert.equal(sum.from, null);
  assert.equal(sum.next.label, "Deliver");
  assert.deepEqual(sum.next.holders.map(h => h.name), ["Sam", "Ada"]);
  assert.equal(sum.done, false);
});

T("after a pass with a note: from names the passer and carries the note; the last stop has no next", () => {
  const st = start();
  const nr = H.hoActiveStops(st.nodeRuns)[0];
  const next = WF.wfAdvance({ run: st.run, nodeRuns: st.nodeRuns },
    { type: "complete", nodeRunId: nr.id, output: { comment: "Terms are signed, go" }, by: "u1" }, { now: 5 });
  next.nodeRuns.forEach(x => { if (x.id === nr.id) { x.completedBy = "u1"; x.completedAs = "holder"; } });
  const sum = H.hoSummary(bp, next.nodeRuns, MEMBERS, uid => uid === "u1" ? "Mia" : "", next.run);
  assert.equal(sum.stop.label, "Deliver"); assert.equal(sum.stop.index, 2); assert.equal(sum.stop.count, 2); assert.equal(sum.stop.iteration, 1);
  assert.equal(sum.from.uid, "u1"); assert.equal(sum.from.name, "Mia");
  assert.equal(sum.from.note, "Terms are signed, go");
  assert.equal(sum.from.label, "Agree terms");
  assert.equal(sum.next, null, "the last stop should have nothing after it");
});

T("a narrowed next stop names only the people it is narrowed to; an empty one says so", () => {
  const bp2 = H.hoBuildBlueprint(TYPE, [{ label: "Outreach", roleId: "staff" }, { label: "Close", roleId: "staff", assignees: ["u2"] }], { id: "bp3", orgId: "o1", now: 1 });
  const st2 = WF.wfStartRun({ blueprint: bp2, runId: "r3", taskId: "i3", task: {}, orgId: "o1", now: 1 });
  const sum = H.hoSummary(bp2, st2.nodeRuns, MEMBERS, uid => uid, null);
  assert.ok(sum.next, "no next stop on the narrowed track");
  assert.deepEqual(sum.next.holders.map(h => h.uid), ["u2"], "u3 is staff too but was not named");
  const empty = H.hoSummary(bp, start().nodeRuns, [{ uid: "u1", roleId: "manager" }], uid => uid, null);
  assert.deepEqual(empty.next.holders, [], "nobody is staff, so the next stop has nobody");
});

T("a completed run is done, and still says who finished it", () => {
  let st = start();
  st = finish(st, 2); st = finish(st, 3);
  const sum = H.hoSummary(bp, st.nodeRuns, MEMBERS, uid => uid, st.run);
  assert.equal(sum.done, true);
  assert.equal(sum.stop, null);
  assert.equal(sum.from.label, "Deliver");
});

/* ---------- branching: if / otherwise, and stops that run together ----------
   Everything here runs through the REAL engine, because the claim is
   that a track with branches is still a blueprint it accepts and runs. */
const LOOP = [
  { id: "a", label: "Write the draft", roleId: "staff" },
  { id: "b", label: "Check it", roleId: "manager", choices: ["Approve", "Send back"],
    routes: [{ when: { kind: "choice", value: "Send back" }, to: "a" }] },
  { id: "c", label: "Publish", roleId: "staff" }
];
const loopBp = H.hoBuildBlueprint(TYPE, LOOP, { id: "bpL", orgId: "o1", now: 1 });
const startOn = (b, task) => WF.wfStartRun({ blueprint: b, runId: "rL", taskId: "iL", task: task || {}, orgId: "o1", now: 1 });
const finishWith = (b, st, output, which) => {
  const nr = H.hoActiveStops(st.nodeRuns)[which || 0];
  return WF.wfAdvance({ run: st.run, nodeRuns: st.nodeRuns }, { type: "complete", nodeRunId: nr.id, output: output || {} }, { now: 2 });
};
const where = (b, st) => H.hoActiveStops(st.nodeRuns).map(nr => b.nodes.find(n => n.id === nr.nodeId).config.label);

T("a step with a choice compiles to a route split the real engine accepts", () => {
  assert.deepEqual(plain(WF.wfValidate(loopBp)), []);
  const check = loopBp.nodes.find(n => n.id === "s1");
  assert.deepEqual(plain(check.config.choices), ["Approve", "Send back"]);
  assert.deepEqual(plain(check.config.outputs), [{ key: "choice", type: "text", label: "Decision" }]);
  const split = loopBp.nodes.find(n => n.type === "split");
  assert.equal(split.config.mode, "route");
  assert.equal(split.config.branches.filter(b => b.isElse).length, 1, "the list order is the otherwise");
});
T("Send back returns the work to the first step; Approve carries it on", () => {
  let st = startOn(loopBp);
  st = finishWith(loopBp, st, {});
  assert.deepEqual(where(loopBp, st), ["Check it"]);
  const back = finishWith(loopBp, st, { choice: "Send back" });
  assert.deepEqual(where(loopBp, back), ["Write the draft"], "Send back did not loop");
  const again = finishWith(loopBp, finishWith(loopBp, back, {}), { choice: "Approve" });
  assert.deepEqual(where(loopBp, again), ["Publish"]);
  assert.equal(finishWith(loopBp, again, {}).run.status, "completed");
});
T("a step that asks for a choice cannot be finished without one", () => {
  const st = finishWith(loopBp, startOn(loopBp), {});
  assert.throws(() => finishWith(loopBp, st, {}), /must record: choice/);
});
T("the summary offers each choice with where it sends the work", () => {
  const st = finishWith(loopBp, startOn(loopBp), {});
  const sum = H.hoSummary(loopBp, st.nodeRuns, MEMBERS, uid => uid, st.run);
  assert.deepEqual(plain(sum.stop.choices), [{ value: "Approve", to: "Publish", back: false }, { value: "Send back", to: "Write the draft", back: true }]);
  assert.equal(sum.next.label, "Publish", "next is the otherwise path");
});
T("a rule can read a field on the work, frozen when the run started", () => {
  const fast = [
    { id: "a", label: "Write", roleId: "staff", routes: [{ when: { kind: "field", key: "priority", op: "==", value: "urgent" }, to: "c" }] },
    { id: "b", label: "Review", roleId: "manager" },
    { id: "c", label: "Publish", roleId: "staff" }
  ];
  const b = H.hoBuildBlueprint(TYPE, fast, { id: "bpF", now: 1 });
  assert.deepEqual(plain(WF.wfValidate(b)), []);
  const urgent = finishWith(b, startOn(b, { fields: { priority: "urgent" } }), {});
  assert.deepEqual(where(b, urgent), ["Publish"], "urgent work did not skip the review");
  const normal = finishWith(b, startOn(b, { fields: { priority: "normal" } }), {});
  assert.deepEqual(where(b, normal), ["Review"]);
});
const PAR = [
  { id: "a", label: "Brief", roleId: "manager" },
  { id: "b", label: "Design", roleId: "staff", assignees: ["u2"] },
  { id: "c", label: "Copy", roleId: "staff", assignees: ["u3"], together: true },
  { id: "d", label: "Check", roleId: "manager" }
];
const parBp = H.hoBuildBlueprint(TYPE, PAR, { id: "bpP", now: 1 });
T("steps that run together start at once and the step after waits for both", () => {
  assert.deepEqual(plain(WF.wfValidate(parBp)), []);
  let st = finishWith(parBp, startOn(parBp), {});
  assert.deepEqual(where(parBp, st).sort(), ["Copy", "Design"]);
  assert.deepEqual(H.hoHolders(parBp, st.nodeRuns, MEMBERS).sort(), ["u2", "u3"], "both people hold it at once");
  st = finishWith(parBp, st, {}, 0);
  assert.deepEqual(where(parBp, st).length, 1, "the other branch is still open");
  st = finishWith(parBp, st, {}, 0);
  assert.deepEqual(where(parBp, st), ["Check"], "the merge did not fire after both finished");
});
T("the summary says the next steps run together", () => {
  const sum = H.hoSummary(parBp, startOn(parBp).nodeRuns, MEMBERS, uid => uid, null);
  assert.equal(sum.next.label, "Design");
  assert.deepEqual(plain(sum.next.also), ["Copy"]);
});
/* Reported 2026-09-13: two steps ran together, the owner held the second,
   and Submit for review said "this step is not with you". The summary
   named only the FIRST running step, so every screen offered the owner
   somebody else's step. */
T("while steps run together the summary carries every running step, each with its holders", () => {
  const st = finishWith(parBp, startOn(parBp), {});
  const sum = H.hoSummary(parBp, st.nodeRuns, MEMBERS, uid => ({ u2: "Sam", u3: "Ada" })[uid] || "", null);
  assert.equal(sum.stop.label, "Design", "the first running step is still `stop`, for every older reader");
  assert.deepEqual(plain(sum.stops).map(x => [x.label, x.nodeId, x.index, x.iteration, x.holders.map(h => h.uid + ":" + h.name).join(",")]),
    [["Design", "s1", 2, 1, "u2:Sam"], ["Copy", "s2", 3, 1, "u3:Ada"]]);
  assert.deepEqual(plain(sum.stop.holders), [{ uid: "u2", name: "Sam" }], "the first step does not say who holds it");
  assert.equal(sum.next.label, "Check", "the step after the group is what both pass to");
  // one running step: `stops` is that one, so a reader never special-cases it
  const one = H.hoSummary(parBp, startOn(parBp).nodeRuns, MEMBERS, uid => uid, null);
  assert.deepEqual(plain(one.stops).map(x => x.nodeId), ["s0"]);
  assert.deepEqual(plain(one.stops[0].holders).map(h => h.uid), ["u1"]);
});
T("hoMyStop gives each person the running step THEY hold, and the first to anyone else", () => {
  const st = finishWith(parBp, startOn(parBp), {});
  const sum = plain(H.hoSummary(parBp, st.nodeRuns, MEMBERS, uid => uid, null));
  assert.equal(H.hoMyStop(sum, "u3").label, "Copy", "the person on the second step was given the first");
  assert.equal(H.hoMyStop(sum, "u2").label, "Design");
  assert.equal(H.hoMyStop(sum, "u9").label, "Design", "an owner on no step gets the first, as before");
  assert.equal(H.hoMyStop(sum, null).label, "Design");
  // a summary written before `stops` existed still answers
  assert.equal(H.hoMyStop({ stop: { label: "Old", nodeId: "s0" }, next: null, done: false }, "u3").label, "Old");
  assert.equal(H.hoMyStop({ stop: null, done: true }, "u3"), null);
  assert.equal(H.hoMyStop(null, "u3"), null);
});
T("groups are found from the list, and the sentence says together and where a branch goes", () => {
  assert.deepEqual(plain(H.hoGroups(H.hoStopIds(PAR))), [{ from: 0, to: 0 }, { from: 1, to: 2 }, { from: 3, to: 3 }]);
  assert.equal(H.hoDescribe(PAR, id => ({ manager: "Manager", staff: "Staff" })[id]),
    "Brief (Manager) → { Design (Staff, 1 named) + Copy (Staff, 1 named) together } → Check (Manager) → done");
  assert.equal(H.hoDescribe(LOOP, id => ({ manager: "Manager", staff: "Staff" })[id]),
    "Write the draft (Staff) → Check it (Manager) [if Send back → back to Write the draft] → Publish (Staff) → done");
});
T("the branch mistakes are refused with a reason, before the engine sees them", () => {
  const e = t => H.hoTrackErrors(t, ROLES, STATUSES, null, ["priority"]).map(x => x.message).join(" | ");
  assert.match(e([{ label: "A", roleId: "staff", together: true }]), /first step has nothing to run alongside/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", routes: [{ when: { kind: "choice", value: "Yes" }, to: "done" }] }]), /no choices/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", choices: ["Yes"], routes: [{ when: { kind: "choice", value: "No" }, to: "done" }] }]), /not one of this step's choices/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", routes: [{ when: { kind: "field", key: "brand", op: "==", value: "x" }, to: "done" }] }]), /not a field this kind of work has/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", routes: [{ when: { kind: "field", key: "priority", op: "==", value: "x" }, to: "zz" }] }]), /no longer there/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", routes: [{ when: { kind: "field", key: "priority", op: "==", value: "x" }, to: "c" }] },
                  { id: "b", label: "B", roleId: "staff" }, { id: "c", label: "C", roleId: "staff", together: true }]), /middle of steps that run together/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff" }, { id: "b", label: "B", roleId: "staff", together: true, choices: ["Y"], routes: [{ when: { kind: "choice", value: "Y" }, to: "done" }] }]), /cannot branch/);
  assert.match(e([{ id: "a", label: "A", roleId: "staff", choices: ["Yes", "Yes"] }]), /same name/);
  assert.equal(H.hoTrackErrors(LOOP, ROLES, STATUSES).length, 0, "a good loop must pass: " + e(LOOP));
  assert.equal(H.hoTrackErrors(PAR, ROLES, STATUSES).length, 0, "a good group must pass: " + e(PAR));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
