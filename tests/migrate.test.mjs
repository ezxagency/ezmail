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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
