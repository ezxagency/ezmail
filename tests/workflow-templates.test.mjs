/* Every built-in template must be engine-valid, and the acceptance
   template must actually fire down each lane - templates are promises
   about what a one-click blueprint will do, so they get held to the same
   bar as the handshake. Loads js/workflow.js VERBATIM in a VM (same
   harness as workflow-builder-handshake.test.mjs) and reads WF_TEMPLATES
   out of it.
   Run: node tests/workflow-templates.test.mjs */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { wfValidate, wfStartRun } = require("../js/workflow-engine.js");
const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 160)); }
};

const ctx = vm.createContext({
  console,
  Date: { now: () => 1755302400000 },
  auth: { currentUser: { uid: "admin1" } },
  $: () => null
});
vm.runInContext(readFileSync(join(here, "../js/workflow-engine.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/workflow.js"), "utf8"), ctx);

// vm-realm prototypes vs host deep-equal: JSON round-trip, same as Firestore would
const tpls = JSON.parse(JSON.stringify(
  vm.runInContext(`WF_TEMPLATES.map(t => ({ key: t.key, name: t.name, graph: t.make() }))`, ctx)
));
const asBp = t => ({ id: "tpl-" + t.key, orgId: "ez-agency", ownerId: "admin1", name: t.name,
  version: 1, status: "draft", nodes: t.graph.nodes, edges: t.graph.edges, createdAt: 0, updatedAt: 0 });

T("there are templates, and each key is unique", () => {
  assert.ok(tpls.length >= 3);
  assert.equal(new Set(tpls.map(t => t.key)).size, tpls.length);
});

tpls.forEach(t => {
  T(`template "${t.key}" passes wfValidate with zero errors`, () => {
    assert.deepEqual(wfValidate(asBp(t)), []);
  });
});

T("make() hands out fresh objects — editing one seed never bleeds into the next", () => {
  const label = vm.runInContext(`(() => {
    const a = WF_TEMPLATES[0].make();
    const b = WF_TEMPLATES[0].make();
    a.nodes[0].config.label = "MUTATED";
    a.edges.pop();
    return b.nodes[0].config.label + ":" + b.edges.length;
  })()`, ctx);
  assert.equal(label, "Start:15");
});

const acceptance = asBp(tpls.find(t => t.key === "acceptance"));
["A", "B", "C"].forEach(lane => {
  T(`acceptance template fires lane ${lane}`, () => {
    const st = wfStartRun({ blueprint: acceptance, runId: "tpl" + lane, task: { lane }, now: 1 });
    assert.equal(st.run.status, "running");
    assert.equal(st.nodeRuns.find(nr => nr.nodeId === "n_s1").output.pickedBranch, "b" + lane);
    assert.deepEqual(st.run.activeNodeIds, ["n_r1"]);
    assert.deepEqual(st.nodeRuns.filter(nr => nr.nodeId === "n_r3").map(nr => nr.status), ["skipped"]);
  });
});
T("acceptance template fires the else lane", () => {
  const st = wfStartRun({ blueprint: acceptance, runId: "tplZ", task: { lane: "Z" }, now: 1 });
  assert.equal(st.nodeRuns.find(nr => nr.nodeId === "n_s1").output.pickedBranch, "bE");
  assert.deepEqual(st.run.activeNodeIds, ["n_r3"]);
});

T("approval template's reject loop actually loops", () => {
  const { wfAdvance } = require("../js/workflow-engine.js");
  const bp = asBp(tpls.find(t => t.key === "approval"));
  let st = wfStartRun({ blueprint: bp, runId: "tplAp", task: {}, now: 1 });
  const stop = () => st.nodeRuns.find(nr => nr.status === "in_progress");
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: {} }, { now: 2 });          // draft
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: { approved: false } }, { now: 3 });
  assert.equal(stop().nodeId, "r_draft");                                                          // rejected → rework
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: {} }, { now: 4 });
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: { approved: true } }, { now: 5 });
  assert.equal(st.run.status, "completed");
  assert.ok(st.effects.some(e => e.type === "action"));
});

T("tidy layout: rows follow the flow, gaps are generous, zero overlaps", () => {
  const g = tpls.find(t => t.key === "acceptance").graph;
  const pos = JSON.parse(JSON.stringify(vm.runInContext(
    `wfLayoutPositions(${JSON.stringify(g.nodes)}, ${JSON.stringify(g.edges)})`, ctx)));
  const ids = g.nodes.map(n => n.id);
  ids.forEach(id => assert.ok(pos[id], "every node got a position"));
  // no two nodes closer than a node box + breathing room
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++){
      const a = pos[ids[i]], b = pos[ids[j]];
      assert.ok(Math.abs(a.x - b.x) >= 250 || Math.abs(a.y - b.y) >= 170,
        ids[i] + " and " + ids[j] + " overlap");
    }
  // downward = forward: every wire drops at least one full row
  g.edges.forEach(e => assert.ok(pos[e.to].y >= pos[e.from].y + 200, e.id + " should point down"));
  // the trigger sits alone at the top
  const minY = Math.min(...ids.map(id => pos[id].y));
  assert.equal(pos["n_t"].y, minY);
  assert.equal(ids.filter(id => pos[id].y === minY).length, 1);
});

T("tidy layout: a rework loop doesn't sink the graph (back edge ignored)", () => {
  const g = tpls.find(t => t.key === "approval").graph;
  const pos = JSON.parse(JSON.stringify(vm.runInContext(
    `wfLayoutPositions(${JSON.stringify(g.nodes)}, ${JSON.stringify(g.edges)})`, ctx)));
  // forward chain descends…
  assert.ok(pos["r_draft"].y > pos["t"].y);
  assert.ok(pos["r_review"].y > pos["r_draft"].y);
  assert.ok(pos["g"].y > pos["r_review"].y);
  assert.ok(pos["a_pub"].y > pos["g"].y);
  // …and the loop-back edge (g → r_draft) pointing up is the exception, not
  // a reason for ranks to explode: everything fits in 5 rows
  const rows = new Set(Object.values(pos).map(p => p.y));
  assert.equal(rows.size, 5);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
