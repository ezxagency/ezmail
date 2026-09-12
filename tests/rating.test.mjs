/* Unit tests for ../js/rating.js - pure, so plain node:
     node tests/rating.test.mjs

   The math is a policy the owner stated: quality 50, brief 30, handoff
   20, out of 5, carried as integer tenths (q×5 + b×3 + h×2); a person
   is the mean of their approved contributions; ranked from eight.
   These pin it exactly, and pin the rules that keep it honest: one
   rating per contribution however many rounds it took, counts beside
   every percentage, "building data" below the minimum, pending work
   as nothing rather than zero, the period and the role and the kind
   of work as filters, and what a submission or a decision needs. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../js/rating.js");
const P = require("../js/permissions.js");
// rvMayDecide reads the permission grammar from the shared scope, the
// way the browser has it
globalThis.permGrantScope = P.permGrantScope;

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};

/* ---------- one contribution ---------- */
T("a contribution's rating is quality × .5 + brief × .3 + handoff × .2, carried as integer tenths", () => {
  assert.equal(R.rtTenths({ quality: 4, brief: 5, handoff: 4 }), 43);
  assert.equal(R.rtScore({ quality: 4, brief: 5, handoff: 4 }), 4.3);
  assert.equal(R.rtFmt(R.rtScore({ quality: 4, brief: 5, handoff: 4 })), "4.30");
  assert.equal(R.rtTenths({ quality: 5, brief: 5, handoff: 5 }), 50);
  assert.equal(R.rtTenths({ quality: 1, brief: 1, handoff: 1 }), 10);
  assert.equal(R.rtScore({ quality: 3, brief: 4, handoff: 2 }), 3.1);
  assert.deepEqual(R.RT_TENTHS, { quality: 5, brief: 3, handoff: 2 });
  assert.deepEqual(R.RT_WEIGHTS, { quality: 0.5, brief: 0.3, handoff: 0.2 });
});
T("a score that is missing, fractional, a string or out of range is no rating at all", () => {
  assert.equal(R.rtTenths({ quality: 4, brief: 5 }), null);
  assert.equal(R.rtTenths({ quality: 4, brief: 5, handoff: 3.5 }), null);
  assert.equal(R.rtTenths({ quality: 6, brief: 5, handoff: 4 }), null);
  assert.equal(R.rtTenths({ quality: 0, brief: 5, handoff: 4 }), null);
  assert.equal(R.rtTenths({ quality: "4", brief: 5, handoff: 4 }), null);
  assert.equal(R.rtTenths(null), null);
  assert.equal(R.rtValidScores({ quality: 1, brief: 5, handoff: 3 }), true);
});
T("a person is the mean of their tenths ÷ 10, full precision inside, two places for display", () => {
  // 43, 47, 42 tenths → 44 → 4.4 exactly; floats would have given 4.3999…
  assert.equal(R.rtMeanTenths([43, 47, 42]), 4.4);
  assert.equal(R.rtFmt(R.rtMeanTenths([43, 47, 42])), "4.40");
  assert.equal(R.rtMeanTenths([43, 44]), 4.35);
  assert.equal(R.rtFmt(R.rtMeanTenths([43, 44, 44])), "4.37", "rounded for display only");
  assert.equal(R.rtMeanTenths([]), null);
  assert.equal(R.rtFmt(null), "—");
});
T("the scale has five words, and each criterion has an example for each of them", () => {
  assert.deepEqual(R.RT_SCALE, ["Unusable", "Needs substantial work", "Meets expectations", "Strong", "Exceptional"]);
  R.RT_KEYS.forEach(k => assert.equal(R.RT_EXAMPLES[k].length, 5, k + " lacks five examples"));
  assert.equal(R.RT_MIN_REVIEWS, 8);
});
T("months are named in the viewer's calendar; the periods start on Monday, the 1st, and the beginning of time", () => {
  assert.equal(R.rtPrevMonth("2026-01"), "2025-12");
  assert.equal(R.rtPrevMonth("2026-09"), "2026-08");
  assert.equal(R.rtMonth(new Date(2026, 8, 12).getTime()), "2026-09");
  const sat = new Date(2026, 8, 12, 15).getTime();           // a Saturday
  assert.equal(R.rtSince("week", sat), new Date(2026, 8, 7).getTime(), "the week starts on Monday");
  assert.equal(R.rtSince("month", sat), new Date(2026, 8, 1).getTime());
  assert.equal(R.rtSince("all", sat), 0);
  assert.equal(R.rtSince("week", new Date(2026, 8, 14, 1).getTime()), new Date(2026, 8, 14).getTime(), "a Monday is its own week's start");
});

/* ---------- what a review is ---------- */
T("a review is keyed by the work, the step and the person - so parallel steps and co-assignees are separate", () => {
  assert.equal(R.rvKey("it1", "s2", "ada"), "it1:s2:ada");
  assert.equal(R.rvKey("it1", null, "ada"), "it1:work:ada");
  assert.notEqual(R.rvKey("it1", "s1", "ada"), R.rvKey("it1", "s2", "ada"));
  assert.notEqual(R.rvKey("it1", null, "ada"), R.rvKey("it1", null, "bo"));
});
const approved = (about, scores, extra) => {
  const tenths = R.rtTenths(scores);
  return Object.assign({ itemId: "it", nodeId: null, aboutUid: about, status: "approved", round: 1,
    submission: { at: 100, byUid: about, iteration: null, onTime: null },
    decision: { kind: "approved", feedback: "Good", scores, byUid: "lead", at: 200 },
    weightedTenths: tenths, score: tenths / 10, at: 200, month: "2026-09" }, extra || {});
};
T("only an approved current round is a rating; submitted, changes and a reopened approval are pending, never zero", () => {
  const x = R.rvRating(approved("ada", { quality: 4, brief: 5, handoff: 4 }));
  assert.equal(x.tenths, 43); assert.equal(x.score, 4.3); assert.equal(x.firstPass, true); assert.equal(x.revisions, 0);
  assert.equal(R.rvRating(Object.assign(approved("ada", { quality: 4, brief: 5, handoff: 4 }), { status: "submitted", decision: null })), null);
  assert.equal(R.rvRating(Object.assign(approved("ada", { quality: 4, brief: 5, handoff: 4 }), { status: "changes" })), null);
  assert.equal(R.rvRating(null), null);
  const r3 = R.rvRating(approved("ada", { quality: 5, brief: 5, handoff: 5 }, { round: 3 }));
  assert.equal(r3.firstPass, false); assert.equal(r3.revisions, 2, "three rounds is two revisions");
});
T("the state a card is in: an approval for an earlier pass of a step is stale, not reused", () => {
  const r = approved("ada", { quality: 4, brief: 4, handoff: 4 }, { submission: { at: 1, byUid: "ada", iteration: 1 } });
  assert.equal(R.rvState(r, 1), "approved");
  assert.equal(R.rvState(r, 2), "stale", "a loop sent the step round again; the old approval must not stand for the new work");
  assert.equal(R.rvState(r, null), "approved", "work that is not on a track has no iterations");
  assert.equal(R.rvState(Object.assign({}, r, { status: "changes" }), 1), "changes");
  assert.equal(R.rvState(null, 1), "none");
  assert.equal(R.rvState({ status: "weird" }, 1), "none");
});
T("a submission needs a link or a note; a link is a web address or nothing", () => {
  assert.equal(R.rvLinkOk("https://docs.example.com/x?y=1"), true);
  assert.equal(R.rvLinkOk("http://x.y"), true);
  assert.equal(R.rvLinkOk(""), true);
  assert.equal(R.rvLinkOk(null), true);
  assert.equal(R.rvLinkOk("javascript:alert(1)"), false);
  assert.equal(R.rvLinkOk("docs.example.com"), false);
  assert.equal(R.rvLinkOk("https://x.y/a b"), false);
  assert.equal(R.rvLinkOk("https://" + "x".repeat(2000)), false);
  assert.deepEqual(R.rvSubmissionOk("", ""), { ok: false, reason: "empty" });
  assert.deepEqual(R.rvSubmissionOk("ftp://x", "note"), { ok: false, reason: "bad-link" });
  assert.deepEqual(R.rvSubmissionOk("", "  here it is  "), { ok: true });
  assert.deepEqual(R.rvSubmissionOk("https://x.y", ""), { ok: true });
  assert.deepEqual(R.rvSubmissionOk("", "x".repeat(4001)), { ok: false, reason: "long" });
});
T("a decision needs feedback; an approval needs three whole scores as well", () => {
  assert.deepEqual(R.rvDecisionOk("changes", null, ""), { ok: false, reason: "feedback" });
  assert.deepEqual(R.rvDecisionOk("changes", null, "   "), { ok: false, reason: "feedback" });
  assert.deepEqual(R.rvDecisionOk("changes", null, "Tighten the intro"), { ok: true });
  assert.deepEqual(R.rvDecisionOk("approved", { quality: 5, brief: 5 }, "Great"), { ok: false, reason: "scores" });
  assert.deepEqual(R.rvDecisionOk("approved", { quality: 5, brief: 5, handoff: 5 }, "Great, because…"), { ok: true });
  assert.deepEqual(R.rvDecisionOk("approved", { quality: 5, brief: 5, handoff: 5 }, ""), { ok: false, reason: "feedback" }, "a 5 needs its reason like any other score");
  assert.deepEqual(R.rvDecisionOk("maybe", null, "x"), { ok: false, reason: "kind" });
});
T("deadlines: a date is the end of that day on the submitter's clock, a time narrows it, none is null - never false", () => {
  assert.equal(R.rvDueAt({ dueAt: 5000 }), 5000);
  assert.equal(R.rvDueAt({ dueDate: "2026-09-12" }), new Date(2026, 8, 12, 23, 59, 59, 999).getTime());
  assert.equal(R.rvDueAt({ dueDate: "2026-09-12", dueTime: "17:30" }), new Date(2026, 8, 12, 17, 30).getTime());
  assert.equal(R.rvDueAt({ dueDate: "nonsense" }), null);
  assert.equal(R.rvDueAt({}), null);
  assert.equal(R.rvOnTime(10, 20), true);
  assert.equal(R.rvOnTime(30, 20), false);
  assert.equal(R.rvOnTime(30, null), null, "no deadline is not late");
});
T("who may decide: the owner, the named reviewer, a role granted review:decide - and never the person themselves", () => {
  const r = { aboutUid: "ada", reviewerUid: null };
  assert.equal(R.rvMayDecide(r, "owner1", "owner", ["*:*:org"]), true);
  assert.equal(R.rvMayDecide(r, "ada", "owner", ["*:*:org"]), false, "an owner cannot rate their own work");
  assert.equal(R.rvMayDecide(r, "bo", "staff", ["item:update:assigned"]), false);
  assert.equal(R.rvMayDecide(r, "bo", "manager", ["review:decide:org"]), true);
  assert.equal(R.rvMayDecide(r, "bo", "manager", ["review:decide:own"]), false, "own scope reaches nobody else's work");
  assert.equal(R.rvMayDecide({ aboutUid: "ada", reviewerUid: "bo" }, "bo", "staff", []), true, "the named reviewer decides");
  assert.equal(R.rvMayDecide({ aboutUid: "ada", reviewerUid: "bo" }, "cy", "staff", []), false);
  assert.equal(R.rvMayDelegate(r, "owner1", "owner", []), true);
  assert.equal(R.rvMayDelegate(r, "ada", "owner", []), false, "nobody picks their own reviewer");
  assert.equal(R.rvMayDelegate({ aboutUid: "ada", reviewerUid: "bo" }, "bo", "staff", []), false, "being the reviewer is not being allowed to hand it on");
});

/* ---------- the board ---------- */
const NOW = new Date(2026, 8, 12).getTime();
const thisM = R.rtMonth(NOW), lastM = R.rtPrevMonth(thisM);
const DAY = 86400000;
let seq = 0;
const rv = (about, scores, extra) => {
  const tenths = R.rtTenths(scores);
  const at = (extra && extra.at) || NOW - DAY;
  return Object.assign({ id: "d" + (++seq), itemId: "d" + seq, nodeId: null, typeId: "brief", aboutUid: about, status: "approved", round: 1,
    submission: { at: at - 1, byUid: about, iteration: null, onTime: null }, decision: { kind: "approved", feedback: "ok", scores, byUid: "lead", at },
    weightedTenths: tenths, score: tenths / 10, at, month: R.rtMonth(at), onTime: null }, extra || {});
};
const S45 = { quality: 5, brief: 4, handoff: 4 };   // 45 tenths
const S38 = { quality: 4, brief: 3, handoff: 4 };   // 37 tenths
const S49 = { quality: 5, brief: 5, handoff: 4 };   // 48 tenths
const S30 = { quality: 3, brief: 3, handoff: 3 };   // 30
const S42 = { quality: 4, brief: 5, handoff: 4 };   // 43
const MEMBERS = [{ uid: "ada", name: "Ada", roleId: "staff" }, { uid: "bo", name: "Bo", roleId: "staff" }, { uid: "cy", name: "Cy", roleId: "designer" }, { uid: "di", name: "Di", roleId: "staff" }, { uid: "ed", name: "Ed", roleId: null }];
const REVIEWS = [
  ...Array.from({ length: 9 }, (_, i) => rv("ada", S45, { onTime: i < 8 })),                          // 9, 8 of 9 on time
  ...Array.from({ length: 8 }, (_, i) => rv("bo", i < 4 ? S38 : S49, { round: i % 2 ? 2 : 1 })),      // 8, half revised
  ...Array.from({ length: 3 }, () => rv("cy", S42, { typeId: "video" })),                              // building
  ...Array.from({ length: 4 }, () => rv("di", S30, { at: NOW - 40 * DAY })),                            // last month only
  ...Array.from({ length: 3 }, () => rv("di", S42))                                                     // this month
];

T("people with enough approved contributions are ranked by rating; the rest are building data, most reviewed first", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  assert.deepEqual(rows.map(r => [r.name, r.ranked, r.rank]), [["Ada", true, 1], ["Bo", true, 2], ["Di", false, null], ["Cy", false, null], ["Ed", false, null]]);
  assert.equal(R.rtFmt(rows[0].rating), "4.50");
  assert.equal(rows[1].rating, (37 * 4 + 48 * 4) / 8 / 10, "the mean is over tenths, exactly");
  assert.equal(R.rtFmt(rows[1].rating), "4.25");
  assert.equal(rows[2].n, 7, "all time counts last month too");
  assert.equal(rows[4].n, 0);
  assert.equal(rows[4].roleId, null, "a member with no role is not given one");
});
T("every percentage carries its count, and 'on time' is only over work that had a deadline", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  const ada = rows.find(r => r.name === "Ada"), bo = rows.find(r => r.name === "Bo"), cy = rows.find(r => r.name === "Cy");
  assert.equal(ada.onTimePct, 89); assert.equal(ada.onTimeN, 9);
  assert.equal(bo.onTimePct, null, "no deadlines means no on-time figure, not 0%");
  assert.equal(bo.onTimeN, 0);
  assert.equal(bo.firstPassPct, 50); assert.equal(bo.revisions, 4);
  assert.equal(cy.firstPassPct, 100);
});
T("one rating per contribution: the same document twice, or four rounds of one, is one row of credit", () => {
  const four = rv("ada", S49, { round: 4 });
  const rows = R.rtBoard([four, Object.assign({}, four), four], [MEMBERS[0]], { now: NOW, min: 1 });
  assert.equal(rows[0].n, 1, "a duplicate was counted twice");
  assert.equal(rows[0].revisions, 3);
  assert.equal(rows[0].firstPassPct, 0);
  // and a document sent round again after its approval is pending, so its earlier score leaves the board
  const reopened = Object.assign(rv("ada", S49), { status: "submitted", decision: null, history: [{ round: 1, decision: { kind: "approved", scores: S49 } }] });
  assert.equal(R.rtBoard([reopened], [MEMBERS[0]], { now: NOW, min: 1 })[0].n, 0);
});
T("'this month' narrows the rating but the trend always reads whole months", () => {
  const since = new Date(2026, 8, 1).getTime();
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW, since });
  const di = rows.find(r => r.name === "Di");
  assert.equal(di.n, 3, "only this month's approvals count toward the rating");
  assert.equal(R.rtFmt(di.rating), "4.30");
  assert.equal(di.thisMonth.n, 3); assert.equal(di.lastMonth.n, 4);
  assert.equal(R.rtFmt(di.delta), "1.30");
  const ada = rows.find(r => r.name === "Ada");
  assert.equal(ada.delta, null, "no last month means no trend, not a trend from zero");
});
T("'this week' reads the viewer's Monday-to-Sunday week", () => {
  const monday = new Date(2026, 8, 7).getTime();
  const rows = R.rtBoard([rv("ada", S45, { at: monday + 1 }), rv("ada", S30, { at: monday - 1 })], [MEMBERS[0]], { now: NOW, since: R.rtSince("week", NOW), min: 1 });
  assert.equal(rows[0].n, 1); assert.equal(R.rtFmt(rows[0].rating), "4.50");
});
T("a role filter compares matching roles only; a kind-of-work filter counts matching work only; neither invents a row", () => {
  let rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW, roleId: "staff" });
  assert.deepEqual(rows.map(r => r.name), ["Ada", "Bo", "Di"], "designers and the unroled are not staff");
  rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW, typeId: "video" });
  assert.equal(rows.find(r => r.name === "Cy").n, 3);
  assert.equal(rows.find(r => r.name === "Ada").n, 0, "briefs do not count under the video filter");
  assert.equal(rows.find(r => r.name === "Ada").rating, null, "nothing counted is no rating, not 0");
  rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW, roleId: "nobody-has-this" });
  assert.deepEqual(rows, []);
});
T("the counts: approved in the period, awaiting review now, and changes waiting on a revision", () => {
  const docs = REVIEWS.concat([
    { id: "p1", itemId: "p1", aboutUid: "ada", typeId: "brief", status: "submitted", submission: { at: NOW } },
    { id: "p2", itemId: "p2", aboutUid: "bo", typeId: "video", status: "submitted", submission: { at: NOW } },
    { id: "p3", itemId: "p3", aboutUid: "cy", typeId: "brief", status: "changes", decision: { kind: "changes" } }
  ]);
  assert.deepEqual(R.rtCounts(docs, {}), { reviewed: 27, awaiting: 2, changes: 1 });
  assert.deepEqual(R.rtCounts(docs, { since: new Date(2026, 8, 1).getTime() }), { reviewed: 23, awaiting: 2, changes: 1 }, "waiting work is never narrowed by the period");
  assert.deepEqual(R.rtCounts(docs, { typeId: "video" }), { reviewed: 3, awaiting: 1, changes: 0 });
  assert.deepEqual(R.rtCounts(docs, { roleIds: ["ada"] }), { reviewed: 9, awaiting: 1, changes: 0 });
  assert.deepEqual(R.rtCounts(null, {}), { reviewed: 0, awaiting: 0, changes: 0 });
});
T("standout is the top ranked person with a reason; most improved is the biggest rise; nothing is nobody", () => {
  const rows = R.rtBoard(REVIEWS, MEMBERS, { now: NOW });
  assert.equal(R.rtStandout(rows).name, "Ada");
  assert.match(R.rtWhy(R.rtStandout(rows)), /Consistently strong work/);
  assert.match(R.rtWhy(R.rtStandout(rows)), /usually approved first time/);
  assert.equal(R.rtImproved(rows).name, "Di");
  assert.equal(R.rtImproved(R.rtBoard([], MEMBERS, { now: NOW })), null);
  assert.equal(R.rtStandout(R.rtBoard([], MEMBERS, { now: NOW })), null, "nobody is ranked on nothing");
  assert.equal(R.rtWhy(R.rtBoard([], MEMBERS, { now: NOW })[0]), "No reviewed work yet.");
});
T("a document with no score, no subject or the wrong status is ignored, never counted as zero", () => {
  const rows = R.rtBoard([{ aboutUid: "ada", status: "approved", decision: { scores: null } }, { status: "approved" }, rv("ada", S42)], MEMBERS, { now: NOW, min: 1 });
  assert.equal(rows.find(r => r.name === "Ada").n, 1);
  assert.equal(R.rtFmt(rows.find(r => r.name === "Ada").rating), "4.30");
});
T("hours never enter the score", () => {
  const src = require("node:fs").readFileSync(new URL("../js/rating.js", import.meta.url), "utf8");
  assert.ok(!/netMs|hours|shiftMinutes/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "rating.js reads a clock");
});
T("capacity is open work per person, fewest first, done in each kind's own word", () => {
  const items = [
    { typeId: "t", status: "open", assigneeIds: ["ada"] }, { typeId: "t", status: "open", assigneeIds: ["ada", "bo"] },
    { typeId: "t", status: "done", assigneeIds: ["cy"] }, { typeId: "v", status: "published", assigneeIds: ["cy"] }
  ];
  const doneOf = it => it.status === (it.typeId === "v" ? "published" : "done");
  const cap = R.rtCapacity(items, MEMBERS.slice(0, 4), doneOf);
  assert.deepEqual(cap.map(c => [c.name, c.open]), [["Cy", 0], ["Di", 0], ["Bo", 1], ["Ada", 2]]);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
