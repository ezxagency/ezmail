/* ============================================================
   PICK UP WHERE YOU LEFT OFF — docs/dashboard-v6-spec.md §4.

   The row of chips under the dock is THIS SHIFT'S PAUSED TASKS:
   work with a closed segment, not the one running now, and not
   finished. Each chip carries the task's own name and the time
   already spent on it, and pressing one opens a fresh segment
   for that task - the same act the card's own Start task
   performs, and the reason the row is not a permanent button:
   it changes as the day does.

   It used to name the last work from S.history and do nothing
   when tapped. That was two mistakes at once. History is
   YESTERDAY'S work, not the task you put down an hour ago -
   the thing somebody actually wants back. And a chip that looks
   pressable and is not is the shape this app has paid for
   before ("A correct action that looks like a dead button is
   not correct enough", docs/lessons.md).

   Two halves on purpose: hrOffer() is pure and decides WHICH
   paused tasks may be offered; hrRenderPickup() is the only
   part that touches the document.

   `hr` prefix: `pk` belongs to js/packs.js and `wk` to
   js/work.js in this one shared scope.
   ============================================================ */

/* clkPaused() knows what was PUT DOWN. It deliberately does not know what
   is FINISHED - "done" lives on the Item, not in the shift - so the deck's
   own rows are what say a task is still open. A paused task with no row
   behind it is work that was completed (or reassigned away), and offering
   it back would start the clock on something nobody can finish.

   Which also settles the case where the queue has not loaded yet: no rows,
   no chips. Briefly quiet is right; confidently offering finished work is
   the failure shape this file already has an entry for.

   Work whose type was deleted is skipped for the same reason dkStart()
   refuses it - a control that can only fail should not be drawn. */
function hrOffer(paused, rows, max){
  const cap = max || 3;
  const by = new Map();
  (rows || []).forEach(r => {
    const id = r.itemId || r.id;
    if (id && !by.has(id)) by.set(id, r);
  });
  const out = [];
  for (const p of (paused || [])){
    const row = by.get(p.itemId);
    if (!row || row.orphanType) continue;
    out.push({ itemId: p.itemId, task: p.task || row.task || "Work", ms: p.ms, row });
    if (out.length >= cap) break;
  }
  return out;
}

/* The glue: this shift's paused tasks, narrowed to the work still on the
   deck. Kept separate from hrOffer so the decision can be tested without a
   shift and the walk can be tested with one. */
function hrPickups(shift, rows, now, max){
  if (typeof clkPaused !== "function") return [];
  return hrOffer(clkPaused(shift, now || Date.now()), rows, max);
}

/* ---------- drawn under the dock ---------- */

const HR_CHIP_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8a9 9 0 1 1-1 5.5"/><path d="M3 3v5h5"/></svg>';

/* Called at the end of renderDock, so the chips live INSIDE the dock's
   grid area and cannot be auto-placed into a cell the layout did not plan
   for. Nothing paused draws nothing - a caption over an empty row is
   furniture pretending to be information. */
function hrRenderPickup(dock){
  if (!dock) return;
  const rows = hrPickups(S.shift, typeof dkRows === "undefined" ? [] : dkRows, Date.now(), 3);
  if (!rows.length) return;

  const box = document.createElement("div");
  box.className = "pickup";
  box.innerHTML = '<p class="pu-cap">Pick up where you left off</p><div class="pu-row"></div>';
  const strip = box.querySelector(".pu-row");

  rows.forEach(p => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pu-chip";
    b.innerHTML = '<span class="pu-ico">' + HR_CHIP_ICO + '</span>'
      + '<b>' + esc(p.task) + '</b><em>·</em><i>' + esc(humanDur(p.ms)) + '</i>';
    // The deck moves to the card as well as the clock: resuming a task and
    // then looking at somebody else's work is not what the press asked for.
    b.onclick = async () => {
      if (typeof dkStart !== "function") return;
      await dkStart(p.row);
      if (typeof dkTo === "function" && typeof dkRows !== "undefined"){
        const at = dkRows.findIndex(r => (r.itemId || r.id) === p.itemId);
        if (at >= 0) dkTo(at);
      }
    };
    strip.append(b);
  });
  dock.append(box);
}

/* The dock and the deck are drawn by different callers - renderDock() on
   state changes, dkRender() on snapshots - and the chips depend on both.
   This is how the deck hands the row back after ITS half moved. */
function hrRefresh(){
  const dock = typeof $ === "function" ? $("dock") : null;
  if (!dock || !uiNextOn()) return;
  const old = dock.querySelector(".pickup");
  if (old) old.remove();
  hrRenderPickup(dock);
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { hrOffer };
}
