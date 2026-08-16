/* THE HANDSHAKE: proves the builder's saved Firestore doc is engine-valid.
   Loads js/workflow.js VERBATIM in a VM, authors the acceptance-sketch
   blueprint through the builder's own config shapes (exactly what the
   sheets store), serializes through the builder's own wfSerializeGraph/
   wfBlueprintObj over Drawflow's documented export format, then feeds the
   resulting doc to the engine's wfValidate (expect zero errors) and
   wfStartRun (expect the trigger to fire and the first stops to exist).
   Run: node tests/workflow-builder-handshake.test.mjs
   (--print-doc dumps the doc JSON that wfPublish would write.) */
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

/* ---------- run the real builder file with only the browser seams stubbed ---------- */
const FIXED_NOW = 1755302400000;   // 2025-08-16T00:00:00Z, pinned so the doc is stable
const ctx = vm.createContext({
  console,
  Date: { now: () => FIXED_NOW },
  auth: { currentUser: { uid: "admin1" } },
  $: () => null
});
vm.runInContext(readFileSync(join(here, "../js/workflow-engine.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/workflow.js"), "utf8"), ctx);

/* Author the acceptance sketch the way the sheets do: start from
   wfDefaultConfig and overwrite the fields each sheet's Done button sets.
   TRIGGER → SPLIT[route A,B,C,else] → (A,B,C → r1 → SPLIT[parallel] →
   r2a + r2b → v1) and (else → r3 → r4 → v2) → rf [waitFor:all] → ACTION. */
vm.runInContext(`
  const cfg = (t, patch) => Object.assign(wfDefaultConfig(t), patch);
  const role = (label, patch) => cfg("role", Object.assign({ label, role: "designer" }, patch || {}));
  const laneCond = v => ({ source: "task", path: "lane", op: "==", value: v });

  wfNodes.set("n_t", { type: "trigger", config: cfg("trigger", { label: "Start" }), waitFor: null });
  wfNodes.set("n_s1", { type: "split", config: { mode: "route", branches: [
    { id: "bA", label: "Lane A", condition: laneCond("A") },
    { id: "bB", label: "Lane B", condition: laneCond("B") },
    { id: "bC", label: "Lane C", condition: laneCond("C") },
    { id: "bE", label: "Else", isElse: true, condition: null }
  ] }, waitFor: null });
  wfNodes.set("n_r1", { type: "role", config: role("Draft the piece"), waitFor: null });
  wfNodes.set("n_s2", { type: "split", config: { mode: "parallel", branches: [
    { id: "p1", label: "Visual", condition: null },
    { id: "p2", label: "Copy", condition: null }
  ] }, waitFor: null });
  wfNodes.set("n_r2a", { type: "role", config: role("Visual pass") });
  wfNodes.set("n_r2b", { type: "role", config: role("Copy pass", { role: "copywriter" }) });
  wfNodes.set("n_v1", { type: "vault", config: cfg("vault", { vaultName: "Lane assets", storeWhat: "the finished pieces" }), waitFor: null });
  wfNodes.set("n_r3", { type: "role", config: role("Generalist draft") });
  wfNodes.set("n_r4", { type: "role", config: role("Generalist polish") });
  wfNodes.set("n_v2", { type: "vault", config: cfg("vault", { vaultName: "Else assets", storeWhat: "the fallback piece" }), waitFor: null });
  wfNodes.set("n_rf", { type: "role", config: role("Final review", { role: "lead" }), waitFor: null });
  wfNodes.set("n_a1", { type: "action", config: cfg("action", { actionType: "notify", params: { message: "Track finished" } }), waitFor: null });

  // Drawflow's documented export shape for this drawing - the only vendor
  // surface wfSerializeGraph reads (pos_x/pos_y, data.oid, outputs.*.connections)
  const wires = {
    n_t:  [["output_1", "n_s1"]],
    n_s1: [["output_1", "n_r1"], ["output_2", "n_r1"], ["output_3", "n_r1"], ["output_4", "n_r3"]],
    n_r1: [["output_1", "n_s2"]],
    n_s2: [["output_1", "n_r2a"], ["output_2", "n_r2b"]],
    n_r2a: [["output_1", "n_v1"]],
    n_r2b: [["output_1", "n_v1"]],
    n_v1: [["output_1", "n_rf"]],
    n_r3: [["output_1", "n_r4"]],
    n_r4: [["output_1", "n_v2"]],
    n_v2: [["output_1", "n_rf"]],
    n_rf: [["output_1", "n_a1"]],
    n_a1: []
  };
  const dfIds = {}; let n = 0;
  for (const oid of wfNodes.keys()) dfIds[oid] = String(++n);
  const data = {}; let i = 0;
  for (const oid of wfNodes.keys()){
    const outputs = {};
    (wires[oid] || []).forEach(([cls, to]) => {
      (outputs[cls] = outputs[cls] || { connections: [] }).connections.push({ node: dfIds[to], output: "input_1" });
    });
    data[dfIds[oid]] = { id: Number(dfIds[oid]), name: "wf_" + wfNodes.get(oid).type,
      data: { oid }, class: "wf-node", html: "", typenode: false, inputs: {},
      outputs, pos_x: 80 + (i % 3) * 280, pos_y: 40 + Math.floor(i / 3) * 180 };
    i++;
  }
  wfEditor = { export: () => ({ drawflow: { Home: { data } } }) };
  wfCurrent = { docId: "bp-acceptance", name: "Acceptance sketch", version: 1, status: "draft", createdAt: null };
  globalThis.__doc = wfBlueprintObj("published", 1);   // exactly what wfPublish writes
`, ctx);

// vm-realm objects carry the other realm's prototypes, which strict
// deep-equal rejects; JSON round-trip = exactly what Firestore stores anyway
const doc = JSON.parse(JSON.stringify(ctx.__doc));
const bp = { id: "bp-acceptance", ...doc };

/* ---------- the handshake assertions ---------- */
T("builder doc: validates with zero errors", () => {
  assert.deepEqual(wfValidate(bp), []);
});

T("builder doc: schema fields the runs step depends on", () => {
  assert.equal(doc.orgId, "ez-agency");
  assert.equal(doc.status, "published");
  assert.equal(doc.nodes.length, 12);
  assert.equal(doc.edges.length, 15);
  const s1 = doc.nodes.find(n => n.id === "n_s1");
  assert.deepEqual(s1.config.branches.map(b => b.id), ["bA", "bB", "bC", "bE"]);
  // split edges carry their branch id; the three lanes land on r1, else on r3
  const laneEdges = doc.edges.filter(e => e.from === "n_s1");
  assert.deepEqual(laneEdges.map(e => e.fromHandle).sort(), ["bA", "bB", "bC", "bE"]);
  assert.ok(laneEdges.filter(e => e.to === "n_r1").length === 3);
  assert.ok(laneEdges.find(e => e.fromHandle === "bE").to === "n_r3");
  // no undefined anywhere - Firestore rejects it
  assert.ok(!JSON.stringify(doc).includes("undefined"));
});

T("builder doc: wfStartRun fires the trigger into lane A", () => {
  const st = wfStartRun({ blueprint: bp, runId: "hand1", task: { lane: "A" }, now: 1 });
  assert.equal(st.run.status, "running");
  const byNode = id => st.nodeRuns.filter(nr => nr.nodeId === id).map(nr => nr.status);
  assert.deepEqual(byNode("n_t"), ["completed"]);
  assert.deepEqual(byNode("n_s1"), ["completed"]);
  assert.equal(st.nodeRuns.find(nr => nr.nodeId === "n_s1").output.pickedBranch, "bA");
  assert.deepEqual(byNode("n_r1"), ["in_progress"]);      // the first human stop exists
  assert.deepEqual(byNode("n_r3"), ["skipped"]);          // dead else-arm eliminated
  assert.deepEqual(st.run.activeNodeIds, ["n_r1"]);
  assert.ok(st.effects.some(e => e.type === "role-activated" && e.nodeId === "n_r1"));
});

T("builder doc: the else lane fires too", () => {
  const st = wfStartRun({ blueprint: bp, runId: "hand2", task: { lane: "Z" }, now: 1 });
  assert.deepEqual(st.run.activeNodeIds, ["n_r3"]);
  assert.equal(st.nodeRuns.find(nr => nr.nodeId === "n_s1").output.pickedBranch, "bE");
});

if (process.argv.includes("--print-doc")) console.log("\n" + JSON.stringify(doc, null, 1));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
