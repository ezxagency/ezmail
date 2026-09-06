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
  assert.deepEqual(plain(bp.track), plain(TRACK));
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
  assert.match(errs([]), /at least one stop/);
});
T("a stop needs a name and a holder", () => {
  assert.match(errs([{ label: "", roleId: "" }]), /needs a name/);
  assert.match(errs([{ label: "", roleId: "" }]), /Who holds this stop/);
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
  assert.match(errs(many), /straight line should carry/);
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
