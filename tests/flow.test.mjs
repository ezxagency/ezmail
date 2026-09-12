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

/* ---------- reaching the end of a track means FINISHED ---------- */
await T("finishing the last stop finishes the work, not just the stop", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
  const type = Object.assign({ id: "video" }, await get("orgs/" + ORG + "/itemTypes/video"));
  const r = await runAsync(`
    return await itemSave(${JSON.stringify(type)}, null,
      { kind: "create", title: "Video #99", fields: {}, assigneeIds: [] });`);
  assert.ok(r.ok, JSON.stringify(r));
  const id = r.item.id;
  await until(async () => (await get("orgs/" + ORG + "/items/" + id) || {}).workflowRunId, "the run to start");
  // walk it off the end: four stops, owner overrides each
  for (let i = 0; i < 4; i++) {
    const it = Object.assign({ id }, await get("orgs/" + ORG + "/items/" + id));
    const runDoc = await get("orgs/" + ORG + "/runs/" + it.workflowRunId);
    const active = (runDoc.nodeRuns || []).find(n => n.status === "in_progress" && n.nodeType === "role");
    if (!active) break;
    const out = await runAsync(`return await itemsAdvanceHandoff(${JSON.stringify(it)},
      ${JSON.stringify(type)}, ${JSON.stringify(active.id)}, {});`);
    assert.ok(out.ok, "stop " + i + ": " + JSON.stringify(out));
  }
  const done = await get("orgs/" + ORG + "/items/" + id);
  // the LAST STOP says "scheduled"; the TYPE says finished is "published".
  // hoStatus reads the active stop and a finished run has none, so this
  // used to stop at "scheduled" and read as unfinished forever.
  assert.equal(done.status, "published", "work that ran the whole track still reads as mid-track");
  assert.deepEqual(plain(done.assigneeIds), [], "it is finished and still on somebody's dashboard");
});

/* ---------- deleting a type must not orphan its work ---------- */
await T("a type in use refuses to be deleted", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
  const n = await runAsync(`return await itemsCountOfType("video");`);
  assert.ok(n > 0, "the count cannot see work of that type");
  // orgTypeDelete refuses above zero - the orphan this prevents is an Item
  // pointing at a type that is gone: unopenable, unfinishable, and still
  // on somebody's dashboard
});

/* ---------- THE ONE THAT WAS REPORTED ----------
   "the work is deleted from admin's end but still showing in test's
   dashboard and it's not going." It was never deleted. The type was.
   The Work page is tabbed BY TYPE, so with the type gone the work was
   reachable from no tab and looked deleted; the assigned queue reads by
   FACET, so it kept showing - unopenable, unfinishable, undeletable. */
await T("work orphaned by a deleted type is findable again", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
  await db.collection("orgs").doc(ORG).collection("items").doc("zombie1").set({
    id: "zombie1", orgId: ORG, typeId: "video", title: "Video #23", status: "idea",
    fields: {}, facets: ["type:video", "status:idea", "assignee:staff1"],
    assigneeIds: ["staff1"], workflowRunId: null,
    createdAt: 1, updatedAt: 1, createdBy: "owner1" });
  // the owner deletes the type, as they did
  await db.collection("orgs").doc(ORG).collection("itemTypes").doc("video").delete();
  run(`orgInvalidate();`);

  const r = await runAsync(`return await itemsOrphans();`);
  assert.ok(r.ok, JSON.stringify(r));
  const ids = r.rows.map(x => x.id);
  assert.ok(ids.indexOf("zombie1") >= 0, "the owner still cannot see the work they think they deleted");
});

await T("and the owner can actually clear it", async () => {
  const it = Object.assign({ id: "zombie1" }, await get("orgs/" + ORG + "/items/zombie1"));
  const r = await runAsync(`return await itemsDeleteWork(${JSON.stringify(it)});`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(await get("orgs/" + ORG + "/items/zombie1"), undefined, "it survived the delete");
  // and so leaves the holder's queue, which reads these same documents
  const mine = await db.collection("orgs/" + ORG + "/items")
    .where("facets", "array-contains", "assignee:staff1").get();
  assert.ok(mine.docs.every(d => d.id !== "zombie1"), "it is still on the holder's dashboard");
});

/* ---------- deleting an assignment has to delete its mirror ----------
   The Team page's confirm says "This removes it for them too". It deleted
   the assignment document; the worker's dashboard reads ITEMS. So every
   deleted assignment left its mirror on their queue forever, and the
   promise in the dialog is why nobody thought to check. */
await T("an assignment deleted by the admin leaves the worker's queue", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
  const aid = "asg_del_1";
  await db.collection("assignments").doc(aid).set({
    toUid: "staff1", toName: "Staff", store: "TEST STORE", task: "Task Review",
    note: "please review", fromName: "Owner", createdAt: 1, done: false, doneAt: null });
  await runAsync(`return await itemsMirrorAssignments([{ id: ${JSON.stringify(aid)},
    row: ${JSON.stringify({ toUid: "staff1", toName: "Staff", store: "TEST STORE", task: "Task Review",
      note: "please review", fromName: "Owner", createdAt: 1, done: false, doneAt: null })} }]);`);

  const mirrorId = run(`migrateItemId("assignment", ${JSON.stringify(aid)})`);
  await until(async () => await get("orgs/" + ORG + "/items/" + mirrorId), "the mirror to be written");
  let mine = await db.collection("orgs/" + ORG + "/items")
    .where("facets", "array-contains", "assignee:staff1").get();
  assert.ok(mine.docs.some(d => d.id === mirrorId), "the mirror never reached their queue");

  // the admin deletes it, exactly as the Team page does
  await db.collection("assignments").doc(aid).delete();
  await runAsync(`return await itemsMirrorAssignmentsDelete([${JSON.stringify(aid)}]);`);

  assert.equal(await get("orgs/" + ORG + "/items/" + mirrorId), undefined, "the mirror survived");
  mine = await db.collection("orgs/" + ORG + "/items")
    .where("facets", "array-contains", "assignee:staff1").get();
  assert.ok(mine.docs.every(d => d.id !== mirrorId),
    "the admin was told it was removed for them too, and it was not");
});

await T("deleting a mirror that was never written is not an error", async () => {
  // work assigned before the Item model existed has no mirror; a cleanup
  // that threw on that would take the real deletion down with it
  await runAsync(`return await itemsMirrorAssignmentsDelete(["never_mirrored_1", ""]);`);
});

/* ---------- an owner is a SEAT, not a row that can go missing ---------- */
await T("an owner whose role document is gone still holds every permission", async () => {
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  // an org created before the seed roles, or one whose role write failed:
  // the seat still says owner and firestore.rules still grants them the
  // whole tenant, but the client looked up a DOCUMENT and found none
  await db.collection("orgs").doc(ORG).collection("roles").doc("owner").delete();
  run(`orgInvalidate();`);
  const perms = await runAsync(`return await itemActorPermissions();`);
  assert.ok(perms.length, "the owner was silently left holding no permissions at all");
  const may = await runAsync(`return await itemsMayDeleteWork();`);
  assert.equal(may.ok, true, "the owner cannot clear work the server would let them clear");

  await db.collection("orgs").doc(ORG).collection("items").doc("orphan_perm").set({
    id: "orphan_perm", orgId: ORG, typeId: "gone", title: "Nike · Design", status: "open",
    fields: {}, facets: ["assignee:staff1"], assigneeIds: ["staff1"],
    createdAt: 1, updatedAt: 1, createdBy: "someone_else" });
  const r = await runAsync(`return await itemsDeleteWork(${JSON.stringify({
    id: "orphan_perm", orgId: ORG, typeId: "gone", title: "Nike · Design",
    assigneeIds: ["staff1"], createdBy: "someone_else" })});`);
  assert.ok(r.ok, "the owner was refused their own tenant's work: " + JSON.stringify(r));
  // put it back for the suites after this one
  await db.collection("orgs").doc(ORG).collection("roles").doc("owner")
    .set({ name: "Owner", permissions: ["*:*:org"] });
  run(`orgInvalidate();`);
});

await T("a role with no org-wide delete is told so BEFORE it presses anything", async () => {
  // staff holds item:update:assigned and no delete at all - the tab must
  // ask this before drawing a button whose only outcome is a refusal
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate();`);
  const may = await runAsync(`return await itemsMayDeleteWork();`);
  assert.equal(may.ok, false);
  assert.equal(may.roleId, "staff", "the refusal cannot name the role it is about");
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate();`);
});

await T("an orphan cannot be finished, so the queue must not offer to", async () => {
  // itemCommit refuses every intent with no type - which is right, and is
  // why the Done button on that row could only ever produce an error
  const refused = run(`itemCommit({ type: null, item: { id: "z", orgId: "${ORG}" },
    intent: { kind: "set_status", status: "done" },
    actor: { uid: "staff1", orgId: "${ORG}" }, allow: () => true, now: 1 })`);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "no-type");
});

/* ---------- a NEW org that applies "Just tasks" first, then assigns ----------
   Order matters here and is the whole bug: the pack lands before the
   composer has ever mirrored anything, so the pack's type is what the
   mirror finds under the id it reads. */
const ORG_B = "orgB";
await db.collection("orgs").doc(ORG_B).set({ name: "Second Co", ownerUid: "owner2", createdAt: 1 });
await db.collection("orgs").doc(ORG_B).collection("members").doc("owner2").set({ uid: "owner2", roleId: "owner", joinedAt: 1 });
await db.collection("orgs").doc(ORG_B).collection("members").doc("hand2").set({ uid: "hand2", roleId: "staff", joinedAt: 1 });
await db.collection("orgs").doc(ORG_B).collection("roles").doc("owner").set({ name: "Owner", permissions: ["*:*:org"] });
await db.collection("memberOf").doc("owner2").set({ orgId: ORG_B, at: 1 });

await T("in a fresh org, the simple pack leaves the composer mirror's type id alone", async () => {
  AUTH.currentUser = { uid: "owner2", email: "owner2@x.com" };
  run(`orgInvalidate(); itemsTaskTypeCache = null;`);
  const r = await runAsync(`return await itemsApplyPack("simple");`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.created.itemTypes >= 1, "the pack wrote no type at all");
  const taken = await get("orgs/" + ORG_B + "/itemTypes/task");
  assert.equal(taken, undefined, "the pack's Task type sits under the id the mirror reads");
});

await T("and an assignment made afterwards still reaches the queue as an Item", async () => {
  run(`orgInvalidate(); itemsTaskTypeCache = null;`);
  await runAsync(`await itemsMirrorAssignments([{ id: "b1", row: {
    toUid: "hand2", toName: "Hand", store: "Alpha", task: "Copy", note: "", createdAt: 5,
    done: false, doneAt: null, dueDate: null, dueTime: "", groupId: null, groupSize: 1, seenAt: null } }]);`);
  const items = find("orgs/" + ORG_B + "/items", it => /b1$/.test(it.id));
  assert.equal(items.length, 1, "the mirror refused the row - the queue would never show it");
  assert.equal(items[0].status, "open");
  assert.ok((items[0].facets || []).includes("assignee:hand2"));
  // back to the first org for everything that follows
  AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
  run(`orgInvalidate(); itemsTaskTypeCache = null;`);
});

/* ---------- the composer's edit path reaches the mirror ---------- */
await T("editing an assignment updates its Item rather than replacing it", async () => {
  run(`orgInvalidate(); itemsTaskTypeCache = null;`);
  const row = { toUid: "staff1", toName: "Grace", store: "Alpha", task: "Copy", note: "first draft", createdAt: 5,
    done: false, doneAt: null, dueDate: null, dueTime: "", groupId: null, groupSize: 1, seenAt: null };
  await runAsync(`await itemsMirrorAssignments([{ id: "e1", row: ${JSON.stringify(row)} }]);`);
  const before = find("orgs/" + ORG + "/items", it => /e1$/.test(it.id));
  assert.equal(before.length, 1);
  // a run stamped behind the composer's back, which a re-create would lose
  await db.collection("orgs").doc(ORG).collection("items").doc(before[0].id).update({ workflowRunId: "runX" });
  await runAsync(`await itemsMirrorAssignments([{ id: "e1", row: ${JSON.stringify(Object.assign({}, row, { note: "second draft", dueDate: "2030-01-02" }))} }]);`);
  const after = find("orgs/" + ORG + "/items", it => /e1$/.test(it.id));
  assert.equal(after.length, 1, "the edit made a second Item");
  assert.equal(after[0].fields.note, "second draft", "the edited note never reached the Item");
  assert.equal(after[0].fields.dueDate, "2030-01-02");
  assert.equal(after[0].workflowRunId, "runX", "the edit rebuilt the Item and dropped its run");
});

/* ---------- accepting a hand-off lands on the dashboard that reads Items ---------- */
await T("an accepted hand-off is mirrored into the queue", async () => {
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate(); itemsTaskTypeCache = null; S.worker = "Grace"; isAdmin = false; isMember = false;`);
  await db.collection("notifications").doc("n1").set({ toUid: "staff1", kind: "handoff", status: "pending",
    fromName: "Ada", store: "Beta", task: "Design", text: "please take this", createdAt: 1, read: false });
  try {
    await runAsync(`await handoffAccept({ id: "n1", fromName: "Ada", store: "Beta", task: "Design", text: "please take this" });`);
    const asg = find("assignments", a => a.toUid === "staff1" && a.task === "Design");
    assert.equal(asg.length, 1, "no assignment was written");
    const item = await until(() => find("orgs/" + ORG + "/items", it => it.title === "Beta · Design")[0], "the mirrored Item");
    assert.ok((item.facets || []).includes("assignee:staff1"), "the Item is not addressed to the accepter");
  } finally {
    AUTH.currentUser = { uid: "owner1", email: "owner@x.com" };
    run(`orgInvalidate(); itemsTaskTypeCache = null;`);
  }
});

/* ---------- a member's completion tells nobody it cannot reach ---------- */
await T("a member's @mention writes no notification at all", async () => {
  run(`isMember = true; isAdmin = false;`);
  const before = find("notifications").length;
  await runAsync(`await dispatchMentionNotifications("done - @Grace please review", "x1", { store: "A", task: "T" });`);
  assert.equal(find("notifications").length, before,
    "a member's completion wrote a notification the rules would refuse or an offer nobody can accept");
  run(`isMember = false;`);
});

await T("a team member's @mention still makes the offer", async () => {
  run(`isMember = false; isAdmin = false; notifDir = null;`);
  await db.collection("directory").doc("staff1").set({ uid: "staff1", name: "Grace", email: "s@x.com", orgId: ORG });
  const before = find("notifications").length;
  await runAsync(`await dispatchMentionNotifications("done - @Grace please review", "x1", { store: "A", task: "T" });`);
  const offers = find("notifications", n => n.kind === "handoff" && n.toUid === "staff1");
  assert.ok(find("notifications").length > before && offers.length >= 1, "the offer to Grace was not written");
});

/* ---------- a save from a stale copy must not erase a side write ---------- */
await T("saving from a page-old copy keeps a stamp written in between", async () => {
  run(`orgInvalidate();`);
  const type = await get("orgs/" + ORG + "/itemTypes/simpletask");
  const created = await runAsync(`return await itemSave(${JSON.stringify(Object.assign({ id: "simpletask" }, type))}, null,
    { kind: "create", title: "Late thing", fields: {}, assigneeIds: ["staff1"] });`);
  assert.ok(created.ok, JSON.stringify(created));
  const stale = plain(created.item);
  // the overdue chase stamps the document behind the page's back
  await db.collection("orgs").doc(ORG).collection("items").doc(stale.id).update({ nudgedAt: 777 });
  const saved = await runAsync(`return await itemSave(${JSON.stringify(Object.assign({ id: "simpletask" }, type))},
    ${JSON.stringify(stale)}, { kind: "update", title: "Late thing, renamed" });`);
  assert.ok(saved.ok, JSON.stringify(saved));
  const after = await get("orgs/" + ORG + "/items/" + stale.id);
  assert.equal(after.title, "Late thing, renamed");
  assert.equal(after.nudgedAt, 777, "the rename from a stale copy erased the chase stamp");
});

await T("starting over clears the work and the runs, and nothing else", async () => {
  const typesBefore = find("orgs/" + ORG + "/itemTypes").length;
  const rolesBefore = find("orgs/" + ORG + "/roles").length;
  const r = await runAsync(`return await itemsDeleteAllWork();`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(find("orgs/" + ORG + "/items").length, 0, "work survived");
  assert.equal(find("orgs/" + ORG + "/runs").length, 0, "runs survived");
  assert.equal(find("orgs/" + ORG + "/itemTypes").length, typesBefore, "it took the types with it");
  assert.equal(find("orgs/" + ORG + "/roles").length, rolesBefore, "it took the roles with it");
  // the log is append-only against everyone, so it is still there
  assert.ok(find("orgs/" + ORG + "/events").length > 0, "the event log was cleared, which nothing may do");
});

/* TEMPORARY - the owner's testing aid. Back to the day the org was
   created: setup and work gone, seed roles as seeded, seats kept. */
await T("resetting the organization puts it back to fresh, and keeps every seat", async () => {
  await db.collection("orgs").doc(ORG).collection("roles").doc("editor").set({ name: "Editor", permissions: ["item:read:org"] });
  await db.collection("orgs").doc(ORG).collection("roles").doc("manager").set({ name: "Manager", permissions: ["item:read:org"] });
  await db.collection("orgs").doc(ORG).collection("members").doc("ed1").set({ uid: "ed1", roleId: "editor", joinedAt: 2 });
  await db.collection("orgs").doc(ORG).collection("automations").doc("auto9").set({ name: "x", trigger: {}, action: {} });
  run(`orgInvalidate();`);
  assert.ok(find("orgs/" + ORG + "/itemTypes").length > 0, "the fixture has no types to reset");
  // the tests above leave automations firing after their commits; a write
  // landing between the reset's read and its check made this test red
  // once in six runs, so the fixture is given a moment to go quiet
  await new Promise(res => setTimeout(res, 60));
  const r = await runAsync(`return await itemsResetOrg();`);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(find("orgs/" + ORG + "/itemTypes").length, 0, "kinds of work survived");
  assert.equal(find("orgs/" + ORG + "/automations").length, 0, "rules survived");
  assert.equal(find("orgs/" + ORG + "/blueprints").length, 0, "tracks survived");
  assert.equal(find("orgs/" + ORG + "/items").length, 0);
  const roles = find("orgs/" + ORG + "/roles").map(x => x.id).sort();
  assert.deepEqual(roles, ["manager", "owner", "staff"], "the roles are not the three seeds");
  const mgr = await get("orgs/" + ORG + "/roles/manager");
  assert.ok(mgr.permissions.includes("member:hours:org"), "the manager's edited permissions were not put back");
  assert.equal((await get("orgs/" + ORG + "/members/owner1")).roleId, "owner", "the owner lost their seat");
  assert.equal((await get("orgs/" + ORG + "/members/ed1")).roleId, "staff", "a member seated in a deleted role was not reseated");
  assert.ok(r.reseated >= 1, "nobody was reseated: " + JSON.stringify(r));
  assert.ok(find("orgs/" + ORG + "/events").length > 0, "the event log was cleared, which nothing may do");
});

await T("only an owner may start over", async () => {
  AUTH.currentUser = { uid: "staff1", email: "s@x.com" };
  run(`orgInvalidate();`);
  const r = await runAsync(`return await itemsDeleteAllWork();`);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not-owner");
  const r2 = await runAsync(`return await itemsResetOrg();`);
  assert.equal(r2.error, "not-owner", "a non-owner could reset the organization");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
