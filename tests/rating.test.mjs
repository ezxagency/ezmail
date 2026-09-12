/* Unit tests for ../js/rating.js - pure, so plain node:
     node tests/rating.test.mjs

   The math is a policy the owner stated (quality 50, brief 30, handoff
   20, out of 5; a person is the mean of their tasks; ranked from eight).
   These pin it exactly, and pin the rules that keep it honest: counts
   beside every percentage, "building data" below the minimum, a
   revision as one rating and not two. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../js/rating.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};

/* ---------- one task ---------- */
T("a task's rating is quality × .5 + brief × .3 + handoff × .2", () => {
  assert.equal(R.rtRound(R.rtScore({ quality: 4, brief: 5, handoff: 4 })), 4.3);
  assert.equal(R.rtRound(R.rtScore({ quality: 5, brief: 5, handoff: 5 })), 5);
  assert.equal(R.rtRound(R.rtScore({ quality: 1, brief: 1, handoff: 1 })), 1);
  assert.equal(R.rtRound(R.rtScore({ quality: 3, brief: 4, handoff: 2 })), 3.1);
});
T("a score that is missing, fractional or out of range is no rating at all", () => {
  assert.equal(R.rtScore({ quality: 4, brief: 5 }), null);
  assert.equal(R.rtScore({ quality: 4, brief: 5, handoff: 3.5 }), null);
  assert.equal(R.rtScore({ quality: 6, brief: 5, handoff: 4 }), null);
  assert.equal(R.rtScore({ quality: 0, brief: 5, handoff: 4 }), null);
  assert.equal(R.rtScore(null), null);
});
T("full precision inside, two places for display", () => {
  const xs = [4.3, 4.7, 4.2];
  const mean = xs.reduce((t, x) => t + x, 0) / xs.length;
  assert.equal(R.rtFmt(mean), "4.40");
  assert.equal(R.rtFmt(null), "—");
});
T("months are named in the viewer's calendar, and the previous one wraps the year", () => {
  assert.equal(R.rtPrevMonth("2026-01"), "2025-12");
  assert.equal(R.rtPrevMonth("2026-09"), "2026-08");
  assert.equal(R.rtMonth(new Date(2026, 8, 12).getTime()), "2026-09");
});

/* ---------- the board ---------- */
const NOW = new Date(2026, 8, 12).getTime();
const thisM = R.rtMonth(NOW), lastM = R.rtPrevMonth(thisM);
const DAY = 86400000;
const rv = (about, score, extra) => Object.assign({ aboutUid: about, byUid: "lead", score, at: NOW - DAY, month: thisM, firstPass: true, revisions: 0, onTime: null }, extra || {});
const MEMBERS = [{ uid: "ada", name: "Ada", roleId: "staff" }, { uid: "bo", name: "Bo", roleId: "staff" }, { uid: "cy", name: "Cy", roleId: "designer" }, { uid: "di", name: "Di", roleId: "staff" }];
const REVIEWS = [
  ...Array.from({ length: 9 }, (_, i) => rv("ada", 4.5, { onTime: i < 8 })),                 // 9 reviews, 8 of 9 on time
  ...Array.from({ length: 8 }, (_, i) => rv("bo", i < 4 ? 3.8 : 4.9, { firstPass: i % 2 === 0, revisions: i % 2 ? 1 : 0 })),
  ...Array.from({ length: 3 }, () => rv("cy", 4.0)),                                          // building
  ...Array.from({ length: 4 }, () => rv("di", 3.0, { month: lastM, at: NOW - 40 * DAY })),     // last month only
  ...Array.from({ length: 3 }, () => rv("di", 4.2))                                            // this month
];

T("people with enough reviewed tasks are ranked by rating; the rest are building data, most reviewed first", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  assert.deepEqual(rows.map(r => [r.name, r.ranked, r.rank]), [["Ada", true, 1], ["Bo", true, 2], ["Di", false, null], ["Cy", false, null]]);
  assert.equal(R.rtFmt(rows[0].rating), "4.50");
  assert.equal(R.rtFmt(rows[1].rating), "4.35");
  assert.equal(rows[2].n, 7, "all time counts last month too");
});
T("every percentage carries its count, and 'on time' is only over tasks that had a deadline", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  const ada = rows.find(r => r.name === "Ada"), bo = rows.find(r => r.name === "Bo"), cy = rows.find(r => r.name === "Cy");
  assert.equal(ada.onTimePct, 89); assert.equal(ada.onTimeN, 9);
  assert.equal(bo.onTimePct, null, "no deadlines means no on-time figure, not 0%");
  assert.equal(bo.firstPassPct, 50); assert.equal(bo.revisions, 4);
  assert.equal(cy.firstPassPct, 100);
});
T("'this month' narrows the rating but the trend always reads whole months", () => {
  const since = new Date(2026, 8, 1).getTime();
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW, since });
  const di = rows.find(r => r.name === "Di");
  assert.equal(di.n, 3, "only this month's reviews count toward the rating");
  assert.equal(R.rtFmt(di.rating), "4.20");
  assert.equal(di.thisMonth.n, 3); assert.equal(di.lastMonth.n, 4);
  assert.equal(R.rtFmt(di.delta), "1.20");
  const ada = rows.find(r => r.name === "Ada");
  assert.equal(ada.delta, null, "no last month means no trend, not a trend from zero");
});
T("standout is the top ranked person with a reason; most improved is the biggest rise", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  assert.equal(R.rtStandout(rows).name, "Ada");
  assert.match(R.rtWhy(R.rtStandout(rows)), /Consistently strong work/);
  assert.match(R.rtWhy(R.rtStandout(rows)), /usually approved first time/);
  assert.equal(R.rtImproved(rows).name, "Di");
  assert.equal(R.rtImproved(R.rtBoard([], MEMBERS, { now: NOW })), null);
  assert.equal(R.rtStandout(R.rtBoard([], MEMBERS, { now: NOW })), null, "nobody is ranked on nothing");
  assert.equal(R.rtWhy(R.rtBoard([], MEMBERS, { now: NOW })[0]), "No reviewed work yet.");
});
T("a review with no score or no subject is ignored, never counted as zero", () => {
  const rows = R.rtBoard([{ aboutUid: "ada", score: null }, { score: 4 }, rv("ada", 4)], MEMBERS, { now: NOW, min: 1 });
  assert.equal(rows.find(r => r.name === "Ada").n, 1);
});
T("capacity is open work per person, fewest first, done in each kind's own word", () => {
  const items = [
    { typeId: "t", status: "open", assigneeIds: ["ada"] }, { typeId: "t", status: "open", assigneeIds: ["ada", "bo"] },
    { typeId: "t", status: "done", assigneeIds: ["cy"] }, { typeId: "v", status: "published", assigneeIds: ["cy"] }
  ];
  const doneOf = it => it.status === (it.typeId === "v" ? "published" : "done");
  const cap = R.rtCapacity(items, MEMBERS, doneOf);
  assert.deepEqual(cap.map(c => [c.name, c.open]), [["Cy", 0], ["Di", 0], ["Bo", 1], ["Ada", 2]]);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
