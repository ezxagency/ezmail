/* Version history's promises, held to account: wfValidate still gates
   publish (a broken graph plans NO writes), v1 is recorded on the first
   publish, re-publish preserves the outgoing version and never rewrites a
   past one, restore seeds an independent draft, and - the reason this
   feature is safe at all - in-flight runs execute their frozen snapshot,
   deaf to anything happening to the live blueprint.
   Same VM harness as the handshake: js/workflow.js loaded VERBATIM.
   Run: node tests/workflow-versions.test.mjs */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { wfStartRun, wfAdvance } = require("../js/workflow-engine.js");
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

const J = v => JSON.parse(JSON.stringify(v));   // vm realm → host realm
const approval = J(vm.runInContext(`wfTplApproval()`, ctx));
const docFor = (graph, over) => Object.assign({
  orgId: "ez-agency", ownerId: "admin1", name: "Approval", version: 1, status: "published",
  nodes: graph.nodes, edges: graph.edges, createdAt: 1, updatedAt: 2
}, over || {});
const plan = (fetched, docData) =>
  J(vm.runInContext(`wfPublishPlan(${JSON.stringify(fetched)}, ${JSON.stringify(docData)})`, ctx));

T("wfValidate still gates publish: a broken graph plans zero writes", () => {
  const broken = docFor({ nodes: [], edges: [] });
  const p = plan(null, broken);
  assert.ok(p.errs.length > 0);
  assert.equal(p.versionWrites, undefined);
  assert.equal(p.main, undefined);
});

T("first publish records v1 and starts the counter", () => {
  const p = plan(null, docFor(approval));
  assert.deepEqual(p.errs, []);
  assert.equal(p.newVer, 1);
  assert.deepEqual(p.versionWrites.map(w => w.id), ["1"]);
  assert.equal(p.versionWrites[0].data.publishedBy, "admin1");
  assert.equal(p.main.status, "published");
  assert.equal(p.main.lastPublishedVersion, 1);
});

T("re-publish becomes v2; v1's copy is only backfilled, never rewritten", () => {
  // what's live in Firestore: v1, already self-recorded at its own publish
  const live = docFor(approval, { lastPublishedVersion: 1 });
  const edited = J(approval);
  edited.nodes.find(n => n.id === "r_draft").config.label = "Write the draft, v2";
  const p = plan(live, docFor(edited, { status: "draft" }));
  assert.equal(p.newVer, 2);
  const w1 = p.versionWrites.find(w => w.id === "1");
  const w2 = p.versionWrites.find(w => w.id === "2");
  assert.equal(w1.onlyIfMissing, true);   // exists already → skipped at write time
  assert.equal(w1.data.nodes.find(n => n.id === "r_draft").config.label, "Write the draft");
  assert.equal(w2.onlyIfMissing, undefined);
  assert.equal(w2.data.nodes.find(n => n.id === "r_draft").config.label, "Write the draft, v2");
  assert.equal(p.main.lastPublishedVersion, 2);
});

T("a pre-history published blueprint gets its outgoing content preserved", () => {
  const legacy = docFor(approval, { version: 3 });   // no lastPublishedVersion field
  delete legacy.lastPublishedVersion;
  const p = plan(legacy, docFor(approval, { status: "draft" }));
  assert.equal(p.newVer, 4);
  const w3 = p.versionWrites.find(w => w.id === "3");
  assert.equal(w3.onlyIfMissing, true);
  assert.deepEqual(w3.data.nodes, legacy.nodes);
});

T("a draft-demoted blueprint republished: no double-preserve, next number", () => {
  const demoted = docFor(approval, { status: "draft", lastPublishedVersion: 2 });
  const p = plan(demoted, docFor(approval, { status: "draft" }));
  assert.equal(p.newVer, 3);
  assert.deepEqual(p.versionWrites.map(w => w.id), ["3"]);   // outgoing v2 already self-recorded
});

T("restore seeds a draft equal to the version — same id, independent copies", () => {
  const out = J(vm.runInContext(`(() => {
    const v = { version: 1, name: "Approval", nodes: wfTplApproval().nodes, edges: wfTplApproval().edges };
    const current = { docId: "bp9", name: "Approval (renamed)", version: 2, status: "published",
      createdAt: 5, lastPublishedVersion: 2 };
    const seed = wfRestoreDraftDoc(current, v);
    const equalBefore = JSON.stringify(seed.nodes) === JSON.stringify(v.nodes)
      && JSON.stringify(seed.edges) === JSON.stringify(v.edges);
    seed.nodes[0].config.label = "MUTATED";   // editing the draft...
    return { seed, equalBefore, pastUntouched: v.nodes[0].config.label };
  })()`, ctx));
  assert.equal(out.equalBefore, true);
  assert.equal(out.seed.docId, "bp9");                    // SAME blueprint
  assert.equal(out.seed.status, "draft");
  assert.equal(out.seed.lastPublishedVersion, 2);         // next publish → v3
  assert.equal(out.pastUntouched, "Start");               // ...never bleeds into the version
});

T("in-flight runs are untouched: they execute the snapshot, not the live blueprint", () => {
  const bp = { id: "bp9", ...docFor(approval) };
  let st = wfStartRun({ blueprint: bp, runId: "vrun", task: {}, now: 1 });
  // simulate v2 landing: the live blueprint object is gutted entirely
  bp.nodes.length = 0;
  bp.edges.length = 0;
  const stop = () => st.nodeRuns.find(nr => nr.status === "in_progress");
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: {} }, { now: 2 });
  st = wfAdvance(st, { type: "complete", nodeRunId: stop().id, output: { approved: true } }, { now: 3 });
  assert.equal(st.run.status, "completed");               // rode the frozen copy to the end
  assert.ok(st.effects.some(e => e.type === "action"));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
