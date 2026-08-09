/* ============================================================
   OFF-CANVAS DRAWER + ROUTER
   The three features that used to sit in the bottom nav are full pages
   now, reached from the hamburger beside the wordmark. Routes live in the
   hash so the browser's back button and deep links both behave.
   ============================================================ */
const PAGE_IDS = { mission: "missionScreen", history: "historyScreen", campaigns: "campaignsScreen", team: "teamScreen" };

function currentRoute(){
  const h = location.hash.replace(/^#\/?/, "");
  return PAGE_IDS.hasOwnProperty(h) ? h : "";
}
function go(route){ location.hash = "#/" + route; }

let drawerPrevFocus = null;
function openDrawer(){
  drawerPrevFocus = document.activeElement;
  $("drawer").classList.add("on");
  $("drawerScrim").classList.add("on");
  $("menuBtn").setAttribute("aria-expanded", "true");
  const active = $("drawer").querySelector(".drawer-item.active") || $("drawer").querySelector(".drawer-item");
  if (active) active.focus();
}
function closeDrawer(){
  if (!$("drawer").classList.contains("on")) return;
  $("drawer").classList.remove("on");
  $("drawerScrim").classList.remove("on");
  $("menuBtn").setAttribute("aria-expanded", "false");
  if (drawerPrevFocus && drawerPrevFocus.focus) drawerPrevFocus.focus();
  drawerPrevFocus = null;
}

$("menuBtn").onclick = openDrawer;
$("drawerClose").onclick = closeDrawer;
$("drawerScrim").onclick = closeDrawer;
$("drawerProfile").onclick = () => { closeDrawer(); showProfile(); };
$("drawerSignOut").onclick = () => { closeDrawer(); if (auth) auth.signOut(); };
// clicking the route you are already on changes nothing in the hash, so the
// drawer has to dismiss itself
document.querySelectorAll(".drawer-item").forEach(a => {
  a.addEventListener("click", () => { if ((a.dataset.route || "") === currentRoute()) closeDrawer(); });
});
// Dashboard is a reset, not just a route: it always lands on a clean home
// screen - open sheet dismissed, expanded side pane collapsed - even when
// the hash is already "#/" and no hashchange will fire.
document.querySelector('.drawer-item[data-route=""]').addEventListener("click", () => {
  if (sheetIsOpen() && sheetDismissible) closeSheet();
  if ($("appScreen").classList.contains("side-open")) setSidePaneOpen(false);
  go("");
});
// roving arrows inside the drawer, Raycast-style
$("drawer").addEventListener("keydown", e => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = [...$("drawer").querySelectorAll(".drawer-item:not(.hidden)")];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const next = e.key === "Home" ? items[0]
    : e.key === "End" ? items[items.length - 1]
    : e.key === "ArrowDown" ? (items[i + 1] || items[0])
    : (items[i - 1] || items[items.length - 1]);
  next.focus();
});

function updateDrawerIdentity(){
  const email = (auth && auth.currentUser && auth.currentUser.email) || "";
  const name = S.worker || (email ? email.split("@")[0] : "") || "Not signed in";
  $("drawerName").textContent = name;
  $("drawerMail").textContent = email;
  const avatar = $("drawerAvatar");
  avatar.classList.toggle("has-photo", !!userPhoto);
  avatar.style.backgroundImage = userPhoto ? `url("${userPhoto}")` : "";
  avatar.textContent = userPhoto ? "" : ((S.worker || email || "·").trim().charAt(0).toUpperCase() || "·");
}

/* Keyboard: 1-5 jump straight to a page (guarded away from inputs and open
   sheets), Esc closes the drawer or walks a page back to the dashboard. */
document.addEventListener("keydown", e => {
  if ($("appScreen").classList.contains("hidden")) return;
  if (e.key === "Escape"){
    // innermost layer first, one layer per press: a dropdown that already
    // handled its own Esc (preventDefault) stops the ladder here
    if (e.defaultPrevented) return;
    const pdropOpen = document.querySelector(".pdrop .af-panel:not([hidden])");
    if ($("drawer").classList.contains("on")) { closeDrawer(); e.preventDefault(); }
    else if (pdropOpen) { pomoDropCloseAll(); e.preventDefault(); }
    else if (sheetIsOpen()) { if (sheetDismissible) closeSheet(); e.preventDefault(); }
    else if (currentRoute()) { go(""); e.preventDefault(); }
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if ($("sheet").classList.contains("on")) return;
  const map = { "1": "", "2": "mission", "3": "history", "4": "campaigns", "5": "team" };
  if (!(e.key in map)) return;
  const r = map[e.key];
  if (r === "team" && !isAdmin) return;
  if (r === "history" && isAdmin) return;
  go(r);
});

function applyRoute(){
  let r = currentRoute();
  // role guards: a deep link to a page you can't use lands on the dashboard.
  // History is personal, so it's everyone's page EXCEPT admin's - their own
  // record lives inside Team's History section instead.
  if ((r === "team" && !isAdmin) || (r === "history" && isAdmin)) { r = ""; if (location.hash) location.replace("#/"); }
  Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.toggle("hidden", k !== r));
  document.querySelectorAll(".drawer-item").forEach(a =>
    a.classList.toggle("active", (a.dataset.route || "") === r));
  closeDrawer();
  if (r === "mission") renderMissionPage();
  else if (r === "history") renderHistoryPage();
  else if (r === "campaigns") enterCampaignsPage();
  else if (r === "team") loadTeamScreen();
}
window.addEventListener("hashchange", applyRoute);
document.querySelectorAll("[data-back]").forEach(b => b.onclick = () => go(""));

/* Sub-pages behave like modals: a click on the empty gutter AROUND the
   page's content column walks back to the dashboard, same as Back or Esc.
   Bound once at boot (no per-open listeners to leak); e.target === page
   is only ever true for the gutter, never for anything inside the column. */
Object.keys(PAGE_IDS).forEach(k => {
  const el = $(PAGE_IDS[k]);
  if (el) el.addEventListener("click", e => { if (e.target === el) go(""); });
});

// re-render whichever page is open when the shift state changes underneath it
function refreshOpenPage(){
  const r = currentRoute();
  if (r === "mission" && !$("missionScreen").classList.contains("hidden")) renderMissionPage();
  else if (r === "history" && !$("historyScreen").classList.contains("hidden")) renderHistoryPage();
}

/* ============================================================
   DAILY MISSION PAGE — today's shift as a full tool: live status,
   contextual controls, headline numbers, per-task time, timeline.
   ============================================================ */
const todaysClosedShifts = () => {
  const key = dayStamp(Date.now());
  return S.history.filter(r => dayStamp(r.startedAt) === key);
};

function missionModel(){
  const now = Date.now();
  const closed = todaysClosedShifts();
  const live = (S.shift && S.status !== "IDLE") ? S.shift : null;
  const all = live ? closed.concat([live]) : closed.slice();
  let net = closed.reduce((t, r) => t + r.netMs, 0);
  let brk = closed.reduce((t, r) => t + (r.breakMs || 0), 0);
  if (live) { net += netMs(live, now); brk += breakMs(live, now); }
  const tally = new Map();
  const stores = new Set();
  all.forEach(r => {
    taskTally(r, r.endedAt || now).forEach(t => {
      stores.add(t.store);
      const cur = tally.get(t.store + "\n" + t.task) || { store: t.store, task: t.task, ms: 0 };
      cur.ms += t.ms;
      tally.set(t.store + "\n" + t.task, cur);
    });
  });
  return { closed, live, all, net, brk,
    tally: [...tally.values()].sort((a, b) => b.ms - a.ms), stores: [...stores] };
}

const MISSION_STATE = {
  IDLE:     { cls: "", label: "Clocked out" },
  ACTIVE:   { cls: "is-active", label: "On shift" },
  ON_BREAK: { cls: "is-break", label: "On break" }
};

function missionActionsHTML(){
  if (S.status === "IDLE")
    return `<button class="btn btn-go btn-sm" id="msClockIn">Clock in</button>`;
  if (S.status === "ACTIVE")
    return `<button class="btn btn-sm" id="msSwitch">Switch task</button>
            <button class="btn btn-break btn-sm" id="msPause">Pause</button>
            <button class="btn btn-ghost btn-sm" id="msOut">Clock out</button>`;
  const last = [...(S.shift.segs || [])].pop();
  return `<button class="btn btn-go btn-sm" id="msResume">Resume · ${esc(last ? last.task : "work")}</button>
          <button class="btn btn-ghost btn-sm" id="msOut">Clock out</button>`;
}

function renderMissionPage(){
  const box = $("missionBody");
  if (!box) return;
  const m = missionModel();
  const st = MISSION_STATE[S.status] || MISSION_STATE.IDLE;
  $("missionDate").textContent = "Today · " + dayStamp(Date.now());

  const seg = S.shift ? openSeg(S.shift) : null;
  const statusNote = S.status === "ACTIVE"
    ? `Working <b>${esc(seg ? seg.task : "")}</b> at ${esc(currentStore(S.shift).toUpperCase())}`
    : S.status === "ON_BREAK"
      ? `Paused · ${esc((openBreak(S.shift) || {}).reason || "Break")}`
      : m.closed.length ? "Done for now — today's record below." : "Not on shift yet.";

  if (!m.all.length){
    box.innerHTML = `
      <div class="fpage-bar">
        <span class="fpage-status ${st.cls}">${st.label}</span>
        <div class="fpage-bar-acts">${missionActionsHTML()}</div>
      </div>
      <div class="fpage-panel">
        <div class="empty">
          <span class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="12" height="17" rx="2"/><path d="M8.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><circle cx="18" cy="16" r="4.2" fill="#33333a"/><path d="M18 14.2V16l1.1 1"/></svg>
          </span>
          Nothing on the card yet. Clock in and today's mission builds itself here.
        </div>
      </div>`;
    wireMissionActions();
    return;
  }

  const maxMs = m.tally.length ? m.tally[0].ms : 1;
  const shiftsHTML = m.all.map((sh, i) => {
    const isLive = !sh.endedAt;
    const label = m.all.length > 1
      ? `Shift ${i + 1}${isLive ? " · live" : ""}`
      : (isLive ? "Live shift" : "Shift");
    return `
      <p class="hx-day">${label} · in ${clock(sh.startedAt)}${sh.endedAt ? ` · out ${clock(sh.endedAt)}` : ""}</p>
      <ul class="punches">
        ${punchEvents(sh).map(e => `
          <li><span class="punch-t">${clock(e.t)}</span>
              <span class="punch-k ${e.cls}">${esc(e.k)}</span>
              <span class="punch-n">${esc(e.n || "")}</span></li>`).join("")}
      </ul>`;
  }).join("");

  box.innerHTML = `
    <div class="fpage-bar">
      <div>
        <span class="fpage-status ${st.cls}">${st.label}</span>
        <p class="fpage-bar-note" style="margin-top:8px">${statusNote}</p>
      </div>
      <div class="fpage-bar-acts">${missionActionsHTML()}</div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile"><p class="stat-tile-label">Net worked</p><p class="stat-tile-value" id="msNet">${humanDur(m.net)}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">On break</p><p class="stat-tile-value" id="msBreak">${m.brk ? humanDur(m.brk) : "—"}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Tasks touched</p><p class="stat-tile-value">${m.tally.length}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Stores</p><p class="stat-tile-value">${m.stores.length}</p>
        ${m.stores.length ? `<p class="stat-tile-sub">${esc(m.stores.join(", "))}</p>` : ""}</div>
    </div>

    ${m.tally.length ? `
    <div class="fpage-panel">
      <p class="fpage-section-title">Where the time went</p>
      ${m.tally.map(t => `
        <div class="tbar-row">
          <span class="tbar-name" title="${esc(t.store)} · ${esc(t.task)}">${esc(t.store)} · ${esc(t.task)}</span>
          <span class="tbar-track"><span class="tbar-fill" style="width:${Math.max(3, Math.round(t.ms / maxMs * 100))}%"></span></span>
          <span class="tbar-ms">${humanDur(t.ms)}</span>
        </div>`).join("")}
    </div>` : ""}

    <div class="fpage-panel">
      <p class="fpage-section-title">Timeline</p>
      ${shiftsHTML}
    </div>`;
  wireMissionActions();
}

function wireMissionActions(){
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on("msClockIn", askClockIn);
  on("msSwitch", askSwitch);
  on("msPause", askPause);
  on("msResume", resume);
  on("msOut", askWrapUp);
}

// the per-second heartbeat only touches the two numbers that move
function updateMissionTick(){
  if ($("missionScreen").classList.contains("hidden")) return;
  const netEl = $("msNet"), brkEl = $("msBreak");
  if (!netEl) return;
  const m = missionModel();
  netEl.textContent = humanDur(m.net);
  if (brkEl) brkEl.textContent = m.brk ? humanDur(m.brk) : "—";
}

/* ============================================================
   HISTORY PAGE — every closed shift, filterable, each one expandable
   into the full story, with the Excel export alongside. Also the one
   place for "how's the team doing": headline KPI tiles (two carrying a
   trend sparkline), and - for an admin - a sortable by-member
   breakdown, all driven by the exact same filtered rows as the shift
   list below them. There used to be a separate Summary page computing
   its own overlapping monthly totals off a second fetch of the same
   appState collection; folding it in here means one filter (these range
   chips + search), one fetch, one place these numbers can disagree.
   Defaults to TODAY's shifts. Personal only - the admin's whole-team
   view of this same appState collection lives in Team's own History
   section instead (js/team.js). That section reuses this file's
   stateless helpers (sparklineSvg, hxMonthKey) but keeps its own filter
   state, since "the whole team" and "my own record" are different
   enough views to want independent controls rather than sharing one.
   ============================================================ */
let hxRange = "today"; // today | all | 7 | 30 | custom — survives leaving the page
let hxQuery = "";
let hxStart = "", hxEnd = "";   // the custom range's calendar bounds
let hxStartTime = "00:00", hxEndTime = "23:59";
let hxOpenKeys = new Set();

// uid disambiguates two members clocking in at the same millisecond
const hxKey = r => (r.uid ? r.uid + ":" : "") + r.startedAt;
const hxRows = () => S.history;

function hxFiltered(){
  const q = hxQuery.trim().toLowerCase();
  let rows = hxRows();
  if (hxRange === "today"){
    const key = dayStamp(Date.now());
    rows = rows.filter(r => dayStamp(r.startedAt) === key);
  } else if (hxRange === "custom"){
    rows = summaryFilterRows(rows,
      hxStart ? hxStart + "T" + (hxStartTime || "00:00") : "",
      hxEnd ? hxEnd + "T" + (hxEndTime || "23:59") : "");
  } else if (hxRange !== "all"){
    const cut = Date.now() - Number(hxRange) * 86400000;
    rows = rows.filter(r => r.startedAt >= cut);
  }
  if (!q) return rows;
  return rows.filter(r => {
    const hay = [r.client, r.note, ...taskTally(r, r.endedAt).map(t => t.store + " " + t.task)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

// what the current filter means as words, for the email subject/header
function hxRangeLabel(){
  if (hxRange === "today") return "Today";
  if (hxRange === "7") return "Last 7 days";
  if (hxRange === "30") return "Last 30 days";
  if (hxRange === "custom") return summaryRangeLabel(hxStart, hxEnd);
  return "All time";
}

/* One point per bucket of the active filter, for the two KPI sparklines -
   granularity follows the range so "last 7 days" gets 7 daily points and
   "all time" gets one per month, never an unreadable pile of points.
   "Today" has nothing to trend against a single day, so it gets none.
   hxMonthKey and sparklineSvg below are pure - Team's History section
   (js/team.js) reuses both directly rather than redefining them. */
function hxMonthKey(ts){ const d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function hxSeries(rows){
  if (hxRange === "today" || !rows.length) return null;
  let keyOf, order;
  if (hxRange === "7" || hxRange === "30"){
    const days = Number(hxRange);
    keyOf = r => dayStamp(r.startedAt);
    order = Array.from({ length: days }, (_, i) => dayStamp(Date.now() - (days - 1 - i) * 86400000));
  } else if (hxRange === "custom" && hxStart && hxEnd){
    const spanDays = Math.round((new Date(hxEnd) - new Date(hxStart)) / 86400000) + 1;
    if (spanDays > 0 && spanDays <= 60){
      keyOf = r => dayStamp(r.startedAt);
      order = Array.from({ length: spanDays }, (_, i) => dayStamp(new Date(hxStart).getTime() + i * 86400000));
    } else {
      keyOf = r => hxMonthKey(r.startedAt);
      order = [...new Set(rows.map(keyOf))].sort();
    }
  } else {
    keyOf = r => hxMonthKey(r.startedAt);
    order = [...new Set(rows.map(keyOf))].sort();
  }
  if (order.length < 2) return null;
  const byKey = new Map();
  rows.forEach(r => {
    const k = keyOf(r);
    const cur = byKey.get(k) || { ms: 0, shifts: 0 };
    cur.ms += r.netMs; cur.shifts += 1;
    byKey.set(k, cur);
  });
  return order.map(k => byKey.get(k) || { ms: 0, shifts: 0 });
}

/* A tiny inline trend line for a stat tile - not the full interactive
   chart the same series would get as a standalone plot, just a shape
   that answers "is this a normal period". One hue (the app's own mint
   accent), a soft fill under the line, and the value spelled out as a
   native-tooltip title since there's no room here for a real hover
   layer. */
function sparklineSvg(values, title){
  const width = 120, height = 32;
  const max = Math.max(1, ...values);
  const n = values.length;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const pts = values.map((v, i) => [
    n > 1 ? i * stepX : width / 2,
    height - 2 - (v / max) * (height - 4)
  ]);
  const line = pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1)).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = pts[pts.length - 1] || [width, height];
  return `
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">
      <title>${esc(title)}</title>
      <path class="spark-area" d="${area}"></path>
      <path class="spark-line" d="${line}"></path>
      <circle class="spark-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6"></circle>
    </svg>`;
}

/* ---------- reusable inline calendar range-picker ----------
   Swaps in for a pair of native <input type=date> fields - the OS-native
   picker is a plain white/light popup that looks jarring dropped into a
   dark, custom-styled sheet (the same reason type=date got its own
   color-scheme:dark treatment elsewhere; a full replacement reads better
   than fighting the native chrome's styling limits). Two clicks pick a
   range: first click sets the start (clearing any existing end), the
   next sets the end - clicking before the current start restarts it
   rather than producing a backwards range. get/set are passed in rather
   than hardcoded to one page's state, so the same calendar drives both
   Team's and this page's own History range without duplicating it.
   viewKey just needs to be unique per calendar on screen, so flipping
   months on one doesn't affect another. Lives here (not team.js) since
   Team's History section already reuses this file's other stateless
   history helpers (sparklineSvg, hxMonthKey) the same way. */
let calViewMonth = {};
function calRangeRender(containerId, opts){
  const { getStart, getEnd, onPick, viewKey } = opts;
  const box = $(containerId);
  if (!box) return;
  const start = getStart(), end = getEnd();
  if (calViewMonth[viewKey] === undefined){
    const base = start ? new Date(start + "T00:00") : new Date();
    calViewMonth[viewKey] = base.getFullYear() * 12 + base.getMonth();
  }
  const vm = calViewMonth[viewKey];
  const year = Math.floor(vm / 12), month = ((vm % 12) + 12) % 12;
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const todayISO = summaryISO(Date.now());
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

  const cells = [];
  for (let i = 0; i < startWeekday; i++){
    const d = daysInPrevMonth - startWeekday + 1 + i;
    cells.push({ iso: iso(month === 0 ? year - 1 : year, (month + 11) % 12, d), d, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ iso: iso(year, month, d), d, other: false });
  let nextD = 1;
  while (cells.length % 7 !== 0) cells.push({ iso: iso(month === 11 ? year + 1 : year, (month + 1) % 12, nextD), d: nextD++, other: true });

  const inRange = i => start && end && i > start && i < end;
  const hint = !start ? "Pick a start date" : !end ? "Pick an end date" : "";

  box.innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" id="${containerId}Prev" aria-label="Previous month">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="cal-month">${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
      <button type="button" class="cal-nav" id="${containerId}Next" aria-label="Next month">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
    <div class="cal-dow">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span>${d}</span>`).join("")}</div>
    <div class="cal-grid">
      ${cells.map(c => `<button type="button" class="cal-day${c.other ? " is-other" : ""}${c.iso === todayISO ? " is-today" : ""}${c.iso === start ? " is-start" : ""}${c.iso === end ? " is-end" : ""}${inRange(c.iso) ? " is-in-range" : ""}" data-iso="${c.iso}">${c.d}</button>`).join("")}
    </div>
    ${hint ? `<p class="cal-hint">${hint}</p>` : ""}`;

  $(containerId + "Prev").onclick = () => { calViewMonth[viewKey]--; calRangeRender(containerId, opts); };
  $(containerId + "Next").onclick = () => { calViewMonth[viewKey]++; calRangeRender(containerId, opts); };
  box.querySelectorAll(".cal-day").forEach(btn => {
    btn.onclick = () => {
      const picked = btn.dataset.iso;
      const s = getStart(), e = getEnd();
      if (!s || (s && e) || picked < s) onPick(picked, "");
      else onPick(s, picked);
      calRangeRender(containerId, opts);
    };
  });
}

/* Optional companion to calRangeRender: two <input type=time> once a start
   date exists, refining the picked days down to an exact moment instead
   of defaulting to midnight-through-midnight. Kept separate from the
   calendar itself rather than folded in - most ranges only ever needed
   day precision, so a caller that doesn't want time inputs just never
   renders this container. */
function calTimeRowRender(containerId, opts){
  const { hasStart, getStartTime, getEndTime, onStartTime, onEndTime } = opts;
  const box = $(containerId);
  if (!box) return;
  if (!hasStart()){ box.innerHTML = ""; return; }
  box.innerHTML = `
    <label>Start time <input type="time" id="${containerId}Start" value="${esc(getStartTime())}"></label>
    <label>End time <input type="time" id="${containerId}End" value="${esc(getEndTime())}"></label>`;
  $(containerId + "Start").onchange = e => onStartTime(e.target.value || "00:00");
  $(containerId + "End").onchange = e => onEndTime(e.target.value || "23:59");
}

function renderHistoryPage(){
  const box = $("historyBody");
  if (!box) return;

  if (!hxRows().length){
    box.innerHTML = `
      <div class="fpage-panel">
        <div class="empty">
          <span class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.8"/><path d="M9 2h6"/></svg>
          </span>
          No closed shifts yet. Your first clock-out lands here, ready to export.
        </div>
      </div>`;
    return;
  }

  box.innerHTML = `
    <div id="hxStats"></div>
    <div class="fpage-filters">
      <button type="button" class="chip" data-range="today">Today</button>
      <button type="button" class="chip" data-range="7">Last 7 days</button>
      <button type="button" class="chip" data-range="30">Last 30 days</button>
      <button type="button" class="chip" data-range="all">All time</button>
      <button type="button" class="chip" data-range="custom">Custom…</button>
      <label class="fpage-search"><input type="text" id="hxSearch" placeholder="Search store, task or note…" value="${esc(hxQuery)}" autocomplete="off"></label>
    </div>
    <div class="fpage-dates${hxRange === "custom" ? "" : " hidden"}" id="hxDates">
      <div class="cal-picker" id="hxCal"></div>
      <div class="cal-time-row" id="hxTimeRow"></div>
    </div>
    <div id="hxList"></div>`;

  box.querySelectorAll(".chip[data-range]").forEach(c => {
    c.setAttribute("aria-pressed", String(c.dataset.range === hxRange));
    c.onclick = () => {
      hxRange = c.dataset.range;
      renderHistoryPage();
    };
  });
  const search = $("hxSearch");
  search.oninput = () => { hxQuery = search.value; renderHistoryList(); };
  if (hxRange === "custom"){
    const renderHxTimeRow = () => calTimeRowRender("hxTimeRow", {
      hasStart: () => !!hxStart,
      getStartTime: () => hxStartTime, getEndTime: () => hxEndTime,
      onStartTime: v => { hxStartTime = v; renderHistoryList(); },
      onEndTime: v => { hxEndTime = v; renderHistoryList(); }
    });
    calRangeRender("hxCal", {
      getStart: () => hxStart, getEnd: () => hxEnd,
      onPick: (s, e) => { hxStart = s; hxEnd = e; renderHistoryList(); renderHxTimeRow(); },
      viewKey: "hx"
    });
    renderHxTimeRow();
  }
  renderHistoryList();
}

function renderHistoryList(){
  const rows = hxFiltered();
  const stats = $("hxStats"), list = $("hxList");
  if (!stats || !list) return;

  const total = rows.reduce((t, r) => t + r.netMs, 0);
  const rated = rows.filter(r => r.rating);
  const avgRating = rated.length ? (rated.reduce((t, r) => t + r.rating, 0) / rated.length).toFixed(1) : null;
  const series = hxSeries(rows);
  const rangeWords = hxRangeLabel();
  stats.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile">
        <p class="stat-tile-label">Shifts</p><p class="stat-tile-value">${rows.length}</p>
        ${series ? `<div class="stat-tile-spark">${sparklineSvg(series.map(d => d.shifts), `Shifts across ${rangeWords}`)}</div>` : ""}
      </div>
      <div class="stat-tile">
        <p class="stat-tile-label">Net worked</p><p class="stat-tile-value">${humanDur(total)}</p>
        ${series ? `<div class="stat-tile-spark">${sparklineSvg(series.map(d => d.ms / 3600000), `Hours across ${rangeWords}`)}</div>` : ""}
      </div>
      <div class="stat-tile"><p class="stat-tile-label">Avg shift</p><p class="stat-tile-value">${rows.length ? humanDur(total / rows.length) : "—"}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Avg rating</p><p class="stat-tile-value">${avgRating ? avgRating + `<small>/ 5</small>` : "—"}</p></div>
    </div>
    <div class="fpage-bar">
      <p class="fpage-bar-note">${rows.length} shift${rows.length === 1 ? "" : "s"} shown${hxRange !== "all" || hxQuery ? " · filtered" : ""}</p>
      <div class="fpage-bar-acts">
        <button class="btn btn-go btn-sm" id="hxEmail" ${rows.length ? "" : "disabled"}>Email my summary</button>
      </div>
    </div>`;
  const em = $("hxEmail");
  if (em) em.onclick = async () => {
    const me = (auth && auth.currentUser && auth.currentUser.email) || "";
    if (!me){ toast("No email on this account"); return; }
    const btn = $("hxEmail");
    btn.disabled = true; btn.textContent = "Sending…";
    // the email is exactly what the page shows: same range, same search
    await queueSummaryEmail({ to: me, name: S.worker || me, rows: hxFiltered(), rangeLabel: hxRangeLabel() });
    btn.disabled = false; btn.textContent = "Email my summary";
  };

  if (!rows.length){
    list.innerHTML = `<div class="fpage-panel"><div class="empty">Nothing matches this filter. Widen the range or clear the search.</div></div>`;
    return;
  }

  const sorted = [...rows].sort((a, b) => b.startedAt - a.startedAt);
  let lastDay = null, html = `<ul class="hx-list">`;
  sorted.forEach(r => {
    const day = dayStamp(r.startedAt);
    if (day !== lastDay){ html += `</ul><p class="hx-day">${day}</p><ul class="hx-list">`; lastDay = day; }
    const tally = taskTally(r, r.endedAt);
    const open = hxOpenKeys.has(hxKey(r));
    const maxMs = tally.length ? tally[0].ms : 1;
    html += `
      <li class="hx-row${open ? " is-open" : ""}" data-k="${esc(hxKey(r))}">
        <button type="button" class="hx-head" aria-expanded="${open}">
          <span class="hx-when"><span class="hx-date">${day}</span>
            <span class="hx-clock">${clock(r.startedAt)}–${clock(r.endedAt)}</span></span>
          <span class="hx-mid"><span class="hx-store">${esc(r.client)}</span>
            <span class="hx-meta">${tally.length} task${tally.length === 1 ? "" : "s"} · ${r.breakMs ? humanDur(r.breakMs) + " break · " : ""}${r.rating}/5</span></span>
          <span class="hx-net">${humanDur(r.netMs)}</span>
          <svg class="hx-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="hx-body">
          ${tally.length ? `<p class="fpage-section-title">Tasks</p>` + tally.map(t => `
            <div class="tbar-row">
              <span class="tbar-name" title="${esc(t.store)} · ${esc(t.task)}">${esc(t.store)} · ${esc(t.task)}</span>
              <span class="tbar-track"><span class="tbar-fill" style="width:${Math.max(3, Math.round(t.ms / maxMs * 100))}%"></span></span>
              <span class="tbar-ms">${humanDur(t.ms)}</span>
            </div>`).join("") : ""}
          <p class="fpage-section-title">Timeline</p>
          <ul class="punches">
            ${punchEvents(r).map(e => `
              <li><span class="punch-t">${clock(e.t)}</span>
                  <span class="punch-k ${e.cls}">${esc(e.k)}</span>
                  <span class="punch-n">${esc(e.n || "")}</span></li>`).join("")}
          </ul>
          <p class="fpage-section-title">Rating</p>
          <p class="hx-stars">${"★".repeat(Math.max(0, Math.min(5, r.rating || 0)))}${"☆".repeat(5 - Math.max(0, Math.min(5, r.rating || 0)))}</p>
          ${r.note ? `<p class="fpage-section-title">Note</p><p class="hx-note">${esc(r.note)}</p>` : ""}
          <div class="hx-acts">
            <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(hxKey(r))}">Copy report</button>
          </div>
        </div>
      </li>`;
  });
  html += `</ul>`;
  list.innerHTML = html;

  list.querySelectorAll(".hx-head").forEach(b => b.onclick = () => {
    const row = b.closest(".hx-row"), k = row.dataset.k;
    const open = row.classList.toggle("is-open");
    b.setAttribute("aria-expanded", String(open));
    if (open) hxOpenKeys.add(k); else hxOpenKeys.delete(k);
  });
  list.querySelectorAll("button[data-copy]").forEach(b => b.onclick = async () => {
    const r = hxRows().find(x => hxKey(x) === b.dataset.copy);
    if (!r) return;
    toast(await copyText(reportText(r)) ? "Report copied" : "Copy failed");
  });
}

