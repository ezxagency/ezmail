/* ============================================================
   THE STARTED STACK — one landscape card per task this shift has
   started, in the column between the clocks and the deck.

   Pure half first (stPlan), because everything on a card is
   DERIVED: the shift's segments carry the item each was spent on,
   so grouping them by itemId gives the task, the store, the time
   on it and whether it is the one running now. No new read.

   Only work started from the deck lands here - a segment with no
   itemId is the classic dashboard's, or the idle gap between two
   tasks, and neither is "a task I started". A new task lands at
   the BOTTOM, three fit, and past three the stack scrolls one card
   per wheel notch on the same spring as the deck.

   `st` prefix: one shared global scope, and nothing else owns it.
   ============================================================ */

const ST_SHOW = 3;                 // cards in view; past that the stack scrolls
const ST_H = 104, ST_GAP = 12;     // px - the same numbers as css/started.css

/* What this shift has started, oldest first.
   `onDeck` is the set of item ids still on the deck and `deckLoaded`
   whether its first snapshot has landed: a task whose segments are all
   closed is FINISHED only when the deck has loaded and no longer carries
   it. Before that snapshot the honest word is Paused - the segments are
   closed, and that is all this device knows. */
function stPlan(sh, now, onDeck, deckLoaded){
  if (!sh) return [];
  const by = new Map();
  (sh.segs || []).forEach(s => {
    if (!s.itemId) return;
    const cur = by.get(s.itemId) || {
      itemId: s.itemId, task: s.task || "", client: s.client || "",
      firstAt: s.startedAt, ms: 0, running: false
    };
    cur.ms += clkMs(s, now);
    if (s.task) cur.task = s.task;
    if (s.client) cur.client = s.client;
    cur.firstAt = Math.min(cur.firstAt, s.startedAt);
    if (!s.endedAt) cur.running = true;
    by.set(s.itemId, cur);
  });
  const list = [...by.values()].sort((a, b) => a.firstAt - b.firstAt);
  list.forEach(p => {
    p.state = p.running ? "running"
      : (deckLoaded && onDeck && !onDeck.has(p.itemId)) ? "finished"
      : "paused";
  });
  return list;
}

/* ---------- the half that touches the document ---------- */

let stKey = "", stCount = 0, stPos = 0, stTarget = 0, stRaf = 0, stBound = false, stWheelAt = 0;

const stTime = p => p.running ? hms(p.ms) : humanDur(p.ms);
const stLabel = { running: "Running", paused: "Paused", finished: "Finished" };

function stDeckIds(){
  if (typeof dkRows === "undefined" || typeof dkItemId !== "function") return null;
  return new Set(dkRows.map(dkItemId));
}
const stDeckLoaded = () => typeof assignedTasksSeen !== "undefined" && assignedTasksSeen !== null;

function stCard(p, n){
  return '<article class="st-card is-' + p.state + '" data-n="' + n + '" data-item="' + esc(p.itemId) + '">'
    + '<div class="st-top">'
    +   (p.client ? '<span class="st-store">' + esc(p.client) + '</span>' : '<span class="st-store"></span>')
    +   '<span class="st-state">' + stLabel[p.state] + '</span>'
    + '</div>'
    + '<h4 class="st-title">' + esc(p.task || "Work") + '</h4>'
    + '<div class="st-meta"><b class="st-time">' + esc(stTime(p)) + '</b>'
    +   '<span>started ' + clock(p.firstAt) + '</span></div>'
    + '</article>';
}

/* Redrawn only when a card's IDENTITY or state changes - a task started,
   put down, picked up, finished. Every second in between only the running
   card's digits move, and those are written in place: rebuilding the
   stack once a second would restart the spring under the reader's wheel. */
function stRender(){
  const host = $("startedRail");
  if (!host) return;
  const plan = stPlan(S.status === "IDLE" ? null : S.shift, Date.now(), stDeckIds(), stDeckLoaded());
  const key = plan.map(p => p.itemId + ":" + p.state).join("|");
  if (key === stKey){
    host.querySelectorAll(".st-time").forEach((t, n) => { if (plan[n]) t.textContent = stTime(plan[n]); });
    return;
  }
  stKey = key;
  const grew = plan.length > stCount;
  stCount = plan.length;
  if (!plan.length){
    host.innerHTML = "";
    host.classList.remove("has-cards");
    stPos = stTarget = 0;
    return;
  }
  host.classList.add("has-cards");
  host.innerHTML =
    '<p class="st-cap">Started this shift <b>' + plan.length + '</b></p>'
    + '<div class="st-stage" tabindex="0" style="height:' + (ST_SHOW * (ST_H + ST_GAP) - ST_GAP) + 'px">'
    +   plan.map(stCard).join("")
    + '</div>'
    + (plan.length > ST_SHOW ? '<p class="st-more">Scroll for the rest</p>' : "");

  // a task just started is the bottom card, so the stack goes to meet it;
  // otherwise it holds its place, clamped to a stack that may have shrunk
  const last = Math.max(0, plan.length - ST_SHOW);
  stTarget = grew ? last : Math.min(stTarget, last);
  if (typeof requestAnimationFrame !== "function") stPos = stTarget;
  stBind(host);
  stLayout();
  stAnimate();
}
function stTick(){ stRender(); }

/* One transform per card from a FRACTIONAL position, the deck's idea. A
   card leaving at the top (or waiting past the third slot) shrinks a
   touch and fades; at opacity 0 it is hidden outright, so the browser
   paints three or four cards however many were started. */
function stLayout(){
  const host = $("startedRail");
  if (!host) return;
  host.querySelectorAll(".st-card").forEach((c, n) => {
    const o = n - stPos;
    const back = o < 0 ? -o : Math.max(0, o - (ST_SHOW - 1));
    if (back >= 1){ c.classList.add("is-off"); return; }
    c.classList.remove("is-off");
    const y = o * (ST_H + ST_GAP);
    c.style.transform = "translate3d(0," + y.toFixed(2) + "px,0) scale(" + (1 - back * 0.06).toFixed(3) + ")";
    c.style.opacity = (1 - back).toFixed(3);
    c.style.zIndex = String(100 - Math.round(back * 10));
    c.style.pointerEvents = back < 0.5 ? "auto" : "none";
  });
}

/* The spring asks for frames while it MOVES and stops at rest - the deck
   learned that the hard way (docs/lessons.md > "Thirty cards"). */
function stAnimate(){
  if (stRaf || typeof requestAnimationFrame !== "function") return;
  stRaf = requestAnimationFrame(stFrame);
}
/* stepped by wall-clock time, as the deck's is - see dkFrames() */
let stPrevFrame = 0;
function stFrame(ts){
  if (!document.querySelector(".st-stage")){ stRaf = 0; stPrevFrame = 0; return; }
  const dt = (typeof ts === "number" && stPrevFrame) ? ts - stPrevFrame : 0;
  stPrevFrame = typeof ts === "number" ? ts : 0;
  const f = (dt > 0 && dt < 100) ? dt / 16.667 : 1;
  stPos += (stTarget - stPos) * (1 - Math.pow(0.76, f));
  if (Math.abs(stTarget - stPos) < 0.0009) stPos = stTarget;
  stLayout();
  if (stPos === stTarget){ stRaf = 0; stPrevFrame = 0; return; }
  stRaf = requestAnimationFrame(stFrame);
}
function stTo(n){
  stTarget = Math.max(0, Math.min(Math.max(0, stCount - ST_SHOW), n));
  if (typeof requestAnimationFrame !== "function"){ stPos = stTarget; stLayout(); return; }
  stAnimate();
}

/* Bound once, on the column that survives every redraw. */
function stBind(host){
  if (stBound) return;
  stBound = true;

  /* One card per notch, and only when a notch MOVES a card: with three or
     fewer, or at either end, the page scrolls as it always would. */
  host.addEventListener("wheel", e => {
    if (stCount <= ST_SHOW || !e.deltaY) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const near = Math.round(stPos);
    if (near + dir < 0 || near + dir > stCount - ST_SHOW) return;
    e.preventDefault();
    if (e.timeStamp - stWheelAt < 260) return;
    stWheelAt = e.timeStamp;
    stTo(near + dir);
  }, { passive: false });

  host.addEventListener("keydown", e => {
    if (e.key === "ArrowDown"){ stTo(Math.round(stPos) + 1); e.preventDefault(); }
    if (e.key === "ArrowUp"){ stTo(Math.round(stPos) - 1); e.preventDefault(); }
  });

  // pressing a card brings that work to the front of the deck, where its
  // buttons are; a finished one has no card there to go to
  host.addEventListener("click", e => {
    const c = e.target.closest(".st-card");
    if (!c || typeof dkRows === "undefined" || typeof dkTo !== "function") return;
    const i = dkRows.findIndex(r => dkItemId(r) === c.dataset.item);
    if (i >= 0) dkTo(i);
  });
}

/* A fresh sign-in must not inherit the last person's stack. */
function stReset(){ stKey = ""; stCount = 0; stPos = 0; stTarget = 0; }

if (typeof module !== "undefined" && module.exports){
  module.exports = { stPlan };
}
