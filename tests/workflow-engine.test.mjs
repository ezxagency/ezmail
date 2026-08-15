/* Unit tests for ../js/workflow-engine.js - pure logic, so no emulator,
   no DOM, no Firebase: plain node.
     node tests/workflow-engine.test.mjs
   Same runner shape as firestore-rules.test.mjs: PASS/FAIL lines, exit 1
   on any failure. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WF_MAX_HOPS, wfValidate, wfEvalCondition, wfStartRun, wfAdvance } = require("../js/workflow-engine.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 160)); }
};

/* ---------- builders ---------- */
const N = (id, type, config = {}, waitFor) =>
  ({ id, type, position: { x: 0, y: 0 }, config, ...(waitFor ? { waitFor } : {}) });
const Ed = (id, from, to, fromHandle) => ({ id, from, to, ...(fromHandle ? { fromHandle } : {}) });
const BP = (nodes, edges) => ({ id: "bp1", orgId: "ez-agency", ownerId: "admin1", name: "Test",
  version: 1, status: "draft", nodes, edges, createdAt: 0, updatedAt: 0 });
const role = (id, extra) => N(id, "role", Object.assign({ role: "designer" }, extra));
const taskCond = (path, op, value) => ({ source: "task", path, op, value });

const inflight = (st, nodeId) => st.nodeRuns.find(nr => nr.nodeId === nodeId && nr.status === "in_progress");
const attempts = (st, nodeId) => st.nodeRuns.filter(nr => nr.nodeId === nodeId);
const statuses = (st, nodeId) => attempts(st, nodeId).map(nr => nr.status);
const finish = (st, nodeId, output) =>
  wfAdvance(st, { type: "complete", nodeRunId: inflight(st, nodeId).id, output }, { now: 1 });
const start = (bp, task, runId = "run1") => wfStartRun({ blueprint: bp, runId, taskId: "task1", task, now: 0 });

/* The acceptance sketch from the spec:
   TRIGGER → SPLIT[route] → (A|B|C → ROLE r1 → SPLIT[parallel] → r2a + r2b → VAULT v1)
   and (else → r3 → r4 → VAULT v2); both → ROLE rf [waitFor:all] → ACTION.
   The three lane edges all land on r1: multiple incoming lines ARE the merge. */
function acceptanceBP(){
  return BP([
    N("t", "trigger"),
    N("s1", "split", { mode: "route", branches: [
      { id: "brA", label: "A", condition: taskCond("lane", "==", "A") },
      { id: "brB", label: "B", condition: taskCond("lane", "==", "B") },
      { id: "brC", label: "C", condition: taskCond("lane", "==", "C") },
      { id: "brE", label: "else", isElse: true }
    ] }),
    role("r1"),
    N("s2", "split", { mode: "parallel", branches: [{ id: "p1", label: "L" }, { id: "p2", label: "R" }] }),
    role("r2a"), role("r2b"), N("v1", "vault"),
    role("r3"), role("r4"), N("v2", "vault"),
    role("rf"), N("a1", "action", { actionType: "notify" })
  ], [
    Ed("e0", "t", "s1"),
    Ed("eA", "s1", "r1", "brA"), Ed("eB", "s1", "r1", "brB"), Ed("eC", "s1", "r1", "brC"),
    Ed("eE", "s1", "r3", "brE"),
    Ed("e1", "r1", "s2"),
    Ed("e2a", "s2", "r2a", "p1"), Ed("e2b", "s2", "r2b", "p2"),
    Ed("e3a", "r2a", "v1"), Ed("e3b", "r2b", "v1"),
    Ed("e4", "v1", "rf"),
    Ed("e5", "r3", "r4"), Ed("e6", "r4", "v2"), Ed("e7", "v2", "rf"),
    Ed("e8", "rf", "a1")
  ]);
}

/* TRIGGER → r1 (declares approved) → LOGIC g; true → ACTION, false → back to r1.
   r1 has two incoming edges (entry + rework loop): the join-on-a-loop case. */
function reworkBP(){
  return BP([
    N("t", "trigger"),
    role("r1", { outputs: [{ key: "approved", type: "boolean" }] }),
    N("g", "logic", { condition: { source: "nodeOutput", nodeId: "r1", path: "approved", op: "==", value: true } }),
    N("a1", "action", { actionType: "notify" })
  ], [
    Ed("e0", "t", "r1"), Ed("e1", "r1", "g"),
    Ed("eT", "g", "a1", "true"), Ed("eF", "g", "r1", "false")
  ]);
}

/* ================= 1. ACCEPTANCE FLOW ================= */
["A", "B", "C"].forEach(lane => {
  T(`acceptance lane ${lane}: runs to the final ACTION, no deadlock`, () => {
    let st = start(acceptanceBP(), { lane });
    assert.equal(attempts(st, "s1")[0].output.pickedBranch, "br" + lane);
    // dead else-chain eliminated at start: skipped, not pending
    assert.deepEqual(statuses(st, "r3"), ["skipped"]);
    assert.deepEqual(statuses(st, "v2"), ["skipped"]);
    assert.ok(inflight(st, "r1"));
    assert.ok(st.effects.some(e => e.type === "role-activated" && e.nodeId === "r1"));
    assert.equal(attempts(st, "rf").length, 0);  // the join waits for the live path

    st = finish(st, "r1", { note: "picked lane " + lane });
    assert.ok(inflight(st, "r2a") && inflight(st, "r2b"));  // parallel split armed both

    st = finish(st, "r2a", {});
    assert.equal(attempts(st, "v1").length, 0);  // v1 waits: r2b still live
    st = finish(st, "r2b", {});
    assert.deepEqual(statuses(st, "v1"), ["completed"]);   // both in → vault stamped
    assert.ok(inflight(st, "rf"));  // fired on completed(v1) + skip(v2): all LIVE paths arrived
    assert.deepEqual(st.run.activeNodeIds, ["rf"]);

    st = finish(st, "rf", {});
    assert.ok(st.effects.some(e => e.type === "action" && e.nodeId === "a1"));
    assert.equal(st.run.status, "completed");
    assert.notEqual(st.run.completedAt, null);
  });
});

T("acceptance else lane: whole A/B/C arm skips, run still completes", () => {
  let st = start(acceptanceBP(), { lane: "Z" });
  assert.equal(attempts(st, "s1")[0].output.pickedBranch, "brE");
  // the dead arm: skip propagated node by node, exactly one attempt each
  ["r1", "s2", "r2a", "r2b", "v1"].forEach(id => assert.deepEqual(statuses(st, id), ["skipped"]));
  assert.ok(inflight(st, "r3"));
  st = finish(st, "r3", {});
  st = finish(st, "r4", {});
  assert.deepEqual(statuses(st, "v2"), ["completed"]);
  assert.ok(inflight(st, "rf"));
  st = finish(st, "rf", {});
  assert.equal(st.run.status, "completed");
  assert.equal(st.effects.filter(e => e.type === "action").length, 1);
});

/* ================= 2. REWORK LOOP ================= */
T("rework loop: onFalse revisits the ROLE, resolves on the 2nd pass", () => {
  let st = start(reworkBP(), {});
  assert.ok(inflight(st, "r1"));  // fired on the entry edge alone: loop-back edge can't arrive yet

  st = finish(st, "r1", { approved: false, note: "logo off-brand" });
  assert.deepEqual(statuses(st, "r1"), ["completed", "in_progress"]);  // fresh attempt, fresh nodeRun
  assert.equal(attempts(st, "g")[0].output.result, false);
  assert.equal(attempts(st, "a1").length, 0);  // the untaken true-side gets NOTHING this pass — not dead, just not yet
  assert.equal(st.run.status, "running");

  st = finish(st, "r1", { approved: true });
  assert.equal(st.run.status, "completed");
  assert.deepEqual(attempts(st, "g").map(nr => nr.output.result), [false, true]);
  assert.deepEqual(statuses(st, "a1"), ["completed"]);  // fires once, on the pass that took it
  assert.equal(attempts(st, "r1").length, 2);  // and no ghost third attempt from a skip echo
  assert.ok(st.effects.some(e => e.type === "action"));
});

T("declared outputs are enforced at completion", () => {
  const st = start(reworkBP(), {});
  assert.throws(() => finish(st, "r1", { note: "forgot the checkbox" }), /approved/);
});

/* ================= 3. HOP CAP ================= */
T("a loop that never resolves fails at the hop cap", () => {
  let st = start(reworkBP(), {}, "run3");
  let guard = 0;
  while (st.run.status === "running" && guard++ < 200) st = finish(st, "r1", { approved: false });
  assert.equal(st.run.status, "failed");
  assert.ok(guard < 200, "loop should have been stopped by the cap, not the test guard");
  assert.ok(st.run.hops <= WF_MAX_HOPS);
  assert.ok(st.effects.some(e => e.type === "run-failed" && e.reason === "hop-cap"));
  assert.ok(!st.nodeRuns.some(nr => nr.status === "in_progress"));  // nothing left dangling
  assert.deepEqual(st.run.activeNodeIds, []);
});

/* ================= 4. ALL-INCOMING-SKIPPED JOIN ================= */
T("a join whose every incoming path died skips itself and propagates", () => {
  const bp = BP([
    N("t", "trigger"),
    N("s", "split", { mode: "route", branches: [
      { id: "brA", condition: taskCond("pick", "==", "A") },
      { id: "brB", condition: taskCond("pick", "==", "B") },
      { id: "brE", isElse: true }
    ] }),
    N("a1", "action", { actionType: "notify" }),
    role("rB"), role("rE"), role("j"),
    N("a2", "action", { actionType: "email" })
  ], [
    Ed("e0", "t", "s"),
    Ed("eA", "s", "a1", "brA"), Ed("eB", "s", "rB", "brB"), Ed("eE", "s", "rE", "brE"),
    Ed("e1", "rB", "j"), Ed("e2", "rE", "j"), Ed("e3", "j", "a2")
  ]);
  const st = start(bp, { pick: "A" }, "run4");
  assert.deepEqual(statuses(st, "j"), ["skipped"]);       // neither fired nor deadlocked
  assert.deepEqual(statuses(st, "a2"), ["skipped"]);      // and the skip kept propagating
  assert.equal(st.run.status, "completed");
  const acts = st.effects.filter(e => e.type === "action");
  assert.deepEqual(acts.map(a => a.nodeId), ["a1"]);      // the dead arm's action never fired
});

/* ================= 5. CONDITION EVAL ================= */
T("condition eval: every operator, both sources, missing = false", () => {
  const ctx = {
    task: { words: 812, title: "Summer drop", tags: ["rush", "video"] },
    nodeRuns: [
      { nodeId: "n1", status: "completed", output: { approved: true, score: 7 } },
      { nodeId: "n1", status: "completed", output: { approved: false, score: 9 } },  // latest attempt wins
      { nodeId: "n2", status: "skipped", output: {} }
    ]
  };
  const ev = c => wfEvalCondition(c, ctx);
  // task-field source, each operator
  assert.equal(ev(taskCond("title", "==", "Summer drop")), true);
  assert.equal(ev(taskCond("title", "!=", "Summer drop")), false);
  assert.equal(ev(taskCond("words", ">", 500)), true);
  assert.equal(ev(taskCond("words", ">=", 812)), true);
  assert.equal(ev(taskCond("words", "<", 812)), false);
  assert.equal(ev(taskCond("words", "<=", 812)), true);
  assert.equal(ev(taskCond("title", "contains", "drop")), true);
  assert.equal(ev(taskCond("title", "contains", "Drop")), false);  // case-sensitive, documented by test
  assert.equal(ev(taskCond("tags", "contains", "rush")), true);
  assert.equal(ev(taskCond("words", "contains", "8")), false);     // contains on a number: false, not coerced
  // nodeOutput source: reads the LATEST completed attempt
  const out = (path, op, value) => ({ source: "nodeOutput", nodeId: "n1", path, op, value });
  assert.equal(ev(out("approved", "==", true)), false);
  assert.equal(ev(out("approved", "==", false)), true);
  assert.equal(ev(out("score", ">=", 9)), true);
  // missing values: false for EVERY operator, both sources
  assert.equal(ev(taskCond("nope", "==", 1)), false);
  assert.equal(ev(taskCond("nope", "!=", 1)), false);
  assert.equal(ev({ source: "nodeOutput", nodeId: "n2", path: "anything", op: "==", value: 1 }), false);
  assert.equal(ev({ source: "nodeOutput", nodeId: "ghost", path: "x", op: "!=", value: 1 }), false);
});

T("route branches: in order, first match wins, else catches the rest", () => {
  const st = start(acceptanceBP(), { lane: "B" }, "run5");
  assert.equal(attempts(st, "s1")[0].output.pickedBranch, "brB");
  const st2 = start(acceptanceBP(), { lane: "nope" }, "run5b");
  assert.equal(attempts(st2, "s1")[0].output.pickedBranch, "brE");
});

/* ================= 6. VALIDATION ================= */
const codes = bp => wfValidate(bp).map(e => e.code);

T("validation: the two real blueprints pass clean", () => {
  assert.deepEqual(wfValidate(acceptanceBP()), []);
  assert.deepEqual(wfValidate(reworkBP()), []);
});

T("validation: trigger rules", () => {
  assert.ok(codes(BP([role("r1")], [])).includes("no-trigger"));
  assert.ok(codes(BP([N("t1", "trigger"), N("t2", "trigger"), N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t1", "a"), Ed("e2", "t2", "a")])).includes("many-triggers"));
  assert.ok(codes(BP([N("t", "trigger"), N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t", "a"), Ed("e2", "a", "t")])).includes("trigger-incoming"));
});

T("validation: floats, islands, dangling paths, vault ends", () => {
  assert.ok(codes(BP([N("t", "trigger"), N("a", "action", { actionType: "notify" }), role("r1")],
    [Ed("e1", "t", "a")])).includes("floating"));
  // two blocks feeding each other pass the incoming check but are an island
  assert.ok(codes(BP([N("t", "trigger"), N("a", "action", { actionType: "notify" }), role("r1"), role("r2")],
    [Ed("e1", "t", "a"), Ed("e2", "r1", "r2"), Ed("e3", "r2", "r1")])).includes("unreachable"));
  // a cycle with no exit can never reach an end
  assert.ok(codes(BP([N("t", "trigger"), role("r1"), role("r2")],
    [Ed("e1", "t", "r1"), Ed("e2", "r1", "r2"), Ed("e3", "r2", "r1")])).includes("dangling"));
  assert.ok(codes(BP([N("t", "trigger"), N("v", "vault")], [Ed("e1", "t", "v")])).includes("vault-end"));
});

T("validation: split rules", () => {
  const oneOut = BP([N("t", "trigger"), N("s", "split", { mode: "route",
      branches: [{ id: "b1", condition: taskCond("x", "==", 1) }, { id: "bE", isElse: true }] }),
    N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t", "s"), Ed("e2", "s", "a", "b1")]);
  assert.ok(codes(oneOut).includes("split-outgoing"));
  const noHandle = BP([N("t", "trigger"), N("s", "split", { mode: "route",
      branches: [{ id: "b1", condition: taskCond("x", "==", 1) }, { id: "bE", isElse: true }] }),
    N("a", "action", { actionType: "notify" }), N("a2", "action", { actionType: "notify" })],
    [Ed("e1", "t", "s"), Ed("e2", "s", "a"), Ed("e3", "s", "a2", "bE")]);
  assert.ok(codes(noHandle).includes("split-handle"));
  const noElse = BP([N("t", "trigger"), N("s", "split", { mode: "route",
      branches: [{ id: "b1", condition: taskCond("x", "==", 1) }, { id: "b2" }] }),
    N("a", "action", { actionType: "notify" }), N("a2", "action", { actionType: "notify" })],
    [Ed("e1", "t", "s"), Ed("e2", "s", "a", "b1"), Ed("e3", "s", "a2", "b2")]);
  assert.ok(codes(noElse).includes("route-else"));
  assert.ok(codes(noElse).includes("branch-condition"));  // b2 has neither rule nor else
});

T("validation: logic, role, action rules", () => {
  const g = BP([N("t", "trigger"), N("g", "logic", {}), N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t", "g"), Ed("e2", "g", "a", "true")]);
  assert.ok(codes(g).includes("logic-condition"));
  assert.ok(codes(g).includes("logic-handles"));  // no false path
  assert.ok(codes(BP([N("t", "trigger"), N("r", "role", {}), N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t", "r"), Ed("e2", "r", "a")])).includes("role-assignee"));
  assert.ok(codes(BP([N("t", "trigger"), N("a", "action", {})],
    [Ed("e1", "t", "a")])).includes("action-type"));
  assert.ok(codes(BP([N("t", "trigger"), N("a", "action", { actionType: "notify" })],
    [Ed("e1", "t", "a"), Ed("e2", "t", "ghost")])).includes("edge-endpoint"));
});

T("validation: the nodeOutput declaration invariant", () => {
  const mk = (cond, roleExtra) => BP([
    N("t", "trigger"), role("r1", roleExtra),
    N("g", "logic", { condition: cond }), N("a", "action", { actionType: "notify" })
  ], [Ed("e1", "t", "r1"), Ed("e2", "r1", "g"),
      Ed("eT", "g", "a", "true"), Ed("eF", "g", "r1", "false")]);
  const reads = (nodeId, path) => ({ source: "nodeOutput", nodeId, path, op: "==", value: true });
  // reading an undeclared key, or from a ghost node → flagged
  assert.ok(codes(mk(reads("r1", "approved"), {})).includes("cond-output"));
  assert.ok(codes(mk(reads("ghost", "approved"), {})).includes("cond-output"));
  // declared role output, a gate's own `result` → clean
  assert.deepEqual(codes(mk(reads("r1", "approved"), { outputs: [{ key: "approved", type: "boolean" }] })), []);
  const viaLogic = mk(reads("g0", "result"), { outputs: [{ key: "approved", type: "boolean" }] });
  viaLogic.nodes.splice(1, 0, N("g0", "logic", { condition: taskCond("x", "==", 1) }));
  viaLogic.edges[0] = Ed("e1", "t", "g0");
  viaLogic.edges.push(Ed("eT0", "g0", "r1", "true"), Ed("eF0", "g0", "r1", "false"));
  assert.deepEqual(codes(viaLogic), []);
});

T("starting a run on an invalid blueprint throws", () => {
  assert.throws(() => start(BP([role("r1")], []), {}), /Trigger/);
});

/* ================= ADVERSARIAL A: parallel join INSIDE a loop body ================= */
/* t → r0 → SPLIT[parallel] → ra + rb → VAULT j [waitFor:all] → LOGIC g;
   g true → ACTION, g false → back before the split (r0). The join must
   re-synchronize fresh each pass: pass-1 arrivals were consumed, so pass
   2 must wait for BOTH branches again — firing early on a stale arrival
   and deadlocking on a spent one are the two failure modes. */
function loopJoinBP(){
  return BP([
    N("t", "trigger"),
    role("r0"),
    N("sp", "split", { mode: "parallel", branches: [{ id: "p1" }, { id: "p2" }] }),
    role("ra"), role("rb", { outputs: [{ key: "ok", type: "boolean" }] }),
    N("j", "vault"),
    N("g", "logic", { condition: { source: "nodeOutput", nodeId: "rb", path: "ok", op: "==", value: true } }),
    N("a1", "action", { actionType: "notify" })
  ], [
    Ed("e0", "t", "r0"), Ed("e1", "r0", "sp"),
    Ed("e2a", "sp", "ra", "p1"), Ed("e2b", "sp", "rb", "p2"),
    Ed("e3a", "ra", "j"), Ed("e3b", "rb", "j"),
    Ed("e4", "j", "g"),
    Ed("eT", "g", "a1", "true"), Ed("eF", "g", "r0", "false")
  ]);
}

T("adversarial A: a waitFor:all join inside a loop re-synchronizes each pass", () => {
  let st = start(loopJoinBP(), {}, "runA");
  st = finish(st, "r0", {});
  assert.ok(inflight(st, "ra") && inflight(st, "rb"));
  st = finish(st, "ra", {});
  assert.equal(attempts(st, "j").length, 0);               // pass 1: no early fire
  st = finish(st, "rb", { ok: false });
  assert.deepEqual(statuses(st, "j"), ["completed"]);      // synchronized fire
  assert.ok(inflight(st, "r0"));                            // loop re-entered
  assert.equal(st.run.status, "running");
  st = finish(st, "r0", {});
  assert.ok(inflight(st, "ra") && inflight(st, "rb"));      // both branches re-armed
  assert.equal(attempts(st, "j").length, 1);
  st = finish(st, "ra", {});
  assert.equal(attempts(st, "j").length, 1);               // pass 2: still waits for rb — no early fire
  st = finish(st, "rb", { ok: true });
  assert.deepEqual(statuses(st, "j"), ["completed", "completed"]);  // re-synchronized, no deadlock
  assert.deepEqual(attempts(st, "g").map(nr => nr.output.result), [false, true]);
  assert.equal(st.run.status, "completed");
  assert.ok(attempts(st, "a1").some(nr => nr.status === "completed"));
});

/* ================= ADVERSARIAL B: nested rework loops ================= */
/* t → rO → rI → gI (inner gate): false → rI, true → gO (outer gate):
   false → rO, true → ACTION. Attempts must count one per iteration of
   the loop that owns the node — the inner loop must not leak attempts
   onto outer nodes, and a gate's untaken side must not spawn ghosts. */
function nestedLoopBP(){
  return BP([
    N("t", "trigger"),
    role("rO", { outputs: [{ key: "outerOk", type: "boolean" }] }),
    role("rI", { outputs: [{ key: "innerOk", type: "boolean" }] }),
    N("gI", "logic", { condition: { source: "nodeOutput", nodeId: "rI", path: "innerOk", op: "==", value: true } }),
    N("gO", "logic", { condition: { source: "nodeOutput", nodeId: "rO", path: "outerOk", op: "==", value: true } }),
    N("a1", "action", { actionType: "notify" })
  ], [
    Ed("e0", "t", "rO"), Ed("eA", "rO", "rI"), Ed("e1", "rI", "gI"),
    Ed("eIT", "gI", "gO", "true"), Ed("eIF", "gI", "rI", "false"),
    Ed("eOT", "gO", "a1", "true"), Ed("eOF", "gO", "rO", "false")
  ]);
}

T("adversarial B: nested loops keep clean per-iteration attempt counts", () => {
  let st = start(nestedLoopBP(), {}, "runB");
  // outer pass 1: inner rejects once, then passes; outer gate rejects
  st = finish(st, "rO", { outerOk: false });
  st = finish(st, "rI", { innerOk: false });
  assert.equal(attempts(st, "rI").length, 2);
  st = finish(st, "rI", { innerOk: true });
  // the outer gate said no → back to rO, and ONLY rO: no phantom attempts
  assert.deepEqual(statuses(st, "rO"), ["completed", "in_progress"]);
  assert.equal(attempts(st, "rI").length, 2);
  assert.deepEqual(attempts(st, "gI").map(nr => nr.output.result), [false, true]);
  assert.deepEqual(attempts(st, "gO").map(nr => nr.output.result), [false]);
  // outer pass 2: inner rejects once again, then passes; outer gate passes
  st = finish(st, "rO", { outerOk: true });
  st = finish(st, "rI", { innerOk: false });
  st = finish(st, "rI", { innerOk: true });
  assert.equal(st.run.status, "completed");
  assert.equal(attempts(st, "rO").length, 2);   // one per outer iteration, nothing phantom
  assert.equal(attempts(st, "rI").length, 4);   // two per outer iteration
  assert.deepEqual(attempts(st, "gI").map(nr => nr.output.result), [false, true, false, true]);
  assert.deepEqual(attempts(st, "gO").map(nr => nr.output.result), [false, true]);
  assert.deepEqual(statuses(st, "a1"), ["completed"]);
  assert.ok(st.nodeRuns.every(nr => nr.status !== "skipped"));  // nothing on a live loop is ever "skipped"
});

T("adversarial B: the hop cap still bounds nested loops", () => {
  let st = start(nestedLoopBP(), {}, "runB2");
  let guard = 0;
  while (st.run.status === "running" && guard++ < 300){
    const stop = st.run.activeNodeIds[0];
    st = finish(st, stop, stop === "rO" ? { outerOk: false } : { innerOk: true });
  }
  assert.equal(st.run.status, "failed");
  assert.ok(guard < 300, "the cap should stop it, not the test guard");
  assert.ok(st.run.hops <= WF_MAX_HOPS);
});

/* ================= ENGINE CONTRACT ================= */
T("advance never mutates its input and is deterministic", () => {
  const st = start(reworkBP(), {}, "run6");
  const before = JSON.stringify(st);
  const a = finish(st, "r1", { approved: false });
  const b = finish(st, "r1", { approved: false });
  assert.equal(JSON.stringify(st), before);                // untouched input
  assert.equal(JSON.stringify(a), JSON.stringify(b));      // same event, same next state
});

T("advance accepts nodeRuns in any order (Firestore returns docs unordered)", () => {
  const st = start(reworkBP(), {}, "run7");
  const shuffled = { run: st.run, nodeRuns: [...st.nodeRuns].reverse() };
  const a = wfAdvance(st, { type: "complete", nodeRunId: inflight(st, "r1").id, output: { approved: true } }, { now: 1 });
  const b = wfAdvance(shuffled, { type: "complete", nodeRunId: inflight(st, "r1").id, output: { approved: true } }, { now: 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
