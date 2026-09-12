/* The week row — js/week.js.

     node tests/week.test.mjs

   Every number in this row is DERIVED from shifts already on the device,
   so the only way to know it is right is to compute it from a fixture and
   check the answer. The streak is the one with an opinion in it: an empty
   TODAY must not read as a broken streak, because a day that has not
   happened yet cannot have been missed. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { wrPlan } = createRequire(import.meta.url)(join(here, "..", "js", "week.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const H = 3600000;
// Friday 4 September 2026, 14:00 local. Local on purpose: the row is drawn
// in the reader's timezone and a UTC fixture would pass in London and fail
// in Kathmandu.
const NOW = new Date(2026, 8, 4, 14, 0, 0).getTime();
const at = (day, hour) => new Date(2026, 8, day, hour).getTime();
const shift = (day, hours) => ({
  startedAt: at(day, 9), endedAt: at(day, 9 + hours), netMs: hours * H, breakMs: 0
});
const byLabel = p => p.days.map(d => d.label + (d.ms / H));

T("the week runs Monday to Sunday and lands today in the right column", () => {
  const p = wrPlan([], null, NOW);
  assert.equal(p.days.length, 7);
  assert.deepEqual(p.days.map(d => d.label), ["M", "T", "W", "T", "F", "S", "S"]);
  assert.equal(p.days[4].state, "today", "Friday is not marked as today");
  assert.equal(p.days[5].state, "future");
  assert.equal(p.days[0].state, "empty", "a past day with no shift is not empty");
});

T("hours land on the day the shift STARTED, and add up", () => {
  const p = wrPlan([shift(1, 7), shift(2, 6), shift(2, 2)], null, NOW);
  assert.deepEqual(byLabel(p), ["M0", "T7", "W8", "T0", "F0", "S0", "S0"]);
  assert.equal(p.total, 15 * H);
});

/* Full height is an 8-hour DAY, not the week's best day. Scaled to the
   best day, a twenty-minute Tuesday in an otherwise empty week filled the
   whole band and looked like a full shift. */
T("a bar's height is its share of an 8-hour day, not of the week's best day", () => {
  const p = wrPlan([shift(1, 2), shift(2, 8), shift(3, 10), { startedAt: at(4, 9), endedAt: at(4, 9.5), netMs: 20 * 60000 }], null, NOW);
  // the 1st is a Tuesday: Monday is empty and each shift lands one column on
  assert.equal(p.days[0].frac, 0, "an empty Monday");
  assert.equal(p.days[1].frac, 0.25, "two hours is a quarter of a day");
  assert.equal(p.days[2].frac, 1, "eight hours is the full bar");
  assert.equal(p.days[3].frac, 1, "a ten-hour day tops out at full, not past it");
  assert.ok(p.days[4].frac > 0 && p.days[4].frac < 0.05, "twenty minutes is a sliver");
  const alone = wrPlan([{ startedAt: at(2, 9), endedAt: at(2, 9.5), netMs: 20 * 60000 }], null, NOW);
  assert.ok(alone.days[1].frac < 0.05, "the week's only day still fills the whole band");
});

T("last week's shifts are not this week's hours", () => {
  const p = wrPlan([shift(1, 7), { startedAt: at(-3, 9), endedAt: at(-3, 17), netMs: 8 * H }], null, NOW);
  assert.equal(p.total, 7 * H, "a shift from before Monday was counted");
});

/* A row that ignored the hours being worked right now would be wrong all
   day and correct only after clock-out. */
T("the open shift counts before it is closed, breaks deducted", () => {
  const open = {
    startedAt: at(4, 10),
    segs: [{ task: "Copy", startedAt: at(4, 10), endedAt: null }],
    breaks: [{ reason: "Lunch", startedAt: at(4, 12), endedAt: at(4, 13) }]
  };
  const p = wrPlan([], open, NOW);
  assert.equal(p.days[4].ms, 3 * H, "4 hours elapsed minus a 1 hour break is not 3");
  assert.equal(p.days[4].state, "today");
});

T("a record with no netMs is measured rather than dropped", () => {
  const p = wrPlan([{ startedAt: at(1, 9), endedAt: at(1, 17), breakMs: 1 * H }], null, NOW);
  assert.equal(p.total, 7 * H);
});

/* ---- the streak ---- */
T("consecutive days count, and today counts once there are hours on it", () => {
  const p = wrPlan([shift(2, 6), shift(3, 6), shift(4, 6)], null, NOW);
  assert.equal(p.streak, 3);
});

T("an empty today is stepped over, not counted as a miss", () => {
  const p = wrPlan([shift(2, 6), shift(3, 6)], null, NOW);
  assert.equal(p.streak, 2, "the streak broke because today has not started yet");
});

T("one missed day ends it, weekend or not", () => {
  // Wednesday missing: Thursday alone survives
  const p = wrPlan([shift(1, 6), shift(3, 6)], null, NOW);
  assert.equal(p.streak, 1);
});

T("the streak reaches back past the start of the week", () => {
  const days = [];
  for (let d = 28; d <= 31; d++) days.push({ startedAt: new Date(2026, 7, d, 9).getTime(), netMs: 6 * H });
  [1, 2, 3, 4].forEach(d => days.push(shift(d, 6)));
  const p = wrPlan(days, null, NOW);
  assert.equal(p.streak, 8, "the streak stopped at Monday instead of following the days");
});

T("no history is no streak, not a crash", () => {
  const p = wrPlan(null, null, NOW);
  assert.equal(p.streak, 0);
  assert.equal(p.total, 0);
  assert.ok(p.days.every(d => d.frac === 0));
});

/* ---- drawn ---- */
const dom = new JSDOM(`<!doctype html><html><body><div id="weekRow"></div></body></html>`,
  { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/clock.js", "js/week.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
const run = expr => vm.runInContext(expr, ctx);
const row = () => dom.window.document.getElementById("weekRow");

T("seven bars are drawn, today is marked, and the total is stated", () => {
  // one hour starting in today's first minute: "an hour ago" is yesterday
  // for anyone running this just after midnight
  run(`const __d = new Date(); __d.setHours(0, 1, 0, 0);
       S.history = [{ startedAt: __d.getTime(), endedAt: __d.getTime() + 3600000, netMs: 3600000 }];
       S.shift = null; wrRender($("weekRow"));`);
  assert.equal(row().querySelectorAll(".wrow-day").length, 7);
  assert.equal(row().querySelectorAll(".wrow-day.is-today").length, 1);
  assert.ok(row().textContent.includes("This week"));
  assert.ok(/1h/.test(row().textContent), "the week's total is not on screen");
  const todayBar = row().querySelector(".wrow-day.is-today .wrow-bar");
  const h = parseInt(todayBar.style.height, 10);
  assert.ok(h > 6 && h < 12, "one hour of an 8h day should be a short bar, got " + h + "px");
});

/* A pill reading "0 days streak" is a boast about nothing. */
T("no streak means no pill at all", () => {
  run(`S.history = []; S.shift = null; wrRender($("weekRow"));`);
  assert.equal(row().querySelectorAll(".wrow-streak.is-none").length, 1);
  assert.ok(!row().textContent.includes("streak"), "an empty streak pill was drawn anyway");
});

T("one day is a day, not 1 days", () => {
  run(`S.history = [{ startedAt: Date.now() - 3600000, endedAt: Date.now(), netMs: 3600000 }];
       wrRender($("weekRow"));`);
  assert.ok(row().textContent.includes("1 day streak"));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
