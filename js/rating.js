/* ============================================================
   RATING — reviewed quality: the math, the words, and what a
   review IS. Pure. No DOM below the form helpers at the bottom,
   no Firestore anywhere, so the same file runs in the browser
   and under Node (tests/rating.test.mjs).

   THE FLOW (js/reviews.js does the writing; this file decides):
     1. the person doing the work SUBMITS it - a link and/or a note
     2. the reviewer reads the brief, the submission, the person and
        the task together, and either REQUESTS CHANGES (feedback
        required) or APPROVES & RATES (three scores and feedback,
        all required)
     3. the person sees the result; after changes they resubmit,
        which closes the round into `history` and opens the next
     4. an approval is the go-ahead; the person then finishes or
        passes the work on, and the button says so

   ONE REVIEW DOCUMENT PER CONTRIBUTION, keyed by rvKey(): the piece
   of work, the step (parallel steps are separate contributions) and
   the person. Every round of a contribution lives in that one
   document - the current round on top, the closed ones in `history`
   in order, never rewritten - so a polished result after four rounds
   is ONE rating with `revisions: 3` beside it, never four rows on
   the board. A re-entry of a step (a loop sending it round again)
   is a new round of the same document, and an approval given to an
   earlier round says so rather than standing for the new work.

   THE MATH IS EXACT AND STATED ONCE. A contribution's rating is
       quality × 0.50 + brief × 0.30 + handoff × 0.20     (out of 5)
   carried as INTEGER TENTHS: weightedTenths = q×5 + b×3 + h×2, so
   nothing is rounded until it is drawn. A person is
       sum(weightedTenths of their approved contributions) ÷ count ÷ 10.
   The weights are a policy the owner chose (2026-09-12), not a
   measurement; they live here so changing them is one line.

   WHAT KEEPS IT HONEST. Unreviewed work is pending, never zero;
   hours do not enter the score; nobody is ranked under RT_MIN_REVIEWS
   approved contributions in the chosen period (the row says "Building
   data · 3 of 8", and eight is a starting line, not a proof); every
   percentage carries its count; "on time" is only over work that had
   a deadline; nobody rates themselves (the rules refuse it, and the
   sheet never offers it).
   ============================================================ */

const RT_WEIGHTS = { quality: 0.50, brief: 0.30, handoff: 0.20 };
const RT_TENTHS  = { quality: 5, brief: 3, handoff: 2 };       // the same weights, in tenths of a point
const RT_KEYS = ["quality", "brief", "handoff"];
const RT_LABELS = { quality: "Execution quality", brief: "Brief accuracy", handoff: "Handoff readiness" };
const RT_HINTS = {
  quality: "The work itself - is it done well, correct and complete?",
  brief: "Did it do what was asked - the instructions, the standard, the details that mattered?",
  handoff: "Could the next person pick it up - everything there, clearly labelled, nothing to chase?"
};
/* What each score means, with examples that fit ANY kind of work - a
   report, a build, a delivery, a design, a spreadsheet, a service call -
   so a 4 and a 5 are different things and not a mood. The first version
   spoke only of copy and design; a team doing anything else could not
   see itself in it. */
const RT_EXAMPLES = {
  quality: [
    "Cannot be used: the wrong thing was delivered, or it is broken or wrong enough to redo from scratch.",
    "The outline is there but most of it needs redoing - errors throughout, a rough finish, does not hold up when checked.",
    "Solid and usable as delivered: accurate, complete, finished to the standard the job needs.",
    "Better than asked: cleaner, sharper or more thorough than it had to be, with the edge cases handled without being told.",
    "Work you would hold up as the example - the version everyone else's gets measured against."
  ],
  brief: [
    "Answered a different task: wrong scope, wrong audience or customer, the instructions ignored.",
    "Hit some of it, missed key parts - a required piece is missing, or a stated must-do was skipped.",
    "Everything that was asked for is there, and nothing that was ruled out.",
    "Followed the instructions and caught what they implied - the format the reader needs, the standard the situation calls for.",
    "Understood the goal better than the instructions did: flagged a gap, proposed the fix, delivered both."
  ],
  handoff: [
    "Nothing to pick up: no files, a dead link, nobody could tell what was delivered.",
    "It is there but somebody has to chase - pieces missing, access not granted, versions unlabelled.",
    "The next person can start: the link works, the files are named, a note says what is what.",
    "Organised for the next step: sources included, versions labelled, the note anticipates the questions.",
    "Zero friction: everything the next few steps will need is already in place and explained."
  ]
};
const RT_SCALE = ["Unusable", "Needs substantial work", "Meets expectations", "Strong", "Exceptional"];
const RT_MIN_REVIEWS = 8;       // ranked from this many approved contributions
const RT_MIN_TREND = 3;         // a month counts toward "improved" from this many
const RT_FEEDBACK_MAX = 4000;   // characters; the rules hold the same number
const RT_NOTE_MAX = 4000;
const RT_LINK_MAX = 2000;

/* Every score a whole number from 1 to 5, or nothing at all: a 3.5 typed
   somewhere would make every average look more precise than the
   judgement behind it. */
function rtValidScores(scores){
  if (!scores || typeof scores !== "object") return false;
  return RT_KEYS.every(k => {
    const v = scores[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
  });
}
/* The rating in tenths - an integer, so sums and means stay exact. */
function rtTenths(scores){
  if (!rtValidScores(scores)) return null;
  return RT_KEYS.reduce((t, k) => t + scores[k] * RT_TENTHS[k], 0);
}
/* One contribution's rating out of 5, or null if any score is missing
   or out of range. quality 4, brief 5, handoff 4 → 43 tenths → 4.3. */
function rtScore(scores){
  const t = rtTenths(scores);
  return t == null ? null : t / 10;
}
const rtRound = x => x == null ? null : Math.round(x * 100) / 100;
const rtFmt = x => x == null ? "—" : (Math.round(x * 100) / 100).toFixed(2);
/* A person: the mean of their contributions' tenths, then out of ten.
   Full precision; rtFmt rounds for the screen and nothing else does. */
function rtMeanTenths(tenths){
  if (!tenths || !tenths.length) return null;
  return tenths.reduce((t, x) => t + x, 0) / tenths.length / 10;
}

/* "2026-09" for a timestamp, in the viewer's own calendar - the same
   calendar the week row and the shift history already use. */
function rtMonth(at){
  const d = new Date(at || 0);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function rtPrevMonth(month){
  const [y, m] = String(month).split("-").map(Number);
  return m === 1 ? (y - 1) + "-12" : y + "-" + String(m - 1).padStart(2, "0");
}
/* The start of a period, in the viewer's calendar: the week runs Monday
   to Sunday (what the week row under the wordmark already says), the
   month from its first day, and "all" from the beginning of time. */
function rtSince(period, now){
  const d = new Date(now || Date.now());
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (period === "week") return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - ((midnight.getDay() + 6) % 7)).getTime();
  if (period === "month") return new Date(midnight.getFullYear(), midnight.getMonth(), 1).getTime();
  return 0;
}
const RT_PERIODS = [["week", "This week"], ["month", "This month"], ["all", "All time"]];

const rtMean = xs => xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null;
const rtPct = (num, den) => den ? Math.round(100 * num / den) : null;

/* ---------- what a review document is ---------- */

/* One document per CONTRIBUTION: the work, the step (so two people on
   parallel steps, or the same person on two steps, are reviewed
   separately) and the person - the last part so untracked work with
   two assignees gets two reviews rather than one they share. */
function rvKey(itemId, nodeId, aboutUid){
  return String(itemId) + ":" + (nodeId || "work") + ":" + String(aboutUid);
}

const RV_STATUSES = ["submitted", "changes", "approved"];

/* Only approved rounds count, and only the CURRENT round of a document:
   a document sent round again after an approval is pending work, and
   the earlier approval sits in its history where the person can still
   read it. `approvedAt` is when the decision was made; the tenths are
   what the board averages. */
function rvRating(r){
  if (!r || r.status !== "approved" || !r.decision) return null;
  const tenths = typeof r.weightedTenths === "number" ? r.weightedTenths : rtTenths(r.decision.scores);
  if (tenths == null) return null;
  return {
    key: r.id || rvKey(r.itemId, r.nodeId, r.aboutUid),
    aboutUid: r.aboutUid, byUid: r.decision.byUid || r.byUid || null,
    roleId: r.aboutRoleId || null, typeId: r.typeId || null,
    tenths, score: tenths / 10, at: r.decision.at || r.at || 0,
    month: r.month || rtMonth(r.decision.at || r.at),
    firstPass: r.round === 1, revisions: Math.max(0, (r.round || 1) - 1),
    onTime: typeof r.onTime === "boolean" ? r.onTime : null,
    title: r.title || "", stepLabel: r.stepLabel || "", feedback: r.decision.feedback || "",
    scores: r.decision.scores || null
  };
}

/* Which round the screen should treat a document as being in, given the
   iteration of the step the work is on NOW. An approval given to an
   earlier iteration - a loop sent the work round again - is `stale`: it
   is not reused for the new work, and the person is offered a fresh
   submission. `iteration` is null for work that is not on a track. */
function rvState(r, iteration){
  if (!r) return "none";
  if (r.status === "approved" && iteration != null && r.submission && r.submission.iteration != null
      && r.submission.iteration < iteration) return "stale";
  return RV_STATUSES.indexOf(r.status) >= 0 ? r.status : "none";
}

/* A submission link is optional, but if it is there it is a real web
   address - not "javascript:", not a bare word - because the reviewer's
   sheet will draw it as something to click. */
function rvLinkOk(url){
  if (url == null || url === "") return true;
  if (typeof url !== "string" || url.length > RT_LINK_MAX) return false;
  return /^https?:\/\/[^\s]+$/i.test(url.trim());
}
/* What the person has to give before "Submit for review" wakes: a link
   or a note - an empty submission tells the reviewer nothing. */
function rvSubmissionOk(link, note){
  const l = (link || "").trim(), n = (note || "").trim();
  if (!rvLinkOk(l)) return { ok: false, reason: "bad-link" };
  if (!l && !n) return { ok: false, reason: "empty" };
  if (n.length > RT_NOTE_MAX) return { ok: false, reason: "long" };
  return { ok: true };
}
/* What a decision needs. Feedback always; three whole scores on an
   approval. The words for a refusal are what the button shows. */
function rvDecisionOk(kind, scores, feedback){
  const f = (feedback || "").trim();
  if (kind !== "changes" && kind !== "approved") return { ok: false, reason: "kind" };
  if (!f) return { ok: false, reason: "feedback" };
  if (f.length > RT_FEEDBACK_MAX) return { ok: false, reason: "long" };
  if (kind === "approved" && !rtValidScores(scores)) return { ok: false, reason: "scores" };
  return { ok: true };
}

/* Deadlines, stated once. Work on a track carries `dueAt` in ms; a classic
   assignment carries a `dueDate` (YYYY-MM-DD) and maybe a `dueTime`
   (HH:MM), which mean a moment in the SUBMITTER's local clock - the end
   of that day when no time was set. The on-time verdict is made at
   submission, on the submitter's device, and stored; it is never
   recomputed on another clock. No deadline is null, never false, so
   missing deadlines cannot read as 0% on time. */
function rvDueAt(row){
  if (!row) return null;
  if (typeof row.dueAt === "number" && row.dueAt > 0) return row.dueAt;
  if (row.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) {
    const [y, m, d] = row.dueDate.split("-").map(Number);
    const t = /^\d{2}:\d{2}$/.test(row.dueTime || "") ? row.dueTime.split(":").map(Number) : null;
    return t ? new Date(y, m - 1, d, t[0], t[1], 0, 0).getTime() : new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }
  return null;
}
const rvOnTime = (submittedAt, dueAt) => dueAt == null ? null : submittedAt <= dueAt;

/* Who may decide a review: the org's owner, the reviewer the owner
   named, or a role granted review:decide at org scope (the seeded
   Manager). Never the person the review is about. firestore.rules
   answers this from the same three facts. */
function rvMayDecide(r, uid, roleId, perms){
  if (!r || !uid || r.aboutUid === uid) return false;
  if (roleId === "owner") return true;
  if (r.reviewerUid && r.reviewerUid === uid) return true;
  return typeof permGrantScope === "function" && permGrantScope(perms || [], "review", "decide") === "org";
}
/* Who may pick a reviewer: an owner, or a role that may decide - and
   never the person whose work it is, whatever else they hold. */
function rvMayDelegate(r, uid, roleId, perms){
  if (!r || !uid || r.aboutUid === uid) return false;
  if (roleId === "owner") return true;
  return typeof permGrantScope === "function" && permGrantScope(perms || [], "review", "decide") === "org";
}

/* ---------- the board ---------- */

/* `reviews` are the org's review documents; `members` the roster with
   names and roles; `opts.since` limits which approvals count toward the
   rating, `opts.roleId` and `opts.typeId` narrow the comparison to
   matching roles and kinds of work (a designer against designers), and
   the trend always reads whole months. Every row carries its counts,
   so a screen can never show a percentage without saying how many
   contributions it stands on. Nobody is invented: a member with no
   role has roleId null and is left out of a role filter, not put in
   one. */
function rtBoard(reviews, members, opts){
  const o = opts || {};
  const now = o.now || Date.now();
  const min = o.min || RT_MIN_REVIEWS;
  const thisMonth = rtMonth(now), lastMonth = rtPrevMonth(thisMonth);
  const roleOf = {};
  (members || []).forEach(m => { roleOf[m.uid] = m.roleId || null; });
  // one rating per contribution, whatever the input carried twice
  const seen = new Set();
  const all = [];
  (reviews || []).forEach(r => {
    const x = rvRating(r);
    if (!x || !x.aboutUid || seen.has(x.key)) return;
    seen.add(x.key);
    x.roleId = roleOf[x.aboutUid] != null ? roleOf[x.aboutUid] : x.roleId;
    all.push(x);
  });
  const inType = x => !o.typeId || x.typeId === o.typeId;
  const counted = all.filter(x => (!o.since || x.at >= o.since) && inType(x));
  const people = (members || []).filter(m => !o.roleId || (m.roleId || null) === o.roleId);
  const rows = people.map(m => {
    const mine = counted.filter(x => x.aboutUid === m.uid);
    const whole = all.filter(x => x.aboutUid === m.uid && inType(x));
    const timed = mine.filter(x => typeof x.onTime === "boolean");
    const tm = whole.filter(x => x.month === thisMonth).map(x => x.tenths);
    const lm = whole.filter(x => x.month === lastMonth).map(x => x.tenths);
    const row = {
      uid: m.uid, name: m.name || m.uid, roleId: m.roleId || null,
      n: mine.length,
      rating: rtMeanTenths(mine.map(x => x.tenths)),
      firstPassPct: rtPct(mine.filter(x => x.firstPass).length, mine.length),
      onTimePct: rtPct(timed.filter(x => x.onTime).length, timed.length),
      onTimeN: timed.length,
      revisions: mine.reduce((t, x) => t + x.revisions, 0),
      thisMonth: { n: tm.length, avg: rtMeanTenths(tm) },
      lastMonth: { n: lm.length, avg: rtMeanTenths(lm) },
      delta: null,
      ranked: mine.length >= min, rank: null, min
    };
    if (row.thisMonth.n >= RT_MIN_TREND && row.lastMonth.n >= RT_MIN_TREND)
      row.delta = row.thisMonth.avg - row.lastMonth.avg;
    return row;
  });
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
  const ranked = rows.filter(r => r.ranked).sort((a, b) => (b.rating - a.rating) || (b.n - a.n) || byName(a, b));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const building = rows.filter(r => !r.ranked).sort((a, b) => (b.n - a.n) || byName(a, b));
  return ranked.concat(building);
}

/* The two counts above the board: approved contributions in the period
   (after the same filters), and everything sitting in a reviewer's
   queue right now - which is never filtered by period, because waiting
   work is waiting today whenever it was submitted. */
function rtCounts(reviews, opts){
  const o = opts || {};
  const seen = new Set();
  let reviewed = 0, awaiting = 0, changes = 0;
  (reviews || []).forEach(r => {
    if (!r) return;
    const key = r.id || rvKey(r.itemId, r.nodeId, r.aboutUid);
    if (seen.has(key)) return;
    seen.add(key);
    if (o.typeId && r.typeId !== o.typeId) return;
    if (o.roleIds && o.roleIds.indexOf(r.aboutUid) < 0) return;
    if (r.status === "submitted") awaiting++;
    else if (r.status === "changes") changes++;
    else {
      const x = rvRating(r);
      if (x && (!o.since || x.at >= o.since)) reviewed++;
    }
  });
  return { reviewed, awaiting, changes };
}

const rtStandout = rows => (rows || []).find(r => r.ranked) || null;
function rtImproved(rows){
  let best = null;
  (rows || []).forEach(r => { if (r.delta != null && r.delta > 0 && (!best || r.delta > best.delta)) best = r; });
  return best;
}

/* Why a row stands where it does, in words, from its own numbers - so
   "Standout" comes with a reason and not just a name. */
function rtWhy(row){
  if (!row || !row.n) return "No reviewed work yet.";
  const parts = [];
  if (row.rating >= 4.5) parts.push("consistently strong work");
  else if (row.rating >= 4) parts.push("strong work");
  if (row.firstPassPct != null && row.firstPassPct >= 80) parts.push("usually approved first time");
  if (row.onTimePct != null && row.onTimeN >= 3 && row.onTimePct >= 90) parts.push("reliably on time");
  if (row.n >= RT_MIN_REVIEWS && row.revisions === 0) parts.push("no revisions asked for");
  if (!parts.length) parts.push("steady across " + row.n + (row.n === 1 ? " review" : " reviews"));
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/* Who has room: open work per person. `doneOf(item)` says whether an
   item is finished in its own kind's vocabulary, because "done" is a
   status each kind spells differently. Fewest open first. */
function rtCapacity(items, members, doneOf){
  const open = (items || []).filter(it => it && !(doneOf ? doneOf(it) : false));
  return (members || []).map(m => ({
    uid: m.uid, name: m.name || m.uid, roleId: m.roleId || null,
    open: open.filter(it => (it.assigneeIds || []).indexOf(m.uid) >= 0).length
  })).sort((a, b) => (a.open - b.open) || (a.name || "").localeCompare(b.name || ""));
}

/* ---------- the form, shared by every sheet that rates ---------- */

const rtEsc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function rtFormHTML(aboutName){
  return '<div class="rt-form" role="group" aria-label="Rate the work">' +
    '<p class="rt-form-h">Rate what ' + rtEsc(aboutName || "they") + ' delivered</p>' +
    RT_KEYS.map(k =>
      '<div class="rt-row" data-key="' + k + '">' +
        '<div class="rt-row-l"><b>' + rtEsc(RT_LABELS[k]) + ' <i>' + Math.round(RT_WEIGHTS[k] * 100) + '%</i></b><small>' + rtEsc(RT_HINTS[k]) + '</small></div>' +
        '<div class="rt-scale" role="radiogroup" aria-label="' + rtEsc(RT_LABELS[k]) + '">' +
          [1, 2, 3, 4, 5].map(v => '<button type="button" class="rt-pt" role="radio" aria-checked="false" data-v="' + v + '" title="' + rtEsc(RT_SCALE[v - 1]) + '" aria-label="' + v + ' — ' + rtEsc(RT_SCALE[v - 1]) + '">' + v + '</button>').join("") +
        '</div>' +
        '<em class="rt-word">Pick 1 to 5</em>' +
        '<small class="rt-eg" hidden></small>' +
      '</div>').join("") +
    '<p class="rt-form-n">Quality counts 50%, brief 30%, handoff 20% - out of 5. ' +
      '1 Unusable · 2 Needs substantial work · 3 Meets expectations · 4 Strong · 5 Exceptional.</p>' +
    '<p class="rt-form-t" data-rt-total>Rating: <b>—</b></p>' +
  '</div>';
}

/* Wire the form; `onChange(scores)` is told the current scores (null
   until all three are picked). Returns a reader for the current scores.
   Picking a point shows its word and the example for it, so the person
   rating can check the number against what it is supposed to mean. */
function rtFormBind(root, onChange){
  const picked = {};
  const read = () => RT_KEYS.every(k => picked[k]) ? Object.assign({}, picked) : null;
  const total = root.querySelector("[data-rt-total] b");
  root.querySelectorAll(".rt-row").forEach(row => {
    const k = row.dataset.key;
    row.querySelectorAll(".rt-pt").forEach(b => b.onclick = () => {
      picked[k] = +b.dataset.v;
      row.querySelectorAll(".rt-pt").forEach(x => { const on = x === b; x.classList.toggle("is-on", on); x.setAttribute("aria-checked", String(on)); });
      row.querySelector(".rt-word").textContent = picked[k] + " · " + RT_SCALE[picked[k] - 1];
      const eg = row.querySelector(".rt-eg");
      if (eg) { eg.textContent = RT_EXAMPLES[k][picked[k] - 1]; eg.hidden = false; }
      const s = read();
      if (total) total.textContent = s ? rtFmt(rtScore(s)) + " / 5" : "—";
      if (onChange) onChange(s);
    });
  });
  return read;
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { RT_WEIGHTS, RT_TENTHS, RT_KEYS, RT_LABELS, RT_HINTS, RT_EXAMPLES, RT_SCALE, RT_MIN_REVIEWS, RT_MIN_TREND,
    RT_FEEDBACK_MAX, RT_NOTE_MAX, RT_LINK_MAX, RT_PERIODS, RV_STATUSES,
    rtValidScores, rtTenths, rtScore, rtRound, rtFmt, rtMeanTenths, rtMonth, rtPrevMonth, rtSince,
    rvKey, rvRating, rvState, rvLinkOk, rvSubmissionOk, rvDecisionOk, rvDueAt, rvOnTime, rvMayDecide, rvMayDelegate,
    rtBoard, rtCounts, rtStandout, rtImproved, rtWhy, rtCapacity, rtFormHTML, rtFormBind };
}
