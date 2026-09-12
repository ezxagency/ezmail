/* ============================================================
   RATING — reviewed quality, the math and the words.

   The question the admin home could not answer was "who is doing good
   work". Hours say who was present; the deck says what is open; neither
   says how good the work was. The only person who knows is the one who
   received it - the checker at the next step - so the rating is part of
   finishing that step: three scores from 1 to 5, weighted, one official
   rating per deliverable, and a leaderboard built from nothing else.

   THE MATH IS EXACT AND THE POLICY IS STATED. A task's rating is
       quality × 0.50 + brief × 0.30 + handoff × 0.20     (out of 5)
   and a person's rating is the mean of their task ratings, full
   precision, rounded only for display. The weights are a policy the
   owner chose (2026-09-12), not a measurement of anything; they live in
   one place so changing them is one line and every screen follows.

   WHAT KEEPS IT HONEST. A revision UPDATES a deliverable's rating rather
   than adding a second one (the review document is keyed by run and
   step; earlier reviews stay in its history), so a polished result after
   four rounds is one rating, with `revisions: 4` and `firstPass: false`
   beside it. Every percentage carries the count behind it. Nobody is
   ranked on fewer than RT_MIN_REVIEWS reviewed tasks - below that the
   row says "Building data", never a number that looks final. Unreviewed
   work is pending, never zero. Nobody rates themselves (the rules refuse
   it, and the sheet never offers it).

   Pure: reviews and members in, rows out. The two DOM helpers at the
   bottom draw and read the three-score form, so the deck's finish sheet
   and the Work page ask the same question the same way.
   ============================================================ */

const RT_WEIGHTS = { quality: 0.50, brief: 0.30, handoff: 0.20 };
const RT_KEYS = ["quality", "brief", "handoff"];
const RT_LABELS = { quality: "Execution quality", brief: "Brief accuracy", handoff: "Handoff readiness" };
const RT_HINTS = {
  quality: "The copy, design or build itself",
  brief: "Did it do what was asked - content, brand, instructions",
  handoff: "Right files, working links, organised, complete"
};
const RT_SCALE = ["Unusable", "Needs substantial work", "Meets expectations", "Strong", "Exceptional"];
const RT_MIN_REVIEWS = 8;       // ranked from this many reviewed tasks
const RT_MIN_TREND = 3;         // a month counts toward "improved" from this many

/* One task's rating from its three scores, or null if any is missing or
   out of range. Integers 1..5 only: a 3.5 typed somewhere would make
   every average look more precise than the judgement behind it. */
function rtScore(scores){
  if (!scores) return null;
  let total = 0;
  for (const k of RT_KEYS){
    const v = scores[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) return null;
    total += v * RT_WEIGHTS[k];
  }
  return total;
}
const rtRound = x => x == null ? null : Math.round(x * 100) / 100;
const rtFmt = x => x == null ? "—" : (Math.round(x * 100) / 100).toFixed(2);

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

const rtMean = xs => xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null;
const rtPct = (num, den) => den ? Math.round(100 * num / den) : null;

/* The board. `reviews` are the org's review documents (one per
   deliverable, the final rating); `members` the roster with names;
   `opts.since` limits which reviews count toward the rating (this
   month, all time) while the trend always reads whole months. Every row
   carries its counts, so a screen can never show a percentage without
   saying how many tasks it stands on. */
function rtBoard(reviews, members, opts){
  const o = opts || {};
  const now = o.now || Date.now();
  const min = o.min || RT_MIN_REVIEWS;
  const thisMonth = rtMonth(now), lastMonth = rtPrevMonth(thisMonth);
  const all = (reviews || []).filter(r => r && r.aboutUid && typeof r.score === "number");
  const counted = o.since ? all.filter(r => (r.at || 0) >= o.since) : all;
  const rows = (members || []).map(m => {
    const mine = counted.filter(r => r.aboutUid === m.uid);
    const whole = all.filter(r => r.aboutUid === m.uid);
    const timed = mine.filter(r => typeof r.onTime === "boolean");
    const tm = whole.filter(r => (r.month || rtMonth(r.at)) === thisMonth).map(r => r.score);
    const lm = whole.filter(r => (r.month || rtMonth(r.at)) === lastMonth).map(r => r.score);
    const row = {
      uid: m.uid, name: m.name || m.uid, roleId: m.roleId || null,
      n: mine.length,
      rating: rtMean(mine.map(r => r.score)),
      firstPassPct: rtPct(mine.filter(r => r.firstPass === true).length, mine.length),
      onTimePct: rtPct(timed.filter(r => r.onTime).length, timed.length),
      onTimeN: timed.length,
      revisions: mine.reduce((t, r) => t + (r.revisions || 0), 0),
      thisMonth: { n: tm.length, avg: rtMean(tm) },
      lastMonth: { n: lm.length, avg: rtMean(lm) },
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

/* ---------- the form, shared by both finish sheets ---------- */

function rtFormHTML(aboutName){
  const e = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return '<div class="rt-form" role="group" aria-label="Rate the work">' +
    '<p class="rt-form-h">Rate what ' + e(aboutName || "they") + ' handed you</p>' +
    RT_KEYS.map(k =>
      '<div class="rt-row" data-key="' + k + '">' +
        '<div class="rt-row-l"><b>' + e(RT_LABELS[k]) + '</b><small>' + e(RT_HINTS[k]) + '</small></div>' +
        '<div class="rt-scale" role="radiogroup" aria-label="' + e(RT_LABELS[k]) + '">' +
          [1, 2, 3, 4, 5].map(v => '<button type="button" class="rt-pt" role="radio" aria-checked="false" data-v="' + v + '" title="' + e(RT_SCALE[v - 1]) + '">' + v + '</button>').join("") +
        '</div>' +
        '<em class="rt-word"></em>' +
      '</div>').join("") +
    '<p class="rt-form-n">Quality counts 50%, brief 30%, handoff 20%. Out of 5.</p>' +
  '</div>';
}

/* Wire the form; `onChange(scores)` is told the current scores (null
   until all three are picked). Returns a reader for the current scores. */
function rtFormBind(root, onChange){
  const picked = {};
  const read = () => RT_KEYS.every(k => picked[k]) ? Object.assign({}, picked) : null;
  root.querySelectorAll(".rt-row").forEach(row => {
    const k = row.dataset.key;
    row.querySelectorAll(".rt-pt").forEach(b => b.onclick = () => {
      picked[k] = +b.dataset.v;
      row.querySelectorAll(".rt-pt").forEach(x => { const on = x === b; x.classList.toggle("is-on", on); x.setAttribute("aria-checked", String(on)); });
      row.querySelector(".rt-word").textContent = RT_SCALE[picked[k] - 1];
      if (onChange) onChange(read());
    });
  });
  return read;
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { RT_WEIGHTS, RT_KEYS, RT_LABELS, RT_SCALE, RT_MIN_REVIEWS, RT_MIN_TREND,
    rtScore, rtRound, rtFmt, rtMonth, rtPrevMonth, rtBoard, rtStandout, rtImproved, rtWhy, rtCapacity, rtFormHTML, rtFormBind };
}
