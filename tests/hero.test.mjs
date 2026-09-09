/* "Pick up where you left off" — js/hero.js.

     node tests/hero.test.mjs

   The chips are this shift's PAUSED tasks (docs/dashboard-v6-spec.md §4)
   and pressing one picks that task back up. Both halves are tested here
   because the interesting failures live between them: a chip naming work
   that was finished, and a chip that looks pressable and moves nothing. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { hrOffer } = createRequire(import.meta.url)(join(here, "..", "js", "hero.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};
const TA = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

/* ---------- hrOffer: which paused tasks may be offered ---------- */

const P = (id, task, ms) => ({ itemId: id, task, ms });
const R = (id, extra) => Object.assign({ id, task: "Row " + id }, extra || {});

T("a paused task with work still on the deck is offered", () => {
  const out = hrOffer([P("a", "Copy", 60000)], [R("a")]);
  assert.deepEqual(out.map(x => x.task), ["Copy"]);
  assert.equal(out[0].ms, 60000);
});

/* clkPaused() cannot know a task was finished - "done" lives on the Item -
   so the rows are what say it is still open. Offering finished work back
   would start the clock on something nobody can complete. */
T("a paused task that was FINISHED is not offered back", () => {
  assert.deepEqual(hrOffer([P("a", "Copy", 60000)], []), []);
});

T("an unloaded queue offers nothing rather than offering everything", () => {
  assert.deepEqual(hrOffer([P("a", "Copy", 1)], null), []);
  assert.deepEqual(hrOffer(null, [R("a")]), []);
});

/* Same reason dkStart() refuses it: a control that can only fail should
   not be drawn at all. */
T("work whose kind was deleted is not offered", () => {
  assert.deepEqual(hrOffer([P("a", "Copy", 1)], [R("a", { orphanType: "Blog post" })]), []);
});

T("the order clkPaused gave is kept — newest put-down first", () => {
  const out = hrOffer([P("b", "Design", 2), P("a", "Copy", 1)], [R("a"), R("b")]);
  assert.deepEqual(out.map(x => x.task), ["Design", "Copy"]);
});

T("three chips at most, however many tasks were put down", () => {
  const paused = [], rows = [];
  for (let i = 0; i < 9; i++){ paused.push(P("i" + i, "T" + i, 1)); rows.push(R("i" + i)); }
  assert.equal(hrOffer(paused, rows).length, 3);
});

T("a baton row is matched by its itemId, not its own document id", () => {
  const out = hrOffer([P("item1", "Copy", 5)], [R("cg9", { itemId: "item1" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].row.id, "cg9");
});

T("the segment's task name wins, and the row's fills in when it has none", () => {
  assert.equal(hrOffer([P("a", "Copy", 1)], [R("a")])[0].task, "Copy");
  assert.equal(hrOffer([P("a", null, 1)], [R("a")])[0].task, "Row a");
});

/* ---------- drawn, and pressed ---------- */

const dom = new JSDOM(`<!doctype html><html><body class="ui-next">
  <div id="assignedDeck"></div><footer id="dock"></footer></body></html>`,
  { runScripts: "outside-only", url: "https://ezclockn.com/?ui=next" });
const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/clock.js", "js/deck.js", "js/hero.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
/* What hero.js reaches for that lives in files this harness does not load.
   save() is the REAL one from config.js - it is Store.write that is counted
   here, so a resume that never asked to be written still fails. */
vm.runInContext(`
  var saves = 0, toasts = [];
  Store.write = function(){ saves++; return Promise.resolve(); };
  function render(){}
  function toast(t){ toasts.push(t); }
  function markAssignmentDone(){}
`, ctx);
const run = expr => vm.runInContext(expr, ctx);
const dock = () => dom.window.document.getElementById("dock");

const setUp = (segs, rows) => run(`
  S.status = "ACTIVE";
  S.shift = { client: "Alpha", startedAt: 0, segs: ${JSON.stringify(segs)}, breaks: [] };
  dkRows = ${JSON.stringify(rows)};
  $("dock").innerHTML = ""; hrRenderPickup($("dock"));`);

const NOW = 3600000;   // segments below are stamped well under this

T("a chip names the task and the time already spent on it", () => {
  setUp([{ task: "Design review", itemId: "a", startedAt: 0, endedAt: 1380000 },
         { task: null, itemId: null, startedAt: 1380000, endedAt: null }],
        [{ id: "a", task: "Design review" }]);
  const chips = dock().querySelectorAll(".pu-chip");
  assert.equal(chips.length, 1);
  assert.ok(chips[0].textContent.includes("Design review"), chips[0].textContent);
  assert.ok(/23m/.test(chips[0].textContent), chips[0].textContent);
});

/* The whole point of the feature: two stretches on one task read as one
   number, not as two chips or as the last stretch alone. */
T("a task picked up twice shows the SUM of its segments, once", () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: "Copy", itemId: "a", startedAt: 900000, endedAt: 1500000 },
         { task: null, itemId: null, startedAt: 1500000, endedAt: null }],
        [{ id: "a", task: "Copy" }]);
  const chips = dock().querySelectorAll(".pu-chip");
  assert.equal(chips.length, 1);
  assert.ok(/20m/.test(chips[0].textContent), chips[0].textContent);
});

T("the task running RIGHT NOW is not offered back to you", () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: "Design", itemId: "b", startedAt: 600000, endedAt: null }],
        [{ id: "a", task: "Copy" }, { id: "b", task: "Design" }]);
  assert.deepEqual([...dock().querySelectorAll(".pu-chip")].map(c => c.textContent.includes("Design")),
    [false]);
});

T("nothing put down draws nothing at all — not even the caption", () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: null }], [{ id: "a" }]);
  assert.equal(dock().innerHTML, "");
});

/* The classic dashboard's segments carry no itemId. They are not tasks
   anything can be resumed BY, and a chip for one would be a dead button. */
T("a classic segment with no item is not a chip", () => {
  setUp([{ task: "Ad-hoc", startedAt: 0, endedAt: 600000 },
         { task: null, startedAt: 600000, endedAt: null }], [{ id: "a" }]);
  assert.equal(dock().innerHTML, "");
});

T("a chip IS a button — it has somewhere to go now", () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: null, itemId: null, startedAt: 600000, endedAt: null }],
        [{ id: "a", task: "Copy" }]);
  assert.equal(dock().querySelectorAll("button.pu-chip").length, 1,
    "the chip renders as plain text while pressing it does something");
});

await TA("pressing a chip opens a FRESH segment for that task, and saves", async () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: null, itemId: null, startedAt: 600000, endedAt: null }],
        [{ id: "a", task: "Copy", store: "Alpha" }]);
  run(`saves = 0`);
  dock().querySelector(".pu-chip").click();
  await new Promise(r => setTimeout(r, 0));
  const segs = JSON.parse(run(`JSON.stringify(S.shift.segs)`));
  assert.equal(segs.length, 3, "the idle segment should have closed and a task segment opened");
  assert.notEqual(segs[1].endedAt, null, "the idle segment was left open beside the new one");
  assert.equal(segs[2].itemId, "a");
  assert.equal(segs[2].endedAt, null);
  // the invariant: exactly one open segment, whatever kind
  assert.equal(segs.filter(x => !x.endedAt).length, 1);
  assert.equal(run(`saves`), 1, "the resume was never written");
});

/* Failure shape 3: written, never read. The sum has to come back out of
   the segments the press just made, not out of a counter beside them. */
await TA("after resuming, the task's total includes what it had before", async () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: null, itemId: null, startedAt: 600000, endedAt: null }],
        [{ id: "a", task: "Copy" }]);
  dock().querySelector(".pu-chip").click();
  await new Promise(r => setTimeout(r, 0));
  const total = Number(run(`clkTaskTotal(S.shift, "a", Date.now())`));
  assert.ok(total >= 600000, "the 10 minutes already spent were dropped: " + total);
});

/* And once it is running it must leave the row: a chip offering to resume
   the task you are already on is the dead button in another costume. */
await TA("the resumed task stops being a chip", async () => {
  setUp([{ task: "Copy", itemId: "a", startedAt: 0, endedAt: 600000 },
         { task: null, itemId: null, startedAt: 600000, endedAt: null }],
        [{ id: "a", task: "Copy" }]);
  dock().querySelector(".pu-chip").click();
  await new Promise(r => setTimeout(r, 0));
  run(`$("dock").innerHTML = ""; hrRenderPickup($("dock"))`);
  assert.equal(dock().innerHTML, "");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
