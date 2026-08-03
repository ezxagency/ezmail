/* ============================================================
   SUMMARY — the monthly report, as its own page. Was a table wedged
   under the Team roster; now it's the team's real "how's the month
   going" view: headline KPI tiles with a daily trend sparkline each,
   then the same per-member table (now sortable by any column).
   Bucketed by the shift's START date, same rule the old table used - a
   shift that clocks in Aug 1 at 23:00 and out Aug 2 at 02:00 counts
   wholly under Aug 1. Defaulting to the running month is the "reset on
   the 1st": a new month simply starts its own bucket.
   ============================================================ */
let teamMonthSel = null;   // "YYYY-MM"; null = the current month
const monthISO = ts => { const d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1); };
const teamMonth = () => teamMonthSel || monthISO(Date.now());

function monthLabel(month){
  const p = month.split("-").map(Number);
  return new Date(p[0], p[1] - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// one member's numbers for one month, zeros included
function monthlyStatsFor(s, month, now = Date.now()){
  const hist = (s.history || []).filter(r => monthISO(r.startedAt) === month);
  const live = (s.shift && s.status !== "IDLE" && monthISO(s.shift.startedAt) === month) ? s.shift : null;
  const days = new Set(hist.map(r => dayStamp(r.startedAt)));
  let ms = hist.reduce((t, r) => t + r.netMs, 0);
  if (live){ ms += netMs(live, now); days.add(dayStamp(live.startedAt)); }
  const rated = hist.filter(r => r.rating);
  return {
    days: days.size, ms, avgMs: days.size ? ms / days.size : 0,
    shifts: hist.length + (live ? 1 : 0),
    rating: rated.length ? (rated.reduce((t, r) => t + r.rating, 0) / rated.length).toFixed(1) : null
  };
}

const MEMBER_STATUS = {
  ACTIVE:   { cls: "is-active", label: "Active" },
  ON_BREAK: { cls: "is-break",  label: "On break" },
  IDLE:     { cls: "is-idle",   label: "Idle" }
};

/* Whole-team numbers behind the KPI tiles: totals across every member for
   the picked month, plus the two figures monthlyStatsFor doesn't already
   carry at the team level (rated-shift average, days anyone worked). */
function summaryTeamStats(month){
  const now = Date.now();
  let totalMs = 0, totalShifts = 0, ratingSum = 0, ratingCount = 0;
  const activeDays = new Set();
  (teamPageDocs || []).forEach(d => {
    const m = monthlyStatsFor(d.state, month, now);
    totalMs += m.ms; totalShifts += m.shifts;
    (d.state.history || []).forEach(r => {
      if (monthISO(r.startedAt) !== month) return;
      activeDays.add(dayStamp(r.startedAt));
      if (r.rating){ ratingSum += r.rating; ratingCount++; }
    });
  });
  return {
    totalMs, totalShifts,
    avgPerDay: activeDays.size ? totalMs / activeDays.size : 0,
    avgRating: ratingCount ? ratingSum / ratingCount : null
  };
}

// one point per day of the month: the whole team's net ms and shift count,
// same start-date bucketing as monthlyStatsFor - feeds the KPI sparklines
function summaryDailySeries(month){
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const series = Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, ms: 0, shifts: 0 }));
  const now = Date.now();
  (teamPageDocs || []).forEach(d => {
    const s = d.state;
    (s.history || []).forEach(r => {
      if (monthISO(r.startedAt) !== month) return;
      const bucket = series[new Date(r.startedAt).getDate() - 1];
      bucket.ms += r.netMs; bucket.shifts += 1;
    });
    if (s.shift && s.status !== "IDLE" && monthISO(s.shift.startedAt) === month){
      const bucket = series[new Date(s.shift.startedAt).getDate() - 1];
      bucket.ms += netMs(s.shift, now); bucket.shifts += 1;
    }
  });
  return series;
}

/* A tiny inline trend line for a stat tile - not the full interactive chart
   the same series would get as a standalone plot, just a shape that answers
   "is this a normal month". One hue (the app's own mint accent), a soft
   fill under the line, and the current value as a native-tooltip title
   since there's no room here for a real hover layer. */
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

function renderSummaryPage(){
  const box = $("summaryBody");
  if (!box) return;
  if (teamPageDocs === null){
    box.innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
    db.collection("appState").get().then(snap => {
      const docs = [];
      snap.forEach(doc => {
        const data = doc.data();
        let s; try { s = JSON.parse(data.json); } catch { s = null; }
        if (s) docs.push({ id: doc.id, raw: data, state: s });
      });
      teamPageDocs = docs;
      backfillDirectoryFrom(docs);   // keep every teammate @-mentionable
      renderSummaryPage();
    }).catch(e => {
      console.error(e);
      box.innerHTML = `<div class="fpage-panel"><div class="empty">Couldn't load summary data — check Firestore rules allow admin reads.</div></div>`;
    });
    return;
  }
  renderSummaryBody();
}

function renderSummaryBody(){
  const box = $("summaryBody");
  if (!box || !teamPageDocs) return;
  const month = teamMonth();
  const stats = summaryTeamStats(month);
  const series = summaryDailySeries(month);
  const label = monthLabel(month);

  box.innerHTML = `
    <div class="monthly-head">
      <p class="hint">${esc(label)}</p>
      <input type="month" id="summaryMonthPick" value="${esc(month)}" max="${monthISO(Date.now())}" aria-label="Pick a month">
    </div>
    <div class="stat-grid">
      <div class="stat-tile">
        <p class="stat-tile-label">Team hours</p>
        <p class="stat-tile-value">${humanDur(stats.totalMs)}</p>
        <div class="stat-tile-spark">${sparklineSvg(series.map(d => d.ms / 3600000), `Daily hours across ${label}`)}</div>
      </div>
      <div class="stat-tile">
        <p class="stat-tile-label">Shifts logged</p>
        <p class="stat-tile-value">${stats.totalShifts}</p>
        <div class="stat-tile-spark">${sparklineSvg(series.map(d => d.shifts), `Daily shifts across ${label}`)}</div>
      </div>
      <div class="stat-tile">
        <p class="stat-tile-label">Avg / active day</p>
        <p class="stat-tile-value">${stats.avgPerDay ? humanDur(stats.avgPerDay) : "—"}</p>
      </div>
      <div class="stat-tile">
        <p class="stat-tile-label">Avg rating</p>
        <p class="stat-tile-value">${stats.avgRating ? stats.avgRating.toFixed(1) + `<small>/ 5</small>` : "—"}</p>
      </div>
    </div>
    <div id="summaryTable"></div>`;

  const pick = $("summaryMonthPick");
  if (pick) pick.onchange = () => { teamMonthSel = pick.value || null; renderSummaryBody(); };
  renderSummaryTable();
}

/* Member table: same data the old Team-page table showed, now click-to-sort
   on any column instead of a fixed "on the clock, then biggest month" order.
   Sort state persists across re-renders (picking a month keeps your sort). */
const SUMMARY_COLS = [
  { key: "name",   label: "Member" },
  { key: "status", label: "Status" },
  { key: "days",   label: "Days" },
  { key: "hours",  label: "Total Hours" },
  { key: "avg",    label: "Avg / Day" },
  { key: "today",  label: "Today" },
  { key: "break",  label: "Break Today" }
];
let summarySort = { key: "hours", dir: -1 };
function summarySortVal(r, key){
  switch (key){
    case "name": return r.name.toLowerCase();
    case "status": return r.status.label;
    case "days": return r.m.days;
    case "hours": return r.m.ms;
    case "avg": return r.m.avgMs;
    case "today": return r.w ? r.w.net : 0;
    case "break": return r.w ? r.w.brk : 0;
    default: return 0;
  }
}
function summarySortRows(rows){
  const { key, dir } = summarySort;
  return [...rows].sort((a, b) => {
    const av = summarySortVal(a, key), bv = summarySortVal(b, key);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function renderSummaryTable(){
  const box = $("summaryTable");
  if (!box || !teamPageDocs) return;
  const month = teamMonth();
  const now = Date.now();
  const shortDate = (new Date().getMonth() + 1) + "/" + new Date().getDate();
  const initials = n => n.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();

  if (!teamPageDocs.length){
    box.innerHTML = `<div class="fpage-panel"><div class="empty">No team members have signed in yet.</div></div>`;
    return;
  }

  const rows = summarySortRows(teamPageDocs.map(d => ({
    d,
    name: d.state.worker || d.raw.email || "Unnamed",
    status: MEMBER_STATUS[d.state.status] || MEMBER_STATUS.IDLE,
    m: monthlyStatsFor(d.state, month, now),
    w: todaysWorkFor(d.state, now)
  })));

  box.innerHTML = `
    <div class="table-card">
      <table class="assign-table month-table summary-table">
        <thead><tr>
          ${SUMMARY_COLS.map(c => `
            <th data-sort="${c.key}" class="${summarySort.key === c.key ? "is-sorted" : ""}"
                aria-sort="${summarySort.key === c.key ? (summarySort.dir === 1 ? "ascending" : "descending") : "none"}">
              ${esc(c.label === "Today" ? `Today (${shortDate})` : c.label)}${summarySort.key === c.key ? `<span class="summary-sort-arrow">${summarySort.dir === 1 ? "▲" : "▼"}</span>` : ""}
            </th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => `<tr data-row="${i}">
            <td data-label="Member" class="work-name"><span class="mt-member"><span class="mt-avatar">${esc(initials(r.name))}</span>${esc(r.name)}</span></td>
            <td data-label="Status" class="nowrap"><span class="work-status ${r.status.cls}">${r.status.label}</span></td>
            <td data-label="Days" class="nowrap">${r.m.days}</td>
            <td data-label="Total Hours" class="nowrap">${r.m.ms ? humanDur(r.m.ms) : "0h"}</td>
            <td data-label="Avg / Day" class="nowrap">${r.m.avgMs ? humanDur(r.m.avgMs) : "—"}</td>
            <td data-label="Today (${shortDate})" class="nowrap">${humanDur(r.w ? r.w.net : 0)}</td>
            <td data-label="Break Today" class="nowrap">${humanDur(r.w ? r.w.brk : 0)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (summarySort.key === key) summarySort = { key, dir: summarySort.dir * -1 };
      else summarySort = { key, dir: (key === "name" || key === "status") ? 1 : -1 };
      renderSummaryTable();
    };
  });
  box.querySelectorAll("tr[data-row]").forEach(tr => {
    tr.style.cursor = "pointer";
    tr.onclick = () => {
      const r = rows[Number(tr.dataset.row)];
      viewWorker(r.d.raw, r.d.state, r.d.id);
    };
  });
}
