/* ============================================================
   THE SEGMENT MATH — pure, and the reason it is its own file.

   docs/dashboard-v6-spec.md §1 restates the shift invariant: a
   segment is either a TASK segment (itemId and task set) or an
   IDLE one (clocked in, nothing running). Everything here reads
   `segs` and answers questions about them; nothing here writes.

   Two rules this file exists to keep:

   1. A task's time is the SUM OF ITS SEGMENTS, found by itemId.
      Never a counter kept beside them - a second copy of a fact
      the segments already carry drifts the first time a save
      fails, and then two screens disagree about somebody's day.

   2. Work with no itemId behaves EXACTLY as it did. The classic
      dashboard's segments carry no item, so clkTaskMs falls back
      to timing the open segment alone, which is what
      taskClockMs() has always done. The new behaviour arrives
      with the new data, not with a flag - one function, one
      answer, decided by what the segment actually is.
   ============================================================ */

const clkOpen = sh => (sh && sh.segs || []).find(s => !s.endedAt) || null;
const clkMs = (s, now) => Math.max(0, (s.endedAt || now) - s.startedAt);

/* Every millisecond spent on one Item in this shift, open segment
   included. */
function clkTaskTotal(sh, itemId, now){
  if (!sh || !itemId) return 0;
  return (sh.segs || []).reduce((t, s) => t + (s.itemId === itemId ? clkMs(s, now) : 0), 0);
}

/* What the TASK CLOCK shows.
   With an item: everything spent on it, so somebody who worked 23
   minutes, switched away and came back reads 23m and counting - which is
   the whole point of coming back to it.
   Without one: the open segment alone, unchanged.
   On a break there is no open segment, so the last one is used and it
   sits frozen, exactly as it does today. */
function clkTaskMs(sh, now){
  if (!sh) return 0;
  const segs = sh.segs || [];
  const seg = clkOpen(sh) || segs[segs.length - 1];
  if (!seg) return 0;
  return seg.itemId ? clkTaskTotal(sh, seg.itemId, now) : clkMs(seg, now);
}

/* The Item the clock is currently on, or null while idle. */
function clkOpenItemId(sh){
  const seg = clkOpen(sh);
  return seg && seg.itemId ? seg.itemId : null;
}

/* Tasks worked in this shift and set down again: closed segments, and
   not the one running now. Newest put-down first, which is the order
   somebody looks for them in.

   It deliberately does NOT know which of them are finished - "done"
   lives on the Item, not in the shift - so the caller filters these
   against the work it is actually showing. A pure function that had to
   read Items would stop being pure and start being a second source of
   truth about what is open. */
function clkPaused(sh, now){
  if (!sh) return [];
  const openId = clkOpenItemId(sh);
  const by = new Map();
  (sh.segs || []).forEach(s => {
    if (!s.itemId || s.itemId === openId) return;
    const cur = by.get(s.itemId) || { itemId: s.itemId, task: s.task, ms: 0, lastAt: 0 };
    cur.ms += clkMs(s, now);
    cur.task = s.task || cur.task;
    cur.lastAt = Math.max(cur.lastAt, s.endedAt || s.startedAt);
    by.set(s.itemId, cur);
  });
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* Is the shift running nothing at all right now? */
const clkIsIdle = sh => { const s = clkOpen(sh); return !!s && !s.itemId; };

if (typeof module !== "undefined" && module.exports){
  module.exports = { clkOpen, clkTaskTotal, clkTaskMs, clkOpenItemId, clkPaused, clkIsIdle };
}
