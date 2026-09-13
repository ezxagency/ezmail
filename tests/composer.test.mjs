/* The composer - the Assign work dialog in js/assign.js - in jsdom, with
   the real files loaded into one scope the way index.html arranges them:

     node tests/composer.test.mjs

   Rebuilt 2026-09-13 (the owner: "boring and not easy"): everything
   there is to choose is on screen as chips - tasks, people with their
   load, stores - under numbered steps, with a sentence that reads the
   send back or names what is still missing. These prove what a person
   SEES and can TAP: a chip picked is a chip lit and a send that counts
   it; a tracked kind shows its route and asks for nobody; the search
   still finds and coins; a roster that could not be read says so. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const { cxDueQuick, cxMissing, cxSummary } = require(join(here, "..", "js", "assign.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.stack || e.message || e).replace(/\n/g, " ⏎ ").slice(0, 900)); }
};

/* ---------- the pure half ---------- */
T("the quick dates are today, tomorrow and a week out, in the local calendar", () => {
  const q = cxDueQuick(new Date(2026, 8, 13, 23, 30).getTime());   // late on Sep 13: still Sep 13 locally
  assert.deepEqual(q.map(x => [x.label, x.date]), [["Today", "2026-09-13"], ["Tomorrow", "2026-09-14"], ["In a week", "2026-09-20"]]);
  assert.equal(cxDueQuick(new Date(2026, 11, 31).getTime())[1].date, "2027-01-01", "a year end did not roll over");
});
T("what is missing is named in the order the steps ask, and a tracked kind needs nobody", () => {
  const st = { tasks: [], who: [], stores: [], note: "" };
  assert.deepEqual(cxMissing(st, false), ["a task", "someone to do it", "a store", "a brief"]);
  assert.deepEqual(cxMissing(st, true), ["a task", "a store", "a brief"]);
  assert.deepEqual(cxMissing({ tasks: ["A"], who: [{ uid: "u" }], stores: ["S"], note: "ok" }, false), ["a brief"], "two letters is a brief");
  assert.deepEqual(cxMissing({ tasks: ["A"], who: [{ uid: "u" }], stores: ["S"], note: "Do it well" }, false), []);
});
T("the sentence reads the send back, or says what is still needed", () => {
  assert.match(cxSummary({ tasks: [], who: [], stores: [], note: "" }, false), /^Still needed: a task, someone to do it, a store, a brief\.$/);
  const full = { tasks: ["Design the hero"], who: [{ uid: "a", name: "Sandy" }, { uid: "b", name: "Kim" }], stores: ["Store Epsilon"], note: "Lead with the restock", due: "2026-09-18", dueTime: "17:30" };
  const s = cxSummary(full, false);
  assert.match(s, /^Design the hero → Sandy and Kim · Store Epsilon · due /);
  assert.match(s, /Sep 18/); assert.match(s, /5:30/);
  assert.match(cxSummary(Object.assign({}, full, { who: full.who.concat([{ uid: "c", name: "Ada" }]), tasks: ["A", "B"], stores: ["S1", "S2"], due: "" }), false), /^2 tasks → 3 people · 2 stores$/);
  assert.match(cxSummary(full, true, "Script"), /^Design the hero → Script · Store Epsilon/, "a tracked kind goes to its first step, not to people");
});

/* ---------- the DOM half ---------- */
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div><div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div><div id="orgBody"></div><div id="workBody"></div>
  <div id="shiftbar"></div><div id="cxScrim" class="cx-scrim"></div><section class="cx" id="cx"></section><footer id="dock"></footer>
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
ctx.console = { log(){}, warn(){}, error(){} };   // the loader's failed reads are the point of one test below
["js/config.js", "js/clock.js", "js/permissions.js", "js/item-engine.js", "js/ui.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js",
 "js/notify.js", "js/packs.js", "js/handoff.js", "js/org.js", "js/work.js",
 "js/team.js", "js/assign.js", "js/deck.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
vm.runInContext(`function render(){} var __toasts = []; toast = m => __toasts.push(String(m));`, ctx);
const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;
const $ = id => doc.getElementById(id);
const tick = () => new Promise(r => setTimeout(r, 30));
const DATA = `{ members: [{ uid: "u2", name: "Sandy", open: 2 }, { uid: "u3", name: "Kim", open: 0 }, { uid: "u4", name: "Desmond", open: 5 }],
  stores: ["Store Epsilon", "Studio North"], tasks: ["Design the hero", "Cut the teaser"],
  types: [{ id: "t1", name: "Video", workflowId: "w1", track: [{ label: "Script", roleId: "staff" }, { label: "Edit", roleId: "staff" }] }, { id: "t2", name: "Sponsorship" }],
  roles: [{ craft: "design", label: "All design", uids: ["u3", "u4"] }], err: {} }`;
const picks = sel => [...doc.querySelectorAll(sel)];

await (async () => {
T("open: three numbered steps, every task, person and store on screen, nothing chosen, the send off and the sentence naming all four needs", () => {
  run(`openComposer(); cxSetData(${DATA});`);
  assert.ok($("cx").classList.contains("on"));
  assert.deepEqual(picks(".cx-sec-h i").map(i => i.textContent), ["1", "2", "3"]);
  assert.deepEqual(picks("#cxTasks .cx-pick").map(b => b.textContent.trim()), ["Design the hero", "Cut the teaser"]);
  assert.deepEqual(picks("#cxPeople .cx-person .cx-person-t b").map(b => b.textContent), ["Sandy", "Kim", "Desmond"]);
  assert.match(picks("#cxPeople .cx-person")[1].textContent, /clear/, "a person with nothing open is not marked clear");
  assert.match(picks("#cxPeople .cx-person")[2].textContent, /5 open/);
  assert.equal(picks("#cxPeople .cx-teams .cx-pick").length, 1);
  assert.match(picks("#cxPeople .cx-teams .cx-pick")[0].textContent, /All design.*2 people/);
  const storeChips = picks("#cxStores .cx-pick");
  assert.equal(storeChips.length, 3);
  assert.match(storeChips[0].textContent, /All locations.*2 stores/);
  assert.deepEqual(storeChips.slice(1).map(b => b.textContent.trim()), ["Store Epsilon", "Studio North"]);
  assert.equal(picks(".is-on").length, 1, "something was lit before anything was chosen (the kind chip aside)");
  assert.ok($("cxSend").disabled);
  assert.match($("cxSum").textContent, /Still needed: a task, someone to do it, a store, a brief/);
  assert.deepEqual(picks("#cxDueQuick .cx-pick").map(b => b.textContent), ["Today", "Tomorrow", "In a week"]);
});

T("a tap lights the chip and the sentence follows; a second tap takes it back", () => {
  picks("#cxTasks .cx-pick")[0].click();
  assert.ok(picks("#cxTasks .cx-pick")[0].classList.contains("is-on"));
  assert.match($("cxSum").textContent, /Still needed: someone to do it, a store, a brief/);
  picks("#cxPeople .cx-person")[0].click();
  assert.ok(picks("#cxPeople .cx-person")[0].classList.contains("is-on"));
  assert.equal(run(`cx.who.map(p => p.name).join()`), "Sandy");
  picks("#cxStores .cx-pick")[1].click();
  $("cxNote").value = "Lead with the restock"; $("cxNote").dispatchEvent(new dom.window.Event("input"));
  assert.equal($("cxSend").disabled, false, "everything is chosen and the send is still off");
  assert.equal($("cxSend").textContent, "Assign 1 task → Sandy");
  assert.match($("cxSum").textContent, /^Design the hero → Sandy · Store Epsilon$/);
  picks("#cxPeople .cx-person")[0].click();
  assert.equal(run(`cx.who.length`), 0, "a second tap did not take the person back");
  assert.ok($("cxSend").disabled);
});

T("All locations lights every store and the team chip lights its people; either taps off as one", () => {
  picks("#cxStores .cx-pick-all")[0].click();
  assert.equal(run(`cx.stores.length`), 2);
  assert.ok(picks("#cxStores .cx-pick").every(b => b.classList.contains("is-on")));
  picks("#cxStores .cx-pick-all")[0].click();
  assert.equal(run(`cx.stores.length`), 0);
  picks("#cxPeople .cx-teams .cx-pick")[0].click();
  assert.deepEqual(run(`cx.who.map(p => p.name)`).join(), "Kim,Desmond");
  assert.ok(picks("#cxPeople .cx-teams .cx-pick")[0].classList.contains("is-on"));
  picks("#cxPeople .cx-teams .cx-pick")[0].click();
  assert.equal(run(`cx.who.length`), 0);
});

T("a quick date sets the date input and the sentence; tapping it again clears it", () => {
  picks("#cxDueQuick .cx-pick")[1].click();
  const tomorrow = run(`cxDueQuick()[1].date`);
  assert.equal(run(`cx.due`), tomorrow); assert.equal($("cxDue").value, tomorrow);
  assert.ok(picks("#cxDueQuick .cx-pick")[1].classList.contains("is-on"));
  picks("#cxDueQuick .cx-pick")[1].click();
  assert.equal(run(`cx.due`), ""); assert.equal($("cxDue").value, "");
});

T("the search still finds people, stores and tasks, dims the pickers, and coins a task that is not on the list", () => {
  run(`cx.tasks = []; cx.who = []; cx.stores = []; cx.order = []; cxPaintPickers();`);
  const input = $("cxInput");
  input.value = "des"; input.dispatchEvent(new dom.window.Event("input"));
  assert.ok($("cx").classList.contains("is-searching"));
  const labels = picks("#cxSugs .cx-sug .cx-sug-main").map(x => x.textContent);
  assert.ok(labels.includes("Desmond") && labels.includes("Design the hero") && labels.includes("All design"), labels.join(" | "));
  input.value = "Restock count"; input.dispatchEvent(new dom.window.Event("input"));
  assert.ok(picks("#cxSugs .cx-sug .cx-sug-main").some(x => /New task “Restock count”/.test(x.textContent)), "a new task was not offered");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.ok(run(`cx.tasks.includes("Restock count")`), "Enter did not coin the task");
  assert.equal(input.value, ""); assert.ok(!$("cx").classList.contains("is-searching"));
  assert.equal(picks("#cxTasks .cx-pick")[0].textContent.trim(), "Restock count", "the coined task is not the first, lit chip");
  assert.ok(picks("#cxTasks .cx-pick")[0].classList.contains("is-on"));
  run(`cxRemove("task", "Restock count"); cxRemove("task", "Design the hero"); cxPaintPickers();`);
});

T("a tracked kind shows its route where the people were, asks for nobody, and the send says where it starts", () => {
  run(`cx.tasks = []; cx.who = []; cx.stores = []; cx.order = []; cxPaintPickers();`);
  $("cxNote").value = ""; $("cxNote").dispatchEvent(new dom.window.Event("input"));
  picks("#cxKinds .cx-kind").find(b => b.dataset.kind === "t1").click();
  assert.ok(doc.querySelector("#cxPeople .cx-route"), "no route drawn");
  assert.equal(picks("#cxPeople .cx-person").length, 0, "people were offered for work the track routes");
  assert.match($("cxWhoHint").textContent, /Goes by its steps/);
  assert.match($("cxSum").textContent, /Still needed: a task, a store, a brief/);
  picks("#cxTasks .cx-pick")[0].click(); picks("#cxStores .cx-pick")[1].click();
  $("cxNote").value = "Teaser for the drop"; $("cxNote").dispatchEvent(new dom.window.Event("input"));
  assert.equal($("cxSend").disabled, false);
  assert.match($("cxSend").textContent, /^Start 1 Video → Script$/);
  picks("#cxKinds .cx-kind")[0].click();
  assert.ok(doc.querySelector("#cxPeople .cx-person"), "back on Task, the people did not return");
});

T("a roster that could not be read says so, never an empty team; a load still in flight cannot overwrite data set by hand", async () => {
  run(`closeComposer(); openComposer();`);
  assert.match($("cxTasks").textContent, /Loading/);
  await tick(); await tick();   // the stubbed database throws: every read fails
  assert.match($("cxPeople").textContent, /Could not load the team/);
  assert.match($("cxTasks").textContent, /Could not load the tasks/);
  assert.doesNotMatch($("cxPeople").textContent, /Nobody has signed in/);
  run(`closeComposer(); openComposer(); cxSetData(${DATA});`);
  await tick(); await tick();
  assert.equal(picks("#cxPeople .cx-person").length, 3, "the failed load overwrote the data set by hand");
  run(`closeComposer();`);
});

T("editing keeps the person locked and offers no other", () => {
  run(`openComposer(null, null, { groupId: "g1", rows: [{ id: "r1", toUid: "u2", toName: "Sandy", store: "Store Epsilon", task: "Design the hero", note: "Keep it tight", done: false, createdAt: 1 }] }); cxSetData(${DATA});`);
  assert.equal(picks("#cxPeople .cx-person").length, 1);
  assert.ok(picks("#cxPeople .cx-person")[0].classList.contains("is-locked"));
  assert.equal(picks("#cxKinds .cx-kind").length, 0, "an edit offered to change the kind");
  assert.equal($("cxSend").textContent, "Save changes");
  assert.ok(picks("#cxTasks .cx-pick")[0].classList.contains("is-on"));
  run(`closeComposer();`);
});
})();

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
