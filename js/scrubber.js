/* ============================================================
   SHIFT SCRUBBER — the bar under the clocks.

   Two halves, deliberately split. sbPlan() is PURE: a shift, a
   moment, and a scheduled length in, a description of the bar
   out - no DOM, no globals, so tests/scrubber.test.mjs runs it
   under Node the way tests/permissions.test.mjs runs the
   permission grammar. sbRender() is the only half that touches
   the document.

   The bar spans the SCHEDULED shift, which an admin or a manager
   sets per person (orgs/{orgId}/members/{uid}.shiftMinutes). With
   no schedule set it spans the elapsed time instead and says so -
   a bar drawn against an invented eight-hour target would be a
   screen stating something nobody configured, which is the shape
   of failure this app has paid for most often.

   Blocks tile the wall clock from the moment of clock-in: work
   segments and breaks, which by the shift invariant leave no
   holes. A hole appearing anyway is drawn as one rather than
   painted over as work - a shift whose data is broken should
   look broken.
   ============================================================ */

function sbPlan(shift, now, schedMs){
  if (!shift || typeof shift.startedAt !== "number") return null;
  const start = shift.startedAt;
  const elapsed = Math.max(0, now - start);

  const raw = [];
  const add = (kind, from, to) => {
    const f = Math.max(0, Math.min(elapsed, from));
    const t = Math.max(0, Math.min(elapsed, to));
    if (t > f) raw.push({ kind, from: f, to: t });
  };
  (shift.segs || []).forEach(s =>
    add("work", s.startedAt - start, (s.endedAt || now) - start));
  (shift.breaks || []).forEach(b =>
    add("break", b.startedAt - start, (b.endedAt || now) - start));
  raw.sort((a, b) => a.from - b.from || a.to - b.to);

  // one pass, left to right: overlaps are clipped to what came before
  // (the earlier block already owns that time) and anything neither a
  // segment nor a break claims becomes a visible gap
  const blocks = [];
  let cursor = 0;
  raw.forEach(b => {
    if (b.to <= cursor) return;
    if (b.from > cursor) blocks.push({ kind: "gap", from: cursor, to: b.from });
    blocks.push({ kind: b.kind, from: Math.max(b.from, cursor), to: b.to });
    cursor = b.to;
  });
  if (cursor < elapsed) blocks.push({ kind: "gap", from: cursor, to: elapsed });

  const sum = kind => blocks.reduce((t, b) => t + (b.kind === kind ? b.to - b.from : 0), 0);
  const worked = sum("work"), brk = sum("break");
  const scheduled = schedMs > 0 ? schedMs : 0;

  return {
    start, elapsed, blocks, worked, brk,
    scheduled,
    // overtime widens the bar rather than running off the end of it:
    // the schedule stops being the whole span and becomes a mark on it
    span: scheduled ? Math.max(scheduled, elapsed) : elapsed,
    remaining: scheduled ? Math.max(0, scheduled - elapsed) : 0,
    over: scheduled ? Math.max(0, elapsed - scheduled) : 0
  };
}

/* ---------- the half that touches the document ----------
   Redrawn every tick, so it stays cheap: one innerHTML of a handful of
   spans, no per-block listeners. The bar is read-only by design - it
   reports the shift, it does not edit it. */

const SB_MIN_BLOCK = 0.4;   // % - so a 20-second break is still visible

function sbLabel(ms){ return humanDur(ms); }
/* "6h", "7h 30m" - the scheduled LENGTH, which reads as a shift name in
   the header rather than as a duration. humanDur would say "6h 00m". */
function sbSpanLabel(ms){
  const mins = Math.round(ms / 60000), h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + "h " + m + "m" : h + "h";
}

function sbRender(host){
  if (!host) return;
  /* Three answers, and the third is the one that matters: null means the
     roster has not loaded, so this screen does not yet KNOW whether hours
     are set and must not say either way. */
  const sched = (typeof orgMyShiftMinutes === "function") ? orgMyShiftMinutes() : null;
  const known = typeof sched === "number";
  const schedMs = known && sched > 0 ? sched * 60000 : 0;
  const plan = S.status === "IDLE" ? null : sbPlan(S.shift, Date.now(), schedMs);
  const title = "Today" + (schedMs ? " · " + sbSpanLabel(schedMs) + " shift" : " · shift");

  if (!plan){
    const note = schedMs ? "The bar fills from the moment you clock in."
      : known ? "No shift length set for you yet, so this bar measures elapsed time only."
      : "";
    host.innerHTML =
      '<div class="sb-head"><span class="sb-title">' + esc(title) + '</span>'
      + '<span class="sb-prog sb-prog-idle">Not started</span></div>'
      + '<div class="sb-bar sb-bar-empty"></div>'
      + (note ? '<div class="sb-foot"><span class="sb-note">' + note + '</span></div>' : "");
    return;
  }

  const pct = ms => (plan.span ? (ms / plan.span) * 100 : 0);
  const blocks = plan.blocks.map(b => {
    const w = Math.max(SB_MIN_BLOCK, pct(b.to - b.from));
    return '<span class="sb-seg sb-' + b.kind + '" style="left:' + pct(b.from).toFixed(3)
      + '%;width:' + w.toFixed(3) + '%"></span>';
  }).join("");

  const playPct = Math.min(100, pct(plan.elapsed));
  // the schedule stops being the bar's whole width once somebody runs
  // over it, so it gets a mark of its own - otherwise overtime would be
  // indistinguishable from a longer shift
  const overMark = plan.over > 0
    ? '<span class="sb-target" style="left:' + pct(plan.scheduled).toFixed(3) + '%"></span>' : "";

  const progress = plan.scheduled
    ? '<b>' + esc(sbLabel(plan.worked)) + '</b> <i>/</i> ' + esc(sbLabel(plan.scheduled))
      + (plan.over > 0 ? '<em class="sb-over">+' + esc(sbLabel(plan.over)) + ' over</em>' : "")
    : '<b>' + esc(sbLabel(plan.worked)) + '</b> <i>worked</i>';

  host.innerHTML =
    '<div class="sb-head"><span class="sb-title">' + esc(title) + '</span>'
    + '<span class="sb-prog">' + progress + '</span></div>'
    + '<div class="sb-bar">' + blocks + overMark
    + '<span class="sb-play" style="left:' + playPct.toFixed(3) + '%"></span></div>'
    + '<div class="sb-foot">'
    +   '<span class="sb-t sb-t-start">' + esc(clock(plan.start)) + '</span>'
    +   '<span class="sb-t sb-t-live" style="left:' + playPct.toFixed(3) + '%">'
    +     esc(clock(plan.start + plan.elapsed)) + '</span>'
    +   (plan.scheduled
          ? '<span class="sb-t sb-t-end">' + esc(clock(plan.start + plan.scheduled)) + '</span>' : "")
    +   (plan.scheduled || !known ? "" :
          '<span class="sb-note sb-note-live">No shift length set for you yet</span>')
    +   '<span class="sb-legend">'
    +     '<span class="sb-key"><i class="sb-work"></i>Worked</span>'
    +     '<span class="sb-key"><i class="sb-break"></i>Break</span>'
    +     (plan.scheduled ? '<span class="sb-key"><i class="sb-rest"></i>Remaining</span>' : "")
    +   '</span>'
    + '</div>';
}

/* Node test hook — the browser never defines `module`. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { sbPlan };
}
