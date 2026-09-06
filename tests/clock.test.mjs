/* The segment math — js/clock.js.

     node tests/clock.test.mjs

   docs/dashboard-v6-spec.md §1 and §4. Two properties are worth more
   than the rest and most of these assertions are about them:

   1. A task's time is the SUM of its segments, so putting work down and
      picking it up continues rather than restarts.
   2. Segments with no itemId behave EXACTLY as they always have. The
      classic dashboard makes nothing else, and it must not move. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { clkTaskTotal, clkTaskMs, clkOpenItemId, clkPaused, clkIsIdle } =
  createRequire(import.meta.url)(join(here, "..", "js", "clock.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const M = 60000;
const T0 = 1_700_000_000_000;
const seg = (task, itemId, from, to) =>
  ({ task, itemId, startedAt: T0 + from, endedAt: to === null ? null : T0 + to, via: "task" });
const idle = (from, to) =>
  ({ task: null, itemId: null, startedAt: T0 + from, endedAt: to === null ? null : T0 + to, via: "idle" });
const shift = (...segs) => ({ client: "Alpha", startedAt: T0, segs, breaks: [] });

/* ---- the classic path must not move ---- */
T("a segment with no item times only itself, as it always has", () => {
  const sh = { startedAt: T0, segs: [
    { task: "Copy", startedAt: T0, endedAt: T0 + 10 * M },
    { task: "Copy", startedAt: T0 + 20 * M, endedAt: null }], breaks: [] };
  assert.equal(clkTaskMs(sh, T0 + 25 * M), 5 * M,
    "the classic dashboard's task clock started summing across segments");
});

T("on a break the last segment is used, frozen", () => {
  const sh = { startedAt: T0, segs: [
    { task: "Copy", startedAt: T0, endedAt: T0 + 30 * M }], breaks: [] };
  assert.equal(clkTaskMs(sh, T0 + 90 * M), 30 * M);
});

T("no shift and no segments are zero, not a throw", () => {
  assert.equal(clkTaskMs(null, T0), 0);
  assert.equal(clkTaskMs({ segs: [] }, T0), 0);
  assert.equal(clkTaskTotal(null, "i1", T0), 0);
  assert.equal(clkTaskTotal(shift(), null, T0), 0);
});

/* ---- picking work back up ---- */
T("a task's time is all of its segments, not the newest one", () => {
  const sh = shift(seg("Copy", "i1", 0, 23 * M), seg("Design", "i2", 23 * M, 40 * M),
                   seg("Copy", "i1", 40 * M, null));
  assert.equal(clkTaskTotal(sh, "i1", T0 + 45 * M), 28 * M);
  assert.equal(clkTaskMs(sh, T0 + 45 * M), 28 * M,
    "coming back to a task restarted its clock from zero");
});

T("the clock names the item it is running", () => {
  const sh = shift(seg("Copy", "i1", 0, 10 * M), seg("Design", "i2", 10 * M, null));
  assert.equal(clkOpenItemId(sh), "i2");
});

T("while idle nothing is running and the clock counts the idle stretch", () => {
  const sh = shift(seg("Copy", "i1", 0, 30 * M), idle(30 * M, null));
  assert.equal(clkOpenItemId(sh), null);
  assert.ok(clkIsIdle(sh));
  assert.equal(clkTaskMs(sh, T0 + 42 * M), 12 * M,
    "the task clock did not reset when the task was finished");
});

T("idle time is not counted against the task that came before it", () => {
  const sh = shift(seg("Copy", "i1", 0, 30 * M), idle(30 * M, null));
  assert.equal(clkTaskTotal(sh, "i1", T0 + 42 * M), 30 * M);
});

/* ---- the paused row ---- */
T("a task set down is paused; the one running is not", () => {
  const sh = shift(seg("Copy", "i1", 0, 23 * M), seg("Design", "i2", 23 * M, null));
  const p = clkPaused(sh, T0 + 30 * M);
  assert.deepEqual(p.map(x => x.itemId), ["i1"]);
  assert.equal(p[0].ms, 23 * M);
  assert.equal(p[0].task, "Copy");
});

T("the most recently put down comes first", () => {
  const sh = shift(seg("A", "i1", 0, 10 * M), seg("B", "i2", 10 * M, 20 * M),
                   seg("C", "i3", 20 * M, null));
  assert.deepEqual(clkPaused(sh, T0 + 25 * M).map(x => x.itemId), ["i2", "i1"]);
});

T("a task picked up twice is one row carrying both stretches", () => {
  const sh = shift(seg("A", "i1", 0, 10 * M), seg("B", "i2", 10 * M, 20 * M),
                   seg("A", "i1", 20 * M, 35 * M), seg("C", "i3", 35 * M, null));
  const p = clkPaused(sh, T0 + 40 * M);
  assert.equal(p.length, 2);
  assert.equal(p.find(x => x.itemId === "i1").ms, 25 * M);
});

T("idle stretches are not tasks and never appear as paused", () => {
  const sh = shift(seg("A", "i1", 0, 10 * M), idle(10 * M, 20 * M), seg("B", "i2", 20 * M, null));
  assert.deepEqual(clkPaused(sh, T0 + 25 * M).map(x => x.itemId), ["i1"]);
});

/* While idle, EVERY task worked so far is available to pick back up -
   including the one just finished, which the caller drops by checking it
   against the work it is actually showing. */
T("with nothing running, every task worked is offered back", () => {
  const sh = shift(seg("A", "i1", 0, 10 * M), seg("B", "i2", 10 * M, 20 * M), idle(20 * M, null));
  assert.deepEqual(clkPaused(sh, T0 + 25 * M).map(x => x.itemId), ["i2", "i1"]);
});

T("classic segments carry no item, so the paused row stays empty", () => {
  const sh = { startedAt: T0, segs: [
    { task: "Copy", startedAt: T0, endedAt: T0 + 10 * M },
    { task: "Design", startedAt: T0 + 10 * M, endedAt: null }], breaks: [] };
  assert.deepEqual(clkPaused(sh, T0 + 20 * M), []);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
