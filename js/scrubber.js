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
   no schedule set it spans EIGHT HOURS - the owner's decision, made
   in as many words on 2026-09-12 - and the header says the length
   is a default rather than something anybody configured, so the
   screen is never confidently claiming a schedule that is not there.
   The fill starts at the left edge the moment you clock in and grows
   with the clocked-in time.

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
  /* Every block carries what it WAS - the task, the break's reason - and
     whether it is the one still open, so the bar can say so when asked
     rather than being a row of anonymous shapes. */
  const add = (kind, from, to, meta) => {
    const f = Math.max(0, Math.min(elapsed, from));
    const t = Math.max(0, Math.min(elapsed, to));
    if (t > f) raw.push(Object.assign({ kind, from: f, to: t }, meta));
  };
  (shift.segs || []).forEach(s =>
    add("work", s.startedAt - start, (s.endedAt || now) - start,
      { label: s.task || "Idle", idle: !s.task, itemId: s.itemId || null, live: !s.endedAt }));
  (shift.breaks || []).forEach(b =>
    add("break", b.startedAt - start, (b.endedAt || now) - start,
      { label: b.reason || "Break", idle: false, itemId: null, live: !b.endedAt }));
  raw.sort((a, b) => a.from - b.from || a.to - b.to);

  // one pass, left to right: overlaps are clipped to what came before
  // (the earlier block already owns that time) and anything neither a
  // segment nor a break claims becomes a visible gap
  const blocks = [];
  let cursor = 0;
  const gap = (from, to) => ({ kind: "gap", from, to, label: "Unaccounted", idle: false, itemId: null, live: false });
  raw.forEach(b => {
    if (b.to <= cursor) return;
    if (b.from > cursor) blocks.push(gap(cursor, b.from));
    blocks.push(Object.assign({}, b, { from: Math.max(b.from, cursor), to: b.to }));
    cursor = b.to;
  });
  if (cursor < elapsed) blocks.push(gap(cursor, elapsed));

  const sum = kind => blocks.reduce((t, b) => t + (b.kind === kind ? b.to - b.from : 0), 0);
  const worked = sum("work"), brk = sum("break");
  const scheduled = schedMs > 0 ? schedMs : 0;

  return {
    start, elapsed, blocks, worked, brk,
    scheduled,
    /* The bar's width on screen never changes. What changes is what that
       width MEANS: past the schedule the span becomes the elapsed time, so
       the scheduled part squeezes down to scheduled/elapsed of the bar and
       overtime takes the rest, growing as the day runs on. At 7h on a 6h
       shift the schedule is six sevenths and overtime the last seventh. */
    span: scheduled ? Math.max(scheduled, elapsed) : elapsed,
    remaining: scheduled ? Math.max(0, scheduled - elapsed) : 0,
    over: scheduled ? Math.max(0, elapsed - scheduled) : 0
  };
}

/* ---------- the half that touches the document ----------
   Ticked every second, but only REBUILT when the bar's structure changes:
   a task started or put down, a break, the schedule, another hour of
   overtime. In between, the blocks' edges, the playhead and the digits
   are moved in place - which is what lets the playhead glide and the live
   block shimmer instead of both restarting sixty times a minute. The bar
   reports the shift and does not edit it; the one thing pressing it does
   is bring that block's task to the front of the deck. */

const SB_MIN_BLOCK = 0.4;   // % - so a 20-second break is still visible
const SB_HOUR = 3600000;
const SB_DEFAULT_MS = 8 * SB_HOUR;   // the bar's span when nobody set one

function sbLabel(ms){ return humanDur(ms); }
/* "6h", "7h 30m" - the scheduled LENGTH, which reads as a shift name in
   the header rather than as a duration. humanDur would say "6h 00m". */
function sbSpanLabel(ms){
  const mins = Math.round(ms / 60000), h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + "h " + m + "m" : h + "h";
}
/* what a block says when hovered: what it was, when, how long */
function sbTip(plan, b){
  return b.label + " · " + clock(plan.start + b.from) + "–" + (b.live ? "now" : clock(plan.start + b.to))
    + " · " + humanDur(b.to - b.from);
}
function sbProgressHTML(plan){
  return plan.scheduled
    ? '<b>' + esc(sbLabel(plan.worked)) + '</b> <i>/</i> ' + esc(sbLabel(plan.scheduled))
      + (plan.over > 0 ? '<em class="sb-over">+' + esc(sbLabel(plan.over)) + ' over</em>' : "")
    : '<b>' + esc(sbLabel(plan.worked)) + '</b> <i>worked</i>';
}

function sbBind(host){
  if (host.dataset.sbBound) return;
  host.dataset.sbBound = "1";
  host.addEventListener("click", e => {
    const seg = e.target.closest(".sb-seg[data-item]");
    if (!seg || typeof dkRows === "undefined" || typeof dkTo !== "function" || typeof dkItemId !== "function") return;
    const i = dkRows.findIndex(r => dkItemId(r) === seg.dataset.item);
    if (i >= 0) dkTo(i);
  });
}

function sbRender(host){
  if (!host) return;
  /* Three answers, and the third is the one that matters: null means the
     roster has not loaded, so this screen does not yet KNOW whether hours
     are set and must not say either way. */
  const sched = (typeof orgMyShiftMinutes === "function") ? orgMyShiftMinutes() : null;
  const known = typeof sched === "number";
  const set = known && sched > 0;
  const schedMs = set ? sched * 60000 : SB_DEFAULT_MS;
  const plan = S.status === "IDLE" ? null : sbPlan(S.shift, Date.now(), schedMs);
  /* "8h shift · default" when the eight hours is assumed. The roster not
     having loaded yet also draws eight hours, but says nothing about a
     default: it does not yet KNOW whether hours are set. */
  const title = "Today · " + sbSpanLabel(schedMs) + " shift";
  const SB_DEFAULT_WHY = "No shift length set for you yet — the bar assumes 8h";
  const titleHTML = esc(title)
    + (known && !set ? ' <em class="sb-default" title="' + esc(SB_DEFAULT_WHY) + '">default</em>' : "");

  if (!plan){
    const note = set ? "The bar fills from the moment you clock in."
      : known ? SB_DEFAULT_WHY + "."
      : "";
    const key = "idle|" + title + "|" + note;
    if (host.dataset.sbKey === key) return;
    host.dataset.sbKey = key;
    host.innerHTML =
      '<div class="sb-head"><span class="sb-title">' + titleHTML + '</span>'
      + '<span class="sb-prog sb-prog-idle">Not started</span></div>'
      + '<div class="sb-bar sb-bar-empty"></div>'
      + (note ? '<div class="sb-foot"><span class="sb-note">' + note + '</span></div>' : "");
    return;
  }

  const pct = ms => (plan.span ? (ms / plan.span) * 100 : 0);
  const hours = Math.floor(plan.span / SB_HOUR);
  const playPct = Math.min(100, pct(plan.elapsed));
  const key = plan.blocks.map(b => b.kind + (b.idle ? "~" : "") + (b.live ? "!" : "") + ":" + b.label).join("|")
    + "#" + plan.scheduled + "#" + (plan.over > 0) + "#" + known + "#" + hours + "#" + title;

  if (host.dataset.sbKey === key){
    // the same bar, a second later
    const prog = host.querySelector(".sb-prog");
    if (prog) prog.innerHTML = sbProgressHTML(plan);
    host.querySelectorAll(".sb-seg").forEach((el, i) => {
      const b = plan.blocks[i]; if (!b) return;
      el.style.left = pct(b.from).toFixed(3) + "%";
      el.style.width = Math.max(SB_MIN_BLOCK, pct(b.to - b.from)).toFixed(3) + "%";
      el.setAttribute("data-tip", sbTip(plan, b));
    });
    host.querySelectorAll(".sb-tick").forEach((el, i) => { el.style.left = pct((i + 1) * SB_HOUR).toFixed(3) + "%"; });
    const target = host.querySelector(".sb-target");
    if (target) target.style.left = pct(plan.scheduled).toFixed(3) + "%";
    const live = host.querySelector(".sb-t-live");
    if (live){ live.style.left = playPct.toFixed(3) + "%"; live.textContent = clock(plan.start + plan.elapsed); }
    return;
  }
  host.dataset.sbKey = key;

  const blocks = plan.blocks.map((b, i) => {
    const w = Math.max(SB_MIN_BLOCK, pct(b.to - b.from));
    return '<span class="sb-seg sb-' + b.kind + (b.idle ? " is-idle" : "") + (b.live ? " is-live" : "") + '"'
      + ' data-n="' + i + '"' + (b.itemId ? ' data-item="' + esc(b.itemId) + '"' : "")
      + ' data-tip="' + esc(sbTip(plan, b)) + '"'
      + ' style="left:' + pct(b.from).toFixed(3) + '%;width:' + w.toFixed(3) + '%;animation-delay:' + (i * 60) + 'ms"></span>';
  }).join("");
  // one mark per whole hour of the span, so a block's length can be read
  // off the track without hovering it
  let ticks = "";
  for (let i = 1; i <= hours; i++){
    const at = pct(i * SB_HOUR);
    if (at < 100) ticks += '<span class="sb-tick" style="left:' + at.toFixed(3) + '%"></span>';
  }

  // the schedule stops being the bar's whole width once somebody runs
  // over it, so it gets a mark of its own - otherwise overtime would be
  // indistinguishable from a longer shift
  const overMark = plan.over > 0
    ? '<span class="sb-target" style="left:' + pct(plan.scheduled).toFixed(3) + '%"></span>' : "";

  host.innerHTML =
    '<div class="sb-head"><span class="sb-title">' + titleHTML + '</span>'
    + '<span class="sb-prog">' + sbProgressHTML(plan) + '</span></div>'
    + '<div class="sb-bar">' + ticks + blocks + overMark + '</div>'
    + '<div class="sb-foot">'
    +   '<span class="sb-t sb-t-start">' + esc(clock(plan.start)) + '</span>'
    +   '<span class="sb-t sb-t-live" style="left:' + playPct.toFixed(3) + '%">'
    +     esc(clock(plan.start + plan.elapsed)) + '</span>'
    +   '<span class="sb-t sb-t-end">' + esc(clock(plan.start + plan.scheduled)) + '</span>'
    +   '<span class="sb-legend">'
    +     '<span class="sb-key"><i class="sb-work"></i>Worked</span>'
    +     '<span class="sb-key"><i class="sb-break"></i>Break</span>'
    +     '<span class="sb-key"><i class="sb-rest"></i>Remaining</span>'
    +   '</span>'
    + '</div>';
  sbBind(host);
}

/* Node test hook — the browser never defines `module`. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { sbPlan };
}
