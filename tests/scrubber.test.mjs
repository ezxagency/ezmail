/* The shift scrubber's arithmetic — js/scrubber.js, pure half.

     node tests/scrubber.test.mjs

   The bar is the first thing on this dashboard that draws a claim about
   somebody's DAY rather than their stopwatch, so the claims are worth
   pinning: that the blocks tile the elapsed time exactly, that a hole in
   the data shows as a hole, and that running over the scheduled length
   widens the bar instead of silently clipping the overtime off the end. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { sbPlan } = createRequire(import.meta.url)(join(here, "..", "js", "scrubber.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const M = 60000, H = 3600000;
const T0 = 1_700_000_000_000;   // a real epoch, so a zero-vs-missing bug can't hide
const shift = (segs, breaks) => ({ startedAt: T0, segs, breaks });
const seg = (from, to) => ({ task: "Copy", startedAt: T0 + from, endedAt: to === null ? null : T0 + to });
const brk = (from, to) => ({ reason: "Lunch", startedAt: T0 + from, endedAt: to === null ? null : T0 + to });
const span = b => b.to - b.from;

T("no shift means no bar at all", () => {
  assert.equal(sbPlan(null, T0, 6 * H), null);
  assert.equal(sbPlan({ segs: [] }, T0, 6 * H), null);
});

/* A shift that started at midnight has startedAt 0 in a fixture and a real
   timestamp in life. The guard has to tell "no shift" from "a shift whose
   clock reads zero", and `!shift.startedAt` cannot. */
T("a shift whose startedAt is 0 is still a shift", () => {
  const p = sbPlan({ startedAt: 0, segs: [{ startedAt: 0, endedAt: 100 }], breaks: [] }, 100, 0);
  assert.ok(p, "a zero timestamp was read as no shift");
  assert.equal(p.worked, 100);
});

T("work and break tile the elapsed time with nothing left over", () => {
  const p = sbPlan(shift([seg(0, 2 * H), seg(3 * H, null)], [brk(2 * H, 3 * H)]), T0 + 4 * H, 6 * H);
  assert.equal(p.elapsed, 4 * H);
  assert.equal(p.worked, 3 * H);
  assert.equal(p.brk, 1 * H);
  assert.equal(p.worked + p.brk, p.elapsed, "the blocks do not add up to the wall clock");
  assert.deepEqual(p.blocks.map(b => b.kind), ["work", "break", "work"]);
  assert.equal(p.blocks.reduce((t, b) => t + span(b), 0), p.elapsed);
});

T("an open segment runs to now, not to nowhere", () => {
  const p = sbPlan(shift([seg(0, null)], []), T0 + 45 * M, 6 * H);
  assert.equal(p.worked, 45 * M);
  assert.equal(p.blocks.length, 1);
  assert.equal(span(p.blocks[0]), 45 * M);
});

/* The invariant says this cannot happen. It has happened - a crash between
   closing a break and reopening a segment is exactly the shape - and the
   bar's job then is to look wrong rather than to quietly call the missing
   hour "worked" and inflate somebody's day. */
T("time nothing claims is drawn as a gap, not as work", () => {
  const p = sbPlan(shift([seg(0, 1 * H)], [brk(2 * H, 3 * H)]), T0 + 3 * H, 6 * H);
  const gaps = p.blocks.filter(b => b.kind === "gap");
  assert.equal(gaps.length, 1);
  assert.equal(span(gaps[0]), 1 * H);
  assert.equal(p.worked, 1 * H, "the gap was counted as worked time");
});

T("overlapping records are clipped, never double-counted", () => {
  // a break recorded over the top of a segment that was never closed
  const p = sbPlan(shift([seg(0, 2 * H)], [brk(1 * H, 2 * H)]), T0 + 2 * H, 6 * H);
  assert.equal(p.worked + p.brk, p.elapsed);
  assert.equal(p.blocks.reduce((t, b) => t + span(b), 0), 2 * H);
});

T("a record reaching outside the shift is clamped to it", () => {
  const p = sbPlan(shift([seg(-1 * H, 1 * H)], []), T0 + 1 * H, 6 * H);
  assert.equal(p.blocks[0].from, 0, "a segment started before the shift did");
  assert.equal(p.worked, 1 * H);
});

T("with a schedule the bar spans the schedule and counts down", () => {
  const p = sbPlan(shift([seg(0, null)], []), T0 + 2 * H, 6 * H);
  assert.equal(p.scheduled, 6 * H);
  assert.equal(p.span, 6 * H);
  assert.equal(p.remaining, 4 * H);
  assert.equal(p.over, 0);
});

T("overtime widens the bar instead of running off the end of it", () => {
  const p = sbPlan(shift([seg(0, null)], []), T0 + 7 * H, 6 * H);
  assert.equal(p.span, 7 * H, "the bar clipped the overtime off");
  assert.equal(p.over, 1 * H);
  assert.equal(p.remaining, 0);
  assert.ok(p.scheduled < p.span, "nothing left to mark where the schedule ended");
});

/* Nobody has set this person's hours. The honest bar measures what HAS
   happened; inventing an eight-hour target would put a number on screen
   that no admin ever chose. */
T("with no schedule there is no target, no remaining and no overtime", () => {
  const p = sbPlan(shift([seg(0, null)], []), T0 + 2 * H, 0);
  assert.equal(p.scheduled, 0);
  assert.equal(p.span, 2 * H);
  assert.equal(p.remaining, 0);
  assert.equal(p.over, 0);
});

T("a shift one second old has a bar, not a divide by zero", () => {
  const p = sbPlan(shift([seg(0, null)], []), T0 + 1000, 6 * H);
  assert.equal(p.elapsed, 1000);
  assert.ok(p.span > 0);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
