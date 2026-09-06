/* ============================================================
   THE HERO'S LAST PIECE — "pick up where you left off".

   Two chips under the clock-in button naming the last work this
   person actually did: the store and the task, newest first.
   They are DELIBERATELY not buttons yet. The comp has them and
   what a tap should do is undecided, and a chip that looks
   pressable and does nothing is worse than one that plainly is
   not - so they render as plain text until that is settled.

   They show REAL work, though. A hardcoded "Store Epsilon ·
   Design review" would be a screen stating something untrue,
   which is the failure this app has paid for most often. With
   nothing on record the row does not draw at all.

   `hr` prefix: `pk` belongs to js/packs.js and `wk` to
   js/work.js in this one shared scope.
   ============================================================ */

/* Every (store, task) this shift touched, newest last, with the store
   carried forward across segments that did not name one - the same walk
   currentStore() does, because a switch only records the store when the
   store is what changed.
   An OPEN segment is skipped: work you are doing right now is not work to
   pick back up. */
function hrPairsOf(sh){
  const out = [];
  if (!sh) return out;
  let store = sh.client;
  (sh.segs || []).forEach(s => {
    if (s.client) store = s.client;
    if (!s.endedAt || !s.task) return;
    out.push({ store: store || "", task: s.task, at: s.startedAt });
  });
  return out;
}

function hrPickups(history, shift, max){
  const cap = max || 2;
  const all = hrPairsOf(shift);
  (history || []).forEach(r => all.push(...hrPairsOf(r)));
  all.sort((a, b) => (b.at || 0) - (a.at || 0));
  const seen = new Set(), out = [];
  for (const p of all){
    const key = p.store + "|" + p.task;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

/* ---------- drawn under the dock ---------- */

const HR_CHIP_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8a9 9 0 1 1-1 5.5"/><path d="M3 3v5h5"/></svg>';

/* Called at the end of renderDock, so the chips live INSIDE the dock's
   grid area and cannot be auto-placed into a cell the layout did not
   plan for. Nothing on record draws nothing - a caption over an empty
   row is furniture pretending to be information. */
function hrRenderPickup(dock){
  if (!dock) return;
  const rows = hrPickups(S.history, S.shift, 2);
  if (!rows.length) return;
  const box = document.createElement("div");
  box.className = "pickup";
  box.innerHTML =
    '<p class="pu-cap">Pick up where you left off</p>'
    + '<div class="pu-row">' + rows.map((p, i) =>
        '<span class="pu-chip">'
        + (i === 0 ? '<span class="pu-ico">' + HR_CHIP_ICO + '</span>' : "")
        + (p.store ? '<b>' + esc(p.store) + '</b><em>·</em>' : "")
        + '<i>' + esc(p.task) + '</i></span>').join("")
    + '</div>';
  dock.append(box);
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { hrPairsOf, hrPickups };
}
