/* The assigned deck — js/deck.js, both halves.

     node tests/deck.test.mjs

   The pure half answers one question and it is the one that breaks: when
   the card in front is finished it leaves the snapshot, and what the deck
   shows NEXT must be the work that took its place - not card one, and not
   an index off the end.

   The DOM half is here because the deck's whole claim is that FOUR kinds
   of work wear the same card and only the action changes. That is a claim
   about markup, and only a document can check it. The real files are
   loaded into one shared scope exactly as index.html arranges them, so
   the card is built by the same code the browser runs. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { dkPick } = createRequire(import.meta.url)(join(here, "..", "js", "deck.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

/* ---------- the pure half ---------- */
const rows = ids => ids.map(id => ({ id, task: "T" + id }));

T("an empty deck picks nothing rather than card zero", () => {
  assert.deepEqual(dkPick([], "a", 0), { idx: -1, id: null });
  assert.deepEqual(dkPick(null, "a", 3), { idx: -1, id: null });
});

T("the same work stays in front even when the order changes under it", () => {
  const p = dkPick(rows(["c", "a", "b"]), "a", 0);
  assert.equal(p.id, "a");
  assert.equal(p.idx, 1, "followed the position instead of the work");
});

/* Finishing a card is the common case, and "show me the next one" is the
   only answer that does not feel like the app lost your place. */
T("when the front card is finished, its position shows what took its place", () => {
  const p = dkPick(rows(["a", "c", "d"]), "b", 1);
  assert.equal(p.idx, 1);
  assert.equal(p.id, "c");
});

T("finishing the LAST card falls back onto the new last one", () => {
  const p = dkPick(rows(["a", "b"]), "c", 2);
  assert.equal(p.idx, 1);
  assert.equal(p.id, "b");
});

T("a remembered index from a longer deck cannot point off the end", () => {
  const p = dkPick(rows(["a"]), "gone", 9);
  assert.equal(p.idx, 0);
  assert.equal(p.id, "a");
});

/* ---------- the DOM half ---------- */
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div><div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div><div id="orgBody"></div><div id="workBody"></div>
  <div id="shiftbar"></div><div id="cxScrim"></div>
  <div id="appScreen"><aside id="assignedTasksSection">
    <span id="assignedCount"></span><p id="assignedCounts"></p><div id="assignedNext"></div>
    <ul id="assignedTasksList"></ul><div id="assignedDeck" tabindex="0"></div>
  </aside></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;

// load order IS the dependency graph, exactly as index.html declares it
["js/config.js", "js/clock.js", "js/permissions.js", "js/item-engine.js", "js/ui.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js",
 "js/notify.js", "js/packs.js", "js/handoff.js", "js/org.js", "js/work.js",
 // dueWithTime lives in assign.js and todayISO in team.js: the deck reads
 // both, so both are loaded rather than stubbed
 "js/team.js", "js/assign.js", "js/deck.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

const run = expr => vm.runInContext(expr, ctx);
const deck = () => dom.window.document.getElementById("assignedDeck");
const draw = js => { run(js); return deck().innerHTML; };
const front = () => deck().querySelector(".adeck-card.is-front");

T("one card in front, the rest stacked behind it, and a count that says how many", () => {
  const html = draw(`dkReset(); dkRender([
    { id:"r1", task:"Copy", store:"Store Epsilon", fromName:"Ada" },
    { id:"r2", task:"Design", store:"Store Beta", fromName:"Ada" },
    { id:"r3", task:"Embed", store:"Store Zeta", fromName:"Ada" },
    { id:"r4", task:"Review", store:"Store Alpha", fromName:"Ada" }]);`);
  assert.equal(deck().querySelectorAll(".adeck-card").length, 3, "the stack is not three deep");
  assert.equal(deck().querySelectorAll(".adeck-card.is-front").length, 1);
  assert.ok(front().textContent.includes("Copy"));
  assert.ok(html.includes("1 <i>/</i> 4"), "the counter does not say where you are");
});

T("the peeking cards carry no note and no buttons — they are not reachable", () => {
  draw(`dkReset(); dkRender([
    { id:"r1", task:"Copy", fromName:"Ada" },
    { id:"r2", task:"Design", note:"the brief for the second one", fromName:"Ada" }]);`);
  const behind = deck().querySelectorAll(".adeck-card:not(.is-front)");
  assert.equal(behind.length, 1);
  assert.equal(behind[0].querySelectorAll("button").length, 0, "a card behind the front one is clickable");
  assert.ok(!behind[0].innerHTML.includes("the brief"), "a card nobody can act on is showing its brief");
  assert.equal(behind[0].getAttribute("aria-hidden"), "true");
});

/* Four kinds, one card. The action is the only part that changes, and it
   has to route where the list rows route: finishing a baton IS a handoff. */
T("an assignment offers Done", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", fromName:"Ada" }]);`);
  assert.equal(front().querySelectorAll(".adeck-done").length, 1);
});

T("a campaign baton offers the campaign's own moves, never Done", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", cg:"c1", canBack:true, fromName:"Ada" }]);`);
  assert.equal(front().querySelectorAll(".adeck-done").length, 0, "a baton was offered Done");
  assert.equal(front().querySelectorAll(".adeck-pass").length, 1);
  assert.equal(front().querySelectorAll(".adeck-sendback").length, 1);
  assert.equal(front().querySelectorAll(".adeck-view").length, 1);
  assert.ok(front().textContent.includes("campaign"));
});

T("a multi-approval baton says Approve rather than Pass forward", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", cg:"c1", multi:"2 of 3", fromName:"Ada" }]);`);
  assert.ok(front().querySelector(".adeck-pass").textContent.includes("Approve"));
});

T("a workflow stop is worked at its stop, not marked done", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", wfNodeRunId:"run1:n1:1", fromName:"Ada" }]);`);
  assert.equal(front().querySelectorAll(".adeck-done").length, 0);
  assert.equal(front().querySelectorAll(".adeck-wf").length, 1);
});

/* Offering an action that can only fail is what turned one stuck row into
   three rounds of screenshots. The orphan card says what happened and who
   can fix it, and offers nothing. */
T("work whose type was deleted gets no button at all, and says why", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", orphanType:"Brief", fromName:"Ada" }]);`);
  assert.equal(front().querySelectorAll("button").length, 0, "an orphan was offered an action");
  assert.ok(front().textContent.includes("Brief"), "the missing type is not named");
  assert.ok(front().textContent.includes("Work page"), "nobody is told where it can be cleared");
});

T("overdue is stated as overdue, not as a due date", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy", dueDate:"2000-01-01", fromName:"Ada" }]);`);
  assert.ok(front().querySelector(".adeck-due.is-late"), "a late card is not marked late");
  assert.ok(front().textContent.includes("Overdue"));
});

T("the arrows move one card and stop at both ends", () => {
  draw(`dkReset(); dkRender([
    { id:"r1", task:"Copy" }, { id:"r2", task:"Design" }, { id:"r3", task:"Embed" }]);`);
  const arrows = () => [...deck().querySelectorAll(".adeck-arrow")];
  assert.equal(arrows()[0].disabled, true, "Previous is live on the first card");
  assert.equal(arrows()[1].disabled, false);
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Design"));
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Embed"));
  assert.equal(arrows()[1].disabled, true, "Next is live on the last card");
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Embed"), "the deck ran past its own end");
});

/* The same distinction the list makes, and for the same reason: an empty
   deck that says "nothing assigned" when the truth is "this account is in
   no organization" is a screen nobody can debug. */
T("an empty deck says WHY it is empty", () => {
  run(`assignedEmptyReason = null;`);
  assert.ok(draw(`dkReset(); dkRender([]);`).includes("Nothing assigned right now"));
  run(`assignedEmptyReason = "no-org";`);
  assert.ok(draw(`dkRender([]);`).includes("not in an organization"));
  run(`assignedEmptyReason = "org-error";`);
  assert.ok(draw(`dkRender([]);`).includes("could not load it"));
});

T("a finished card leaves and the next one takes the front", () => {
  draw(`dkReset(); dkRender([{ id:"r1", task:"Copy" }, { id:"r2", task:"Design" }]);`);
  assert.ok(front().textContent.includes("Copy"));
  // the snapshot comes back without it, exactly as a real Done would
  draw(`dkRender([{ id:"r2", task:"Design" }]);`);
  assert.ok(front().textContent.includes("Design"));
  assert.ok(deck().innerHTML.includes("1 <i>/</i> 1"));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
