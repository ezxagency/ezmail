/* ============================================================
   ADMIN MODE — one switch, two screens.

   An admin used to get everything a worker gets PLUS the admin
   furniture, all at once. Now the account picks a view:

     Me      the employee's screen, exactly as a worker sees it -
             clocks, deck, stack, bar, chips, Mission, History
     Admin   the admin home: what needs you (approvals, completions
             to acknowledge, overdue work, handoff gaps) with the
             action on the row, who is on shift right now, today's
             numbers, and one row of quick actions

   The switch exists only for an account with something to
   administer (amCapable): an Ez Agency admin, an assigner, an org
   owner or hours-manager. Everyone else never sees it and gets the
   worker screen, gated exactly as before. The choice is remembered
   per account on this device and defaults to Admin.

   Two gates, one truth still holds: this file decides what the
   SCREEN holds. What the account may WRITE is still isAdmin,
   canAssignTasks and the org role, checked where the write is, and
   firestore.rules behind them. Under the classic screen (?ui=classic)
   nothing here changes anything: the mode is a redesign feature.

   `am` prefix: one shared global scope.
   ============================================================ */

const AM_LS = "ez-adminmode-v1";
let amTimer = 0, amOrgAsked = false, amLast = null, amBusy = false;

function amCapable(){
  return !!((typeof isAdmin !== "undefined" && isAdmin)
    || (typeof canAssignTasks !== "undefined" && canAssignTasks)
    || (typeof orgIsOwner === "function" && orgIsOwner())
    || (typeof orgMaySetHours === "function" && orgMaySetHours()));
}
function amUid(){ return (typeof auth !== "undefined" && auth && auth.currentUser) ? auth.currentUser.uid : ""; }
function amKey(){ return AM_LS + ":" + amUid(); }
function amPref(){ try { return localStorage.getItem(amKey()); } catch (e) { return null; } }
function amOn(){ return uiNextOn() && amCapable() && amPref() !== "0"; }
/* Where the old code asked "isAdmin?" to decide what the SCREEN holds - not
   what the account may write - the answer is now the mode. The classic
   screen keeps asking isAdmin. */
function amAdminHere(){ return uiNextOn() ? amOn() : !!isAdmin; }

function amRouteAllowed(r){
  const nx = uiNextOn(), on = amOn();
  if (r === "team") return !!isAdmin && (!nx || on);
  // the builder is the Organization page seen as one picture: same door
  if (r === "org" || r === "flow") return !!(isAdmin || isMember) && (!nx || on);
  if (r === "history") return nx ? !on : !isAdmin;
  if (r === "mission") return !(nx && on);
  return true;
}

function amSet(on){
  try { localStorage.setItem(amKey(), on ? "1" : "0"); } catch (e) {}
  amApply();
}

/* Everything the mode decides, in one place, applied on sign-in, on the
   switch, and again once the org role has loaded. */
function amApply(){
  const app = $("appScreen");
  if (!app) return;
  const nx = uiNextOn(), on = amOn(), cap = amCapable();
  document.body.classList.toggle("admin-mode", on);
  const set = (id, show) => { const el = $(id); if (el) el.classList.toggle("hidden", !show); };
  set("drawerTeam", !!isAdmin && (!nx || on));
  set("drawerOrg", !!(isAdmin || isMember) && (!nx || on));
  set("drawerFlow", !!(isAdmin || isMember) && (!nx || on));
  set("drawerHistory", nx ? !on : !isAdmin);
  set("drawerMission", !(nx && on));
  set("adminAccessBtn", !!isAdmin && (!nx || on));
  ["assignLaunch", "cardAssignBtn", "teamPanelAssignBtn"].forEach(id => set(id, !!canAssignTasks && (!nx || on)));
  // the classic screen keeps its Team pane as the third column; the new
  // screen has the admin home instead, and in Me mode the deck
  app.classList.toggle("has-team", !!isAdmin && !nx);
  set("teamPanel", !!isAdmin && !nx);

  if (typeof rlSync === "function") rlSync();
  amSwitchSync(cap, on);
  if (on) amHomeShow(); else amHomeHide();
  // the deck follows the mode too - but only once its snapshot has landed,
  // or Me view would open on "No tasks assigned" while the rows were still
  // on their way
  if (typeof renderAssignedQueue === "function" && amUid()
      && typeof assignedTasksSeen !== "undefined" && assignedTasksSeen !== null) renderAssignedQueue();
  // a page the new mode does not offer lands home
  if (typeof applyRoute === "function") applyRoute();

  // the org role (owner, member:hours) arrives after sign-in - ask once,
  // and re-apply only if it changed the answer
  if (!amOrgAsked && amUid() && typeof orgEnsure === "function"){
    amOrgAsked = true;
    Promise.resolve().then(() => orgEnsure()).then(() => {
      if (amCapable() !== cap || amOn() !== on) amApply();
    }).catch(() => {});
  }
}

/* A fresh sign-in must not inherit the last account's mode or home. */
function amReset(){
  amHomeHide();
  amLast = null; amOrgAsked = false;
  document.body.classList.remove("admin-mode");
  const sw = $("amSwitch"); if (sw) sw.classList.add("hidden");
  const dm = $("drawerMode"); if (dm) dm.classList.add("hidden");
}

/* ---------- the switch: in the rail, and in the drawer for phones ---------- */
const AM_ICO = {
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.8"/><path d="M9 2h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8 8 0 1 0 12 20"/><path d="M20 5v6h-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

function amSwitchSync(cap, on){
  const rail = $("rail");
  if (rail && !$("amSwitch")){
    const badge = rail.querySelector(".rail-badge");
    if (badge){
      const el = document.createElement("div");
      el.className = "rail-mode hidden"; el.id = "amSwitch";
      el.setAttribute("role", "tablist"); el.setAttribute("aria-label", "View");
      el.innerHTML = '<span class="rail-mode-thumb"></span>'
        + '<button type="button" class="rail-mode-opt" data-mode="admin" role="tab" title="Admin view">' + AM_ICO.admin + '<span>Admin</span></button>'
        + '<button type="button" class="rail-mode-opt" data-mode="me" role="tab" title="My shift">' + AM_ICO.me + '<span>Me</span></button>';
      badge.insertAdjacentElement("afterend", el);
      el.querySelectorAll(".rail-mode-opt").forEach(b => b.onclick = () => amSet(b.dataset.mode === "admin"));
    }
  }
  // the switch is a redesign feature: the classic screen never shows it
  const nx = uiNextOn();
  const sw = $("amSwitch");
  if (sw){
    sw.classList.toggle("hidden", !(cap && nx));
    sw.classList.toggle("is-admin", on);
    sw.querySelectorAll(".rail-mode-opt").forEach(b =>
      b.setAttribute("aria-selected", String((b.dataset.mode === "admin") === on)));
  }
  const dm = $("drawerMode");
  if (dm){
    dm.classList.toggle("hidden", !(cap && nx));
    dm.innerHTML = (on ? AM_ICO.me : AM_ICO.admin) + '<span>' + (on ? "Switch to my shift" : "Switch to admin view") + '</span>';
    dm.onclick = () => { amSet(!on); if (typeof closeDrawer === "function") closeDrawer(); };
  }
}

/* ---------- the admin home ---------- */
function amHomeShow(){
  const host = $("adminHome");
  if (!host) return;
  host.classList.remove("hidden");
  if (!amLast) host.innerHTML = '<div class="am-loading">Gathering what needs you…</div>';
  else amRenderHome(host, amLast);
  amRefresh();
  if (!amTimer) amTimer = setInterval(amRefresh, 60000);
}
function amHomeHide(){
  const host = $("adminHome");
  if (host) host.classList.add("hidden");
  if (amTimer){ clearInterval(amTimer); amTimer = 0; }
}
async function amRefresh(){
  const host = $("adminHome");
  if (!host || host.classList.contains("hidden") || amBusy) return;
  amBusy = true;
  try { amLast = await amCollect(); amRenderHome(host, amLast); }
  catch (e) { console.error(e); }
  finally { amBusy = false; }
}

/* What the home is made of. Every read is one the account already makes
   elsewhere (the Team page, the Org page), guarded by the same predicate,
   and a read that fails is recorded rather than swallowed - the home has
   to say "could not reach" and not "nothing to do". */
async function amCollect(){
  const owner = typeof orgIsOwner === "function" && orgIsOwner();
  const d = {
    at: Date.now(),
    caps: { admin: !!isAdmin, assign: !!canAssignTasks, owner, member: !!isMember,
      org: !!(typeof orgS !== "undefined" && orgS), orgName: (typeof orgS !== "undefined" && orgS && orgS.org && orgS.org.name) || "" },
    pending: null, assigns: null, team: null, gaps: [], errors: {}
  };
  const jobs = [];
  if (isAdmin && typeof db !== "undefined"){
    jobs.push(db.collection("users").where("role", "==", "pending").get()
      .then(s => { d.pending = []; s.forEach(doc => d.pending.push(Object.assign({ uid: doc.id }, doc.data()))); })
      .catch(e => { console.error(e); d.errors.pending = true; }));
    jobs.push(fetchAssignRows().then(rows => { d.assigns = rows; })
      .catch(e => { console.error(e); d.errors.assigns = true; }));
    jobs.push(db.collection("appState").get().then(snap => {
      const team = [];
      snap.forEach(doc => {
        const raw = doc.data();
        let s; try { s = JSON.parse(raw.json); } catch (e) { s = null; }
        if (!s) return;
        const today = todaysWorkFor(s);
        if (!today) return;
        team.push({ uid: doc.id, name: s.worker || raw.email || "Member", status: today.state,
          task: today.tasks.length ? today.tasks[0].task : "", store: today.stores[0] || "",
          netMs: today.net, doc: { raw, state: s } });
      });
      d.team = team;
    }).catch(e => { console.error(e); d.errors.team = true; }));
  }
  if (owner && typeof hoTrackGaps === "function"){
    (orgS.types || []).forEach(t => hoTrackGaps(t.track, orgS.members || []).forEach(g =>
      d.gaps.push({ type: t.name || "Work", at: g.at, label: g.label, roleId: g.roleId })));
  }
  await Promise.all(jobs);
  return d;
}

/* pure: the groups the home draws, from what was collected */
function amDerive(d){
  const today = typeof todayISO === "function" ? todayISO() : "";
  const assigns = d.assigns || [];
  const unacked = assigns.filter(r => r.done && r.ack === false);
  const late = assigns.filter(r => !r.done && r.dueDate && r.dueDate < today);
  const open = assigns.filter(r => !r.done);
  const doneToday = assigns.filter(r => r.done && r.doneAt && typeof dayStamp === "function" && dayStamp(r.doneAt) === dayStamp(d.at));
  const team = (d.team || []).slice().sort((a, b) => {
    const rank = { active: 0, break: 1, done: 2 };
    return (rank[a.status] - rank[b.status]) || (b.netMs - a.netMs);
  });
  return {
    unacked, late, open, doneToday, team,
    onShift: team.filter(t => t.status === "active").length,
    onBreak: team.filter(t => t.status === "break").length,
    hoursToday: team.reduce((t, x) => t + x.netMs, 0),
    pending: d.pending || [],
    gaps: d.gaps || []
  };
}

const AM_STATUS = { active: "On shift", break: "On break", done: "Clocked out" };

function amHomeHTML(d){
  const g = amDerive(d), c = d.caps, err = d.errors || {};
  const n = x => String(x);
  const row = (act, id, dot, main, sub, btn, btnAct) =>
    '<li class="am-row" data-act="' + act + '"' + (id ? ' data-id="' + esc(id) + '"' : "") + '>'
    + '<i class="am-dot is-' + dot + '"></i>'
    + '<div class="am-row-t"><b>' + main + '</b>' + (sub ? '<span>' + sub + '</span>' : "") + '</div>'
    + (btn ? '<button type="button" class="am-go" data-act="' + btnAct + '"' + (id ? ' data-id="' + esc(id) + '"' : "") + '>' + btn + '</button>' : "")
    + '</li>';

  // ---- needs you ----
  let needs = "", needCount = 0;
  if (c.admin){
    if (err.pending) needs += '<li class="am-err">Could not reach the approvals — check your connection.</li>';
    g.pending.forEach(p => { needCount++;
      needs += row("approve", p.uid, "blue", esc(p.name || p.email || "New account"),
        esc(p.email || "") + " · waiting for approval", "Approve…", "approve")
        .replace('</li>', '<button type="button" class="am-x" data-act="reject" data-id="' + esc(p.uid) + '" aria-label="Reject" title="Reject and delete">' + AM_ICO.x + '</button></li>'); });
    if (err.assigns) needs += '<li class="am-err">Could not reach the assignments — check your connection.</li>';
    g.unacked.forEach(r => { needCount++;
      needs += row("ack", r.id, "green", esc(r.toName || r.toEmail || "Someone") + " finished " + esc([r.store, r.task].filter(Boolean).join(" · ") || "a task"),
        (r.comment ? "“" + esc(r.comment) + "” · " : "") + (r.doneAt ? esc(clock(r.doneAt)) : ""), "OK", "ack"); });
    g.late.forEach(r => { needCount++;
      needs += row("late", r.id, "red", esc([r.store, r.task].filter(Boolean).join(" · ") || "Work"),
        "Overdue · due " + esc(r.dueDate) + (r.toName ? " · " + esc(r.toName) : ""), "Open", "team"); });
  }
  g.gaps.forEach(gp => { needCount++;
    needs += row("gap", "", "orange", esc(gp.type) + " will stop at " + esc(gp.label || ("stop " + (gp.at + 1))),
      "Nobody holds that stop — seat someone or change the track", "Fix", "org"); });
  const needsHead = '<div class="am-panel-h"><h2>Needs you</h2>'
    + (needCount ? '<em>' + n(needCount) + '</em>' : "")
    + (c.admin && g.unacked.length > 1 ? '<button type="button" class="am-link" data-act="ackall">Acknowledge all</button>' : "")
    + '</div>';
  const needsBody = needs
    ? '<ul class="am-list">' + needs + '</ul>'
    : '<p class="am-empty">' + (Object.keys(err).length ? "Some of this could not be reached — see above." : "Nothing needs you right now.") + '</p>';

  // ---- the team, in one line: the roster and the numbers live on Team ----
  let pulse = "";
  if (c.admin){
    const parts = [];
    if (err.team) parts.push("could not reach the team's shifts");
    else if (d.team === null) parts.push("loading the team");
    else parts.push(g.onShift ? n(g.onShift) + " on shift" + (g.onBreak ? " · " + n(g.onBreak) + " on break" : "") : "nobody on shift");
    if (!err.assigns && d.assigns !== null) parts.push(n(g.open.length) + " open" + (g.late.length ? " · " + n(g.late.length) + " overdue" : ""));
    pulse = '<button type="button" class="am-pulse' + (err.team ? " is-err" : "") + '" data-act="team">'
      + '<i class="am-dot ' + (g.onShift ? "is-active" : "is-done") + '"></i>'
      + '<span>' + parts.join(" · ") + '</span><b>Team →</b></button>';
  }

  // ---- quick actions ----
  const act = (a, label, primary) => '<button type="button" class="am-act' + (primary ? " is-primary" : "") + '" data-act="' + a + '">' + label + '</button>';
  const acts = (c.assign ? act("assign", "Assign work", true) : "")
    + (c.owner ? act("invite", "Invite") : "")
    + (c.admin ? act("team", "Team") : "")
    + (c.admin || c.org ? act("work", "Work") : "")
    + (c.admin || c.member ? act("org", "Organization") : "")
    + (c.admin || c.member ? act("flow", "Flow builder") : "")
    + (c.admin ? act("export", "Export Excel") : "");

  return '<header class="am-head">'
    + '<div><p class="am-eyebrow">Admin</p><h1>' + esc(c.orgName || "Ez Agency") + '</h1>'
    +   '<p class="am-sub">What needs you, and who is on. Refreshed ' + esc(clock(d.at)) + '.</p></div>'
    + '<div class="am-acts">' + acts
    +   '<button type="button" class="am-act am-refresh" data-act="refresh" aria-label="Refresh" title="Refresh">' + AM_ICO.refresh + '</button></div>'
    + '</header>'
    + pulse
    + '<section class="am-panel am-needs">' + needsHead + needsBody + '</section>';
}

function amRenderHome(host, d){
  host.innerHTML = amHomeHTML(d);
  if (!host.dataset.amBound){
    host.dataset.amBound = "1";
    host.addEventListener("click", amClick);
  }
}

async function amAckOne(id){
  try { await db.collection("assignments").doc(id).update({ ack: true }); }
  catch (e) { console.error(e); toast("Couldn't acknowledge — check Firestore rules"); }
}

function amClick(e){
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const d = amLast || { pending: [], team: [] };
  const call = (name, ...args) => { if (typeof window[name] === "function") window[name](...args); };
  switch (act){
    case "approve": { const p = (d.pending || []).find(x => x.uid === id); if (p) call("approvePendingSheet", p.uid, p); break; }
    case "reject": { const p = (d.pending || []).find(x => x.uid === id); if (p) call("rejectPendingUser", p.uid, p.email || "this account"); break; }
    case "ack": amAckOne(id).then(amRefresh); break;
    case "ackall": call("ackCompletedAssignments"); setTimeout(amRefresh, 400); break;
    case "assign": call("openComposer"); break;
    case "invite": call("orgInviteSheet"); break;
    case "export": call("exportAllExcel"); break;
    case "team": case "work": case "org": case "flow": call("go", act); break;
    case "late": call("go", "team"); break;
    case "gap": call("go", "org"); break;
    case "refresh": amRefresh(); break;
  }
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { amDerive };
}
