/* ============================================================
   RENDER
   ============================================================ */
function render(){
  const st = S.status;
  $("band").dataset.s = st;

  // The band's headline is now always WHO you are (with the person glyph in
  // the markup). The store / break reason it used to carry moves down to the
  // status line, so that signal isn't lost - just demoted.
  $("bandMetaName").textContent = S.worker ? S.worker.toUpperCase() : "Not on shift";

  $("shiftMeta").classList.remove("is-ready");
  if (st === "IDLE"){
    $("bandState").textContent = "Clocked out";
    $("shiftMeta").textContent = "Ready";
    $("shiftMeta").classList.add("is-ready");
    $("taskMeta").textContent = "Idle";
  } else if (st === "ACTIVE"){
    const seg = openSeg(S.shift);
    $("bandState").textContent = "Clocked in · " + currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = seg ? seg.task : "Current task";
  } else {
    const b = openBreak(S.shift);
    $("bandState").textContent = "On break · " + (b.reason||"Break").toUpperCase()
      + " · " + currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = "Paused";
  }

  renderDock();
  renderPunches();
  updateDrawerIdentity();
  refreshOpenPage();
  tick();
}

const DOCK_ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>',
  switch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
};

function renderDock(){
  const d = $("dock"); d.innerHTML = "";
  const mk = (label, cls, fn, icon) => {
    const b = document.createElement("button");
    b.className = "btn " + cls;
    b.innerHTML = (icon ? `<span class="btn-icon">${DOCK_ICONS[icon]}</span>` : "") + esc(label);
    b.onclick = fn; return b;
  };

  if (S.status === "IDLE"){
    d.append(mk("Clock in", "btn-go", askClockIn, "clock"));
  } else if (S.status === "ACTIVE"){
    d.append(mk("Switch task", "", askSwitch, "switch"));
    const row = document.createElement("div"); row.className = "row";
    row.append(mk("Pause", "btn-break btn-sm", askPause, "pause"), mk("Clock out", "btn-ghost btn-sm", askWrapUp, "stop"));
    d.append(row);
  } else {
    const last = [...(S.shift.segs||[])].pop();
    d.append(mk("Resume · " + (last ? last.task : "work"), "btn-go", resume, "clock"));
    d.append(mk("Clock out", "btn-ghost btn-sm", askWrapUp, "stop"));
  }
}

/* One shift's punch card as a flat event list - shared by the dashboard
   card and the Daily Mission page's timeline. */
function punchEvents(sh){
  const ev = [];
  ev.push({ t: sh.startedAt, k: "In", cls: "", n: sh.client });
  (sh.segs||[]).forEach((s, i, arr) => {
    if (s.via !== "switch") return;
    // One row per switch: which store, which task - never two rows for
    // the same action, even when the switch also changed the store.
    let store = s.client;
    if (!store) for (let j = i - 1; j >= 0; j--) { if (arr[j].client) { store = arr[j].client; break; } }
    ev.push({ t: s.startedAt, k: store || sh.client, cls: "k-store", n: s.task });
  });
  (sh.breaks||[]).forEach(b => {
    ev.push({ t: b.startedAt, k: "Break", cls: "k-break", n: b.reason });
    if (b.endedAt){
      const back = (sh.segs||[]).find(s => s.via === "resume" && s.startedAt === b.endedAt);
      ev.push({ t: b.endedAt, k: "Resume", cls: "", n: (back ? back.task + " · " : "") + humanDur(b.endedAt - b.startedAt) });
    }
  });
  if (sh.endedAt) ev.push({ t: sh.endedAt, k: "Out", cls: "k-break", n: humanDur(sh.netMs != null ? sh.netMs : netMs(sh, sh.endedAt)) + " net" });
  ev.sort((a,b) => a.t - b.t);
  return ev;
}

function renderPunches(){
  const ul = $("punches"), sh = S.shift;
  ul.innerHTML = "";
  $("empty").style.display = sh ? "none" : "block";
  if (!sh) return;

  punchEvents(sh).forEach(e => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="punch-t">${clock(e.t)}</span>`
      + `<span class="punch-k ${e.cls}">${e.k}</span>`
      + `<span class="punch-n">${esc(e.n || "")}</span>`;
    ul.append(li);
  });
  if (ul.lastElementChild) ul.lastElementChild.classList.add("stamp-in");
}

function setRingTime(id, ms){
  const s = hms(ms), i = s.lastIndexOf(":");
  const el = $(id);
  el.querySelector(".ring-main").textContent = s.slice(0, i);
  el.querySelector(".ring-sec").textContent = s.slice(i + 1);
}

// Rings are a real progress indicator, not decoration: one full clockwise
// lap = one cycle (8h for the shift ring, 1h for the task ring). Once a
// lap completes it stays behind as a dim fill and a fresh bright arc
// starts sweeping from the top again for the next lap.
const SHIFT_CYCLE_MS = 8 * 3600000;
const TASK_CYCLE_MS = 3600000;
function updateRingProgress(ringId, elapsedMs, cycleMs){
  const ring = $(ringId);
  const lapFill = ring.querySelector(".ring-lap-fill");
  const progress = ring.querySelector(".ring-progress");
  const completedLaps = Math.floor(Math.max(0, elapsedMs) / cycleMs);
  const p = (Math.max(0, elapsedMs) % cycleMs) / cycleMs;
  lapFill.classList.toggle("on", completedLaps >= 1);
  if (p < 0.002) { progress.setAttribute("d", ""); return; }
  // r95.5 + the 9-wide stroke lands the ring's outer edge exactly on the 200
  // viewBox, so the drawn circle fills its box. At r86 the svg wasted 14% of
  // its own width, which made the ring read ~11px small against the comp.
  const theta = p * 360, rad = (theta * Math.PI) / 180;
  const x = (100 + 95.5 * Math.sin(rad)).toFixed(2);
  const y = (100 - 95.5 * Math.cos(rad)).toFixed(2);
  progress.setAttribute("d", `M100,4.5 A95.5,95.5 0 ${theta > 180 ? 1 : 0} 1 ${x},${y}`);
}

function tick(){
  const bar = $("shiftbar");
  updateMissionTick();
  pomoTick();
  if (S.status === "IDLE"){
    setRingTime("shiftClock", 0);
    setRingTime("taskClock", 0);
    updateRingProgress("shiftRing", 0, SHIFT_CYCLE_MS);
    updateRingProgress("taskRing", 0, TASK_CYCLE_MS);
    bar.innerHTML = "";
    return;
  }

  const sh = S.shift, now = Date.now();
  const shiftMs = netMs(sh, now);
  const taskMs = taskClockMs(sh, now);

  setRingTime("shiftClock", shiftMs);
  setRingTime("taskClock", taskMs);
  updateRingProgress("shiftRing", shiftMs, SHIFT_CYCLE_MS);
  updateRingProgress("taskRing", taskMs, TASK_CYCLE_MS);

  if (S.status === "ACTIVE"){
    // the task ring above already shows this exact elapsed time - this bar
    // used to repeat it as "Task 46s" text underneath, which was redundant
    bar.innerHTML = "";
  } else {
    bar.innerHTML = `<span>Shift</span> <b>${humanDur(shiftMs)}</b> <span>· paused</span>`;
  }
}

