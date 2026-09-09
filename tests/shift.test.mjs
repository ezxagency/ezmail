/* The classic shift flows meeting the new IDLE segment - js/shift.js,
   js/render.js, js/nav.js, and taskTally() in js/config.js.

     node tests/shift.test.mjs

   docs/dashboard-v6-spec.md §5: Done on a deck card closes the task
   segment and opens an IDLE one (task: null). Every consumer written
   before that segment existed assumed task was a string. The first
   person to finish a task from the deck and then clock out found the
   wrap-up sheet would not open: taskLabel() threw on null.toUpperCase()
   inside askWrapUp(). The dock read "Resume · null". These load the real
   files into one scope, as index.html does, and drive those paths with
   an idle segment in the shift. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="appScreen">
    <button id="menuBtn"></button><button id="bandMeta"></button>
    <div id="drawerScrim"></div>
    <aside id="drawer"><button id="drawerClose"></button>
      <nav><a class="drawer-item" href="#/" data-route=""><span class="drawer-txt">Dashboard</span></a></nav>
      <button id="drawerProfile"></button><button id="drawerSignOut"></button>
      <span id="drawerAvatar"></span><span id="drawerName"></span><span id="drawerMail"></span>
    </aside>
    <div id="missionScreen" class="hidden"><div id="missionBody"></div><p id="missionDate"></p></div>
    <div id="historyScreen" class="hidden"><div id="historyBody"></div></div>
    <footer id="dock"></footer>
    <button id="cardMenu"></button><button id="teamMenu"></button>
  </div>
  <div id="scrim"></div><div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;

["js/config.js", "js/clock.js", "js/hero.js", "js/ui.js", "js/render.js", "js/shift.js", "js/nav.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;
// the full render loop reaches the rings, the scrubber and the week row -
// none of which these flows are about. What they write to S is the claim.
run(`render = () => {}; syncDirectory = () => {}; loadCompletedAssignmentsForShift = async () => {};`);

const M = 60000, T0 = 1_700_000_000_000;
const idleShift = () => `S.shift = { client: "Alpha", startedAt: ${T0}, breaks: [], segs: [
  { task: "Copy", itemId: "i1", startedAt: ${T0}, endedAt: ${T0 + 30 * M}, via: "task" },
  { task: null, itemId: null, startedAt: ${T0 + 30 * M}, endedAt: null, via: "idle" }
]}; S.status = "ACTIVE";`;

T("the tally skips idle time and keeps the store it carried", () => {
  run(idleShift());
  const tally = JSON.parse(run(`JSON.stringify(taskTally(S.shift, ${T0 + 40 * M}))`));
  assert.deepEqual(tally, [{ store: "Alpha", task: "Copy", ms: 30 * M }]);
});

T("a store switch on an idle segment still carries to the next task", () => {
  run(`S.shift = { client: "Alpha", startedAt: ${T0}, breaks: [], segs: [
    { task: null, itemId: null, client: "Beta", startedAt: ${T0}, endedAt: ${T0 + M}, via: "idle" },
    { task: "Copy", itemId: "i1", startedAt: ${T0 + M}, endedAt: null, via: "task" }]};`);
  const tally = JSON.parse(run(`JSON.stringify(taskTally(S.shift, ${T0 + 2 * M}))`));
  assert.equal(tally[0].store, "Beta");
});

/* THE BUG. Clock out after finishing a deck task. */
T("clock out opens the wrap-up sheet with an idle segment open", () => {
  run(idleShift());
  run(`askWrapUp()`);
  const body = doc.getElementById("sheetBody").textContent;
  assert.ok(doc.getElementById("sheet").classList.contains("on"), "the sheet never opened");
  assert.ok(body.includes("ALPHA COPY WORK"), "the real task is missing from the tally: " + body);
  assert.ok(!body.includes("null"), "idle time was labelled null: " + body);
  run(`closeSheet()`);
});

T("the shift report and the export do not name the idle time", () => {
  run(idleShift());
  const rec = run(`(() => { const sh = S.shift; return reportText(Object.assign({}, sh, {
    worker: "Ada", endedAt: ${T0 + 40 * M}, netMs: 40 * ${M}, breakMs: 0, rating: 4, note: "ok" })); })()`);
  assert.ok(rec.includes("ALPHA COPY WORK"));
  assert.ok(!rec.includes("null"), rec);
});

T("the dock offers a plain Resume when there is nothing to resume to", () => {
  run(idleShift() + `S.shift.segs[1].endedAt = ${T0 + 35 * M};
    S.shift.breaks.push({ reason: "Lunch", startedAt: ${T0 + 35 * M}, endedAt: null }); S.status = "ON_BREAK";`);
  run(`renderDock()`);
  const label = doc.getElementById("dock").querySelector(".btn-go").textContent.trim();
  assert.equal(label, "Resume", "the dock said: " + label);
  const mission = run(`missionActionsHTML()`);
  assert.ok(!mission.includes("null"), mission);
});

T("the dock still names the task when there is one", () => {
  run(`S.shift = { client: "Alpha", startedAt: ${T0}, breaks: [
      { reason: "Lunch", startedAt: ${T0 + 10 * M}, endedAt: null }], segs: [
      { task: "Copy", itemId: "i1", startedAt: ${T0}, endedAt: ${T0 + 10 * M}, via: "task" }]};
    S.status = "ON_BREAK"; renderDock();`);
  assert.equal(doc.getElementById("dock").querySelector(".btn-go").textContent.trim(), "Resume · Copy");
});

/* A break must not turn running work back into "Start task". */
T("resume carries the item the segment was working", () => {
  run(`S.shift = { client: "Alpha", startedAt: ${T0}, breaks: [
      { reason: "Lunch", startedAt: ${T0 + 10 * M}, endedAt: null }], segs: [
      { task: "Copy", itemId: "i1", startedAt: ${T0}, endedAt: ${T0 + 10 * M}, via: "task" }]};
    S.status = "ON_BREAK"; resume();`);
  const seg = JSON.parse(run(`JSON.stringify(openSeg(S.shift))`));
  assert.equal(seg.itemId, "i1", "the resumed segment forgot its item");
  assert.equal(seg.task, "Copy");
  assert.equal(run(`clkOpenItemId(S.shift)`), "i1");
});

T("resuming from idle stays idle rather than inventing a task", () => {
  run(idleShift() + `S.shift.segs[1].endedAt = ${T0 + 35 * M};
    S.shift.breaks.push({ reason: "Lunch", startedAt: ${T0 + 35 * M}, endedAt: null }); S.status = "ON_BREAK"; resume();`);
  const seg = JSON.parse(run(`JSON.stringify(openSeg(S.shift))`));
  assert.equal(seg.task, null);
  assert.equal(seg.itemId, null);
});

T("the switch sheet says nothing is running instead of naming null", () => {
  run(idleShift());
  run(`askSwitch()`);
  const body = doc.getElementById("sheetBody").textContent;
  assert.ok(body.includes("Nothing running"), body);
  assert.ok(!body.includes("null"), body);
  run(`closeSheet()`);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
