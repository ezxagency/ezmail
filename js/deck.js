/* ============================================================
   THE ASSIGNED DECK — one card per piece of work, one at a time.

   The classic queue nests rows under a store heading and expands
   them in place. Under .ui-next the same rows become a deck: the
   card in front is the work you are looking at, the next two peek
   behind it, and the wheel, the arrows or the arrow keys move one
   card per notch.

   Every kind of row gets the SAME card - an assignment, a campaign
   baton, a workflow stop, and work whose type was deleted. Only
   the action at the bottom changes, and it routes exactly where
   the list rows route, because finishing a baton is a handoff and
   finishing an assignment is not.

   dkPick() is the pure half and the one with a bug in it if
   anything here breaks: when a card is finished it leaves the
   snapshot, and what the deck shows NEXT has to be the work that
   took its place - not card one, and not an index off the end.
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

/* ---------- the half that touches the document ---------- */

let dkId = null;      // the work the front card is showing
let dkIdx = 0;        // where it sat, for when that work is gone
let dkRows = [];      // last rendered, so the arrows have something to move over
let dkBound = false;

const DK_PEEK = 2;    // cards visible behind the front one

function dkKindChip(r){
  if (r.orphanType) return '<span class="adeck-kind is-broken">needs an owner</span>';
  if (r.cg) return '<span class="adeck-kind">campaign</span>';
  if (r.wfNodeRunId) return '<span class="adeck-kind">workflow</span>';
  if (r.stage) return '<span class="adeck-kind">' + esc(r.stage) + '</span>';
  return "";
}

/* The action, and it is the same routing the list rows use. Finishing a
   baton IS the handoff; finishing an assignment is not; and work whose
   type was deleted has no action at all, so it is offered none - a button
   whose only outcome is a refusal is worse than no button. */
function dkActions(r){
  if (r.orphanType){
    return '<p class="adeck-broken">Its kind of work (<b>' + esc(r.orphanType) + '</b>) was deleted, '
      + 'so nothing can be done with it here. An owner can clear it on the Work page.</p>';
  }
  if (r.cg){
    return '<button type="button" class="btn btn-go btn-sm adeck-pass" data-cg="' + esc(r.cg) + '">'
      + (r.multi ? "Approve" : "Pass forward") + '</button>'
      + (r.canBack ? '<button type="button" class="btn btn-ghost btn-sm adeck-sendback" data-cg="' + esc(r.cg) + '">Send back</button>' : "")
      + '<button type="button" class="btn btn-ghost btn-sm adeck-view" data-cg="' + esc(r.cg) + '">Open</button>';
  }
  if (r.wfNodeRunId){
    return '<button type="button" class="btn btn-go btn-sm adeck-wf" data-wf="' + esc(r.wfNodeRunId) + '">Work this stop</button>';
  }
  return '<button type="button" class="btn btn-go btn-sm adeck-done" data-id="' + esc(r.id) + '">Done</button>';
}

function dkCard(r, depth){
  const today = todayISO();
  const late = r.dueDate && r.dueDate < today;
  const from = esc(r.fromName || r.fromEmail || "admin");
  const meta = r.cg
    ? "From " + from + (r.createdAt ? " · your stage since " + dayStamp(r.createdAt) : "")
    : "From " + from + (r.createdAt ? " · assigned " + dayStamp(r.createdAt) : "");
  const front = depth === 0;
  return '<article class="adeck-card' + (front ? " is-front" : "") + '" style="--d:' + depth + '"'
    + (front ? '' : ' aria-hidden="true"') + '>'
    + '<p class="adeck-eyebrow">'
    +   (r.store ? '<span class="adeck-store">' + esc(r.store) + '</span>' : "")
    +   dkKindChip(r)
    +   (r.transferredFrom ? '<span class="adeck-kind">from ' + esc(r.transferredFrom) + '</span>' : "")
    + '</p>'
    + '<h3 class="adeck-title">' + esc(r.task || "Work") + '</h3>'
    + '<p class="adeck-due' + (late ? " is-late" : "") + '">'
    +   (r.dueDate ? (late ? "Overdue · " : "Due ") + esc(dueWithTime(r)) : "No due date") + '</p>'
    + (front && r.note ? '<p class="adeck-note">' + esc(r.note) + '</p>' : "")
    + (front && r.snote ? '<p class="adeck-note">' + esc(r.snote) + '</p>' : "")
    + '<p class="adeck-meta">' + meta + '</p>'
    + (front ? '<div class="adeck-acts">' + dkActions(r) + '</div>' : "")
    + '</article>';
}

function dkEmptyHTML(){
  const why = typeof assignedEmptyReason !== "undefined" ? assignedEmptyReason : null;
  return '<div class="adeck-empty">'
    + '<b>' + (why === "no-org" ? "You are not in an organization yet"
             : why === "org-error" ? "Could not reach your organization"
             : "Nothing assigned right now") + '</b>'
    + '<span>' + (why === "no-org"
        ? "Work assigned to you cannot reach this deck until an owner adds you to their organization."
        : why === "org-error"
        ? "Your work is there — this device could not load it. Check your connection and refresh."
        : "New work from your admin lands here, and from any rule that assigns by itself.") + '</span>'
    + '</div>';
}

function dkRender(rows){
  const host = $("assignedDeck");
  if (!host) return;
  dkRows = rows || [];
  const pick = dkPick(dkRows, dkId, dkIdx);
  dkIdx = pick.idx; dkId = pick.id;

  if (pick.idx < 0){ host.innerHTML = dkEmptyHTML(); dkBind(host); return; }

  const shown = dkRows.slice(pick.idx, pick.idx + 1 + DK_PEEK);
  host.innerHTML =
    '<div class="adeck-stage">' + shown.map((r, i) => dkCard(r, i)).join("") + '</div>'
    + '<div class="adeck-nav">'
    +   '<button type="button" class="adeck-arrow" data-dk="-1" aria-label="Previous"'
    +     (pick.idx === 0 ? " disabled" : "") + '>'
    +     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>'
    +   '<span class="adeck-count">' + (pick.idx + 1) + ' <i>/</i> ' + dkRows.length + '</span>'
    +   '<button type="button" class="adeck-arrow" data-dk="1" aria-label="Next"'
    +     (pick.idx >= dkRows.length - 1 ? " disabled" : "") + '>'
    +     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>'
    + '</div>';

  host.querySelectorAll("[data-dk]").forEach(b => b.onclick = () => dkGo(Number(b.dataset.dk)));
  const going = () => { const c = host.querySelector(".adeck-card.is-front"); if (c) c.classList.add("is-going"); };
  host.querySelectorAll(".adeck-done").forEach(b => b.onclick = () => { going(); markAssignmentDone(b.dataset.id); });
  host.querySelectorAll(".adeck-wf").forEach(b => b.onclick = () => {
    if (typeof wfOpenStopById === "function") wfOpenStopById(b.dataset.wf);
  });
  host.querySelectorAll(".adeck-pass").forEach(b => b.onclick = () => cgPassSheet(b.dataset.cg));
  host.querySelectorAll(".adeck-sendback").forEach(b => b.onclick = () => cgBackSheet(b.dataset.cg));
  host.querySelectorAll(".adeck-view").forEach(b => b.onclick = () => cgOpenDetail(b.dataset.cg));
  dkBind(host);
}

function dkGo(delta){
  if (!dkRows.length) return;
  const next = Math.max(0, Math.min(dkRows.length - 1, dkIdx + delta));
  if (next === dkIdx) return;
  dkIdx = next; dkId = dkRows[next].id;
  dkRender(dkRows);
}

/* Bound once, on the container that survives every re-render.
   The wheel only takes the event when it actually MOVES a card: at either
   end of the deck the page scrolls as it always would, because swallowing
   a scroll that changes nothing is how a panel traps a cursor. */
let dkWheelAt = 0;
function dkBind(host){
  if (dkBound) return;
  dkBound = true;
  host.addEventListener("wheel", e => {
    if (!dkRows.length) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    const dir = d > 0 ? 1 : -1;
    if (dkIdx + dir < 0 || dkIdx + dir > dkRows.length - 1) return;
    e.preventDefault();
    const now = Date.now();
    if (now - dkWheelAt < 260) return;   // one card per notch, not per pixel
    dkWheelAt = now;
    dkGo(dir);
  }, { passive: false });
  host.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") { dkGo(1); e.preventDefault(); }
    if (e.key === "ArrowLeft")  { dkGo(-1); e.preventDefault(); }
  });
}

/* A fresh sign-in must not inherit the last person's place in the deck. */
function dkReset(){ dkId = null; dkIdx = 0; dkRows = []; }

if (typeof module !== "undefined" && module.exports){
  module.exports = { dkPick };
}
