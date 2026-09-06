/* Unit tests for ../js/migrate.js - pure, so no emulator, no DOM, no
   Firebase: plain node.
     node tests/migrate.test.mjs
   These decide what a migration MEANS, which is worth settling before
   any of somebody's real work moves. Same runner shape as the others. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../js/migrate.js");
const { itemCommit, itemValidate } = require("../js/item-engine.js");
const { wfValidate, wfStartRun, wfAdvance } = require("../js/workflow-engine.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};

const ASSIGNMENT = {
  toUid: "w1", toName: "W1", fromName: "Ada", fromEmail: "a@b.c",
  store: "Store Alpha", task: "Design", note: "Three banners, dark theme",
  snote: null, dueDate: "2026-09-11", dueTime: "17:30",
  groupId: "g1", groupSize: 3, seenAt: null, createdAt: 1000, done: false, doneAt: null
};
const CAMPAIGN = {
  title: "Spring launch", memberUids: ["w1", "w2"], status: "active", cur: 1,
  stages: [{ name: "Copy", owners: [{ uid: "w1", uname: "W1" }] },
           { name: "Design", owners: [{ uid: "w2", uname: "W2" }, { uid: "w3", uname: "W3" }] }],
  history: [], createdAt: 2000, updatedAt: 3000
};

/* ---------- ids are derived, which is what makes a re-run safe ---------- */
T("an item id is derived from the document it came from", () => {
  assert.equal(M.migrateItemId("assignment", "abc"), "im_assignment_abc");
});
T("the same source always produces the same id", () => {
  assert.equal(M.migrateItemId("assignment", "abc"), M.migrateItemId("assignment", "abc"));
});
T("different sources never collide", () => {
  assert.notEqual(M.migrateItemId("assignment", "a"), M.migrateItemId("campaign", "a"));
});

/* ---------- assignments ---------- */
T("store and task become the title the row already read as", () => {
  assert.equal(M.migrateAssignmentIntent(ASSIGNMENT).title, "Store Alpha · Design");
});
T("a row with neither still gets a title, because title is required", () => {
  assert.equal(M.migrateAssignmentIntent({}).title, "Task");
});
T("the person it was assigned to stays assigned to it", () => {
  assert.deepEqual(M.migrateAssignmentIntent(ASSIGNMENT).assigneeIds, ["w1"]);
});
T("a finished assignment arrives finished", () => {
  assert.equal(M.migrateAssignmentIntent({ ...ASSIGNMENT, done: true }).status, "done");
  assert.equal(M.migrateAssignmentIntent(ASSIGNMENT).status, "open");
});
T("the brief, the due date and who asked all survive", () => {
  const f = M.migrateAssignmentIntent(ASSIGNMENT).fields;
  assert.equal(f.note, "Three banners, dark theme");
  assert.equal(f.dueDate, "2026-09-11");
  assert.equal(f.dueTime, "17:30");
  assert.equal(f.from, "Ada");
});
T("one send that became many rows keeps them together under a parent", () => {
  const a = M.migrateAssignmentIntent(ASSIGNMENT);
  const b = M.migrateAssignmentIntent({ ...ASSIGNMENT, store: "Store Beta" });
  assert.equal(a.parentId, b.parentId);
  assert.equal(a.parentId, "im_group_g1");
});
T("a single-row send has no parent to belong to", () => {
  assert.equal(M.migrateAssignmentIntent({ ...ASSIGNMENT, groupId: null }).parentId, null);
});

/* ---------- campaigns ---------- */
T("a campaign keeps its title", () => {
  assert.equal(M.migrateCampaignIntent(CAMPAIGN).title, "Spring launch");
});
T("the stage holding the baton becomes the stage value", () => {
  assert.equal(M.migrateCampaignIntent(CAMPAIGN).fields.stage, "Design");
});
T("everyone who owns the current stage is assigned to it", () => {
  assert.deepEqual(M.migrateCampaignIntent(CAMPAIGN).assigneeIds, ["w2", "w3"]);
});
T("a v1 stage with a bare uid still resolves its owner", () => {
  const old = { ...CAMPAIGN, cur: 0, stages: [{ name: "Copy", uid: "w9", uname: "W9" }] };
  assert.deepEqual(M.migrateCampaignIntent(old).assigneeIds, ["w9"]);
});
T("a finished campaign arrives finished", () => {
  assert.equal(M.migrateCampaignIntent({ ...CAMPAIGN, status: "done" }).status, "done");
});

/* ---------- options are grown from the data, never guessed ---------- */
T("choices are collected from the rows themselves", () => {
  const rows = [{ store: "Beta" }, { store: "Alpha" }, { store: "Beta" }];
  assert.deepEqual(M.migrateOptionsFor(rows, "store"), ["Alpha", "Beta"]);
});
T("one store spelled two ways stays one choice", () => {
  const rows = [{ store: "Store Alpha" }, { store: "store alpha" }, { store: "STORE ALPHA" }];
  assert.deepEqual(M.migrateOptionsFor(rows, "store"), ["Store Alpha"]);
});
T("blanks never become a choice", () => {
  assert.deepEqual(M.migrateOptionsFor([{ store: "" }, { store: "  " }, {}], "store"), []);
});
T("the type is grown to fit the data before any row is written", () => {
  const rows = [ASSIGNMENT, { ...ASSIGNMENT, store: "Store Beta", task: "Copy" }];
  const type = M.migrateTypeWithOptions(M.MIGRATE_TASK_TYPE, rows, ["store", "task"]);
  const store = type.fields.find(f => f.key === "store");
  assert.deepEqual(store.options, ["Store Alpha", "Store Beta"]);
  assert.deepEqual(type.fields.find(f => f.key === "task").options, ["Copy", "Design"]);
  // and the shipped definition is left alone for the next caller
  assert.deepEqual(M.MIGRATE_TASK_TYPE.fields.find(f => f.key === "store").options, []);
});

/* ---------- the claim under test: these ARE Items ---------- */
T("a real assignment survives the engine intact", () => {
  const rows = [ASSIGNMENT];
  const type = M.migrateTypeWithOptions(M.MIGRATE_TASK_TYPE, rows, ["store", "task"]);
  const r = itemCommit({ type, item: null, actor: { uid: "admin", orgId: "orgA" },
    allow: () => true, now: 5, id: M.migrateItemId("assignment", "a1"),
    intent: M.migrateAssignmentIntent(ASSIGNMENT) });
  assert.ok(r.ok, JSON.stringify(r.details));
  assert.equal(r.item.title, "Store Alpha · Design");
  assert.ok(r.item.facets.includes("store:store-alpha"));
  assert.ok(r.item.facets.includes("task:design"));
  assert.ok(r.item.facets.includes("assignee:w1"));
  assert.ok(r.item.facets.includes("status:open"));
});
T("a real campaign survives the engine intact", () => {
  const rows = [CAMPAIGN].map(c => ({ stage: (c.stages[c.cur] || {}).name }));
  const type = M.migrateTypeWithOptions(M.MIGRATE_CAMPAIGN_TYPE, rows, ["stage"]);
  const r = itemCommit({ type, item: null, actor: { uid: "admin", orgId: "orgA" },
    allow: () => true, now: 5, id: M.migrateItemId("campaign", "c1"),
    intent: M.migrateCampaignIntent(CAMPAIGN) });
  assert.ok(r.ok, JSON.stringify(r.details));
  assert.ok(r.item.facets.includes("stage:design"));
  assert.ok(r.item.facets.includes("assignee:w2") && r.item.facets.includes("assignee:w3"));
});
T("an assignment with an unknown store would be REFUSED - which is why options are grown", () => {
  const bare = M.MIGRATE_TASK_TYPE;   // options still empty
  const r = itemCommit({ type: bare, item: null, actor: { uid: "a", orgId: "orgA" },
    allow: () => true, now: 5, id: "x", intent: M.migrateAssignmentIntent(ASSIGNMENT) });
  assert.equal(r.error, "invalid");
  assert.ok(r.details.some(d => d.key === "store"));
});

/* ---------- a chain becomes a track ---------- */
const CHAIN = { title: "Spring launch", stages: [
  { name: "Copy",   owners: [{ uid: "w1", uname: "W1" }], days: 2 },
  { name: "Design", owners: [{ uid: "w2", uname: "W2" }, { uid: "w3", uname: "W3" }], hours: 6 },
  { name: "Send",   uid: "w1", uname: "W1" }          // a v1 stage, bare uid
]};

T("a chain becomes a straight line of stops, ending somewhere", () => {
  const bp = M.migrateCampaignBlueprint(CHAIN);
  assert.deepEqual(bp.nodes.map(n => n.type), ["trigger", "role", "role", "role", "action"]);
  assert.equal(bp.edges.length, 4);
});

T("the generated blueprint actually validates - it can be published", () => {
  assert.deepEqual(wfValidate(M.migrateCampaignBlueprint(CHAIN)), []);
});

T("a stage with several owners becomes a stop that waits for all of them", () => {
  const bp = M.migrateCampaignBlueprint(CHAIN);
  const design = bp.nodes.find(n => n.config.label === "Design");
  assert.deepEqual(design.config.assignees, ["w2", "w3"]);
  assert.equal(design.config.completionPolicy, "all");
});

T("a stage with one owner does not wait for a crowd", () => {
  const copy = M.migrateCampaignBlueprint(CHAIN).nodes.find(n => n.config.label === "Copy");
  assert.deepEqual(copy.config.assignees, ["w1"]);
  assert.equal(copy.config.completionPolicy, undefined);
});

T("a v1 stage carrying a bare uid still gets its person", () => {
  const send = M.migrateCampaignBlueprint(CHAIN).nodes.find(n => n.config.label === "Send");
  assert.deepEqual(send.config.assignees, ["w1"]);
});

T("a stage budget becomes the stop's deadline, in milliseconds", () => {
  const bp = M.migrateCampaignBlueprint(CHAIN);
  assert.equal(bp.nodes.find(n => n.config.label === "Copy").config.dueAfter, 2 * 86400000);
  assert.equal(bp.nodes.find(n => n.config.label === "Design").config.dueAfter, 6 * 3600000);
  assert.equal(bp.nodes.find(n => n.config.label === "Send").config.dueAfter, undefined);
});

T("a stage with nobody on it still answers 'who works here'", () => {
  const bp = M.migrateCampaignBlueprint({ title: "T", stages: [{ name: "Review" }] });
  assert.deepEqual(wfValidate(bp), []);
  assert.equal(bp.nodes[1].config.role, "anyone");
});

T("a chain with no stages is not a workflow and does not pretend to be", () => {
  assert.equal(M.migrateCampaignBlueprint({ title: "T", stages: [] }), null);
  assert.equal(M.migrateCampaignBlueprint({ title: "T" }), null);
});

T("a converted chain arrives as a DRAFT, so nobody rides it unreviewed", () => {
  assert.equal(M.migrateCampaignBlueprint(CHAIN).status, "draft");
});

/* The real proof: the baton passes down the generated track exactly the
   way it passed down the chain - one stage at a time, and the two-owner
   stage refusing to move until both of them have acted. */
T("the baton passes down the generated track, and waits where it always waited", () => {
  const bp = M.migrateCampaignBlueprint(CHAIN);
  bp.id = "bp1"; bp.orgId = "orgA"; bp.ownerId = "admin";
  let st = wfStartRun({ blueprint: bp, runId: "r1", taskId: null, task: { title: "Spring" }, now: 0 });
  const open = () => st.nodeRuns.find(nr => nr.status === "in_progress");

  // stage 1: one owner, one action
  assert.equal(open().nodeId, "s0");
  assert.equal(open().dueAt, 2 * 86400000, "the Copy budget did not ride along");
  st = wfAdvance(st, { type: "complete", nodeRunId: open().id }, { now: 100 });

  // stage 2: two owners - one is not enough
  assert.equal(open().nodeId, "s1");
  st = wfAdvance(st, { type: "complete", nodeRunId: open().id, by: "w2" }, { now: 200 });
  assert.equal(open().nodeId, "s1", "the baton moved on one approval of two");
  st = wfAdvance(st, { type: "complete", nodeRunId: open().id, by: "w3" }, { now: 300 });

  // stage 3, then the end
  assert.equal(open().nodeId, "s2");
  st = wfAdvance(st, { type: "complete", nodeRunId: open().id }, { now: 400 });
  assert.equal(st.run.status, "completed");
  assert.ok(st.nodeRuns.some(nr => nr.nodeId === "done" && nr.status === "completed"));
});

/* ============================================================
   ROUND TRIP — the gate on the read cutover.

   Reading the queue from Items is only safe if an assignment can go
   assignment -> Item -> queue row and come back the same. Every field
   the queue rendering actually touches is listed here explicitly, so a
   field added to that screen later without being carried through the
   model fails HERE rather than by quietly vanishing off somebody's
   task list on a working morning.
   ============================================================ */
const QUEUE_FIELDS = ["id", "store", "task", "note", "snote", "dueDate", "dueTime",
                      "fromName", "fromEmail", "groupId", "groupSize", "seenAt", "done", "createdAt"];

const roundTrip = (row, srcId) => {
  const type = M.migrateTypeWithOptions(M.MIGRATE_TASK_TYPE, [row], ["store", "task"]);
  const r = itemCommit({ type, item: null, actor: { uid: "a", orgId: "orgA" }, allow: () => true,
    now: row.createdAt || 1, id: M.migrateItemId("assignment", srcId),
    intent: M.migrateAssignmentIntent(row) });
  if (!r.ok) throw new Error("the engine refused it: " + JSON.stringify(r.details));
  const item = Object.assign({}, r.item, { importedFrom: M.migrateSource("assignment", srcId) });
  return M.itemToQueueRow(item);
};

T("round trip: every field the queue reads survives assignment -> Item -> row", () => {
  const back = roundTrip(ASSIGNMENT, "a1");
  const expected = {
    id: "a1", store: "Store Alpha", task: "Design", note: "Three banners, dark theme",
    snote: null, dueDate: "2026-09-11", dueTime: "17:30", fromName: "Ada",
    fromEmail: "a@b.c", groupId: "g1", groupSize: 3, seenAt: null, done: false, createdAt: 1000
  };
  QUEUE_FIELDS.forEach(k =>
    assert.deepEqual(back[k], expected[k], "the queue would lose `" + k + "`: got " + JSON.stringify(back[k])));
});

T("round trip: the id that comes back is the ASSIGNMENT's, because writes still go there", () => {
  const back = roundTrip(ASSIGNMENT, "a1");
  assert.equal(back.id, "a1", "finishing this row would have finished the wrong document");
  assert.equal(back.itemId, "im_assignment_a1");
});

T("round trip: a finished row comes back finished", () => {
  assert.equal(roundTrip({ ...ASSIGNMENT, done: true }, "a2").done, true);
});

T("round trip: a row with no group, no due date and no brief survives being empty", () => {
  const bare = { toUid: "w1", store: "S", task: "T", createdAt: 5 };
  const back = roundTrip(bare, "a3");
  assert.equal(back.groupId, null);
  assert.equal(back.dueDate, null);
  assert.equal(back.groupSize, null);
  assert.equal(back.note, "");
  assert.equal(back.id, "a3");
});

T("round trip: a seen receipt survives, or the queue re-stamps every row forever", () => {
  assert.equal(roundTrip({ ...ASSIGNMENT, seenAt: 1700 }, "a5").seenAt, 1700);
});

T("round trip: a hand-off system note is not dropped", () => {
  const back = roundTrip({ ...ASSIGNMENT, snote: "Accepted hand-off from W2" }, "a4");
  assert.equal(back.snote, "Accepted hand-off from W2");
});

T("an Item that was never an assignment keeps its own id", () => {
  const row = M.itemToQueueRow({ id: "native1", fields: {}, assigneeIds: ["w1"], status: "open" });
  assert.equal(row.id, "native1");
});

/* ---------- the queue shows every kind of work ----------
   The assigned list admitted only the migrated `task` type, which was
   true while those were the only types that existed and silently hid
   every type a customer or a pack has created since. */
T("a custom type's row is titled by its Item title", () => {
  // there is no `task` field on a Sponsorship - its name is the title
  assert.equal(M.itemToQueueRow({ id: "i1", typeId: "sponsor", title: "Outreach to brands",
    fields: {}, assigneeIds: ["u1"] }).task, "Outreach to brands");
});
T("a migrated task still uses its own field", () => {
  assert.equal(M.itemToQueueRow({ id: "i2", typeId: "task", title: "ignored",
    fields: { task: "Restock" }, assigneeIds: ["u1"] }).task, "Restock");
});
T("a row knows whether an assignment stands behind it", () => {
  // update() on a document that is not there fails the whole batch, so
  // the receipt stamp has to know which rows have one
  assert.equal(M.itemToQueueRow({ id: "i1", typeId: "task", fields: {},
    importedFrom: "assignment:a1", assigneeIds: [] }).fromAssignment, true);
  assert.equal(M.itemToQueueRow({ id: "i1", typeId: "task", fields: {}, assigneeIds: [] }).fromAssignment, false);
  // ...and the row id follows the same fact
  assert.equal(M.itemToQueueRow({ id: "i1", typeId: "task", fields: {},
    importedFrom: "assignment:a1", assigneeIds: [] }).id, "a1");
  assert.equal(M.itemToQueueRow({ id: "i1", typeId: "task", fields: {}, assigneeIds: [] }).id, "i1");
});
T("a row with neither a field nor a title is empty, not undefined", () => {
  assert.equal(M.itemToQueueRow({ id: "i3", typeId: "x", fields: {}, assigneeIds: [] }).task, "");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
