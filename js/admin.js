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
  // reviews are a person's own feedback and a reviewer's queue: both views
  if (r === "reviews") return true;
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
  amLast = null; amOrgAsked = false; amRt = { period: "month", roleId: "", typeId: "" };
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
  /* Two things the home used to say nothing about, and both were read
     as "the flow does not work": work that is WITH the admin (it sits
     on the Me screen, behind the switch, and the Admin home never said
     so), and work of a tracked kind that is on no step at all - made
     before the steps were saved, or whose run failed to start - which
     nobody holds and so no list anywhere shows. */
  d.mine = null; d.stuck = null;
  const org = typeof orgS !== "undefined" && orgS ? orgS : null;
  if (org && typeof itemsByFacet === "function" && typeof auth !== "undefined" && auth.currentUser){
    const doneOf = t => (typeof itemDoneStatus === "function" && itemDoneStatus(t)) || "done";
    const typeOf = id => (org.types || []).find(t => t.id === id) || null;
    jobs.push(itemsByFacet("assignee:" + auth.currentUser.uid, 200).then(rows => {
      d.mine = rows.filter(it => it.status !== doneOf(typeOf(it.typeId))).length;
    }).catch(e => { console.error(e); d.errors.mine = true; }));
    if (owner && typeof itemsStuckOf === "function"){
      d.stuck = [];
      (org.types || []).filter(t => t.workflowId).forEach(t =>
        jobs.push(itemsStuckOf(t).then(rows => { if (rows.length) d.stuck.push({ typeId: t.id, type: t.name || "Work", n: rows.length }); })
          .catch(e => { console.error(e); d.errors.stuck = true; })));
    }
  }
  /* The board: the org's review documents, every status, read by any
     member (the rules let a person see their own feedback, and the board
     is the same documents). A failed read is recorded, so the panel can
     say "could not reach" instead of "nobody reviewed yet". */
  if (org && typeof rvLoadAll === "function" && typeof rtBoard === "function"){
    d.members = (org.members || []).map(m => ({ uid: m.uid, roleId: m.roleId || null,
      name: typeof orgPersonName === "function" ? orgPersonName(m.uid) : m.uid }));
    d.roles = org.roles || []; d.types = org.types || [];
    d.reviews = null;
    jobs.push(rvLoadAll(org.orgId).then(r => { d.reviews = r; }).catch(e => { console.error(e); d.errors.reviews = true; }));
  }
  await Promise.all(jobs);
  return d;
}

/* ---------- team performance: the board ---------- */
/* The filters the board is read through. The period is the viewer's own
   calendar (js/rating.js > rtSince); role and kind of work narrow the
   comparison to peers, and both are drawn from the org's own data - a
   member with no role is "No role" and never invented into one. */
let amRt = { period: "month", roleId: "", typeId: "" };

function amQualityHTML(d){
  if (!d.members || typeof rtBoard !== "function") return "";
  const err = d.errors || {};
  const me = amUid();
  const since = rtSince(amRt.period, d.at);
  const reviews = d.reviews || [];
  const rows = rtBoard(reviews, d.members, { now: d.at, since, roleId: amRt.roleId || null, typeId: amRt.typeId || null });
  const inRole = amRt.roleId ? d.members.filter(m => (m.roleId || null) === amRt.roleId).map(m => m.uid) : null;
  const counts = rtCounts(reviews, { since, typeId: amRt.typeId || null, roleIds: inRole });
  const roleName = id => { const r = (d.roles || []).find(x => x.id === id); return r ? r.name : ""; };
  const typeName = id => { const t = (d.types || []).find(x => x.id === id); return t ? t.name : ""; };
  const standout = rtStandout(rows);
  const periodWord = amRt.period === "week" ? "this week" : amRt.period === "month" ? "this month" : "all time";
  /* what waits on ME: everything submitted if I review for the org, else
     what was delegated to me - never my own work */
  const may = typeof rvIsReviewer === "function" && rvIsReviewer();
  const queue = reviews.filter(r => r.status === "submitted" && r.aboutUid !== me && (may || r.reviewerUid === me))
    .sort((a, b) => ((a.submission && a.submission.at) || 0) - ((b.submission && b.submission.at) || 0));

  const chip = (id, label) => '<button type="button" class="am-chip' + (amRt.period === id ? " is-on" : "") + '" data-act="rtperiod" data-id="' + id + '">' + label + '</button>';
  const sel = (act, value, label, opts) => '<label class="am-sel"><span>' + label + '</span><select data-act="' + act + '">' +
    '<option value="">All</option>' + opts.map(o => '<option value="' + esc(o.id) + '"' + (o.id === value ? ' selected' : '') + '>' + esc(o.name) + '</option>').join("") + '</select></label>';

  const card = (k, title, body) => '<div class="am-card am-card-' + k + '"><p class="am-card-k">' + title + '</p>' + body + '</div>';
  const cards =
    card("standout", "Standout performer", standout
      ? '<b>' + esc(standout.name) + '</b><span class="am-card-n">' + rtFmt(standout.rating) + ' <i>/ 5 · ' + standout.n + ' reviewed</i></span><small>' + esc(rtWhy(standout)) + '</small>'
      : '<small>Nobody has ' + RT_MIN_REVIEWS + ' approved contributions ' + periodWord + (amRt.roleId || amRt.typeId ? " under these filters" : "") + '. The first to get there stands here.</small>') +
    card("reviewed", "Reviewed deliverables", '<span class="am-card-n">' + counts.reviewed + ' <i>approved ' + periodWord + '</i></span><small>' + (counts.changes ? counts.changes + ' with changes requested, waiting on a revision.' : 'Nothing is waiting on a revision.') + '</small>') +
    card("waiting", "Awaiting review", '<span class="am-card-n">' + counts.awaiting + ' <i>submitted</i></span><small>' + (queue.length ? queue.length + ' of them ' + (queue.length === 1 ? 'is' : 'are') + ' yours to decide, below.' : counts.awaiting ? 'Delegated to others; none waiting on you.' : 'The queue is empty.') + '</small>');

  const when = at => at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const qrow = r => '<li class="am-row" data-act="rvopen" data-id="' + esc(r.id) + '"><i class="am-dot is-blue"></i>' +
    '<div class="am-row-t"><b>' + esc(r.title || "Work") + '</b><span>' + esc(rvNameOf(r.aboutUid)) + (roleName(r.aboutRoleId) ? ' · ' + esc(roleName(r.aboutRoleId)) : '') +
      esc([r.store, r.stepLabel].filter(Boolean).map(x => ' · ' + x).join("")) + ' · round ' + (r.round || 1) + ' · ' + esc(when(r.submission && r.submission.at)) +
      (r.submission && r.submission.onTime === false ? ' · late' : '') + (r.reviewerUid ? ' · for ' + esc(rvNameOf(r.reviewerUid)) : '') + '</span></div>' +
    '<button type="button" class="am-go" data-act="rvopen" data-id="' + esc(r.id) + '">Review</button></li>';
  const queueHtml = '<div class="am-sub-h"><h3>Needs your review</h3>' + (queue.length ? '<em>' + queue.length + '</em>' : '') + '</div>' +
    (err.reviews ? '<p class="am-err">Could not reach the reviews — check your connection.</p>'
      : d.reviews === null ? '<p class="am-loading">Loading…</p>'
      : queue.length ? '<ul class="am-list">' + queue.slice(0, 8).map(qrow).join("") + '</ul>' + (queue.length > 8 ? '<p class="am-empty">' + (queue.length - 8) + ' more on the Reviews page.</p>' : '')
      : '<p class="am-empty">Nothing is waiting for your review.</p>');

  const pct = (v, n, word) => '<span class="am-lb-num"><b>' + (v == null ? "–" : v + "%") + '</b><small>' + word + (n ? " · " + n : "") + '</small></span>';
  const row = r => '<li class="am-lb-row' + (r.ranked ? "" : " is-building") + '" data-act="rtperson" data-id="' + esc(r.uid) + '">' +
    '<span class="am-lb-rank">' + (r.ranked ? r.rank : "–") + '</span>' +
    '<span class="am-lb-who"><b>' + esc(r.name) + '</b><small>' + esc(roleName(r.roleId) || "No role") + '</small></span>' +
    '<span class="am-lb-rating">' + (r.ranked
      ? '<b>' + rtFmt(r.rating) + '</b><small>/ 5 · ' + r.n + ' reviewed</small>'
      : r.n ? '<b class="am-build">Building data</b><small>' + r.n + ' of ' + r.min + ' reviewed' + (r.rating != null ? ' · ' + rtFmt(r.rating) + ' so far' : '') + '</small>'
            : '<b class="am-build">No reviews yet</b><small>nothing approved ' + periodWord + '</small>') + '</span>' +
    '<span class="am-lb-num"><b>' + r.n + '</b><small>reviewed</small></span>' +
    pct(r.onTimePct, r.onTimeN, "on time") +
    pct(r.firstPassPct, r.n, "first pass") +
    '<span class="am-lb-num"><b>' + r.revisions + '</b><small>revisions</small></span>' +
    '</li>';
  const head = '<li class="am-lb-head" aria-hidden="true"><span></span><span>Employee</span><span>Rating</span><span>Reviewed</span><span>On time</span><span>First pass</span><span>Revisions</span></li>';

  return '<section class="am-panel am-quality">' +
    '<div class="am-panel-h"><h2>Team performance</h2><em>' + counts.reviewed + ' approved ' + periodWord + (counts.awaiting ? ' · ' + counts.awaiting + ' awaiting review' : '') + '</em></div>' +
    '<div class="am-filters">' +
      '<span class="am-chips">' + RT_PERIODS.map(p => chip(p[0], p[1])).join("") + '</span>' +
      sel("rtrole", amRt.roleId, "Role", (d.roles || []).map(r => ({ id: r.id, name: r.name || r.id }))) +
      sel("rttype", amRt.typeId, "Work type", (d.types || []).map(t => ({ id: t.id, name: t.name || t.id }))) +
    '</div>' +
    (err.reviews ? '<p class="am-err">Could not reach the reviews — the numbers below may be stale.</p>' : "") +
    '<div class="am-cards">' + cards + '</div>' +
    '<div class="am-lb-wrap">' + (rows.length ? '<ul class="am-lb">' + head + rows.map(row).join("") + '</ul>' : '<p class="am-empty">' + (amRt.roleId ? "Nobody holds that role." : "Nobody is seated in the organization yet.") + '</p>') + '</div>' +
    '<p class="am-foot">A contribution’s rating is execution quality × 50% + brief accuracy × 30% + handoff readiness × 20%, out of 5, given with written feedback by its reviewer. ' +
      'A person’s rating is the mean of their approved contributions ' + periodWord + '. Ranked from ' + RT_MIN_REVIEWS + ' - a starting line, not a proof - and every percentage shows its count. ' +
      'Revisions update a rating rather than adding one; unreviewed work counts as nothing, never zero. Press a row for the work behind it.</p>' +
    queueHtml +
    '</section>';
}

/* Everything behind one person's number: each approved contribution,
   its three scores, who reviewed it, what they wrote, and the earlier
   rounds - the number is only worth what can be seen under it. Reads
   through the same filters as the board. */
function amPersonSheet(uid){
  const d = amLast || {};
  const m = (d.members || []).find(x => x.uid === uid);
  if (!m || typeof openSheet !== "function") return;
  const since = rtSince(amRt.period, d.at);
  const typeName = id => { const t = (d.types || []).find(x => x.id === id); return t ? t.name : ""; };
  const docs = (d.reviews || []).filter(r => r.aboutUid === uid && (!amRt.typeId || r.typeId === amRt.typeId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const rated = docs.map(r => ({ r, x: rvRating(r) })).filter(p => p.x && p.x.at >= since);
  const open = docs.filter(r => r.status !== "approved");
  const when = at => at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const periodWord = amRt.period === "week" ? "this week" : amRt.period === "month" ? "this month" : "all time";
  const scoreLine = sc => sc ? '<small>' + RT_KEYS.map(k => k[0] + ' ' + sc[k]).join(' · ') + '</small>' : '';
  const rows = rated.map(({ r, x }) => '<li class="am-rv">' +
    '<div class="am-rv-t"><b>' + esc(x.title || "Untitled") + '</b><small>' + esc([r.store, x.stepLabel, typeName(r.typeId)].filter(Boolean).join(" · ")) + ' · reviewed by ' + esc(rvNameOf(x.byUid)) + ' · ' + esc(when(x.at)) + '</small>' +
      (x.feedback ? '<p class="am-rv-fb">“' + esc(x.feedback) + '”</p>' : '') + '</div>' +
    '<div class="am-rv-s"><b>' + rtFmt(x.score) + '</b>' + scoreLine(x.scores) + '</div>' +
    '<div class="am-rv-f">' + (x.revisions ? '<i>' + x.revisions + (x.revisions === 1 ? " revision" : " revisions") + '</i>' : '<i class="is-good">first pass</i>') +
      (x.onTime === true ? '<i class="is-good">on time</i>' : x.onTime === false ? '<i class="is-late">late</i>' : '<i>no deadline</i>') + '</div>' +
    '</li>').join("");
  const pending = open.map(r => '<li class="am-rv is-open"><div class="am-rv-t"><b>' + esc(r.title || "Untitled") + '</b><small>' + esc([r.store, r.stepLabel].filter(Boolean).join(" · ")) + ' · ' + esc(rvStatusWord[r.status] || r.status) + ' · round ' + (r.round || 1) + '</small></div></li>').join("");
  const avg = rtMeanTenths(rated.map(p => p.x.tenths));
  openSheet('<h3 class="sheet-title">' + esc(m.name) + '</h3>' +
    '<p class="org-note">' + (rated.length ? rtFmt(avg) + ' / 5 across ' + rated.length + (rated.length === 1 ? ' approved contribution ' : ' approved contributions ') + periodWord + '.' : 'Nothing of theirs has been approved ' + periodWord + '.') +
      (rated.length && rated.length < RT_MIN_REVIEWS ? ' Building data: ' + rated.length + ' of ' + RT_MIN_REVIEWS + '.' : '') + '</p>' +
    (rows ? '<ul class="am-rvs">' + rows + '</ul>' : "") +
    (pending ? '<p class="org-sub">Open</p><ul class="am-rvs">' + pending + '</ul>' : "") +
    '<button class="btn btn-ghost btn-sm" id="amPsClose">Close</button>', () => { $("amPsClose").onclick = closeSheet; });
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
  if (err.stuck) needs += '<li class="am-err">Could not check for work stuck on no step — check your connection.</li>';
  (d.stuck || []).forEach(st => { needCount++;
    needs += row("stuck", st.typeId, "orange", n(st.n) + " " + esc(st.type) + (st.n === 1 ? " is" : " are") + " on no step",
      "Made before the steps were saved, or the steps did not start — nobody holds " + (st.n === 1 ? "it" : "them"), "Start", "stuck"); });
  if (err.mine) needs += '<li class="am-err">Could not reach the work assigned to you — check your connection.</li>';
  if (d.mine) { needCount++;
    needs += row("me", "", "green", n(d.mine) + (d.mine === 1 ? " piece of work is" : " pieces of work are") + " with you",
      "Work given to you sits on your Me screen, not here", "Me →", "me"); }
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
    + '<section class="am-panel am-needs">' + needsHead + needsBody + '</section>'
    + amQualityHTML(d);
}

function amRenderHome(host, d){
  host.innerHTML = amHomeHTML(d);
  if (!host.dataset.amBound){
    host.dataset.amBound = "1";
    host.addEventListener("click", amClick);
    // the two selects on the board: a change redraws through the filter
    host.addEventListener("change", e => {
      const el = e.target.closest("select[data-act]");
      if (!el) return;
      if (el.dataset.act === "rtrole") amRt.roleId = el.value;
      else if (el.dataset.act === "rttype") amRt.typeId = el.value;
      else return;
      if (amLast) amRenderHome(host, amLast);
    });
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
    case "me": amSet(false); break;
    case "stuck": {
      const t = ((typeof orgS !== "undefined" && orgS && orgS.types) || []).find(x => x.id === id);
      if (!t || typeof itemsStartStuck !== "function") break;
      el.disabled = true;
      itemsStartStuck(t).then(r => {
        toast(r.started ? r.started + " sent to step 1" + (r.failed ? ", " + r.failed + " could not start" : "") : "None could be started - see the console.");
        amRefresh();
      });
      break;
    }
    case "rtperiod": amRt.period = id; if (amLast) amRenderHome($("adminHome"), amLast); break;
    case "rtperson": amPersonSheet(id); break;
    case "rvopen": { const r = ((d.reviews) || []).find(x => x.id === id); if (r && typeof rvReviewSheet === "function") rvReviewSheet(r); break; }
    case "refresh": amRefresh(); break;
  }
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { amDerive, amQualityHTML };
}
