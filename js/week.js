/* ============================================================
   THE WEEK ROW — this week's hours, seven day bars, the streak.

   Pure half first (wrPlan), same discipline as js/scrubber.js, and
   for a second reason here: every number in this row is DERIVED,
   so the only way to know it is right is to compute it from a
   fixture and check the answer.

   It reads S.history, which is the closed shifts already living in
   appState/{uid} — no new query, no new index, no new collection.
   The open shift is added live, because a row that ignored the
   hours you are working right now would be wrong all day and
   correct only after you clocked out.

   `wr` prefix, not `wk`: js/work.js already owns `wk` in this one
   shared global scope, and the file that loads second is the one
   that loses.
   ============================================================ */

const WR_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const WR_DAY_MS = 8 * 3600000;   // one full bar = an 8-hour day

const wrPad = n => String(n).padStart(2, "0");
const wrKey = ts => {
  const d = new Date(ts);
  return d.getFullYear() + "-" + wrPad(d.getMonth() + 1) + "-" + wrPad(d.getDate());
};
const wrKeyOf = d => d.getFullYear() + "-" + wrPad(d.getMonth() + 1) + "-" + wrPad(d.getDate());
/* Net worked time of a shift that has not been closed yet. closeShift()
   stores netMs on the record; until then it has to be computed the same
   way, or the week's total jumps at clock-out. */
function wrLiveNet(sh, now){
  if (!sh || typeof sh.startedAt !== "number") return 0;
  const brk = (sh.breaks || []).reduce((t, b) => t + ((b.endedAt || now) - b.startedAt), 0);
  return Math.max(0, (now - sh.startedAt) - brk);
}
function wrRecNet(r){
  if (typeof r.netMs === "number") return Math.max(0, r.netMs);
  if (typeof r.endedAt === "number" && typeof r.startedAt === "number"){
    return Math.max(0, r.endedAt - r.startedAt - (r.breakMs || 0));
  }
  return 0;
}

function wrPlan(history, openShift, now){
  const worked = new Map();          // day key -> ms, EVERY day on record
  const add = (ts, ms) => {
    if (typeof ts !== "number" || ms <= 0) return;
    const k = wrKey(ts);
    worked.set(k, (worked.get(k) || 0) + ms);
  };
  (history || []).forEach(r => add(r.startedAt, wrRecNet(r)));
  if (openShift) add(openShift.startedAt, wrLiveNet(openShift, now));

  // the week runs Monday to Sunday, which is what the comp's M T W T F S S
  // says and what a working week means to the people using this
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (midnight.getDay() + 6) % 7;
  const todayKey = wrKeyOf(midnight);

  const days = [];
  for (let i = 0; i < 7; i++){
    const day = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - dow + i);
    const key = wrKeyOf(day);
    const ms = worked.get(key) || 0;
    days.push({
      key, label: WR_LABELS[i], ms,
      state: key === todayKey ? "today"
        : day > midnight ? "future"
        : ms > 0 ? "past" : "empty"
    });
  }

  /* The streak counts back one calendar day at a time and stops at the
     first day with nothing on it. A day yet to happen cannot break it, so
     an empty TODAY is stepped over rather than counted - otherwise the
     number would read zero every morning until the first clock-in and
     look like it had been lost. */
  let streak = 0;
  const cursor = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate());
  if (!worked.get(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (worked.get(wrKeyOf(cursor)) > 0){
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  /* Full height is a FULL DAY, not the week's best day. Scaled to the
     best day, a twenty-minute Tuesday in an otherwise empty week fills
     the whole band and reads as a full shift - the bar answered "how
     does this day compare to the others" when the question is "how
     much of a day was this". Same fixed 8h lap as the shift ring
     (SHIFT_CYCLE_MS in js/render.js); a longer day tops out at full. */
  days.forEach(x => { x.frac = Math.min(1, x.ms / WR_DAY_MS); });

  const total = days.reduce((t, x) => t + x.ms, 0);
  return { days, total, streak, todayKey };
}

/* ---------- the half that touches the document ---------- */

const WR_FLAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c2.5 3 4.5 5.8 4.5 9.3a4.5 4.5 0 0 1-9 0c0-1.4.5-2.4 1-3.2-.1 1.6.9 2.4 1.7 2 .9-.5.9-1.6.3-2.6C9 6.2 10.4 4 12 2.5z"/></svg>';

/* A day with no hours is a FLAT LINE, not a short bar: "nothing" and "a
   little" must not look like neighbours on the same scale. */
const WR_FLAT = 6;      // px
const WR_TALL = 58;     // px, a full 8-hour day

function wrRender(host){
  if (!host) return;
  const plan = wrPlan(S.history, S.shift, Date.now());
  const bars = plan.days.map(d => {
    const h = d.ms > 0 ? Math.max(WR_FLAT + 4, Math.round(d.frac * WR_TALL)) : WR_FLAT;
    return '<span class="wrow-day is-' + d.state + '"'
      + (d.ms > 0 ? ' title="' + esc(humanDur(d.ms)) + '"' : "")
      + '><i class="wrow-bar" style="height:' + h + 'px"></i>'
      + '<em>' + d.label + '</em></span>';
  }).join("");

  host.innerHTML =
    '<div class="wrow-total"><span class="wrow-cap">This week</span>'
    +   '<b>' + esc(plan.total ? humanDur(plan.total) : "0m") + '</b></div>'
    + '<div class="wrow-bars">' + bars + '</div>'
    // no streak is not a streak of zero: an empty pill would be a boast
    // about nothing, so it simply is not there
    + (plan.streak > 0
        ? '<div class="wrow-streak">' + WR_FLAME
          + '<span>' + plan.streak + ' day' + (plan.streak === 1 ? "" : "s") + ' streak</span></div>'
        : '<div class="wrow-streak is-none"></div>');
}

/* The open shift keeps accruing, so the total is stale the moment it is
   drawn. Redrawing it every tick would rebuild eight elements a second to
   change one digit a minute, so it redraws when that digit would change. */
let wrLastMinute = -1;
/* Clocking in changes the row inside the same minute the guard is holding,
   so render() forces it rather than letting the row sit a minute behind
   the state it is describing. */
function wrRefresh(){ wrLastMinute = -1; wrTick(); }
function wrTick(){
  const host = $("weekRow");
  if (!host) return;
  const m = Math.floor(Date.now() / 60000);
  if (m === wrLastMinute && host.innerHTML) return;
  wrLastMinute = m;
  wrRender(host);
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { wrPlan };
}
