/* ============================================================
   AUTH + ADMIN
   ============================================================ */
function screen(show){
  $("loginScreen").classList.toggle("hidden", show !== "login");
  $("verifyScreen").classList.toggle("hidden", show !== "verify");
  $("pendingScreen").classList.toggle("hidden", show !== "pending");
  $("appScreen").classList.toggle("hidden", show !== "app");
}

async function loadTeamPending(){
  const pending = $("teamPending");
  if (!pending) return;
  pending.innerHTML = "";
  // The heading sits *beside* the <ul>, not inside it, so emptying the list
  // above leaves it behind - drop any copy from a previous open or this
  // function would stack a new "Pending approval" line on every Team visit.
  const oldHint = $("teamPendingHint");
  if (oldHint) oldHint.remove();
  try {
    const snap = await db.collection("users").where("role", "==", "pending").get();
    if (snap.empty) return;
    pending.insertAdjacentHTML("beforebegin", `<p class="hint" id="teamPendingHint" style="margin:0 0 10px">Pending approval</p>`);
    snap.forEach(doc => {
      const data = doc.data();
      const li = document.createElement("li");
      li.innerHTML = `
        <div><div class="h-c">${esc(data.email || "Unknown")}</div><div class="h-d">Waiting for approval</div></div>
        <button class="btn btn-go btn-sm" style="width:auto" id="approve-${doc.id}">Approve</button>
      `;
      pending.append(li);
      $("approve-" + doc.id).onclick = async (e) => {
        e.stopPropagation();
        await db.collection("users").doc(doc.id).update({ role: "worker" });
        toast(data.email + " approved");
        loadTeamPending();
      };
    });
  } catch (e) {
    console.error(e);
  }
}

/* Feeds the Team page's today table. Team's own History section below
   reads the same appState collection independently (teamHistoryRows/
   loadTeamHistoryRows) - it needs a flat per-shift list rather than
   these per-member docs, so it isn't worth sharing the fetch. */
let teamPageDocs = null;
async function loadTeamData(){
  const today = $("teamToday");
  if (!today) return;
  today.innerHTML = `<p class="hint">Loading today's work…</p>`;
  try {
    const snap = await db.collection("appState").get();
    const docs = [];
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (s) docs.push({ id: doc.id, raw: data, state: s });
    });
    teamPageDocs = docs;
    renderTodaysWork(docs);
    backfillDirectoryFrom(docs);   // keep every teammate @-mentionable
  } catch (e) {
    console.error(e);
    today.innerHTML = `<div class="empty">Couldn't load team data — check Firestore rules allow admin reads.</div>`;
  }
}

/* What one person did today: closed shifts that started today, plus the open
   one if it also started today. An open shift from yesterday is deliberately
   excluded - counting its full elapsed time as "today" is what made the old
   roster figures drift upward overnight. */
function todaysWorkFor(s, now = Date.now()){
  const key = dayStamp(now);
  const closed = (s.history || []).filter(r => dayStamp(r.startedAt) === key);
  const live = (s.shift && s.status !== "IDLE" && dayStamp(s.shift.startedAt) === key) ? s.shift : null;
  if (!closed.length && !live) return null;

  const all = live ? closed.concat([live]) : closed;
  let net = closed.reduce((t, r) => t + r.netMs, 0);
  let brk = closed.reduce((t, r) => t + (r.breakMs || 0), 0);
  if (live) { net += netMs(live, now); brk += breakMs(live, now); }

  const tasks = new Map(), stores = new Set();
  all.forEach(r => {
    let store = r.client;
    if (store) stores.add(store);
    (r.segs || []).forEach(sg => {
      if (sg.client) { store = sg.client; stores.add(store); }
      if (sg.task) tasks.set(sg.task, (tasks.get(sg.task) || 0) + segMs(sg, now));
    });
  });

  return {
    net, brk,
    firstIn: Math.min(...all.map(r => r.startedAt)),
    lastOut: closed.length && !live ? Math.max(...closed.map(r => r.endedAt)) : null,
    shifts: all.length,
    state: live ? (s.status === "ON_BREAK" ? "break" : "active") : "done",
    stores: [...stores],
    tasks: [...tasks.entries()].sort((a, b) => b[1] - a[1]).map(([task, ms]) => ({ task, ms }))
  };
}

const WORK_STATE = { active: "On shift", break: "On break", done: "Clocked out" };

function renderTodaysWork(docs){
  const box = $("teamToday");
  if (!box) return;
  const now = Date.now();
  const rows = docs
    .map(d => ({ name: d.state.worker || d.raw.email || "Unnamed", work: todaysWorkFor(d.state, now) }))
    .filter(r => r.work);

  if (!rows.length){
    box.innerHTML = `
      <p class="hint" style="margin-bottom:8px">Today's work</p>
      <p class="work-none">Nobody has clocked in today.</p>`;
    return;
  }
  // on shift first, then whoever has put in the most time
  const rank = { active: 0, break: 1, done: 2 };
  rows.sort((a, b) => (rank[a.work.state] - rank[b.work.state]) || (b.work.net - a.work.net));

  const totalNet = rows.reduce((t, r) => t + r.work.net, 0);
  const onNow = rows.filter(r => r.work.state !== "done").length;

  box.innerHTML = `
    <div class="work-head">
      <p class="hint" style="margin:0">Today's work
        ${canAssignTasks ? `<button type="button" class="panel-menu head-assign" id="twAssign" aria-label="Assign task" title="Assign task" style="vertical-align:middle;margin-left:6px">${ASSIGN_ICON_SVG}</button>` : ""}
      </p>
      <p class="work-sum">${rows.length} on the clock today · <b>${humanDur(totalNet)}</b> net${onNow ? ` · ${onNow} still on shift` : ""}</p>
    </div>
    <div class="table-card">
      <table class="assign-table work-table">
        <thead><tr>
          <th>Member</th><th>Status</th><th>In</th><th>Out</th><th>Stores</th><th>Tasks</th><th>Break</th><th>Worked</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const w = r.work;
            return `<tr>
              <td data-label="Member" class="work-name">${esc(r.name)}</td>
              <td data-label="Status" class="nowrap"><span class="work-status is-${w.state}">${WORK_STATE[w.state]}</span></td>
              <td data-label="In" class="nowrap">${clock(w.firstIn)}</td>
              <td data-label="Out" class="nowrap">${w.lastOut ? clock(w.lastOut) : "—"}</td>
              <td data-label="Stores">${w.stores.length
                ? w.stores.map(st => `<span class="work-chip">${esc(st)}</span>`).join("")
                : "—"}</td>
              <td data-label="Tasks">${w.tasks.length
                ? w.tasks.map(t => `<span class="work-task">${esc(t.task)} <b>${humanDur(t.ms)}</b></span>`).join("")
                : "—"}</td>
              <td data-label="Break" class="nowrap">${w.brk ? humanDur(w.brk) : "—"}</td>
              <td data-label="Worked" class="work-net">${humanDur(w.net)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
  const tw = $("twAssign");
  if (tw) tw.onclick = () => openAssignFlow();
}

// the quick-assign glyph that rides on section headers
const ASSIGN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.6"/><path d="M3.5 20.5c0-3.5 2.9-6 6.5-6 .9 0 1.8.16 2.6.45"/><path d="M17.5 14.5v6M14.5 17.5h6"/></svg>';

// Team is a full page (not a sheet) - admin gets the whole viewport to
// work with instead of a small bottom sheet. It routes like the other
// pages so back buttons and deep links behave; the router calls the loader.
function showTeam(){ go("team"); }
function loadTeamScreen(){
  $("teamPageClose").onclick = () => go("");
  loadTeamPending();
  loadTeamData();
  ackCompletedAssignments(); // clears the notification badge; log below stays regardless
  loadCompletionLog(true, $("teamRecentlyDone"));
  teamHistoryRows = null;   // fresh fetch every visit, same as the rest of this page
  renderTeamHistorySection();
}

/* The `assignments` collection, fetched once and shared everywhere it's
   needed - Team's status cards, the desktop Team pane, the Assign page's
   log, and the "who's already loaded" counts in its Who dropdown - instead
   of each of those independently re-pulling the whole collection. Callers
   keep their own try/catch around fetchAssignRows() since each reacts to a
   failed fetch differently (an inline error message here, a silently empty
   pane there). */
let assignRows = null;
async function fetchAssignRows(){
  const snap = await db.collection("assignments").get();
  const rows = [];
  // keep the doc id - the row's Delete button needs something to act on
  snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  assignRows = rows;
  return rows;
}

// Team's status cards - who has what open, overdue, or done. Fetched once
// per Team-page visit; loadCompletionLog fetches (when asked) then hands
// off to renderCompletionLog, which just re-renders from the cache - used
// on its own after a local mutation (delete) that doesn't need a re-fetch.
let assignLogBox = null;   // whichever container the log was last rendered into
async function loadCompletionLog(reset, box){
  box = box || assignLogBox || $("teamRecentlyDone");
  if (!box) return;
  assignLogBox = box;
  if (reset || assignRows === null) {
    box.innerHTML = `<p class="hint" style="margin-bottom:8px">Loading assignments…</p>`
      + `<div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
    try {
      await fetchAssignRows();
    } catch (e) {
      console.error(e);
      assignRows = [];
      box.innerHTML = `<div class="empty">Couldn't load assignments — check your connection and Firestore rules.</div>`;
      return;
    }
  }
  renderCompletionLog();
}
function renderCompletionLog(){
  const box = assignLogBox || $("teamRecentlyDone");
  if (!box) return;
  renderTeamStatusCards(box, assignRows || []);
}
/* ---------- Team page's by-status assignment cards ----------
   Three dropdowns - Completed / Open / Overdue - each a thread list,
   instead of one flat table with a Status column. Threads only ever move
   between buckets on a re-render (Firestore write -> assignRows update
   -> here), never mid-render, so building all three fresh each time is
   simplest and cheap enough at this app's scale. */
let tlogOpen = { done: false, open: true, late: true };   // which cards start expanded
let tlogShown = { done: 8, open: 8, late: 8 };             // per-card "load more" cursor
let tlogThreadsByKey = new Map();   // stable key -> thread, for the Edit buttons below
const threadKey = t => t.groupId || t.rows[0].id;
const TLOG_ORDER = ["done", "open", "late"];
const TLOG_META = {
  done: { label: "Completed Task", empty: "Nothing completed in this batch yet." },
  open: { label: "Open Task",      empty: "Nothing open right now." },
  late: { label: "Overdue Task",   empty: "Nothing overdue — nice." }
};

function renderTeamStatusCards(box, rows){
  const threads = groupAssignments(rows);
  tlogThreadsByKey = new Map(threads.map(t => [threadKey(t), t]));
  const buckets = { done: [], open: [], late: [] };
  threads.forEach(t => buckets[threadState(t)].push(t));

  box.innerHTML = `<div class="tlog">${TLOG_ORDER.map(st => tlogCardHtml(st, buckets[st])).join("")}</div>`;

  TLOG_ORDER.forEach(st => {
    const card = box.querySelector(`.tlog-card[data-status="${st}"]`);
    if (!card) return;
    const head = card.querySelector(".tlog-head");
    head.onclick = () => {
      tlogOpen[st] = !tlogOpen[st];
      card.classList.toggle("is-open", tlogOpen[st]);
      head.setAttribute("aria-expanded", String(tlogOpen[st]));
    };
    const moreBtn = card.querySelector(".tlog-more");
    if (moreBtn) moreBtn.onclick = e => {
      e.stopPropagation();
      tlogShown[st] += 8;
      renderTeamStatusCards(box, assignRows || []);
    };
    card.querySelectorAll("button[data-del]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      deleteAssignment(b.dataset.del);
    });
    card.querySelectorAll("button[data-edit]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      const t = tlogThreadsByKey.get(b.dataset.edit);
      if (t) openAssignEdit(t);
    });
  });
}

function tlogCardHtml(status, threads){
  const meta = TLOG_META[status];
  const shown = tlogShown[status];
  const visible = threads.slice(0, shown);
  const isOpen = tlogOpen[status];
  return `
    <div class="tlog-card${isOpen ? " is-open" : ""}" data-status="${status}">
      <button type="button" class="tlog-head" aria-expanded="${isOpen}">
        <span class="tlog-dot is-${status}" aria-hidden="true"></span>
        <span class="tlog-label">${meta.label}</span>
        <span class="tlog-count">${threads.length}</span>
        <svg class="tlog-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="tlog-body">
        ${!threads.length ? `<p class="tlog-empty">${meta.empty}</p>` : `
        <ul class="tlog-list">${visible.map(t => tlogItemHtml(status, t)).join("")}</ul>
        ${threads.length > shown ? `<button type="button" class="tlog-more">Load more (${threads.length - shown} older)</button>` : ""}`}
      </div>
    </div>`;
}

function tlogItemHtml(status, t){
  const r = t.rows[0];
  const doneN = t.rows.filter(x => x.done).length;
  const doneAts = t.rows.map(x => x.doneAt).filter(Boolean);
  const doneAt = status === "done" && doneAts.length ? Math.max(...doneAts) : null;
  const secondLine = status === "done"
    ? (doneAt ? `Done ${dayStamp(doneAt)} ${clock(doneAt)}` : "")
    : `Due ${threadDueCell(t)}`;
  return `
    <li><div class="tlog-item">
      <span class="tlog-who">${esc(r.toName || "Someone")}</span>
      <span class="tlog-what">
        <b>${esc(threadStores(t).join(", ") || "—")}</b> · ${esc(threadTasks(t).join(", ") || "—")}${t.rows.length > 1 ? ` <span class="thread-count">${doneN}/${t.rows.length}</span>` : ""}${seenMark(t)}
      </span>
      <span class="tlog-dates">
        <span>Assigned ${r.createdAt ? dayStamp(r.createdAt) : "—"}</span>
        <span>${secondLine}</span>
      </span>
      <span class="tlog-acts row-acts">
        ${status !== "done" && canAssignTasks ? `
        <button type="button" class="assign-del assign-edit" data-edit="${esc(threadKey(t))}"
                aria-label="Edit this assignment" title="Edit this assignment">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>` : ""}
        ${!isAdmin ? "" : `
        <button type="button" class="assign-del" data-del="${esc(t.rows.map(x => x.id).join(","))}"
                aria-label="Delete this assignment" title="Delete this assignment">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        </button>`}
      </span>
    </div></li>`;
}

// Edit reopens the same staged flow the thread was made with, prefilled.
// Only the open tasks are up for editing - finished work is a record, not a
// draft - so a half-done group keeps its done rows untouched.
function openAssignEdit(t){
  const open = t.rows.filter(r => !r.done);
  if (!open.length) return;
  openAssignFlow(open[0].toUid, open[0].toName, t);
}

// Admin-only: remove an assignment (or a whole group - the ids arrive as one
// comma-joined list) outright. Names what is being deleted so the confirm
// isn't a blind "are you sure", and drops the rows locally rather than
// re-fetching the whole collection.
async function deleteAssignment(idsCsv){
  const ids = String(idsCsv).split(",").filter(Boolean);
  const row = (assignRows || []).find(r => r.id === ids[0]);
  const what = !row ? "this assignment"
    : ids.length > 1
      ? `all ${ids.length} tasks in this group for ${row.toName || "someone"}`
      : `${row.task || "task"} at ${row.store || "—"} for ${row.toName || "someone"}`;
  if (!confirm(`Delete ${what}?\n\nThis removes it for them too, and can't be undone.`)) return;
  try {
    const batch = db.batch();
    ids.forEach(id => batch.delete(db.collection("assignments").doc(id)));
    await batch.commit();
    assignRows = (assignRows || []).filter(r => !ids.includes(r.id));
    renderCompletionLog();
    loadTeamPane();
    toast(ids.length > 1 ? "Group deleted" : "Assignment deleted");
  } catch (e) {
    console.error(e);
    toast("Couldn't delete — check Firestore rules allow admin deletes");
  }
}

/* ============================================================
   TEAM'S HISTORY SECTION — the whole team's closed-shift record. Same
   shape as the worker-facing History page (js/nav.js) - KPI tiles with
   sparklines, range/search filters, a day-grouped shift list - plus a
   sortable by-member breakdown and the team Excel export, since those
   only make sense once "everyone" is the audience. Reuses nav.js's
   stateless helpers (sparklineSvg, hxMonthKey) but keeps its own filter
   state, independent of whatever the worker-facing History page's own
   filters happen to be doing.
   ============================================================ */
let thxRange = "today";
let thxQuery = "";
let thxStart = "", thxEnd = "";
let thxOpenKeys = new Set();
let thxMemberSort = { key: "hours", dir: -1 };
let teamHistoryRows = null;   // every member's closed shifts, flattened

async function loadTeamHistoryRows(){
  const snap = await db.collection("appState").get();
  const rows = [];
  snap.forEach(doc => {
    const data = doc.data();
    let s; try { s = JSON.parse(data.json); } catch { s = null; }
    if (!s) return;
    (s.history || []).forEach(r =>
      rows.push({ ...r, worker: r.worker || s.worker || data.email || "Unnamed", uid: doc.id }));
  });
  return rows;
}

const thxKey = r => (r.uid ? r.uid + ":" : "") + r.startedAt;

function thxFiltered(){
  const q = thxQuery.trim().toLowerCase();
  let rows = teamHistoryRows || [];
  if (thxRange === "today"){
    const key = dayStamp(Date.now());
    rows = rows.filter(r => dayStamp(r.startedAt) === key);
  } else if (thxRange === "custom"){
    rows = summaryFilterRows(rows, thxStart, thxEnd);
  } else if (thxRange !== "all"){
    const cut = Date.now() - Number(thxRange) * 86400000;
    rows = rows.filter(r => r.startedAt >= cut);
  }
  if (!q) return rows;
  return rows.filter(r => {
    const hay = [r.worker, r.client, r.note, ...taskTally(r, r.endedAt).map(t => t.store + " " + t.task)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function thxRangeLabel(){
  if (thxRange === "today") return "Today";
  if (thxRange === "7") return "Last 7 days";
  if (thxRange === "30") return "Last 30 days";
  if (thxRange === "custom") return summaryRangeLabel(thxStart, thxEnd);
  return "All time";
}

// same bucketing rule as nav.js's hxSeries, just reading thx* filter
// state instead of hx*
function thxSeries(rows){
  if (thxRange === "today" || !rows.length) return null;
  let keyOf, order;
  if (thxRange === "7" || thxRange === "30"){
    const days = Number(thxRange);
    keyOf = r => dayStamp(r.startedAt);
    order = Array.from({ length: days }, (_, i) => dayStamp(Date.now() - (days - 1 - i) * 86400000));
  } else if (thxRange === "custom" && thxStart && thxEnd){
    const spanDays = Math.round((new Date(thxEnd) - new Date(thxStart)) / 86400000) + 1;
    if (spanDays > 0 && spanDays <= 60){
      keyOf = r => dayStamp(r.startedAt);
      order = Array.from({ length: spanDays }, (_, i) => dayStamp(new Date(thxStart).getTime() + i * 86400000));
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

// per-member rollup of whatever rows are currently filtered - same range
// chips and search as the shift list below it, so the two never show
// different slices of the same period
function hxMemberStats(rows){
  const byMember = new Map();
  rows.forEach(r => {
    const key = r.uid || r.worker;
    let m = byMember.get(key);
    if (!m){ m = { name: r.worker || "Unnamed", days: new Set(), ms: 0, shifts: 0, ratingSum: 0, ratingCount: 0 }; byMember.set(key, m); }
    m.days.add(dayStamp(r.startedAt));
    m.ms += r.netMs;
    m.shifts += 1;
    if (r.rating){ m.ratingSum += r.rating; m.ratingCount += 1; }
  });
  return [...byMember.values()].map(m => ({
    name: m.name, days: m.days.size, shifts: m.shifts, ms: m.ms,
    avgMs: m.days.size ? m.ms / m.days.size : 0,
    avgRating: m.ratingCount ? m.ratingSum / m.ratingCount : null
  }));
}
const THX_MEMBER_COLS = [
  { key: "name",   label: "Member" },
  { key: "days",   label: "Days" },
  { key: "shifts", label: "Shifts" },
  { key: "hours",  label: "Total Hours" },
  { key: "avg",    label: "Avg / Day" },
  { key: "rating", label: "Avg Rating" }
];
function thxMemberSortVal(m, key){
  switch (key){
    case "name": return m.name.toLowerCase();
    case "days": return m.days;
    case "shifts": return m.shifts;
    case "hours": return m.ms;
    case "avg": return m.avgMs;
    case "rating": return m.avgRating || 0;
    default: return 0;
  }
}
function renderThxMembers(rows){
  const box = $("thxMembers");
  if (!box) return;
  const members = hxMemberStats(rows);
  if (!members.length){ box.innerHTML = ""; return; }
  const { key, dir } = thxMemberSort;
  members.sort((a, b) => {
    const av = thxMemberSortVal(a, key), bv = thxMemberSortVal(b, key);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  box.innerHTML = `
    <p class="fpage-section-title">By member</p>
    <div class="table-card">
      <table class="assign-table month-table">
        <thead><tr>
          ${THX_MEMBER_COLS.map(c => `
            <th data-sort="${c.key}" class="${key === c.key ? "is-sorted" : ""}"
                aria-sort="${key === c.key ? (dir === 1 ? "ascending" : "descending") : "none"}">
              ${esc(c.label)}${key === c.key ? `<span class="hx-sort-arrow">${dir === 1 ? "▲" : "▼"}</span>` : ""}
            </th>`).join("")}
        </tr></thead>
        <tbody>
          ${members.map(m => `<tr data-member="${esc(m.name)}">
            <td data-label="Member" class="work-name">${esc(m.name)}</td>
            <td data-label="Days" class="nowrap">${m.days}</td>
            <td data-label="Shifts" class="nowrap">${m.shifts}</td>
            <td data-label="Total Hours" class="nowrap">${humanDur(m.ms)}</td>
            <td data-label="Avg / Day" class="nowrap">${m.avgMs ? humanDur(m.avgMs) : "—"}</td>
            <td data-label="Avg Rating" class="nowrap">${m.avgRating ? m.avgRating.toFixed(1) + `<small>/5</small>` : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  box.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      thxMemberSort = thxMemberSort.key === k
        ? { key: k, dir: thxMemberSort.dir * -1 }
        : { key: k, dir: (k === "name") ? 1 : -1 };
      renderThxMembers(rows);
    };
  });
  // a member row is a quick filter: jump the shift list below to just them
  box.querySelectorAll("tr[data-member]").forEach(tr => {
    tr.title = "Show only this member's shifts";
    tr.onclick = () => {
      thxQuery = tr.dataset.member;
      const search = $("thxSearch");
      if (search) search.value = thxQuery;
      renderTeamHistoryList();
    };
  });
}

function renderTeamHistorySection(){
  const box = $("teamHistorySection");
  if (!box) return;

  if (teamHistoryRows === null){
    box.innerHTML = `<p class="fpage-section-title">History</p><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
    loadTeamHistoryRows()
      .then(rows => { teamHistoryRows = rows; renderTeamHistorySection(); })
      .catch(e => { console.error(e); teamHistoryRows = []; renderTeamHistorySection(); });
    return;
  }

  if (!teamHistoryRows.length){
    box.innerHTML = `
      <p class="fpage-section-title">History</p>
      <div class="fpage-panel"><div class="empty">No closed shifts across the team yet.</div></div>`;
    return;
  }

  box.innerHTML = `
    <p class="fpage-section-title">History</p>
    <div id="thxStats"></div>
    <div class="fpage-filters">
      <button type="button" class="chip" data-range="today">Today</button>
      <button type="button" class="chip" data-range="7">Last 7 days</button>
      <button type="button" class="chip" data-range="30">Last 30 days</button>
      <button type="button" class="chip" data-range="all">All time</button>
      <button type="button" class="chip" data-range="custom">Custom…</button>
      <label class="fpage-search"><input type="text" id="thxSearch" placeholder="Search member, store, task or note…" value="${esc(thxQuery)}" autocomplete="off"></label>
    </div>
    <div class="fpage-dates${thxRange === "custom" ? "" : " hidden"}" id="thxDates">
      <label>From <input type="date" id="thxStart" value="${esc(thxStart)}"></label>
      <label>To <input type="date" id="thxEnd" value="${esc(thxEnd)}"></label>
    </div>
    <div id="thxMembers"></div>
    <div id="thxList"></div>`;

  box.querySelectorAll(".chip[data-range]").forEach(c => {
    c.setAttribute("aria-pressed", String(c.dataset.range === thxRange));
    c.onclick = () => {
      thxRange = c.dataset.range;
      if (thxRange === "custom" && !thxStart && !thxEnd){
        thxStart = summaryISO(Date.now() - 6 * 86400000);
        thxEnd = summaryISO(Date.now());
      }
      renderTeamHistorySection();
    };
  });
  const search = $("thxSearch");
  search.oninput = () => { thxQuery = search.value; renderTeamHistoryList(); };
  const dateInput = id => { const el = $(id); if (el) el.onchange = () => {
    thxStart = $("thxStart").value; thxEnd = $("thxEnd").value; renderTeamHistoryList();
  }; };
  dateInput("thxStart"); dateInput("thxEnd");
  renderTeamHistoryList();
}

function renderTeamHistoryList(){
  const rows = thxFiltered();
  const stats = $("thxStats"), list = $("thxList");
  if (!stats || !list) return;

  const total = rows.reduce((t, r) => t + r.netMs, 0);
  const rated = rows.filter(r => r.rating);
  const avgRating = rated.length ? (rated.reduce((t, r) => t + r.rating, 0) / rated.length).toFixed(1) : null;
  const series = thxSeries(rows);
  const rangeWords = thxRangeLabel();
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
      <p class="fpage-bar-note">${rows.length} shift${rows.length === 1 ? "" : "s"} shown${thxRange !== "all" || thxQuery ? " · filtered" : ""}</p>
      <div class="fpage-bar-acts">
        <button class="btn btn-go btn-sm" id="thxExport">Export team report</button>
      </div>
    </div>`;
  const teamXl = $("thxExport");
  if (teamXl) teamXl.onclick = exportAllExcel;

  renderThxMembers(rows);

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
    const open = thxOpenKeys.has(thxKey(r));
    const maxMs = tally.length ? tally[0].ms : 1;
    html += `
      <li class="hx-row${open ? " is-open" : ""}" data-k="${esc(thxKey(r))}">
        <button type="button" class="hx-head" aria-expanded="${open}">
          <span class="hx-when"><span class="hx-date">${day}</span>
            <span class="hx-clock">${clock(r.startedAt)}–${clock(r.endedAt)}</span></span>
          <span class="hx-mid"><span class="hx-store">${esc((r.worker ? r.worker + " · " : "") + r.client)}</span>
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
            <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(thxKey(r))}">Copy report</button>
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
    if (open) thxOpenKeys.add(k); else thxOpenKeys.delete(k);
  });
  list.querySelectorAll("button[data-copy]").forEach(b => b.onclick = async () => {
    const r = (teamHistoryRows || []).find(x => thxKey(x) === b.dataset.copy);
    if (!r) return;
    toast(await copyText(reportText(r)) ? "Report copied" : "Copy failed");
  });
}

/* ============================================================
   TEAM PANE — the admin's third column on desktop. Collapsed it is a
   notification: standing counts plus the most recent completion. Expanded
   it swaps places with the punch card and shows every assignment.
   Narrow screens never see it; they use showTeam()'s full page instead.
   ============================================================ */
let teamPendingCount = 0;     // accounts waiting for approval

const todayISO = () => {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};
// done > overdue > open, matching the three dot colours in the table
function assignState(r){
  if (r.done) return "done";
  return (r.dueDate && r.dueDate < todayISO()) ? "late" : "open";
}
// one source for the three status glyphs, shared by the table and the
// collapsed card's stat row so they can't drift apart
const STATUS_GLYPH = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>',
  late: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
  open: ""
};
const STATUS_LABEL = { done: "Done", late: "Overdue", open: "Open" };
// one status pip, shared by the admin's Team pane and the employee's
// Assigned pane - same shape (a count, a label, one of the three colors),
// just fed different counts, so it isn't worth two separate closures
const teamStatPip = (n, label, cls) =>
  `<li class="team-stat is-${cls}${n ? "" : " is-zero"}">
     <span class="team-dot is-${cls}">${STATUS_GLYPH[cls]}</span><b>${n}</b> ${label}
   </li>`;

/* ---------- assignment threads ----------
   Rows born from one multi-select submit share a groupId; fold those back
   into one thread so every table and list shows what the admin meant: one
   grouped brief, not six lookalike rows. Rows without a groupId (assigned
   one at a time, or written before groups existed) each stay their own
   thread. Order of first appearance is kept, so a sorted input stays sorted. */
function groupAssignments(rows){
  const threads = [], byGroup = new Map();
  rows.forEach(r => {
    if (!r.groupId){ threads.push({ groupId: null, rows: [r] }); return; }
    let t = byGroup.get(r.groupId);
    if (!t){ t = { groupId: r.groupId, rows: [] }; byGroup.set(r.groupId, t); threads.push(t); }
    t.rows.push(r);
  });
  return threads;
}
// a thread is done only when every task in it is; one late task makes it late
function threadState(t){
  if (t.rows.every(r => r.done)) return "done";
  return t.rows.some(r => assignState(r) === "late") ? "late" : "open";
}
const threadStores = t => [...new Set(t.rows.map(r => r.store).filter(Boolean))];
const threadTasks  = t => [...new Set(t.rows.map(r => r.task).filter(Boolean))];
// lines in a group can carry their own due dates - a table cell shows the
// earliest and admits there is more, rather than pretending there is one
function threadDues(t){
  const ds = [...new Set(t.rows.map(r => r.dueDate).filter(Boolean))].sort();
  return { min: ds[0] || null, varied: ds.length > 1 || (ds.length === 1 && t.rows.some(r => !r.dueDate)) };
}
function threadDueCell(t){
  const d = threadDues(t);
  if (!d.min) return "—";
  const all = t.rows.map(r => r.dueDate || "no date");
  return `<span${d.varied ? ` title="${esc([...new Set(all)].join(", "))}"` : ""}>${esc(d.min)}${d.varied ? " +" : ""}</span>`;
}
// the receipt: every task still open has been on the assignee's screen.
// Done rows vouch for themselves.
const threadSeen = t => t.rows.every(r => r.seenAt || r.done);
const threadSeenAt = t => Math.max(...t.rows.map(r => r.seenAt || r.doneAt || 0));
const EYE_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/></svg>';
// shown beside an open thread's status once the assignee has seen it
function seenMark(t){
  if (threadState(t) === "done" || !threadSeen(t)) return "";
  return `<span class="seen-eye" title="Seen ${esc(whenLabel(threadSeenAt(t)))}" aria-label="Seen">${EYE_GLYPH}</span>`;
}

// "Jul 26, 2026 · 21:37" is the least important line in the card and was
// taking the most room. Anchor it to now instead.
function whenLabel(ts){
  const d = new Date(ts), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Today " + clock(ts);
  if (sameDay(d, yesterday)) return "Yesterday " + clock(ts);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + clock(ts);
}

async function loadTeamPane(){
  if (!isAdmin) return;
  try {
    await fetchAssignRows();
  } catch (e) { console.error(e); assignRows = []; }
  try {
    const p = await db.collection("users").where("role","==","pending").get();
    teamPendingCount = p.size;
  } catch (e) { console.error(e); teamPendingCount = 0; }
  renderTeamPane();
  backfillDirectory();   // keep every teammate @-mentionable
}

function renderTeamPane(){
  const counts = $("teamPanelCounts"), latest = $("teamPanelLatest"), table = $("teamPanelTable");
  if (!counts || !latest || !table) return;
  const rows = assignRows || [];
  // campaigns share the pane: the admin's watchCampaigns holds every doc,
  // so the merge is pure render-time - one campaign reads as one thread
  const cgs = (typeof cgRows !== "undefined" && cgRows) ? cgRows : [];
  const cgLate = c => {
    if (c.status !== "active") return false;
    const s = cgStage(c);
    return !!((s && s.dueAt && s.dueAt < Date.now()) || (c.dueDate && c.dueDate < todayISO()));
  };
  const cgSeenAll = c => {
    const s = cgStage(c);
    const own = s ? cgOwnersOf(s) : [];
    return own.length > 0 && own.every(o => ((s.seenBy || [])).includes(o.uid));
  };

  // The three states are counted as a partition, not overlapping sets - an
  // overdue task is not also counted as open, or the numbers don't add up to
  // the table you see after Proceed. Counted per thread, same as the table
  // shows them, so a six-task group reads as one thing everywhere.
  const threads = groupAssignments(rows);
  const doneCount = threads.filter(t => threadState(t) === "done").length
    + cgs.filter(c => c.status === "live").length;
  const late = threads.filter(t => threadState(t) === "late").length
    + cgs.filter(cgLate).length;
  const openNow = threads.filter(t => threadState(t) === "open").length
    + cgs.filter(c => c.status === "active" && !cgLate(c)).length;

  // Same pips the expanded table uses, so the collapsed card reads as its
  // legend rather than as a separate vocabulary. Zeroes stay in place but
  // dimmed, so the row keeps a stable shape and the eye lands on what's live.
  counts.innerHTML = (rows.length || cgs.length || teamPendingCount)
    ? `<ul class="team-stats">${teamStatPip(doneCount, "done", "done")}${teamStatPip(late, "overdue", "late")}${teamStatPip(openNow, "open", "open")}</ul>`
      + (teamPendingCount ? `<p class="team-approve">${teamPendingCount} waiting for approval</p>` : "")
    : `<p class="team-approve">No assignments yet.</p>`;

  // latest completion: newest of a finished assignment and a shipped campaign
  const done = rows.filter(r => r.done && r.doneAt).sort((a,b) => b.doneAt - a.doneAt)[0];
  const shipped = cgs.filter(c => c.status === "live" && c.liveAt).sort((a,b) => b.liveAt - a.liveAt)[0];
  if (shipped && (!done || shipped.liveAt > done.doneAt)){
    latest.innerHTML = `<div class="team-latest-who">${esc(shipped.title)} went LIVE</div>
       <div class="team-latest-what">${esc(shipped.store || "campaign")}<span class="team-latest-when"> · ${whenLabel(shipped.liveAt)}</span></div>`;
  } else latest.innerHTML = done
    ? `<div class="team-latest-who">${esc(done.toName || "Someone")} finished ${esc(done.task || "a task")}</div>
       <div class="team-latest-what">${esc(done.store || "—")}<span class="team-latest-when"> · ${whenLabel(done.doneAt)}</span></div>`
    : `<div class="team-latest-none">Nothing finished yet. Completed tasks land here.</div>`;

  if (!rows.length && !cgs.length){
    table.innerHTML = `<tbody><tr><td class="team-table-empty">No assignments yet.</td></tr></tbody>`;
    return;
  }
  const cgRowsHtml = cgs.map(c => {
    const s = cgStage(c);
    const st = c.status === "live" ? "done" : cgLate(c) ? "late" : "open";
    const seen = c.status === "active" && cgSeenAll(c)
      ? `<span class="seen-eye" title="Seen by the stage owner${cgOwnersOf(s).length > 1 ? "s" : ""}" aria-label="Seen">${EYE_GLYPH}</span>` : "";
    const due = (s && s.dueAt) ? dayStamp(s.dueAt) : (c.dueDate || "—");
    return `<tr>
      <td class="team-td-user">${esc(c.status === "live" ? "—" : cgOwnerNames(s) || "—")}</td>
      <td>${esc(c.store || "—")}</td>
      <td>${esc(c.title)}${s && c.status === "active" ? ` <span class="thread-count">${esc(s.name)}</span>` : ""}</td>
      <td class="nowrap"><span class="team-dot is-${st}" title="${STATUS_LABEL[st]}" aria-label="${STATUS_LABEL[st]}">${STATUS_GLYPH[st]}</span>${seen}</td>
      <td class="team-td-muted">${s && s.enteredAt ? dayStamp(s.enteredAt) : (c.createdAt ? dayStamp(c.createdAt) : "—")}</td>
      <td class="team-td-muted">${esc(due)}</td>
    </tr>`;
  }).join("");
  table.innerHTML = `
    <thead><tr>
      <th>User</th><th>Store</th><th>Task</th><th>Status</th><th>Assigned</th><th>Due</th>
    </tr></thead>
    <tbody>
      ${threads.map(t => {
        const r = t.rows[0], st = threadState(t);
        const doneN = t.rows.filter(x => x.done).length;
        return `<tr>
          <td class="team-td-user">${esc(r.toName || "Someone")}</td>
          <td>${esc(threadStores(t).join(", ") || "—")}</td>
          <td>${esc(threadTasks(t).join(", ") || "—")}${t.rows.length > 1 ? ` <span class="thread-count">${doneN}/${t.rows.length}</span>` : ""}</td>
          <td class="nowrap"><span class="team-dot is-${st}" title="${STATUS_LABEL[st]}" aria-label="${STATUS_LABEL[st]}">${STATUS_GLYPH[st]}</span>${seenMark(t)}</td>
          <td class="team-td-muted">${r.createdAt ? dayStamp(r.createdAt) : "—"}</td>
          <td class="team-td-muted">${threadDueCell(t)}</td>
        </tr>`;
      }).join("")}
      ${cgRowsHtml}
    </tbody>`;
}

let swapSettle = null;
// One toggle for both side panes - the admin's Team and the employee's
// Assigned. They occupy the same grid area and share every rule, so the only
// difference is which one is mounted.
function setSidePaneOpen(open){
  const app = $("appScreen");
  // Suspend the panels' backdrop-filter for the length of the swap (see the
  // .is-swapping rules): re-blurring the marble behind two panes on every
  // frame of a width animation is the expensive part, not the layout itself.
  // The timeout is the whole mechanism rather than transitionend, which never
  // fires under prefers-reduced-motion or if the tab is backgrounded midway.
  app.classList.add("is-swapping");
  clearTimeout(swapSettle);
  swapSettle = setTimeout(() => app.classList.remove("is-swapping"), 620);

  app.classList.toggle("side-open", open);
  // opening the Team pane is the admin reading the notification - clear the
  // badge, same as walking into the full Team page does
  if (open && isAdmin) ackCompletedAssignments().then(() => loadTeamPane());
}

/* ---------- team-wide Excel export (one sheet per worker + overview) ---------- */
function barify(value, max, width = 18){
  if (!max || max <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function safeSheetName(base, used){
  let name = String(base).replace(/[\\\/\?\*\[\]:]/g, "").trim().slice(0, 28) || "Member";
  let final = name, i = 2;
  while (used.has(final.toLowerCase())) { final = name.slice(0, 25) + " " + i; i++; }
  used.add(final.toLowerCase());
  return final;
}

// Standard column widths for a fillWorkerSheet() sheet — shared so both
// export paths render identically.
const WORKER_SHEET_COLS = [24,14,12,12,12,10,8,40];

// Populates a worksheet with one member's Excel layout: summary block,
// TASK BREAKDOWN (with a live-colored barify() bar chart), then SHIFT
// HISTORY. Shared by exportAllExcel() (one sheet per member) and
// exportWorkerExcel()'s single-member export so both paths produce the
// same polished layout.
function fillWorkerSheet(ws, name, email, hist){
  const totalMs = hist.reduce((t,r) => t + r.netMs, 0);
  const hrs = +(totalMs / 3600000).toFixed(2);
  const avgRating = hist.length ? hist.reduce((t,r) => t + r.rating, 0) / hist.length : 0;

  const tally = new Map();
  hist.forEach(shift => {
    let store = shift.client;
    (shift.segs || []).filter(s => s.endedAt).forEach(s => {
      if (s.client) store = s.client;
      const key = store + " " + s.task;
      const cur = tally.get(key) || { store, task: s.task, ms: 0 };
      cur.ms += segMs(s);
      tally.set(key, cur);
    });
  });
  const taskRows = [...tally.values()].sort((a,b) => b.ms - a.ms);
  const maxTaskMs = Math.max(1, ...taskRows.map(t => t.ms));

  // history is already newest-first (S.history.unshift(rec) on close), but
  // sort explicitly so the sheet stays correct even if input order ever changes.
  const sortedHist = [...hist].sort((a,b) => b.startedAt - a.startedAt);

  ws.addRow([name]).getCell(1).font = { bold: true, size: 14 };
  ws.addRow([email]);
  ws.addRow([]);
  ws.addRow(["Shifts", "Total Hours", "Avg Rating"]);
  ws.addRow([hist.length, hrs, +avgRating.toFixed(1)]);
  ws.addRow([]);
  ws.addRow(["TASK BREAKDOWN"]).getCell(1).font = { bold: true, size: 12 };
  const taskHeader = ws.addRow(["Store / Task", "Hours", "% of total", "Chart"]);
  styleHeaderRow(ws, taskHeader.number, 4);
  taskRows.forEach(t => {
    const th = +(t.ms / 3600000).toFixed(2);
    const pct = Math.round(t.ms / (totalMs || 1) * 100);
    const row = ws.addRow([taskLabel(t), th, pct + "%", barify(t.ms, maxTaskMs)]);
    row.getCell(4).font = { color: { argb: "FF4A86E8" } };
  });
  ws.addRow([]);
  ws.addRow(["SHIFT HISTORY"]).getCell(1).font = { bold: true, size: 12 };
  const histHeader = ws.addRow(["Date", "Store", "In", "Out", "Break (min)", "Hours", "Rating", "Notes"]);
  styleHeaderRow(ws, histHeader.number, 8);
  sortedHist.forEach(shift => {
    ws.addRow([
      dayStamp(shift.startedAt), shift.client, clock(shift.startedAt), clock(shift.endedAt),
      Math.round(shift.breakMs / 60000), +(shift.netMs / 3600000).toFixed(2), shift.rating, shift.note
    ]);
  });

  ws.columns = WORKER_SHEET_COLS.map(w => ({ width: w }));
}

// ============================================================
// TEAM REPORT — Dashboard / Overview / Clients / Shift Log / one sheet
// per member, all formula-driven off a single consolidated Shift Log.
// "Clean Navy" theme. See notes on REPORT_THEME for the palette source.
// ============================================================
const REPORT_THEME = {
  navy: "FF1F2937", blue: "FF2563EB", green: "FFACC652", orange: "FFF9A33F",
  red: "FFDC2626", zebra: "FFF3F4F6", border: "FFE5E7EB", muted: "FF6B7280"
};
const reportStars = n => "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(5 - Math.max(0, Math.min(5, n)));
const fv = (formula, result) => ({ formula, result });

function styleReportHeaderRow(ws, rowNum, numCols){
  const row = ws.getRow(rowNum);
  for (let c = 1; c <= numCols; c++){
    const cell = row.getCell(c);
    cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REPORT_THEME.navy } };
  }
  row.height = 20;
}
const reportZebra = row => { row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REPORT_THEME.zebra } }; };
const reportRowBorder = (row, numCols) => {
  for (let c = 1; c <= numCols; c++) row.getCell(c).border = { bottom: { style: "thin", color: { argb: REPORT_THEME.border } } };
};
const reportDataBar = (ws, ref) => ws.addConditionalFormatting({
  ref, rules: [{ type: "dataBar", cfvo: [{type:"min"},{type:"max"}], gradient:false, border:false, color:{argb:REPORT_THEME.blue} }]
});
const reportRatingScale = (ws, ref) => ws.addConditionalFormatting({
  ref, rules: [{ type: "colorScale", cfvo: [{type:"num",value:1},{type:"num",value:3},{type:"num",value:5}],
    color: [{argb:REPORT_THEME.red},{argb:REPORT_THEME.orange},{argb:REPORT_THEME.green}] }]
});

// One row per closed shift, across every member, newest first.
function buildShiftLogRows(members){
  const rows = [];
  members.forEach(m => {
    (m.hist || []).forEach(r => {
      rows.push({
        date: r.startedAt, member: m.name, client: String(r.client || "").toUpperCase(),
        inTime: clock(r.startedAt), outTime: clock(r.endedAt),
        brk: Math.round((r.breakMs || 0) / 60000), hours: +(r.netMs / 3600000).toFixed(2),
        rating: r.rating, notes: r.note || ""
      });
    });
  });
  rows.sort((a, b) => b.date - a.date);
  return rows;
}

// Every number the workbook will show, computed once so a formula and its
// cached `result` can never disagree - see fv() above.
function computeReportModel(members, logRows){
  const memberStats = members.map(m => {
    const rows = logRows.filter(r => r.member === m.name);
    const shifts = rows.length;
    const hours = +rows.reduce((t,r)=>t+r.hours,0).toFixed(2);
    const hrsPerShift = shifts ? +(hours/shifts).toFixed(2) : 0;
    const avgRating = shifts ? +(rows.reduce((t,r)=>t+r.rating,0)/shifts).toFixed(1) : 0;
    return { name: m.name, email: m.email, shifts, hours, hrsPerShift, avgRating };
  });
  const totalShifts = memberStats.reduce((t,m)=>t+m.shifts,0);
  const totalHours = +memberStats.reduce((t,m)=>t+m.hours,0).toFixed(2);
  memberStats.forEach(m => { m.share = totalHours ? +(m.hours/totalHours).toFixed(4) : 0; });
  const teamHrsPerShift = totalShifts ? +(totalHours/totalShifts).toFixed(2) : 0;
  const teamAvgRating = logRows.length ? +(logRows.reduce((t,r)=>t+r.rating,0)/logRows.length).toFixed(1) : 0;
  const totalShare = +memberStats.reduce((t,m)=>t+m.share,0).toFixed(4);

  const clientTotals = new Map();
  logRows.forEach(r => {
    if (!r.client) return;
    const cur = clientTotals.get(r.client) || { shifts:0, hours:0 };
    cur.shifts++; cur.hours += r.hours;
    clientTotals.set(r.client, cur);
  });
  const clients = [...clientTotals.entries()].map(([name,v]) => ({ name, shifts:v.shifts, hours:+v.hours.toFixed(2) }))
    .sort((a,b)=>b.hours-a.hours);
  const totalClientHours = +clients.reduce((t,c)=>t+c.hours,0).toFixed(2);
  clients.forEach(c => { c.share = totalClientHours ? +(c.hours/totalClientHours).toFixed(4) : 0; });

  const pick = (arr, key) => arr.length ? arr.reduce((best,m)=> m[key]>best[key]?m:best) : null;

  const dates = logRows.map(r=>r.date);
  return {
    memberStats, totalShifts, totalHours, teamHrsPerShift, teamAvgRating, totalShare,
    clients, totalClientHours,
    mostEfficient: pick(memberStats, "hrsPerShift"), highestRating: pick(memberStats, "avgRating"),
    biggestShare: pick(memberStats, "share"), totalBreak: logRows.reduce((t,r)=>t+r.brk,0),
    minDate: dates.length ? new Date(Math.min(...dates)) : null,
    maxDate: dates.length ? new Date(Math.max(...dates)) : null
  };
}

function fillShiftLogSheet(ws, logRows){
  const headers = ["DATE","MEMBER","STORE/CLIENT","IN","OUT","BRK (min)","HOURS","RATING","STARS","NOTES"];
  ws.addRow(headers);
  styleReportHeaderRow(ws, 1, headers.length);
  const startRow = 2;
  logRows.forEach((r, i) => {
    const rn = startRow + i;
    const row = ws.getRow(rn);
    row.getCell(1).value = new Date(r.date); row.getCell(1).numFmt = "mmm dd, yyyy";
    row.getCell(2).value = r.member;
    row.getCell(3).value = r.client; row.getCell(3).font = { color: { argb: REPORT_THEME.blue } };
    row.getCell(4).value = r.inTime;
    row.getCell(5).value = r.outTime;
    row.getCell(6).value = r.brk;
    row.getCell(7).value = r.hours; row.getCell(7).numFmt = "0.00"; row.getCell(7).font = { bold: true };
    row.getCell(8).value = r.rating;
    row.getCell(9).value = fv(`REPT("★",H${rn})&REPT("☆",5-H${rn})`, reportStars(r.rating));
    row.getCell(9).font = { color: { argb: REPORT_THEME.orange } };
    row.getCell(10).value = r.notes; row.getCell(10).font = { color: { argb: REPORT_THEME.muted } };
    if (i % 2 === 1) reportZebra(row);
    reportRowBorder(row, 10);
  });
  const lastRow = startRow + logRows.length - 1;
  if (logRows.length){
    reportDataBar(ws, `G${startRow}:G${lastRow}`);
    reportRatingScale(ws, `H${startRow}:H${lastRow}`);
    ws.autoFilter = `A1:J${lastRow}`;
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.addRow([]);
  ws.addRow(["Source log - every other sheet in this workbook derives from these rows."]).getCell(1).font = { italic: true, color: { argb: REPORT_THEME.blue } };
  ws.columns = [{width:13},{width:16},{width:16},{width:9},{width:9},{width:10},{width:9},{width:8},{width:14},{width:30}];
}

function fillOverviewSheet(ws, model, logRange){
  const n = model.memberStats.length;
  const firstRow = 2, lastRow = 1 + n, totalRow = lastRow + 1;
  const L = logRange;
  const logRef = c => `'Shift Log'!$${c}$${L.startRow}:$${c}$${L.lastRow}`;
  const ovCol = c => `$${c}$${firstRow}:$${c}$${lastRow}`;

  const header = ws.addRow(["MEMBER","EMAIL","SHIFTS","HOURS","HRS/SHIFT","SHARE","AVG RATING"]);
  styleReportHeaderRow(ws, header.number, 7);

  model.memberStats.forEach((m, i) => {
    const r = firstRow + i;
    const row = ws.getRow(r);
    row.getCell(1).value = m.name;
    row.getCell(2).value = m.email;
    row.getCell(3).value = fv(`COUNTIFS(${logRef("B")},A${r})`, m.shifts);
    row.getCell(4).value = fv(`SUMIFS(${logRef("G")},${logRef("B")},A${r})`, m.hours); row.getCell(4).numFmt = "0.00";
    row.getCell(5).value = fv(`IFERROR(D${r}/C${r},0)`, m.hrsPerShift); row.getCell(5).numFmt = "0.00";
    row.getCell(6).value = fv(`IFERROR(D${r}/SUM(${ovCol("D")}),0)`, m.share); row.getCell(6).numFmt = "0%";
    row.getCell(7).value = fv(`IFERROR(AVERAGEIFS(${logRef("H")},${logRef("B")},A${r}),0)`, m.avgRating); row.getCell(7).numFmt = "0.0";
    if (i % 2 === 1) reportZebra(row);
    reportRowBorder(row, 7);
  });

  const t = ws.getRow(totalRow);
  t.getCell(1).value = "TEAM TOTAL / AVG"; t.font = { bold: true };
  t.getCell(3).value = fv(`SUM(${ovCol("C")})`, model.totalShifts);
  t.getCell(4).value = fv(`SUM(${ovCol("D")})`, model.totalHours); t.getCell(4).numFmt = "0.00";
  t.getCell(5).value = fv(`IFERROR(D${totalRow}/C${totalRow},0)`, model.teamHrsPerShift); t.getCell(5).numFmt = "0.00";
  t.getCell(6).value = fv(`SUM(${ovCol("F")})`, model.totalShare); t.getCell(6).numFmt = "0%";
  t.getCell(7).value = fv(`IFERROR(AVERAGE(${logRef("H")}),0)`, model.teamAvgRating); t.getCell(7).numFmt = "0.0";
  for (let c = 1; c <= 7; c++) t.getCell(c).border = { top: { style: "medium", color: { argb: REPORT_THEME.navy } } };

  if (n){ reportDataBar(ws, `D${firstRow}:D${lastRow}`); reportRatingScale(ws, `G${firstRow}:G${lastRow}`); }

  ws.addRow([]);
  ws.addRow(["Shift Performance Analysis"]).getCell(1).font = { bold: true, size: 12 };
  const mk = (label, note) => { const row = ws.addRow([label]); if (note){ row.getCell(3).value = note; row.getCell(3).font = { italic:true, color:{argb:REPORT_THEME.muted} }; } return row; };

  const r1 = mk("Team avg hours per shift", "total hours ÷ total shifts");
  r1.getCell(2).value = fv(`E${totalRow}`, model.teamHrsPerShift); r1.getCell(2).numFmt = "0.00";
  const r2 = mk("Weighted avg rating per shift", "weighted by shift count, not member avg");
  r2.getCell(2).value = fv(`G${totalRow}`, model.teamAvgRating); r2.getCell(2).numFmt = "0.0";
  const r3 = mk("Most efficient (hrs/shift)");
  r3.getCell(2).value = fv(`IFERROR(INDEX(${ovCol("A")},MATCH(MAX(${ovCol("E")}),${ovCol("E")},0)),"—")`, model.mostEfficient ? model.mostEfficient.name : "—");
  r3.getCell(3).value = fv(`IFERROR(MAX(${ovCol("E")}),0)`, model.mostEfficient ? model.mostEfficient.hrsPerShift : 0); r3.getCell(3).numFmt = "0.00";
  const r4 = mk("Highest avg rating", "first member on ties");
  r4.getCell(2).value = fv(`IFERROR(INDEX(${ovCol("A")},MATCH(MAX(${ovCol("G")}),${ovCol("G")},0)),"—")`, model.highestRating ? model.highestRating.name : "—");
  r4.getCell(3).value = fv(`IFERROR(MAX(${ovCol("G")}),0)`, model.highestRating ? model.highestRating.avgRating : 0); r4.getCell(3).numFmt = "0.0";
  const r5 = mk("Biggest workload share");
  r5.getCell(2).value = fv(`IFERROR(INDEX(${ovCol("A")},MATCH(MAX(${ovCol("F")}),${ovCol("F")},0)),"—")`, model.biggestShare ? model.biggestShare.name : "—");
  r5.getCell(3).value = fv(`IFERROR(MAX(${ovCol("F")}),0)`, model.biggestShare ? model.biggestShare.share : 0); r5.getCell(3).numFmt = "0%";

  ws.addRow([]);
  ws.addRow(["Edit punches on the Shift Log sheet only — every figure here recalculates from it."]).getCell(1).font = { italic: true, color: { argb: REPORT_THEME.blue } };
  ws.columns = [{width:20},{width:26},{width:9},{width:11},{width:11},{width:10},{width:12}];
}

function fillClientsSheet(ws, model, logRange){
  const header = ws.addRow(["CLIENT/STORE","SHIFTS","HOURS","SHARE"]);
  styleReportHeaderRow(ws, header.number, 4);
  const firstRow = 2, lastRow = 1 + model.clients.length;
  const L = logRange;
  const logRef = c => `'Shift Log'!$${c}$${L.startRow}:$${c}$${L.lastRow}`;

  model.clients.forEach((cl, i) => {
    const r = firstRow + i;
    const row = ws.getRow(r);
    row.getCell(1).value = cl.name;
    row.getCell(2).value = fv(`COUNTIF(${logRef("C")},A${r})`, cl.shifts);
    row.getCell(3).value = fv(`SUMIF(${logRef("C")},A${r},${logRef("G")})`, cl.hours); row.getCell(3).numFmt = "0.00";
    row.getCell(4).value = fv(`IFERROR(C${r}/SUM($C$${firstRow}:$C$${lastRow}),0)`, cl.share); row.getCell(4).numFmt = "0%";
    if (i % 2 === 1) reportZebra(row);
    reportRowBorder(row, 4);
  });
  if (model.clients.length) reportDataBar(ws, `C${firstRow}:C${lastRow}`);
  ws.addRow([]);
  ws.addRow(["Grouped case-insensitively - \"Acme\" and \"ACME\" are combined by the formulas above."]).getCell(1).font = { italic: true, color: { argb: REPORT_THEME.muted } };
  ws.columns = [{width:24},{width:9},{width:11},{width:10}];
}

function fillDashboardSheet(ws, model, logRange, overviewRange){
  const L = logRange, O = overviewRange;
  const logRef = c => `'Shift Log'!$${c}$${L.startRow}:$${c}$${L.lastRow}`;
  const ovRef = c => `Overview!$${c}$${O.firstRow}:$${c}$${O.lastRow}`;

  ws.addRow(["EZ AGENCY · TEAM TIME CARDS"]).getCell(1).font = { bold: true, size: 10, color: { argb: REPORT_THEME.muted } };
  ws.addRow(["TEAM REPORT"]).getCell(1).font = { bold: true, size: 24, color: { argb: REPORT_THEME.navy } };
  ws.addRow(["Generated " + new Date().toLocaleString()]).getCell(1).font = { italic: true, color: { argb: REPORT_THEME.muted } };
  ws.addRow([]);

  const badge = ws.addRow(["FILED · " + dayStamp(Date.now())]);
  badge.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  badge.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: REPORT_THEME.navy } };
  ws.addRow([]);

  ws.addRow(["PERIOD","GENERATED","MEMBERS","SHIFTS FILED"]).eachCell(c => { c.font = { bold: true, size: 10, color: { argb: REPORT_THEME.muted } }; });
  const metaRow = ws.addRow([]);
  const periodStr = model.minDate && model.maxDate
    ? dayStamp(model.minDate.getTime()).replace(/,.*/, "") + " – " + dayStamp(model.maxDate.getTime())
    : "—";
  metaRow.getCell(1).value = L.lastRow >= L.startRow
    ? fv(`TEXT(MIN(${logRef("A")}),"mmm d")&" – "&TEXT(MAX(${logRef("A")}),"mmm d, yyyy")`, periodStr)
    : "—";
  metaRow.getCell(2).value = dayStamp(Date.now());
  metaRow.getCell(3).value = fv(`COUNTA(${ovRef("A")})`, model.memberStats.length);
  metaRow.getCell(4).value = fv(`COUNT(${logRef("G")})`, model.totalShifts);
  for (let c = 1; c <= 4; c++){
    metaRow.getCell(c).border = { top:{style:"thin",color:{argb:REPORT_THEME.border}}, bottom:{style:"thin",color:{argb:REPORT_THEME.border}}, left:{style:"thin",color:{argb:REPORT_THEME.border}}, right:{style:"thin",color:{argb:REPORT_THEME.border}} };
    metaRow.getCell(c).font = { bold: true };
  }
  ws.addRow([]);

  ws.addRow(["AT A GLANCE"]).getCell(1).font = { bold: true, size: 12, color: { argb: REPORT_THEME.navy } };
  ws.addRow(["TOTAL HOURS","BREAK TIME","AVG SHIFT RATING","TOP BY HOURS"]).eachCell(c => { c.font = { bold: true, size: 10, color: { argb: REPORT_THEME.muted } }; });
  const kpiRow = ws.addRow([]);
  kpiRow.getCell(1).value = fv(`SUM(${logRef("G")})`, model.totalHours);
  kpiRow.getCell(1).numFmt = '0.00" h"'; kpiRow.getCell(1).font = { bold: true, size: 16, color: { argb: REPORT_THEME.blue } };
  kpiRow.getCell(2).value = fv(`SUM(${logRef("F")})`, model.totalBreak);
  kpiRow.getCell(2).numFmt = '0" min"'; kpiRow.getCell(2).font = { bold: true, size: 16, color: { argb: REPORT_THEME.red } };
  kpiRow.getCell(3).value = fv(`IFERROR(AVERAGE(${logRef("H")}),0)`, model.teamAvgRating);
  kpiRow.getCell(3).numFmt = '0.0" ★"'; kpiRow.getCell(3).font = { bold: true, size: 16, color: { argb: REPORT_THEME.green } };
  const topByHours = model.memberStats.length ? model.memberStats.reduce((b,m)=>m.hours>b.hours?m:b) : null;
  kpiRow.getCell(4).value = fv(`IFERROR(INDEX(${ovRef("A")},MATCH(MAX(${ovRef("D")}),${ovRef("D")},0)),"—")`, topByHours ? topByHours.name : "—");
  kpiRow.getCell(4).font = { bold: true, size: 16, color: { argb: REPORT_THEME.navy } };

  ws.addRow([]);
  ws.addRow(["Every figure on this page recalculates from the Shift Log sheet - nothing here is a fixed number."]).getCell(1).font = { italic: true, color: { argb: REPORT_THEME.blue } };
  ws.columns = [{width:26},{width:20},{width:20},{width:22}];
}

function fillReportMemberSheet(ws, member, mstat, logRange){
  const L = logRange;
  const logRef = c => `'Shift Log'!$${c}$${L.startRow}:$${c}$${L.lastRow}`;
  const nameCell = "A1";

  ws.addRow([member.name]).getCell(1).font = { bold: true, size: 14 };
  ws.addRow([member.email]).getCell(1).font = { color: { argb: REPORT_THEME.muted } };
  ws.addRow([]);

  const kpiHeader = ws.addRow(["SHIFTS","TOTAL HOURS","AVG RATING"]);
  styleReportHeaderRow(ws, kpiHeader.number, 3);
  const kpiRow = ws.addRow([]);
  kpiRow.getCell(1).value = fv(`COUNTIFS(${logRef("B")},${nameCell})`, mstat.shifts);
  kpiRow.getCell(2).value = fv(`SUMIFS(${logRef("G")},${logRef("B")},${nameCell})`, mstat.hours); kpiRow.getCell(2).numFmt = "0.00";
  kpiRow.getCell(3).value = fv(`IFERROR(AVERAGEIFS(${logRef("H")},${logRef("B")},${nameCell}),0)`, mstat.avgRating); kpiRow.getCell(3).numFmt = "0.0";
  const totalHoursCellRef = `B${kpiRow.number}`;
  ws.addRow([]);

  const hist = member.hist || [];
  const tally = new Map();
  hist.forEach(shift => {
    let store = shift.client;
    (shift.segs || []).filter(s => s.endedAt).forEach(s => {
      if (s.client) store = s.client;
      const key = store + " " + s.task;
      const cur = tally.get(key) || { store, task: s.task, ms: 0 };
      cur.ms += segMs(s);
      tally.set(key, cur);
    });
  });
  const taskRows = [...tally.values()].sort((a,b) => b.ms - a.ms);

  if (taskRows.length){
    ws.addRow(["TASK BREAKDOWN"]).getCell(1).font = { bold: true, size: 12 };
    const taskHeader = ws.addRow(["STORE / TASK","HOURS","% OF TOTAL"]);
    styleReportHeaderRow(ws, taskHeader.number, 3);
    const taskFirstRow = taskHeader.number + 1;
    taskRows.forEach((t, i) => {
      const r = taskFirstRow + i;
      const hrs = +(t.ms / 3600000).toFixed(2);
      const pct = mstat.hours ? +(hrs / mstat.hours).toFixed(4) : 0;
      const row = ws.getRow(r);
      row.getCell(1).value = taskLabel(t);
      row.getCell(2).value = hrs; row.getCell(2).numFmt = "0.00";
      row.getCell(3).value = fv(`IFERROR(B${r}/${totalHoursCellRef},0)`, pct); row.getCell(3).numFmt = "0%";
      if (i % 2 === 1) reportZebra(row);
      reportRowBorder(row, 3);
    });
    reportDataBar(ws, `B${taskFirstRow}:B${taskFirstRow + taskRows.length - 1}`);
    ws.addRow([]);
  }

  ws.addRow(["SHIFT HISTORY"]).getCell(1).font = { bold: true, size: 12 };
  const histHeader = ws.addRow(["DATE","STORE","IN","OUT","BRK (min)","HOURS","RATING","STARS","NOTES"]);
  styleReportHeaderRow(ws, histHeader.number, 9);
  const sortedHist = [...hist].sort((a,b) => b.startedAt - a.startedAt);
  const histFirstRow = histHeader.number + 1;
  sortedHist.forEach((shift, i) => {
    const r = histFirstRow + i;
    const row = ws.getRow(r);
    row.getCell(1).value = new Date(shift.startedAt); row.getCell(1).numFmt = "mmm dd, yyyy";
    row.getCell(2).value = shift.client; row.getCell(2).font = { color: { argb: REPORT_THEME.blue } };
    row.getCell(3).value = clock(shift.startedAt);
    row.getCell(4).value = clock(shift.endedAt);
    row.getCell(5).value = Math.round(shift.breakMs / 60000);
    row.getCell(6).value = +(shift.netMs / 3600000).toFixed(2); row.getCell(6).numFmt = "0.00"; row.getCell(6).font = { bold: true };
    row.getCell(7).value = shift.rating;
    row.getCell(8).value = fv(`REPT("★",G${r})&REPT("☆",5-G${r})`, reportStars(shift.rating));
    row.getCell(8).font = { color: { argb: REPORT_THEME.orange } };
    row.getCell(9).value = shift.note || ""; row.getCell(9).font = { color: { argb: REPORT_THEME.muted } };
    if (i % 2 === 1) reportZebra(row);
    reportRowBorder(row, 9);
  });
  if (sortedHist.length){
    const histLastRow = histFirstRow + sortedHist.length - 1;
    reportDataBar(ws, `F${histFirstRow}:F${histLastRow}`);
    reportRatingScale(ws, `G${histFirstRow}:G${histLastRow}`);
  }
  ws.columns = [{width:13},{width:16},{width:9},{width:9},{width:10},{width:9},{width:8},{width:14},{width:30}];
}

async function exportAllExcel(){
  if (!window.ExcelJS) { toast("Excel export isn't available right now"); return; }
  toast("Building workbook…");
  let snap;
  try { snap = await db.collection("appState").get(); }
  catch (e) { console.error(e); toast("Couldn't load team data"); return; }
  if (snap.empty) { toast("No team member data yet"); return; }

  const members = [];
  snap.forEach(doc => {
    const data = doc.data();
    let s; try { s = JSON.parse(data.json); } catch { s = null; }
    if (s) members.push({ name: s.worker || data.email || "Unnamed", email: data.email || "", hist: s.history || [] });
  });
  if (!members.length) { toast("No team member data yet"); return; }
  members.sort((a,b) => (b.hist||[]).reduce((t,r)=>t+r.netMs,0) - (a.hist||[]).reduce((t,r)=>t+r.netMs,0));

  const logRows = buildShiftLogRows(members);
  const model = computeReportModel(members, logRows);
  // Row ranges are deterministic from counts alone, so they can be computed
  // before any sheet exists - this lets Dashboard (which references both
  // Shift Log and Overview) be added first, giving the correct tab order.
  const logRange = { startRow: 2, lastRow: 1 + logRows.length };
  const overviewRange = { firstRow: 2, lastRow: 1 + model.memberStats.length, totalRow: 2 + model.memberStats.length };

  const wb = new ExcelJS.Workbook();
  fillDashboardSheet(wb.addWorksheet("Dashboard"), model, logRange, overviewRange);
  fillOverviewSheet(wb.addWorksheet("Overview"), model, logRange);
  fillClientsSheet(wb.addWorksheet("Clients"), model, logRange);
  fillShiftLogSheet(wb.addWorksheet("Shift Log"), logRows);
  const used = new Set(["dashboard", "overview", "clients", "shift log"]);
  members.forEach((m, i) => {
    const ws = wb.addWorksheet(safeSheetName(m.name, used));
    fillReportMemberSheet(ws, m, model.memberStats[i], logRange);
  });

  await downloadWorkbook(wb, "team-report-" + new Date().toISOString().slice(0,10) + ".xlsx");
  toast("Team report downloaded");
}

function viewWorker(data, s, uid){
  const hist = s.history || [];
  const name = s.worker || data.email || "Member";
  const rows = hist.length ? hist.map(r => `
    <li>
      <div>
        <div class="h-c">${esc(r.client)}</div>
        <div class="h-d">${dayStamp(r.startedAt)} · ${clock(r.startedAt)}–${clock(r.endedAt)} · ${taskTally(r, r.endedAt).length} task${taskTally(r,r.endedAt).length===1?"":"s"} · ${r.rating}/5</div>
      </div>
      <div class="h-h">${humanDur(r.netMs)}</div>
    </li>`).join("") : `<div class="empty">No closed shifts yet.</div>`;
  const total = hist.reduce((t,r) => t + r.netMs, 0);

  openSheet(`
    <h2>${esc(name)}</h2>
    <p class="hint">${hist.length} shift${hist.length===1?"":"s"} · ${humanDur(total)} net worked</p>
    <ul class="hist">${rows}</ul>
    <button class="btn btn-go" id="assign">Assign task</button>
    <button class="btn" id="mailSum" ${hist.length ? "" : "disabled"}>Email summary…</button>
    <button class="btn btn-ghost btn-sm" id="xl" ${hist.length ? "" : "disabled"}>Export to Excel</button>
    <button class="btn btn-ghost btn-sm" id="dn">Close</button>
    <button class="btn btn-break btn-sm" id="delWorker">Remove Member</button>
  `, () => {
    $("assign").onclick = () => askAssignTask(uid, name);
    $("mailSum").onclick = () => askWorkerSummaryEmail(name, data.email || "", hist);
    // the raw spreadsheet is the admin's audit tool; the email is the
    // readable summary either of you can be sent
    $("xl").onclick = () => exportWorkerExcel(name, data.email || "", hist);
    $("dn").onclick = closeSheet;
    $("delWorker").onclick = () => deleteWorker(uid, name);
  });
}

/* Admin picks a range off the calendar and who receives it: the member
   themselves or the admin's own inbox. Defaults to the current week. */
function askWorkerSummaryEmail(name, workerEmail, hist){
  const me = (auth.currentUser && auth.currentUser.email) || "";
  const startDefault = summaryISO(Date.now() - 6 * 86400000);
  const endDefault = summaryISO(Date.now());
  openSheet(`
    <h2>Email summary</h2>
    <p class="hint">A formatted shift summary for <b>${esc(name)}</b>, strictly inside the range you pick.</p>
    <div class="fpage-dates" style="margin-bottom:16px">
      <label>From <input type="date" id="wsStart" value="${startDefault}"></label>
      <label>To <input type="date" id="wsEnd" value="${endDefault}"></label>
    </div>
    <label class="fld"><span>Send to</span></label>
    <div class="chips" id="wsWho">
      ${workerEmail ? `<button type="button" class="chip" data-v="${esc(workerEmail)}" aria-pressed="true">${esc(name)}</button>` : ""}
      <button type="button" class="chip" data-v="${esc(me)}" aria-pressed="${workerEmail ? "false" : "true"}">Me (${esc(me)})</button>
    </div>
    <p class="hint" id="wsCount"></p>
    <button class="btn btn-go" id="wsSend">Send summary</button>
    <button class="btn btn-ghost btn-sm" id="wsBack">Cancel</button>
  `, () => {
    let to = workerEmail || me;
    wireChips(v => { to = v; });
    const count = () => {
      const n = summaryFilterRows(hist, $("wsStart").value, $("wsEnd").value).length;
      $("wsCount").textContent = n ? `${n} shift${n === 1 ? "" : "s"} in this range.` : "No shifts in this range.";
      $("wsSend").disabled = !n;
      return n;
    };
    $("wsStart").onchange = count; $("wsEnd").onchange = count;
    count();
    $("wsSend").onclick = async () => {
      const a = $("wsStart").value, b = $("wsEnd").value;
      const rows = summaryFilterRows(hist, a, b);
      if (!rows.length) return;
      const btn = $("wsSend");
      btn.disabled = true; btn.textContent = "Sending…";
      closeSheet();
      await queueSummaryEmail({ to, name, rows, rangeLabel: summaryRangeLabel(a, b) });
    };
    $("wsBack").onclick = closeSheet;
  });
}

