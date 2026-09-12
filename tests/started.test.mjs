/* The started stack — js/started.js.

     node tests/started.test.mjs

   One landscape card per task this shift has started, between the
   clocks and the deck. Everything on a card is derived from the shift's
   segments, so the pure half is checked from a fixture; the DOM half is
   checked for the thing the pure half cannot say - that three fit, that
   the fourth scrolls in on a spring that then STOPS, and that the digits
   move without the stack being rebuilt under the reader's wheel. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
// the pure half leans on clkMs from js/clock.js, which is a global in the
// browser; hand it over the same way here
globalThis.clkMs = (s, now) => Math.max(0, (s.endedAt || now) - s.startedAt);
const { stPlan } = req(join(here, "..", "js", "started.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const M = 60000, NOW = 10 * 3600000;
const seg = (itemId, task, client, from, to) => ({ itemId, task, client, startedAt: NOW - from * M, endedAt: to == null ? null : NOW - to * M });

T("one card per task, oldest first, so a new one lands at the bottom", () => {
  const p = stPlan({ segs: [seg("b", "Second", "Beta", 50, 30), seg("a", "First", "Alpha", 90, 50), seg("b", "Second", "Beta", 20, null)] }, NOW);
  assert.deepEqual(p.map(x => x.itemId), ["a", "b"]);
  assert.equal(p[1].ms, 40 * M, "a task's time is the sum of ALL its segments");
  assert.equal(p[1].client, "Beta");
  assert.equal(p[1].firstAt, NOW - 50 * M, "the card dates from the FIRST time it was started");
});

T("the open segment's task is running; a closed one is paused", () => {
  const p = stPlan({ segs: [seg("a", "First", "Alpha", 90, 50), seg("b", "Second", "Beta", 20, null)] }, NOW);
  assert.equal(p[0].state, "paused");
  assert.equal(p[1].state, "running");
});

T("finished only once the deck has loaded and no longer carries it", () => {
  const sh = { segs: [seg("a", "First", "Alpha", 90, 50)] };
  assert.equal(stPlan(sh, NOW, null, false)[0].state, "paused", "no deck at all");
  assert.equal(stPlan(sh, NOW, new Set(), false)[0].state, "paused", "the deck has not loaded: the honest word is Paused");
  assert.equal(stPlan(sh, NOW, new Set(["a"]), true)[0].state, "paused", "still on the deck");
  assert.equal(stPlan(sh, NOW, new Set(["z"]), true)[0].state, "finished");
});

T("segments with no item - classic tasks, the idle gap - are not started tasks", () => {
  const p = stPlan({ segs: [
    { task: "Design review", startedAt: NOW - 90 * M, endedAt: NOW - 50 * M },
    { task: null, itemId: null, startedAt: NOW - 50 * M, endedAt: null, via: "idle" },
    seg("a", "First", "Alpha", 40, 30)
  ] }, NOW);
  assert.deepEqual(p.map(x => x.itemId), ["a"]);
});

T("no shift is no cards, not a crash", () => {
  assert.deepEqual(stPlan(null, NOW), []);
  assert.deepEqual(stPlan({ segs: [] }, NOW), []);
});

/* ---------- drawn ---------- */
const dom = new JSDOM(`<!doctype html><html><body><div class="started" id="startedRail"></div></body></html>`,
  { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/clock.js", "js/started.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
// the deck's globals, as js/deck.js and js/assign.js would leave them
vm.runInContext(`var dkRows = [], __to = -1, assignedTasksSeen = null;
  var dkItemId = r => r.itemId || r.id; function dkTo(n){ __to = n; }`, ctx);
const run = expr => vm.runInContext(expr, ctx);
const host = () => dom.window.document.getElementById("startedRail");
const shown = () => [...host().querySelectorAll(".st-card")].filter(c => !c.classList.contains("is-off")).map(c => Number(c.dataset.n));
const five = `S.status = "ACTIVE"; S.shift = { startedAt: Date.now() - 3600000, breaks: [], segs: [
  { itemId:"r1", task:"One", client:"Alpha", startedAt: Date.now() - 50*60000, endedAt: Date.now() - 40*60000 },
  { itemId:"r2", task:"Two", client:"Alpha", startedAt: Date.now() - 40*60000, endedAt: Date.now() - 30*60000 },
  { itemId:"r3", task:"Three", client:"Beta", startedAt: Date.now() - 30*60000, endedAt: Date.now() - 20*60000 },
  { itemId:"r4", task:"Four", client:"Beta", startedAt: Date.now() - 20*60000, endedAt: Date.now() - 10*60000 },
  { itemId:"r5", task:"Five", client:"Gamma", startedAt: Date.now() - 10*60000, endedAt: null }
] };`;

T("nothing started draws nothing - the column is just space", () => {
  run(`stReset(); S.status = "ACTIVE"; S.shift = { startedAt: Date.now(), segs: [{ task: "Design review", startedAt: Date.now(), endedAt: null }], breaks: [] }; stRender();`);
  assert.equal(host().innerHTML, "");
  assert.ok(!host().classList.contains("has-cards"));
});

T("five started: five cards, three in view, and they are the LAST three", () => {
  run(`stReset(); ${five} stRender();`);
  assert.equal(host().querySelectorAll(".st-card").length, 5);
  assert.ok(/Started this shift/.test(host().textContent));
  assert.ok(/5/.test(host().querySelector(".st-cap").textContent));
  assert.deepEqual(shown(), [2, 3, 4], "a task just started is the bottom card, and the stack should be showing it");
  assert.ok(host().querySelector('.st-card[data-n="4"]').classList.contains("is-running"));
  assert.ok(host().querySelector(".st-more"), "past three there is no hint that it scrolls");
});

T("the running card's digits move every second without the stack being rebuilt", () => {
  const before = host().querySelector('.st-card[data-n="4"]');
  const was = before.querySelector(".st-time").textContent;
  run(`S.shift.segs[4].startedAt -= 61000; stTick();`);
  const after = host().querySelector('.st-card[data-n="4"]');
  assert.equal(before, after, "the card was rebuilt for a tick");
  assert.notEqual(after.querySelector(".st-time").textContent, was, "the time did not move");
});

T("the wheel moves one card per notch on a spring that stops at rest", () => {
  run(`var __q = []; requestAnimationFrame = cb => { __q.push(cb); return __q.length; };
       function __frame(){ const q = __q.splice(0); q.forEach(cb => cb(16)); return q.length; }`);
  const wheel = dy => host().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
  assert.equal(wheel(-100), false, "an upward notch with cards above should be taken by the stack");
  assert.notEqual(run(`stRaf`), 0, "the wheel did not start the spring");
  let frames = 0;
  while (run(`__frame()`) && frames < 400) frames++;
  assert.ok(frames > 5 && frames < 400, "settled in " + frames + " frames");
  assert.equal(run(`stPos`), 1);
  assert.equal(run(`stRaf`), 0, "still asking for frames at rest");
  assert.deepEqual(shown(), [1, 2, 3]);
  run(`stTo(0); while (__frame());`);
  assert.deepEqual(shown(), [0, 1, 2]);
  assert.equal(wheel(-100), true, "at the top an upward notch must scroll the page, not be swallowed");
  run(`delete globalThis.requestAnimationFrame;`);
});

T("with three or fewer the wheel is left to the page", () => {
  run(`stReset(); ${five} S.shift.segs = S.shift.segs.slice(2); stRender();`);
  assert.equal(host().querySelectorAll(".st-card").length, 3);
  assert.ok(!host().querySelector(".st-more"));
  const e = new dom.window.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  assert.equal(host().dispatchEvent(e), true, "swallowed a scroll that changes nothing");
});

T("pressing a card brings that work to the front of the deck", () => {
  run(`stReset(); ${five} dkRows = [{ id:"r5" }, { id:"r3" }, { id:"r1" }]; assignedTasksSeen = new Set(); stRender();`);
  host().querySelector('.st-card[data-item="r3"]').click();
  assert.equal(run(`__to`), 1);
  assert.ok(host().querySelector('.st-card[data-item="r2"]').classList.contains("is-finished"),
    "off the loaded deck with its segments closed is finished");
  run(`__to = -1;`);
  host().querySelector('.st-card[data-item="r2"]').click();
  assert.equal(run(`__to`), -1, "a finished task has no card on the deck to go to");
});

T("clocking out empties it", () => {
  run(`S.status = "IDLE"; S.shift = null; stRender();`);
  assert.equal(host().innerHTML, "");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
