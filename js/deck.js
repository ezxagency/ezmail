/* ============================================================
   THE WORK DECK — docs/dashboard-v6-spec.md §4a, §5, §11, §12a.

   One card per piece of work, stacked in 3D the way the iOS app
   switcher stacks apps: the front card flat and centred, the
   neighbours rotated away and pushed back, so DEPTH separates
   them rather than gaps. Moved by drag with inertia, by the
   wheel one card per notch, by the arrows, the arrow keys and
   the dots.

   Every kind of work wears the same card and the same pair of
   buttons, because §12a collapsed four kinds into one: the whole
   app is a chain of stages, so Done means "finish my stage" and
   the work moves itself. Only the LEFT button changes, and only
   with state: Start task before the work is running, Put down
   once it is.

   dkPick() is the pure half. When a card is finished it leaves
   the snapshot, and what shows next has to be the work that took
   its place - not card one, and not an index off the end.
   ============================================================ */

/* Which card to show after the rows changed underneath us.
   Keeping the same WORK matters more than keeping the same position,
   so an id that survived wins; otherwise hold the position, clamped. */
function dkPick(rows, wantId, wantIdx){
  if (!rows || !rows.length) return { idx: -1, id: null };
  const at = rows.findIndex(r => r.id === wantId);
  if (at >= 0) return { idx: at, id: rows[at].id };
  const idx = Math.max(0, Math.min(rows.length - 1, wantIdx | 0));
  return { idx, id: rows[idx].id };
}

/* ---------- what a row IS, in the one vocabulary the card speaks ----------
   §12a: four kinds became one. A row is work; it may be running, it may be
   returnable, and it may be broken. Nothing else about where it came from
   reaches the card. */
const dkItemId = r => r.itemId || r.id;
const dkRunning = r => typeof clkOpenItemId === "function"
  && S.status === "ACTIVE" && clkOpenItemId(S.shift) === dkItemId(r);
const dkPausedMs = r => {
  if (typeof clkTaskTotal !== "function" || !S.shift) return 0;
  return clkTaskTotal(S.shift, dkItemId(r), Date.now());
};

/* ---------- the clock, moved by the card ----------
   §3. Start task skips the store/task sheet: the assigner already chose
   both, and a copywriter opening a copy task should not be asked what they
   are about to do. */
async function dkStart(r){
  if (!r || r.orphanType) return;
  const now = Date.now();
  const seg = { task: r.task || "Work", itemId: dkItemId(r),
                startedAt: now, endedAt: null, via: "task" };
  if (r.store) seg.client = r.store;

  if (S.status === "IDLE"){
    S.shift = { client: r.store || "", startedAt: now, segs: [seg], breaks: [] };
    S.status = "ACTIVE";
  } else {
    if (S.status === "ON_BREAK"){
      const b = openBreak(S.shift);
      if (b) b.endedAt = now;
      S.status = "ACTIVE";
    } else {
      const open = openSeg(S.shift);
      if (open){
        if (open.itemId === seg.itemId) return;   // already on it
        open.endedAt = now;                        // it becomes PAUSED
      }
    }
    S.shift.segs.push(seg);
  }
  await save();
  render();
  toast("Started " + (r.task || "work"));
}

/* §5. Finishing routes by what the row is - unchanged, that is the whole
   point of one card - and then leaves the shift running with NOTHING open,
   which is what the idle segment is for. Without it the invariant breaks:
   ACTIVE with no open seg crashes the next Switch or Pause. */
async function dkIdleAfter(r){
  if (S.status !== "ACTIVE" || !S.shift) return;
  const open = openSeg(S.shift);
  if (!open || open.itemId !== dkItemId(r)) return;
  const now = Date.now();
  open.endedAt = now;
  S.shift.segs.push({ task: null, itemId: null, startedAt: now, endedAt: null, via: "idle" });
  await save();
  render();
}

function dkFinish(r){
  dkIdleAfter(r);
  return markAssignmentDone(r.id);
}

/* ---------- the done moment ----------
   Done is confirmed in a sheet (markAssignmentDone), and the write that
   follows removes the row from the snapshot within a frame or two. That
   used to be the whole ceremony - worse, the card faded the instant Done
   was PRESSED, before anything was confirmed, and cancelling the sheet
   left an invisible card. Now the card does nothing until the finish
   lands. finishAssignment() arms a HOLD before it writes, so the rows the
   snapshot delivers wait instead of applying; on success it asks for the
   strike - a line drawn through the middle of the title - and the deck
   keeps that picture for DK_DONE_MS before the waiting rows apply. On
   failure it releases at once and the card is simply still there. */
const DK_DONE_MS = 1150;
let dkHeld = null;   // { id, rows: the latest rows delivered while holding, timer }

function dkHold(id){
  if (typeof uiNextOn === "function" && !uiNextOn()) return;
  if (!$("assignedDeck")) return;
  dkRelease(false);
  // a finish that never reports back must not freeze the deck for good
  dkHeld = { id, rows: null, timer: setTimeout(() => dkRelease(), 6000) };
}
function dkStrike(id){
  if (!dkHeld || dkHeld.id !== id) return;
  const card = [...document.querySelectorAll(".dk-card")].find(c => c.dataset.id === id);
  if (card) card.classList.add("is-done");
  clearTimeout(dkHeld.timer);
  dkHeld.timer = setTimeout(() => dkRelease(), DK_DONE_MS);
}
function dkRelease(apply){
  if (!dkHeld) return;
  const { rows, timer } = dkHeld;
  clearTimeout(timer);
  dkHeld = null;
  if (apply !== false && rows) dkRender(rows);
}

/* §4: the paused row. Putting work down closes its segment and opens an
   idle one; the card keeps its time (clkTaskTotal sums by itemId) and
   Start task picks it back up. This is the left button while running -
   it replaced "Send back", whose only implementation was the campaigns
   page, cut with it. */
async function dkPutDown(r){
  await dkIdleAfter(r);
  toast("Put down — pick it back up any time");
}

/* ---------- the card ---------- */
const DK_ICO = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8 8 0 1 0 12 20"/><path d="M20 5v6h-6"/></svg>',
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>'
};

function dkDuePill(r){
  if (!r.dueDate) return "";
  const late = r.dueDate < todayISO();
  return '<span class="dk-pill ' + (late ? "dk-late" : "dk-due") + '">'
    + (late ? "Overdue · " : "Due ") + esc(dueWithTime(r)) + '</span>';
}

/* Brief, checklist and attachments are drawn ONLY when the work carries
   them. The comp shows a full card because its fixture is full; inventing
   rows here would put words on screen that nobody wrote. */
function dkBlocks(r){
  let html = "";
  /* Work on a track says where it is: the stop, who passed it here and
     what they wrote, and who is next - the card is the handoff. */
  const h = r.handoff && !r.handoff.done ? r.handoff : null;
  if (h){
    const nextWho = h.next ? h.next.holders.map(x => x.name).filter(Boolean).join(", ") : "";
    html += '<div class="dk-blk dk-hand">'
      + '<p class="dk-blk-h">Handoff' + (h.stop ? ' · stop ' + h.stop.index + ' of ' + h.stop.count + ' · ' + esc(h.stop.label) : "") + '</p>'
      + (h.from
          ? '<p class="dk-hand-from"><b>From ' + esc(h.from.name || h.from.label || "the last stop") + '</b>'
            + (h.from.note ? ' · \u201c' + esc(h.from.note) + '\u201d' : ' · no note') + '</p>'
          : '<p class="dk-hand-from"><b>First stop</b> · it starts with you</p>')
      + (h.next
          ? '<p class="dk-hand-next"><b>Next</b> · ' + esc(h.next.label) + ' \u2192 '
            + (nextWho ? esc(nextWho) : '<em>nobody holds ' + esc(h.next.role || "that stop") + ' yet</em>') + '</p>'
          : '<p class="dk-hand-next"><b>Last stop</b> · finishing closes it</p>')
      + '</div>';
  }
  const brief = r.note || r.snote;
  if (brief){
    html += '<div class="dk-blk"><p class="dk-blk-h">Brief</p>'
      + '<p class="dk-brief">' + esc(brief) + '</p></div>';
  }
  const checks = Array.isArray(r.checklist) ? r.checklist : [];
  if (checks.length){
    html += '<div class="dk-blk"><p class="dk-blk-h">Checklist</p><div class="dk-checks">'
      + checks.map(c => '<span class="dk-chk' + (c.done ? " is-done" : "") + '">'
          + '<i>' + (c.done ? DK_ICO.tick : "") + '</i>' + esc(c.text || "") + '</span>').join("")
      + '</div></div>';
  }
  const files = Array.isArray(r.attachments) ? r.attachments : [];
  if (files.length){
    html += '<div class="dk-blk"><p class="dk-blk-h">Attached</p><div class="dk-files">'
      + files.map((f, i) => '<button type="button" class="dk-file" data-file="' + i + '">'
          + '<span class="dk-file-i">' + (DK_ICO[f.icon] || DK_ICO.doc) + '</span>'
          + '<span class="dk-file-t"><b>' + esc(f.name || f.url || "Attachment") + '</b>'
          + '<span>' + esc(f.meta || "") + '</span></span></button>').join("")
      + '</div></div>';
  }
  return html;
}

function dkFoot(r){
  if (r.orphanType){
    return '<p class="dk-broken">Its kind of work (<b>' + esc(r.orphanType) + '</b>) was '
      + 'deleted, so nothing can be done with it here. An owner can clear it on the Work page.</p>';
  }
  const running = dkRunning(r);
  const left = running
    ? '<button type="button" class="dk-bt dk-bt-gh dk-down">' + DK_ICO.back + 'Put down</button>'
    : '<button type="button" class="dk-bt dk-bt-go dk-start">' + DK_ICO.clock + 'Start task</button>';
  // on a track, Done is a hand-off: say so, and name it Finish at the end
  const h = r.handoff && !r.handoff.done ? r.handoff : null;
  const doneLabel = h ? (h.next ? "Pass on" : "Finish") : "Done";
  const right = '<button type="button" class="dk-bt ' + (running ? "dk-bt-go" : "dk-bt-gh")
    + ' dk-done">' + DK_ICO.tick + doneLabel + '</button>';
  return left + right;
}

function dkCard(r, n){
  const paused = !dkRunning(r) && dkPausedMs(r) > 0;
  return '<article class="dk-card" data-n="' + n + '" data-id="' + esc(r.id) + '">'
    + '<div class="dk-top">'
    +   (r.store ? '<span class="dk-pill dk-store">' + esc(r.store) + '</span>' : "")
    +   dkDuePill(r)
    +   (dkRunning(r) ? '<span class="dk-pill dk-live">Running</span>' : "")
    +   (paused ? '<span class="dk-pill dk-paused">Paused · ' + esc(humanDur(dkPausedMs(r))) + '</span>' : "")
    +   (r.orphanType ? '<span class="dk-pill dk-late">Needs an owner</span>' : "")
    + '</div>'
    // the span is what the done strike draws across, line by line
    + '<h3 class="dk-title"><span>' + esc(r.task || "Work") + '</span></h3>'
    + '<p class="dk-from">From ' + esc(r.fromName || r.fromEmail || "admin")
    +   (r.createdAt ? " · assigned " + dayStamp(r.createdAt) : "")
    +   (r.dueDate ? "" : " · no due date") + '</p>'
    + '<div class="dk-body">' + dkBlocks(r) + '</div>'
    + '<div class="dk-foot">' + dkFoot(r) + '</div>'
    + '</article>';
}

/* ---------- the stack, and the physics that move it ----------
   Ported from the prototype so the FEEL is the design's, not mine:
   travel compresses as cards stack back (so the deck never runs off the
   edge however many tasks there are), neighbours rotate away and sit
   deeper, and release settles onto the nearest card with a spring. */
const DK_STEP = 0.26;    // sideways travel as a share of card width. The prototype's
                         // 0.60 was drawn for a wider stage; at 620px it threw the
                         // neighbours clean out of the column.
const DK_TILT = 15;      // degrees each neighbour rotates away. Gentler than the
                         // prototype's 26: these cards are full-column height, and a
                         // tall plane at 26 degrees reads as a fold rather than depth.
const DK_DEPTH = 210;    // how far back each neighbour sits
const DK_EASE = 0.76;    // what is LEFT of the distance after one 60Hz frame:
                         // 24% closed per frame, settled in about a quarter
                         // of a second. 0.84 took nearly half a second and
                         // read as the deck lagging the hand.

let dkId = null, dkIdx = 0, dkRows = [], dkBound = false;
let dkPos = 0, dkVel = 0, dkTarget = 0, dkDragging = false, dkSettled = -1, dkRaf = 0;
let dkW = 0;             // the front card's width, measured once per draw
let dkPrevFrame = 0;     // the last animation frame's timestamp

/* The spring's feel was tuned at 60Hz: 16% of the way per frame, and 10%
   off the fling per frame. Stepped PER FRAME it ran twice as fast on a
   120Hz screen and crawled under a heavy tab, so every step is scaled by
   how much wall-clock time the frame actually took - `f` is the number of
   60Hz frames' worth. A timestamp that is missing, repeated or absurd
   (a tab coming back from the background) counts as one frame. */
function dkFrames(ts){
  const dt = (typeof ts === "number" && dkPrevFrame) ? ts - dkPrevFrame : 0;
  dkPrevFrame = typeof ts === "number" ? ts : 0;
  return (dt > 0 && dt < 100) ? dt / 16.667 : 1;
}

function dkSubtitle(rows){
  const today = todayISO();
  const late = rows.filter(r => r.dueDate && r.dueDate < today).length;
  const soon = rows.filter(r => r.dueDate === today).length;
  const n = rows.length;
  return '<p class="dk-sub">' + n + (n === 1 ? " task" : " tasks")
    + ' <em>·</em> ' + (late
        ? '<b class="dk-sub-late"><i></i>' + late + ' overdue</b>'
        : '<span>0 overdue</span>')
    + ' <em>·</em> <span>' + soon + ' due today</span></p>';
}

function dkEmptyHTML(){
  const why = typeof assignedEmptyReason !== "undefined" ? assignedEmptyReason : null;
  return '<article class="dk-card dk-card-empty is-front">'
    + '<h3 class="dk-title">' + (why === "no-org" ? "You are not in an organization yet"
        : why === "org-error" ? "Could not reach your organization"
        : "No tasks assigned") + '</h3>'
    + '<p class="dk-from">' + (why === "no-org"
        ? "Work assigned to you cannot reach this deck until an owner adds you to their organization."
        : why === "org-error"
        ? "Your work is there — this device could not load it. Check your connection and refresh."
        : "New work lands here, from your admin and from any rule that assigns by itself.")
    + '</p></article>';
}

function dkRender(rows){
  const host = $("assignedDeck");
  if (!host) return;
  // mid-done: the picture is held, the rows wait (see dkHold)
  if (dkHeld){ dkHeld.rows = rows || []; return; }
  dkRows = rows || [];
  const pick = dkPick(dkRows, dkId, dkIdx);
  const wasIdx = dkIdx;
  dkIdx = pick.idx; dkId = pick.id;
  if (pick.idx !== wasIdx || Math.abs(dkPos - pick.idx) > 3) { dkPos = Math.max(0, pick.idx); }
  dkTarget = Math.max(0, pick.idx);

  const head = '<div class="dk-head">'
    + '<div class="dk-head-t"><h2>Your work</h2>'
    +   (dkRows.length ? dkSubtitle(dkRows) : '<p class="dk-sub"><span>Nothing assigned</span></p>')
    + '</div>'
    + (dkRows.length > 1
        ? '<div class="dk-arrows">'
          + '<button type="button" class="dk-ab" data-dk="-1" aria-label="Previous task">'
          + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>'
          + '<button type="button" class="dk-ab" data-dk="1" aria-label="Next task">'
          + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>'
          + '</div>' : "")
    + '</div>';

  if (pick.idx < 0){
    host.innerHTML = head + '<div class="dk-stage">' + dkEmptyHTML() + '</div>';
    dkBind(host);
    return;
  }

  host.innerHTML = head
    + '<div class="dk-stage" tabindex="0">' + dkRows.map((r, n) => dkCard(r, n)).join("") + '</div>'
    + (dkRows.length > 1
        ? '<div class="dk-dots">' + dkRows.map((_, n) =>
            '<i data-dot="' + n + '"></i>').join("") + '</div>' : "");

  const row = dkRows[pick.idx];
  host.querySelectorAll("[data-dk]").forEach(b => b.onclick = () => dkGo(Number(b.dataset.dk)));
  host.querySelectorAll("[data-dot]").forEach(d => d.onclick = () => dkTo(Number(d.dataset.dot)));
  host.querySelectorAll(".dk-start").forEach(b => b.onclick = () => dkStart(row));
  host.querySelectorAll(".dk-done").forEach(b => b.onclick = () => dkFinish(row));
  host.querySelectorAll(".dk-down").forEach(b => b.onclick = () => dkPutDown(row));
  host.querySelectorAll(".dk-file").forEach(b => b.onclick = () => {
    const f = (row.attachments || [])[Number(b.dataset.file)];
    if (f && f.url) window.open(f.url, "_blank", "noopener");
  });

  dkBind(host);
  dkW = 0;
  /* The cards were just rebuilt, and none of them is marked front. dkSettled
     remembers which index WAS, and dkLayout only marks a card when that
     number changes - so a redraw onto the same index marked nothing, and
     the front card came up as blurred glass. Pressing Start task is such a
     redraw: it writes the shift, and render() rebuilds the deck. */
  dkSettled = -1;
  dkLayout();
  dkStartTicking();
  // the chips under the dock are this shift's paused tasks narrowed to the
  // work still on the deck, so a change here changes them too
  if (typeof hrRefresh === "function") hrRefresh();
  // and the started stack reads the deck to tell Paused from Finished
  if (typeof stRender === "function") stRender();
}

/* The deck is drawn from a SNAPSHOT of the assignments, but the card also
   reflects the SHIFT: the Running pill, Paused - 23m, and which button the
   left seat holds. Starting a task writes the shift and never touches the
   assignments, so nothing told the deck to redraw - and the card went on
   offering Start task on work that was already running. render() calls
   this, which is the only place that sees both. */
function dkRefresh(){
  if (dkHeld) return;   // the held picture is the point; and dkRows is stale by then
  if (typeof $ === "function" && $("assignedDeck")) dkRender(dkRows);
}

/* The spring runs on animation frames, and there is exactly one place that
   asks for them. Somewhere without rAF - jsdom, a test - still gets a laid
   out deck from the dkLayout() above; it simply does not animate. Silently
   doing nothing would have made every deck assertion pass on an empty
   stage.

   The loop STOPS once the deck is at rest and starts again on the next
   thing that moves it. It used to run forever, restyling every card on
   every frame of the day - thirty transforms a frame to move nothing -
   and every frame the stack was moving competed with that. */
function dkStartTicking(){
  if (dkRaf || typeof requestAnimationFrame !== "function") return;
  dkRaf = requestAnimationFrame(dkTick);
}
const dkAtRest = () => !dkDragging && dkVel === 0 && dkPos === dkTarget;

/* One transform per card, from a FRACTIONAL position - which is what lets a
   drag land between two cards and settle rather than snapping. */
function dkLayout(){
  const stage = document.querySelector(".dk-stage");
  if (!stage) return;
  // the empty-state card is not part of the stack and must not be moved by
  // it: it has no position in a deck of nothing
  const cards = [...stage.querySelectorAll(".dk-card:not(.dk-card-empty)")];
  if (!cards.length) return;
  if (!dkW) dkW = cards[0].offsetWidth || 470;
  const w = dkW;

  cards.forEach((c, n) => {
    const o = n - dkPos, a = Math.abs(o), dir = o < 0 ? -1 : 1;
    /* A card more than two back is at opacity 0 - there is nothing of it
       to see - but it was still a full-size glass pane the browser had to
       blur, shadow and composite thirty times over on every frame. Hidden,
       it costs nothing; and once hidden it is left alone until it comes
       back into range, so a deck of thirty moves like a deck of three. */
    // 0.62: a neighbour at 38%, faint enough that the front card is
    // plainly the one on top, and still there to say the deck goes on
    const op = Math.max(0, 1 - a * 0.68);
    const off = op <= 0;
    if (off){
      if (!c.classList.contains("is-off")) c.classList.add("is-off");
      return;
    }
    c.classList.remove("is-off");
    const x = dir * (1 - Math.pow(0.72, a)) / 0.28 * (w * DK_STEP);
    const rot = -Math.max(-2.4, Math.min(2.4, o)) * DK_TILT;
    const z = -Math.min(a, 3) * DK_DEPTH;
    const sc = 1 - Math.min(a, 3) * 0.055;
    c.style.transform = "translateX(-50%) translate3d(" + x.toFixed(2) + "px,0," + z + "px) "
      + "rotateY(" + rot.toFixed(2) + "deg) scale(" + sc.toFixed(3) + ")";
    // 0.34 left a neighbour at 66%, and the sliver that clears the front
    // card is its MIDDLE, not its edge - so words from the next task read
    // beside the one you are on. Depth is the signal; text is not.
    c.style.opacity = String(op);
    c.style.zIndex = String(100 - Math.round(a * 10));
    c.style.pointerEvents = a < 0.5 ? "auto" : "none";
    /* The glass is built from these in css/ios.css: --d is how far back
       the card sits (0 in front, 1 a neighbour), --o which side and how
       far (so the sheen swings as it moves), --v how fast the stack is
       going (a touch of blur while it flies). Written every frame the
       stack moves, so the tint, the blur and the light change WITH the
       motion rather than snapping when the front card is re-picked. */
    c.style.setProperty("--d", Math.min(1, a).toFixed(3));
    c.style.setProperty("--o", Math.max(-1, Math.min(1, o)).toFixed(3));
    c.style.setProperty("--v", Math.min(1, Math.abs(dkVel) * 8).toFixed(3));
  });

  const near = Math.round(dkPos);
  if (near !== dkSettled){
    dkSettled = near;
    cards.forEach((c, n) => c.classList.toggle("is-front", n === near));
    document.querySelectorAll(".dk-dots i").forEach((d, n) => d.classList.toggle("on", n === near));
    document.querySelectorAll("[data-dk]").forEach(b => {
      const d = Number(b.dataset.dk);
      b.disabled = d < 0 ? near <= 0 : near >= dkRows.length - 1;
    });
    if (dkRows[near]) { dkIdx = near; dkId = dkRows[near].id; }
  }
}

function dkTick(ts){
  if (!document.querySelector(".dk-stage")) { dkRaf = 0; dkPrevFrame = 0; return; }
  const f = dkFrames(ts);
  if (!dkDragging){
    if (Math.abs(dkVel) > 0.0005){
      dkPos += dkVel * f; dkVel *= Math.pow(0.90, f);
      dkTarget = Math.max(0, Math.min(dkRows.length - 1, Math.round(dkPos + dkVel * 6)));
    } else {
      dkVel = 0;
      dkPos += (dkTarget - dkPos) * (1 - Math.pow(DK_EASE, f));
      if (Math.abs(dkTarget - dkPos) < 0.0009) dkPos = dkTarget;
    }
    // refuse to travel past the ends, with a little give
    if (dkPos < -0.32){ dkPos = -0.32; dkVel = 0; }
    if (dkPos > dkRows.length - 1 + 0.32){ dkPos = dkRows.length - 1 + 0.32; dkVel = 0; }
  }
  dkLayout();
  if (dkAtRest()) { dkRaf = 0; dkPrevFrame = 0; return; }
  dkRaf = requestAnimationFrame(dkTick);
}

function dkTo(n){
  if (!dkRows.length) return;
  dkTarget = Math.max(0, Math.min(dkRows.length - 1, n));
  dkVel = 0;
  // without frames there is no spring to settle, so land on it outright
  if (typeof requestAnimationFrame !== "function"){ dkPos = dkTarget; dkLayout(); return; }
  dkStartTicking();
}
function dkGo(delta){ dkTo(Math.round(dkPos) + delta); }

/* Bound once, on the container that survives every re-render. */
let dkWheelAt = 0, dkWheelAcc = 0, dkStartX = 0, dkStartPos = 0, dkLastX = 0, dkLastT = 0;
const DK_NOTCH = 50;     // px of wheel that moves one card
function dkBind(host){
  if (dkBound) return;
  dkBound = true;

  host.addEventListener("pointerdown", e => {
    if (!dkRows.length || e.target.closest(".dk-bt, .dk-file, .dk-ab, .dk-dots")) return;
    dkDragging = true; dkVel = 0;
    dkStartX = dkLastX = e.clientX; dkStartPos = dkPos; dkLastT = e.timeStamp;
    host.classList.add("is-drag");
    try { host.setPointerCapture(e.pointerId); } catch (err) {}
    dkStartTicking();
  });
  host.addEventListener("pointermove", e => {
    if (!dkDragging) return;
    const card = host.querySelector(".dk-card");
    const w = (card ? card.offsetWidth : 470) * DK_STEP;
    let raw = dkStartPos - (e.clientX - dkStartX) / w;
    // rubber-band past either end
    if (raw < 0) raw = raw * 0.34;
    if (raw > dkRows.length - 1) raw = dkRows.length - 1 + (raw - (dkRows.length - 1)) * 0.34;
    dkPos = raw;
    const dt = e.timeStamp - dkLastT;
    if (dt > 0) dkVel = -((e.clientX - dkLastX) / w) / dt * 15;
    dkLastX = e.clientX; dkLastT = e.timeStamp;
  });
  const release = () => {
    if (!dkDragging) return;
    dkDragging = false;
    host.classList.remove("is-drag");
    dkVel = Math.max(-0.25, Math.min(0.25, dkVel));
    dkTarget = Math.max(0, Math.min(dkRows.length - 1, Math.round(dkPos + dkVel * 6)));
    dkStartTicking();
  };
  host.addEventListener("pointerup", release);
  host.addEventListener("pointercancel", release);

  /* One card per notch, as asked - not the prototype's free scrub. The
     event is only taken when it actually MOVES a card: at either end the
     page scrolls as it always would, because swallowing a scroll that
     changes nothing is how a panel traps a cursor.

     A mouse notch is ~100px and moves a card at once. A trackpad sends a
     stream of small deltas, so those ACCUMULATE to a notch's worth rather
     than each moving a card - which is what let a two-finger nudge throw
     the deck ten cards. The stream's remainder is dropped once the hand
     has been still for a moment. The 260ms throttle that used to sit
     here is gone: it was the lag between the hand and the deck. */
  host.addEventListener("wheel", e => {
    if (!dkRows.length) return;
    let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    if (e.deltaMode === 1) d *= 40; else if (e.deltaMode === 2) d *= 400;
    const now = e.timeStamp;
    if (now - dkWheelAt > 220) dkWheelAcc = 0;
    dkWheelAt = now;
    const dir = d > 0 ? 1 : -1;
    const near = Math.round(dkTarget);
    if (near + dir < 0 || near + dir > dkRows.length - 1) { dkWheelAcc = 0; return; }
    e.preventDefault();
    dkWheelAcc += d;
    if (Math.abs(dkWheelAcc) < DK_NOTCH) return;
    dkWheelAcc = 0;
    dkTo(near + dir);
  }, { passive: false });

  if (typeof window !== "undefined" && window.addEventListener){
    window.addEventListener("resize", () => { dkW = 0; dkLayout(); });
  }

  host.addEventListener("keydown", e => {
    if (e.key === "ArrowRight"){ dkGo(1); e.preventDefault(); }
    if (e.key === "ArrowLeft"){ dkGo(-1); e.preventDefault(); }
  });
}

/* A fresh sign-in must not inherit the last person's place in the deck. */
function dkReset(){
  dkId = null; dkIdx = 0; dkRows = [];
  dkPos = 0; dkVel = 0; dkTarget = 0; dkSettled = -1; dkW = 0;
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { dkPick };
}
