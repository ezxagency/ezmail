/* The review screens - js/reviews.js - in jsdom, against the in-memory
   Firestore, with the real files loaded into one scope the way
   index.html arranges them:

     node tests/reviews.test.mjs

   The flow suite proves the WRITES (submit, changes, resubmit, approve,
   delegate, the loop, parallel steps). This proves what a person SEES:
   a card that says where its work stands, or that it could not find
   out; a page that distinguishes nothing from could-not-reach; a
   submit sheet that will not send an empty or unsafe submission; a
   review sheet that shows the brief, the work and the person together
   and will not decide without words; and everything a person typed
   drawn as text, never as markup. */
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

const dom = new JSDOM(`<!doctype html><html><body class="ui-next">
  <div id="scrim"></div><div class="sheet" id="sheet"><div id="sheetBody"></div></div>
  <div id="toast"></div><div id="orgBody"></div><div id="workBody"></div>
  <nav id="drawerNav"><a class="drawer-item hidden" id="drawerReviews" href="#/reviews" data-route="reviews"><span class="drawer-txt">Reviews</span></a></nav>
  <div id="reviewsScreen"><div id="reviewsBody"></div></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
const db = makeDb();
const AUTH = { currentUser: { uid: "staff1", email: "s@x.com" } };
ctx.console = console;
ctx.firebase = { initializeApp(){}, auth(){ return AUTH; }, firestore(){ return db; } };
["js/config.js", "js/rating.js", "js/permissions.js", "js/item-engine.js", "js/migrate.js",
 "js/items.js", "js/reviews.js", "js/workflow-engine.js", "js/automation.js", "js/handoff.js",
 "js/packs.js", "js/notify.js", "js/org.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
// the real sheet mechanics are three lines; the toast is recorded
vm.runInContext(`db = firebase.firestore(); auth = firebase.auth();
  var __toasts = []; toast = m => __toasts.push(String(m));
  function openSheet(html, setup){ $("sheetBody").innerHTML = html; $("sheet").classList.add("on"); if (setup) setup(); }
  function closeSheet(){ $("sheet").classList.remove("on"); }
  var isMember = true, isAdmin = false;
  var __dk = 0; function dkRefresh(){ __dk++; }`, ctx);
const run = expr => vm.runInContext(expr, ctx);
const runAsync = expr => vm.runInContext(`(async () => { ${expr} })()`, ctx);
const doc = dom.window.document;
const $ = id => doc.getElementById(id);
const sheet = () => $("sheetBody");
const tick = () => new Promise(r => setTimeout(r, 20));

/* ---------- the org: an owner, a lead who reviews, two staff ---------- */
const ORG = "orgA";
await db.collection("orgs").doc(ORG).set({ name: "Their Co", ownerUid: "owner1", createdAt: 1 });
for (const [uid, role] of [["owner1", "owner"], ["lead1", "lead"], ["staff1", "staff"], ["staff2", "staff"]])
  await db.collection("orgs").doc(ORG).collection("members").doc(uid).set({ uid, roleId: role, joinedAt: 1 });
await db.collection("orgs").doc(ORG).collection("roles").doc("owner").set({ name: "Owner", permissions: ["*:*:org"] });
await db.collection("orgs").doc(ORG).collection("roles").doc("lead").set({ name: "Lead", permissions: ["item:read:org", "review:decide:org"] });
await db.collection("orgs").doc(ORG).collection("roles").doc("staff").set({ name: "Staff", permissions: ["item:update:assigned"] });
for (const [uid, name] of [["owner1", "Olive"], ["lead1", "Lee"], ["staff1", "Sam"], ["staff2", "Sasha"]])
  await db.collection("directory").doc(uid).set({ uid, name, email: uid + "@x.com", orgId: ORG });
await db.collection("orgs").doc(ORG).collection("itemTypes").doc("page")
  .set({ name: "Page", fields: [], statuses: [{ key: "open", label: "Open" }, { key: "done", label: "Done" }] });
await db.collection("orgs").doc(ORG).collection("items").doc("it1").set({ id: "it1", orgId: ORG, typeId: "page", title: "Landing page", status: "open",
  brief: "Lead with the restock <b>not</b> the discount", fields: { store: "Alpha" }, facets: ["assignee:staff1"], assigneeIds: ["staff1"], createdBy: "owner1", createdAt: 1, updatedAt: 1 });
const as = uid => { AUTH.currentUser = { uid, email: uid + "@x.com" }; run(`orgInvalidate(); rvMine = null; rvQueue = null;`); return runAsync(`await orgEnsure();`); };
const row = { id: "it1", itemId: "it1", task: "Landing page", store: "Alpha" };

/* ---------- the card ---------- */
await T("the card says when it does not yet know, and when it could not find out", async () => {
  await as("staff1");
  assert.match(run(`rvCardBlock(${JSON.stringify(row)})`), /Loading your reviews/);
  run(`rvMine = false;`);
  assert.match(run(`rvCardBlock(${JSON.stringify(row)})`), /Could not reach your reviews/);
  run(`rvMine = [];`);
  const block = run(`rvCardBlock(${JSON.stringify(row)})`);
  assert.match(block, /Not sent for review yet/);
  assert.match(block, /Submit for review/);
  assert.equal(run(`rvCardBlock({ id: "a", task: "x" })`).length > 0, true, "a mirrored assignment row with an item id is reviewable");
  assert.equal(run(`rvCardBlock({ id: "a", task: "x", itemId: "a", orphanType: "gone" })`), "", "work whose type is gone offers nothing");
  assert.equal(run(`rvFinishLine(${JSON.stringify(row)})`), "");
});

/* ---------- the watch ---------- */
await T("the watch loads my documents and the reviewer's queue, shows the drawer item, and redraws the deck", async () => {
  await as("staff1");
  run(`rvWatch();`);
  await tick(); await tick();
  assert.deepEqual(run(`JSON.stringify(rvMine)`), "[]");
  assert.deepEqual(run(`JSON.stringify(rvQueue)`), "[]", "a staff member's queue is what was delegated to them");
  assert.ok(!$("drawerReviews").classList.contains("hidden"), "the drawer item stayed hidden");
  assert.ok(run(`__dk`) >= 1, "the deck was not redrawn");
  run(`rvStop();`);
  assert.ok($("drawerReviews").classList.contains("hidden"), "sign-out left the drawer item");
});

/* ---------- the submit sheet ---------- */
await T("the submit sheet shows the brief and the deadline, refuses an empty or unsafe submission, and sends a good one", async () => {
  await as("staff1");
  run(`rvMine = [];`);
  await runAsync(`await rvSubmitSheet("it1", null);`);
  assert.ok($("sheet").classList.contains("on"));
  assert.match(sheet().querySelector(".rv-brief").textContent, /Lead with the restock <b>not<\/b> the discount/, "the brief was not drawn as text");
  assert.equal(sheet().querySelector(".rv-brief b"), null, "markup in a brief became markup on screen");
  assert.match(sheet().textContent, /No deadline on this work/);
  assert.match(sheet().textContent, /Goes to Olive, Lee/, "the sheet does not say who reviews");
  const link = $("rvLink"), note = $("rvNote"), send = $("rvSend");
  assert.equal(send.disabled, true, "an empty submission can be sent");
  link.value = "docs.example.com"; link.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, true); assert.match($("rvHint").textContent, /http/);
  link.value = ""; note.value = "Hero copy in the doc"; note.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, false);
  send.click();
  await tick(); await tick();
  const d = (await db.collection("orgs").doc(ORG).collection("reviews").doc("it1:work:staff1").get()).data();
  assert.ok(d, "nothing was written");
  assert.equal(d.status, "submitted"); assert.equal(d.submission.note, "Hero copy in the doc");
  assert.ok(!$("sheet").classList.contains("on"), "the sheet stayed open");
  assert.match(run(`__toasts.pop()`), /Submitted for review/);
});

await T("submitted: the card says who has it; the finish sheet's line says the review stays open", async () => {
  await as("staff1");
  run(`rvWatch();`);
  await tick(); await tick();
  const block = run(`rvCardBlock(${JSON.stringify(row)})`);
  assert.match(block, /In review/); assert.match(block, /with the owner/);
  assert.match(run(`rvFinishLine(${JSON.stringify(row)})`), /Still in review/);
  run(`rvStop();`);
});

/* ---------- the people on my step ----------
   Reported 2026-09-13: two people on one step could not see each other.
   The card watches each co-holder's review document by its exact id and
   says where they stand; a missing document is "not sent yet", a failed
   read is said as such. */
const rowTogether = { id: "it2", itemId: "it2", task: "Draft the piece", handoff: {
  stop: { label: "Review", index: 1, count: 2, nodeId: "s0", iteration: 1, holders: [{ uid: "staff1", name: "Sam" }, { uid: "staff2", name: "Sasha" }] },
  stops: [{ label: "Review", index: 1, count: 2, nodeId: "s0", iteration: 1, holders: [{ uid: "staff1", name: "Sam" }, { uid: "staff2", name: "Sasha" }] }],
  from: null, next: { label: "Publish", role: "staff", holders: [] }, done: false } };
await T("the card lists the others on my step with where each one's review stands, live", async () => {
  await as("staff1");
  run(`rvMine = [];`);
  assert.deepEqual(JSON.parse(run(`JSON.stringify(rvPeerKeys([${JSON.stringify(rowTogether)}, { id: "plain", task: "x" }], "staff1"))`)), ["it2:s0:staff2"], "the keys are not the co-holders' documents");
  assert.equal(run(`rvPeerLines({ id: "solo", itemId: "solo", handoff: { stop: { nodeId: "s0", holders: [{ uid: "staff1", name: "Sam" }] }, done: false } })`), "", "alone on a step, the card still drew a list");
  run(`__dk = 0; rvPeersWatch([${JSON.stringify(rowTogether)}]);`);
  let lines = run(`rvPeerLines(${JSON.stringify(rowTogether)})`);
  assert.match(lines, /loading/); assert.doesNotMatch(lines, /not sent/, "said not sent before the database had answered");
  await tick(); await tick();
  lines = run(`rvPeerLines(${JSON.stringify(rowTogether)})`);
  assert.match(lines, /With you on this step/);
  assert.match(lines, /Sasha/); assert.match(lines, /not sent for review yet/);
  assert.doesNotMatch(lines, /Sam/, "the reader is listed as their own teammate");
  assert.ok(run(`__dk`) >= 1, "the first answer did not redraw the deck");
  // the teammate submits: the card moves without anybody pressing anything
  run(`__dk = 0;`);
  await db.collection("orgs").doc(ORG).collection("reviews").doc("it2:s0:staff2").set({ orgId: ORG, itemId: "it2", nodeId: "s0", aboutUid: "staff2", reviewerUid: null,
    status: "submitted", round: 2, submission: { link: null, note: "<b>mine</b>", at: 1700000000000, byUid: "staff2", iteration: 1, dueAt: null, onTime: null },
    decision: null, history: [], version: 3, updatedAt: 2 });
  await tick(); await tick();
  lines = run(`rvPeerLines(${JSON.stringify(rowTogether)})`);
  assert.match(lines, /Sasha<\/b> · in review · round 2 · sent/, "the teammate's submission is not shown: " + lines);
  assert.doesNotMatch(lines, /<b>mine/, "a note was drawn as markup");
  assert.ok(run(`__dk`) >= 1, "the teammate moving did not redraw the deck");
  // and the whole card carries it under the handoff, drawn through the deck's own block
  // an approval on an earlier pass of the step is said as such, never as approved now
  run(`rvPeers["it2:s0:staff2"] = Object.assign({}, rvPeers["it2:s0:staff2"], { status: "approved", submission: Object.assign({}, rvPeers["it2:s0:staff2"].submission, { iteration: 0 }) });`);
  assert.match(run(`rvPeerLines(${JSON.stringify(rowTogether)})`), /approved on an earlier pass/);
  // a read that failed says so, and never "not sent"
  run(`rvPeers["it2:s0:staff2"] = false;`);
  lines = run(`rvPeerLines(${JSON.stringify(rowTogether)})`);
  assert.match(lines, /could not reach/); assert.doesNotMatch(lines, /not sent/);
  // rows change: watches follow, and none is left behind
  run(`rvPeersWatch([]);`);
  assert.equal(run(`Object.keys(rvPeerUnsubs).length + Object.keys(rvPeers).length`), 0, "a watch or a document was left behind");
  run(`rvStop();`);
});
await T("my own review is keyed by MY step, not the first running one", async () => {
  await as("staff1");
  const row3 = { id: "it3", itemId: "it3", task: "Two steps", handoff: {
    stop: { label: "Draw", index: 2, count: 3, nodeId: "s1", iteration: 1, holders: [{ uid: "staff2", name: "Sasha" }] },
    stops: [{ label: "Draw", index: 2, count: 3, nodeId: "s1", iteration: 1, holders: [{ uid: "staff2", name: "Sasha" }] },
            { label: "Check", index: 3, count: 3, nodeId: "s2", iteration: 2, holders: [{ uid: "staff1", name: "Sam" }] }],
    from: null, next: null, done: false } };
  run(`rvMine = [{ id: "it3:s2:staff1", itemId: "it3", nodeId: "s2", aboutUid: "staff1", status: "changes", round: 1, reviewerUid: null,
    submission: { link: null, note: "x", at: 1, byUid: "staff1", iteration: 2, dueAt: null, onTime: null },
    decision: { kind: "changes", feedback: "Tighter", scores: null, byUid: "lead1", at: 2 }, history: [], version: 2 }];`);
  assert.equal(run(`rvRowState(${JSON.stringify(row3)})`), "changes", "the card read the review of the other person's step");
  assert.match(run(`rvCardBlock(${JSON.stringify(row3)})`), /Changes requested/);
  assert.equal(run(`rvPeerLines(${JSON.stringify(row3)})`), "", "alone on my step, yet a list was drawn");
});

/* ---------- the review sheet ---------- */
await T("a staff member who is not the reviewer sees the review read-only; the person sees it as their own", async () => {
  await as("staff2");
  const d = Object.assign({ id: "it1:work:staff1" }, (await db.collection("orgs").doc(ORG).collection("reviews").doc("it1:work:staff1").get()).data());
  run(`rvReviewSheet(${JSON.stringify(d)});`);
  assert.equal($("rvDecideBt"), null, "a member without review:decide was offered a decision");
  assert.match(sheet().textContent, /not this work's reviewer/);
  await as("staff1");
  run(`rvReviewSheet(${JSON.stringify(d)});`);
  assert.equal($("rvDecideBt"), null, "the person was offered a decision on their own work");
  assert.match(sheet().textContent, /your own work/);
});

await T("the reviewer's sheet holds the brief, the work and the person together, and will not decide without words", async () => {
  await as("lead1");
  const d = Object.assign({ id: "it1:work:staff1" }, (await db.collection("orgs").doc(ORG).collection("reviews").doc("it1:work:staff1").get()).data());
  run(`rvReviewSheet(${JSON.stringify(d)});`);
  const t = sheet().textContent;
  assert.match(t, /Landing page/); assert.match(t, /Alpha/); assert.match(t, /By Sam/); assert.match(t, /Staff/); assert.match(t, /round 1/);
  assert.match(sheet().querySelector(".rv-brief").textContent, /Lead with the restock/);
  assert.match(sheet().querySelector(".rv-sub").textContent, /Hero copy in the doc/);
  assert.ok($("rvWho"), "a lead who may decide may also name a reviewer, and was not offered to");
  assert.equal([...$("rvWho").options].some(o => o.value === "staff1"), false, "the person was offered as their own reviewer");
  const bt = $("rvDecideBt");
  assert.equal(bt.disabled, true); assert.equal(bt.textContent, "Pick a decision");
  sheet().querySelector('.rv-kind-bt[data-kind="approved"]').click();
  assert.equal($("rvForm").hidden, false, "the rating form did not appear for an approval");
  assert.equal(bt.disabled, true);
  assert.match(bt.textContent, /feedback|Score/);
  // three scores, with the words and the example under each
  for (const [k, v] of [["quality", 4], ["brief", 5], ["handoff", 4]])
    sheet().querySelector('.rt-row[data-key="' + k + '"] .rt-pt[data-v="' + v + '"]').click();
  assert.match(sheet().querySelector('.rt-row[data-key="quality"] .rt-word').textContent, /4 · Strong/);
  assert.match(sheet().querySelector('.rt-row[data-key="brief"] .rt-eg').textContent, /Read the brief better/);
  assert.match(sheet().querySelector("[data-rt-total]").textContent, /4\.30 \/ 5/);
  assert.equal(bt.disabled, true, "an approval without feedback was enabled");
  assert.equal(bt.textContent, "Write the feedback first");
  $("rvFeedback").value = "Restock leads, hero is clean; a 4 on quality because section two runs long."; $("rvFeedback").dispatchEvent(new dom.window.Event("input"));
  assert.equal(bt.disabled, false);
  assert.equal(bt.textContent, "Approve · 4.30 / 5");
  bt.click();
  await tick(); await tick();
  const after = (await db.collection("orgs").doc(ORG).collection("reviews").doc("it1:work:staff1").get()).data();
  assert.equal(after.status, "approved"); assert.equal(after.weightedTenths, 43); assert.equal(after.decision.byUid, "lead1");
  assert.match(run(`__toasts.pop()`), /Approved · 4\.30/);
});

await T("the person's sheet shows the decision, the scores with what they mean, and the way forward", async () => {
  await as("staff1");
  const d = Object.assign({ id: "it1:work:staff1" }, (await db.collection("orgs").doc(ORG).collection("reviews").doc("it1:work:staff1").get()).data());
  run(`rvResultSheet(${JSON.stringify(d)});`);
  const t = sheet().textContent;
  assert.match(t, /Approved · 4\.30 \/ 5/); assert.match(t, /by Lee/);
  assert.match(t, /section two runs long/);
  assert.equal(sheet().querySelectorAll(".rv-scores li").length, 3);
  assert.match(sheet().querySelector(".rv-scores li").textContent, /Execution quality · Strong/);
  assert.match(t, /press Pass on, Finish or Done to complete the work/);
  assert.equal($("rvAgain"), null, "approved work offers a revision");
  run(`rvMine = [${JSON.stringify(d)}];`);
  const block = run(`rvCardBlock(${JSON.stringify(row)})`);
  assert.match(block, /Approved · 4\.30 \/ 5/); assert.match(block, /Next: press <b>Done<\/b>/);
});

/* ---------- escaping ---------- */
await T("what a person typed is drawn as text, never as markup; a link is a real link with no opener", async () => {
  await as("staff1");
  const evil = { id: "it9:work:staff1", itemId: "it9", nodeId: null, typeId: "page", aboutUid: "staff1", aboutRoleId: "staff", reviewerUid: null, status: "changes", round: 1,
    title: "<img src=x onerror=alert(1)>", store: "", stepLabel: "", brief: "<script>alert(2)</script>",
    submission: { link: "https://docs.example.com/x?a=1&b=<2>", note: "<b>bold</b> & co", at: 5, byUid: "staff1", iteration: null, dueAt: null, onTime: null },
    decision: { kind: "changes", feedback: "Use <em>less</em> markup", scores: null, byUid: "owner1", at: 9 }, history: [], updatedAt: 9, version: 2 };
  run(`rvResultSheet(${JSON.stringify(evil)});`);
  assert.equal(sheet().querySelector("img, script, em, b:not(.rv-head b):not(.rv-k b)"), null, "typed markup became elements");
  assert.match(sheet().querySelector(".rv-head b").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(sheet().querySelector(".rv-fb").textContent, /Use <em>less<\/em> markup/);
  const a = sheet().querySelector(".rv-link a");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer"); assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("href"), "https://docs.example.com/x?a=1&b=<2>");
  assert.ok($("rvAgain"), "changes requested but no way to submit a revision");
  // an unsafe stored link is not drawn as a link at all
  evil.submission.link = "javascript:alert(3)";
  run(`rvResultSheet(${JSON.stringify(evil)});`);
  assert.equal(sheet().querySelector(".rv-link a"), null);
  run(`rvMine = [${JSON.stringify(evil)}];`);
  const block = run(`rvCardBlock({ id: "it9", itemId: "it9", task: "x" })`);
  assert.match(block, /Changes requested/); assert.match(block, /Submit revision/); assert.ok(!/<em>/.test(block.replace(/&lt;em&gt;/g, "")), "feedback markup reached the card");
});

/* ---------- the page ---------- */
await T("the page: not in an org, loading, could not reach, nothing yet - each says which", async () => {
  run(`orgS = null; orgWhyNone = "none"; rvMine = null; rvQueue = null; enterReviewsPage();`);
  assert.match($("reviewsBody").textContent, /not seated in one/);
  run(`orgWhyNone = "error"; enterReviewsPage();`);
  assert.match($("reviewsBody").textContent, /Could not reach your organization/);
  await as("staff2");
  run(`rvMine = null; rvQueue = null; enterReviewsPage();`);
  assert.match($("reviewsBody").textContent, /Loading your reviews/);
  run(`rvMine = false; rvPaint();`);
  assert.match($("reviewsBody").textContent, /Could not reach your reviews/);
  run(`rvMine = []; rvQueue = []; rvPaint();`);
  assert.match($("reviewsBody").textContent, /Nothing submitted yet/);
  assert.equal($("reviewsBody").querySelector(".rv-panel h2").textContent, "Your submissions", "a staff member with nothing delegated was shown a reviewer's queue");
  run(`leaveReviewsPage();`);
});

await T("the page for a reviewer: the queue first with Review on each row, then their own; a row opens its sheet", async () => {
  await as("lead1");
  run(`rvWatch(); enterReviewsPage();`);
  await tick(); await tick();
  await db.collection("orgs").doc(ORG).collection("reviews").doc("it2:work:staff2").set({ id: "it2:work:staff2", orgId: ORG, itemId: "it2", nodeId: null, typeId: "page",
    aboutUid: "staff2", aboutRoleId: "staff", reviewerUid: null, status: "submitted", round: 1, title: "Price list", store: "Beta", stepLabel: "", brief: "",
    submission: { link: null, note: "done", at: 7, byUid: "staff2", iteration: null, dueAt: null, onTime: null }, decision: null, history: [],
    weightedTenths: null, score: null, scores: null, createdAt: 7, updatedAt: 7, version: 1 });
  await tick(); await tick();
  const body = $("reviewsBody");
  assert.equal(body.querySelector(".rv-panel h2").textContent, "Needs your review");
  const qrow = body.querySelector('.rv-row[data-act="review"]');
  assert.ok(qrow, "no queue row"); assert.match(qrow.textContent, /Price list/); assert.match(qrow.textContent, /by Sasha/);
  assert.equal(qrow.querySelector(".am-go").textContent, "Review");
  assert.match(body.textContent, /Your rating/);
  qrow.querySelector(".am-go").click();
  assert.ok($("sheet").classList.contains("on") && $("rvDecideBt"), "pressing the row did not open the reviewer's sheet");
  assert.ok($("rvWho"), "a lead with review:decide could not name a reviewer");
  assert.equal([...$("rvWho").options].some(o => o.value === "staff2"), false, "the person was offered as their own reviewer");
  run(`closeSheet(); rvStop(); leaveReviewsPage();`);
});

await T("the page for the person: tiles, changes requested first, approved with the score, and Revise opens the submit sheet", async () => {
  await as("staff1");
  await db.collection("orgs").doc(ORG).collection("items").doc("it3").set({ id: "it3", orgId: ORG, typeId: "page", title: "Banner", status: "open",
    brief: "Logo top left", fields: {}, facets: ["assignee:staff1"], assigneeIds: ["staff1"], createdBy: "owner1", createdAt: 1, updatedAt: 1 });
  await db.collection("orgs").doc(ORG).collection("reviews").doc("it3:work:staff1").set({ id: "it3:work:staff1", orgId: ORG, itemId: "it3", nodeId: null, typeId: "page",
    aboutUid: "staff1", aboutRoleId: "staff", reviewerUid: null, status: "changes", round: 1, title: "Banner", store: "", stepLabel: "", brief: "",
    submission: { link: null, note: "v1", at: 7, byUid: "staff1", iteration: null, dueAt: null, onTime: null },
    decision: { kind: "changes", feedback: "Bigger logo", scores: null, byUid: "owner1", at: 8 }, history: [],
    weightedTenths: null, score: null, scores: null, createdAt: 7, updatedAt: 8, version: 2 });
  run(`rvWatch(); enterReviewsPage();`);
  await tick(); await tick();
  const body = $("reviewsBody");
  const tiles = [...body.querySelectorAll(".rv-tiles .am-tile")].map(t => t.textContent);
  assert.match(tiles[0], /0In review/); assert.match(tiles[1], /1Changes to make/); assert.match(tiles[2], /4\.30Your rating · 1 approved/);
  const heads = [...body.querySelectorAll(".rv-panel h2")].map(h => h.textContent);
  assert.deepEqual(heads, ["Changes requested", "Your submissions"]);
  const rows = [...body.querySelectorAll(".rv-row")].map(r => r.querySelector(".rv-pill").textContent);
  assert.deepEqual(rows, ["Changes requested", "Approved · 4.30"]);
  assert.equal($("drawerReviews").querySelector(".drawer-badge").textContent, "1", "the drawer does not count the change to answer");
  body.querySelector('.rv-row[data-rv="it3:work:staff1"] .am-go').click();
  await tick(); await tick();
  assert.match(sheet().textContent, /Submit a revision/);
  assert.match(sheet().textContent, /Bigger logo/, "the requested changes are not shown above the revision");
  run(`closeSheet(); rvStop(); leaveReviewsPage();`);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
