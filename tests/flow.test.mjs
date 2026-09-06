/* A TO Z: one organization, from applying a template to a baton passing
   between two people, driven against an in-memory Firestore.

     node tests/flow.test.mjs

   Why this exists. Every bug found by hand in this app has lived in the
   GLUE - the code between a decision and a write - and the other suites
   test decisions. A pure test cannot notice that a write goes to a
   collection with nothing in it, that a queue filter admits one type, or
   that a notification is addressed to somebody nothing queries for. This
   walks the real files through the real sequence and checks what actually
   landed in the database. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { makeDb } from "./fakedb.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 190)); }
};
const plain = v => JSON.parse(JSON.stringify(v));

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div><div id="sheet"><div id="sheetBody"></div></div>
  <div id="toast"></div><div id="orgBody"></div><div id="workBody"></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
const db = makeDb();
const AUTH = { currentUser: { uid: "owner1", email: "owner@x.com" } };

ctx.console = console;
ctx.firebase = { initializeApp(){}, auth(){ return AUTH; }, firestore(){ return db; } };

["js/config.js", "js/permissions.js", "js/item-engine.js", "js/migrate.js",
 "js/items.js", "js/workflow-engine.js", "js/automation.js", "js/handoff.js",
 "js/packs.js", "js/notify.js", "js/org.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

// the app's own db/auth, pointed at the fake
vm.runInContext(`db = firebase.firestore(); auth = firebase.auth();
  toast = function(){}; openSheet = function(){}; closeSheet = function(){};
  enterOrgPage = function(){}; enterWorkPage = function(){};`, ctx);

const run = expr => vm.runInContext(expr, ctx);
const runAsync = expr => vm.runInContext(`(async () => { ${expr} })()`, ctx);
const get = async (path) => (await db.collection(path.split("/").slice(0, -1).join("/"))
  .doc(path.split("/").pop()).get()).data();
/* The run starts AFTER the item commits, deliberately - a failure to
   start it must not turn a successful save into an error the person
   sees. So the test waits for the effect rather than for a guessed
   number of milliseconds. */
const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise(res => setTimeout(res, 5));
  }
  throw new Error("timed out waiting for: " + what);
};
const find = (col, pred) => [...db._store.entries()]
  .filter(([p]) => p.split("/").slice(0, -1).join("/") === col)
  .map(([p, d]) => Object.assign({ id: p.split("/").pop() }, d))
  .filter(pred || (() => true));

/* ---------- the org exists, as creating one leaves it ---------- */
const ORG = "orgA";
await db.collection("orgs").doc(ORG).set({ name: "Their Co", ownerUid: "owner1", createdAt: 1 });
await db.collection("orgs").doc(ORG).collection("members").doc("owner1").set({ uid: "owner1", roleId: "owner", joinedAt: 1 });
await db.collection("orgs").doc(ORG).collection("roles").doc("owner").set({ name: "Owner", permissions: ["*:*:org"] });
await db.collection("memberOf").doc("owner1").set({ orgId: ORG, at: 1 });

await T("an owner's session finds their organization", async () => {
  const s = await runAsync(`return await orgEnsure();`);
  assert.equal(s.orgId, ORG);
  assert.equal(s.myRoleId, "owner");
});

/* ---------- apply a template ---------- */
await T("applying a pack creates its roles, types, rules AND blueprints", async () => {
  const r = await runAsync(`return await itemsApplyPack("content");`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.created.itemTypes >= 2 && r.created.roles >= 3);
  assert.ok(r.created.blueprints >= 1, "no compiled tracks were written");
  const video = await get("orgs/" + ORG + "/itemTypes/video");
  assert.ok(video, "the video type is not there");
  assert.equal(video.workflowId, "pk_content_bp_video");
  assert.ok(await get("orgs/" + ORG + "/blueprints/pk_content_bp_video"), "its blueprint is not there");
});

await T("the blueprint it wrote is one the real engine accepts", async () => {
  const bp = await get("orgs/" + ORG + "/blueprints/pk_content_bp_video");
  assert.deepEqual(plain(run(`wfValidate(${JSON.stringify(bp)})`)), []);
});

/* ---------- seat two people ---------- */
await db.collection("orgs").doc(ORG).collection("members").doc("staff1").set({ uid: "staff1", roleId: "staff", joinedAt: 1 });
await db.collection("orgs").doc(ORG).collection("members").doc("lead1").set({ uid: "lead1", roleId: "lead", joinedAt: 1 });
run(`orgInvalidate();`);

await T("a seated member finds their org WITHOUT a memberOf pointer", async () => {
  // the collection-group query - the one that needed an index nobody had
  // declared, and whose failure looked exactly like having no organization
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate();`);
  const s = await runAsync(`return await orgEnsure();`);
  assert.ok(s, "a seated member could not find the org they are in");
  assert.equal(s.orgId, ORG);
  assert.equal(s.myRoleId, "staff");
});

/* ---------- create work of a tracked type ---------- */
AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
run(`orgInvalidate();`);
let itemId = null;

await T("creating tracked work starts its run and hands it to the first stop", async () => {
  const type = await get("orgs/" + ORG + "/itemTypes/video");
  const r = await runAsync(`
    const t = ${JSON.stringify(Object.assign({ id: "video" }, await get("orgs/" + ORG + "/itemTypes/video")))};
    return await itemSave(t, null, { kind: "create", title: "Video #23", fields: {}, assigneeIds: [] });`);
  assert.ok(r.ok, JSON.stringify(r));
  itemId = r.item.id;
  const item = await until(async () => {
    const it = await get("orgs/" + ORG + "/items/" + itemId);
    return (it && it.workflowRunId && it.status === "scripting") ? it : null;
  }, "the run to start and hand the work to its first stop").catch(async e => {
    const items = [...db._store.entries()].filter(([p]) => p.includes("/items/"));
    console.log("    items in store:", JSON.stringify(items.map(([p, d]) =>
      ({ path: p, status: d.status, runId: d.workflowRunId, who: d.assigneeIds }))));
    const runs = [...db._store.entries()].filter(([p]) => p.includes("/runs/"));
    console.log("    runs in store:", runs.length);
    throw e;
  });
  assert.ok(item.workflowRunId, "no run was started");
  // the content pack's first stop is "Write the script", held by staff
  assert.deepEqual(plain(item.assigneeIds), ["staff1"]);
  assert.equal(item.status, "scripting");
});

await T("the run carries its stops inside it, so advancing can be atomic", async () => {
  const item = await get("orgs/" + ORG + "/items/" + itemId);
  const runDoc = await get("orgs/" + ORG + "/runs/" + item.workflowRunId);
  assert.ok(Array.isArray(runDoc.nodeRuns) && runDoc.nodeRuns.length, "the stops are not on the run");
});

await T("the holder was told they were handed it", async () => {
  const notes = find("notifications", n => n.toUid === "staff1");
  assert.ok(notes.length, "nobody told the person holding it");
  assert.ok(notes[0].msg, "the notification has no headline, so it renders as 'Someone finished'");
  assert.match(notes[0].msg, /Video #23/);
});

/* ---------- the assigned queue actually returns it ---------- */
await T("the assigned query finds it for the holder", async () => {
  const snap = await db.collection("orgs/" + ORG + "/items")
    .where("facets", "array-contains", "assignee:staff1").get();
  assert.equal(snap.size, 1, "the work is assigned to them and the queue query cannot see it");
  assert.equal(snap.docs[0].data().typeId, "video");
});

await T("its queue row is titled, and says what kind and what stage", async () => {
  const item = Object.assign({ id: itemId }, await get("orgs/" + ORG + "/items/" + itemId));
  const type = Object.assign({ id: "video" }, await get("orgs/" + ORG + "/itemTypes/video"));
  const row = run(`itemToQueueRow(${JSON.stringify(item)}, ${JSON.stringify(type)})`);
  assert.equal(row.task, "Video #23");
  assert.equal(row.fromAssignment, false, "there is no assignment behind app-created work");
  assert.equal(row.itemId, itemId);
  assert.equal(row.store, "Video", "the row does not say what kind of work it is");
  assert.equal(row.stage, "Scripting", "the row does not say what stage it is at");
});

/* ---------- finishing passes the baton ---------- */
await T("the wrong person cannot finish somebody else's stop", async () => {
  AUTH.currentUser = { uid: "lead1", email: "l@x.com" };
  run(`orgInvalidate();`);
  const r = await runAsync(`return await itemsFinishFromQueue(${JSON.stringify(itemId)}, "");`);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not-your-stop");
});

await T("MARK DONE passes it to the next person", async () => {
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate();`);
  const r = await runAsync(`return await itemsFinishFromQueue(${JSON.stringify(itemId)}, "");`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.how, "advanced");
  const item = await get("orgs/" + ORG + "/items/" + itemId);
  // stop 2 of the content pack is "Film it", also staff - so it stays with
  // them and the STAGE moves. Without the stage on the row that would look
  // like a dead button, which is exactly how it was reported.
  assert.equal(item.status, "filming");
  const type = Object.assign({ id: "video" }, await get("orgs/" + ORG + "/itemTypes/video"));
  const row = run(`itemToQueueRow(${JSON.stringify(Object.assign({ id: itemId }, item))}, ${JSON.stringify(type)})`);
  assert.equal(row.stage, "Filming", "the row still reads as the stage it just left");
});

await T("and again, to a different role, who is told", async () => {
  const before = find("notifications", n => n.toUid === "lead1").length;
  const r = await runAsync(`return await itemsFinishFromQueue(${JSON.stringify(itemId)}, "");`);
  assert.ok(r.ok, JSON.stringify(r));
  const item = await get("orgs/" + ORG + "/items/" + itemId);
  assert.equal(item.status, "editing");
  assert.deepEqual(plain(item.assigneeIds), ["lead1"], "it did not reach the editor");
  assert.ok(find("notifications", n => n.toUid === "lead1").length > before, "the editor was not told");

  // and it is GONE from the queue of the person who finished it
  const mine = await db.collection("orgs/" + ORG + "/items")
    .where("facets", "array-contains", "assignee:staff1").get();
  assert.equal(mine.size, 0, "it stayed on the dashboard of the person who passed it on");
});

await T("the trail records who finished each stop", async () => {
  const item = await get("orgs/" + ORG + "/items/" + itemId);
  const runDoc = await get("orgs/" + ORG + "/runs/" + item.workflowRunId);
  const done = (runDoc.nodeRuns || []).filter(n => n.status === "completed" && n.nodeType === "role");
  assert.equal(done.length, 2);
  assert.deepEqual(plain(done.map(n => n.completedBy)), ["staff1", "staff1"]);
});

/* ---------- work with no handoff still finishes ---------- */
await T("untracked work finishes by status, and says where it went", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
  await db.collection("orgs").doc(ORG).collection("itemTypes").doc("plain")
    .set({ name: "Plain", fields: [], statuses: [{ key: "open", label: "Open" }, { key: "done", label: "Done" }], workflowId: null });
  const r = await runAsync(`
    const t = { id: "plain", name: "Plain", fields: [], statuses: [{ key: "open", label: "Open" }, { key: "done", label: "Done" }] };
    return await itemSave(t, null, { kind: "create", title: "Just a job", fields: {}, assigneeIds: ["staff1"] });`);
  assert.ok(r.ok);
  const fin = await runAsync(`return await itemsFinishFromQueue(${JSON.stringify(r.item.id)}, "");`);
  assert.ok(fin.ok, JSON.stringify(fin));
  assert.equal(fin.how, "done");
  assert.equal((await get("orgs/" + ORG + "/items/" + r.item.id)).status, "done");
});

/* ---------- the two reasons it stayed on the dashboard ---------- */
await T("work on a tracked type with no run is healed, not jumped to the end", async () => {
  // exactly the shape of the item created before the run pointer persisted:
  // tracked type, no workflowRunId. Finishing it used to skip every stop
  // and set the last status.
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate();`);
  await db.collection("orgs").doc(ORG).collection("items").doc("old1").set({
    id: "old1", orgId: ORG, typeId: "video", title: "Video #23", status: "idea",
    fields: {}, facets: ["type:video", "status:idea", "assignee:staff1"],
    assigneeIds: ["staff1"], workflowRunId: null,
    createdAt: 1, updatedAt: 1, createdBy: "owner1" });
  const r = await runAsync(`return await itemsFinishFromQueue("old1", "");`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.how, "advanced", "it finished by status instead of travelling its track");
  const it = await get("orgs/" + ORG + "/items/old1");
  assert.ok(it.workflowRunId, "it was not put on its track");
  assert.notEqual(it.status, "published", "it jumped straight to the end");
});

await T("finished work leaves the queue, whatever the type calls finished", async () => {
  // the other half: the queue dropped only status === "done", which no
  // custom type has, so finished work sat on the dashboard forever
  const type = { id: "sponsor", name: "Sponsorship",
    statuses: [{ key: "talking", label: "Talking" }, { key: "paid", label: "Paid" }] };
  assert.equal(run(`itemDoneStatus(${JSON.stringify(type)})`), "paid");
  assert.equal(run(`itemDoneStatus({ statuses: [{ key: "open" }, { key: "done" }, { key: "archived" }] })`), "done");
  assert.equal(run(`itemDoneStatus({ statuses: [] })`), null);
  assert.equal(run(`itemDoneStatus(null)`), null);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
