/* Admin mode — js/admin.js.

     node tests/admin.test.mjs

   One switch, two screens. What this file pins: the switch exists only
   for an account with something to administer; Admin view hides the
   worker's pages and shows the home, Me view is the worker's screen and
   nothing else; the classic screen is untouched; and the home says
   "could not reach" rather than "nothing to do" when a read fails. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 200)); }
};

const dom = new JSDOM(`<!doctype html><html><body class="ui-next">
  <div id="appScreen" class="app panes">
    <aside id="rail"></aside>
    <button id="assignLaunch" class="hidden"></button><button id="adminAccessBtn" class="hidden"></button>
    <button id="cardAssignBtn" class="hidden"></button><button id="teamPanelAssignBtn" class="hidden"></button>
    <main class="stage"><div class="clock"></div><section id="adminHome" class="hidden"></section>
      <aside id="assignedTasksSection" class="hidden"></aside><aside id="teamPanel" class="hidden"></aside></main>
    <nav id="drawerNav">
      <a class="drawer-item" href="#/" data-route=""><span class="drawer-txt">Dashboard</span></a>
      <a class="drawer-item" id="drawerMission" href="#/mission" data-route="mission"><span class="drawer-txt">Daily Mission</span></a>
      <a class="drawer-item" id="drawerHistory" href="#/history" data-route="history"><span class="drawer-txt">History</span></a>
      <a class="drawer-item hidden" id="drawerTeam" href="#/team" data-route="team"><span class="drawer-txt">Team</span></a>
      <a class="drawer-item" id="drawerWork" href="#/work" data-route="work"><span class="drawer-txt">Work</span></a>
      <a class="drawer-item hidden" id="drawerOrg" href="#/org" data-route="org"><span class="drawer-txt">Organization</span></a>
    </nav>
    <button id="drawerMode" class="hidden"></button>
  </div></body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
ctx.firebase = { initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; } };
ctx.console = console;
["js/config.js", "js/rating.js", "js/permissions.js", "js/reviews.js", "js/rail.js", "js/admin.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
vm.runInContext(`var isAdmin = false, isMember = false, canAssignTasks = false;
  var assignedTasksSeen = null;
  function todayISO(){ return "2026-09-12"; }
  var __calls = []; function approvePendingSheet(uid, data){ __calls.push(["approve", uid, data.email]); }
  function rejectPendingUser(uid, email){ __calls.push(["reject", uid, email]); }
  function go(r){ __calls.push(["go", r]); } function openComposer(){ __calls.push(["assign"]); }
  rlShell(); rlBuild();`, ctx);
const run = expr => vm.runInContext(expr, ctx);
// values crossing out of the jsdom realm are another realm's arrays, which
// strict deepEqual refuses; round-trip through JSON for comparisons
const runJ = expr => JSON.parse(run("JSON.stringify(" + expr + ")"));
const doc = dom.window.document;
const hidden = id => doc.getElementById(id).classList.contains("hidden");
const body = () => doc.body.classList;

T("a worker has no switch and gets the worker screen, gated as before", () => {
  run(`isAdmin = false; canAssignTasks = false; localStorage.clear(); amApply();`);
  assert.equal(run(`amCapable()`), false);
  assert.equal(run(`amOn()`), false);
  assert.ok(!body().contains("admin-mode"));
  assert.ok(hidden("drawerTeam") && hidden("drawerOrg") && !hidden("drawerHistory") && !hidden("drawerMission"));
  assert.ok(hidden("adminHome"), "the admin home is showing to a worker");
  assert.ok(hidden("amSwitch"), "a worker can see the switch");
  assert.ok(hidden("drawerMode"));
  assert.deepEqual(["team", "org", "history", "mission", "work", ""].map(r => run(`amRouteAllowed(${JSON.stringify(r)})`)),
    [false, false, true, true, true, true]);
});

T("an admin lands in Admin view: the home, Team and Organization; not Mission or History", () => {
  run(`isAdmin = true; canAssignTasks = true; localStorage.clear(); amApply();`);
  assert.equal(run(`amOn()`), true, "Admin view is not the default for an admin");
  assert.ok(body().contains("admin-mode"));
  assert.ok(!hidden("drawerTeam") && !hidden("drawerOrg") && hidden("drawerHistory") && hidden("drawerMission"));
  assert.ok(!hidden("adminHome"), "the home is hidden in Admin view");
  assert.ok(!hidden("amSwitch") && doc.getElementById("amSwitch").classList.contains("is-admin"));
  assert.ok(!hidden("assignLaunch") && !hidden("adminAccessBtn"));
  assert.ok(!doc.getElementById("appScreen").classList.contains("has-team"), "the classic Team pane is on under the new dashboard");
  assert.ok(hidden("teamPanel"));
  assert.ok(/my shift/i.test(doc.getElementById("drawerMode").textContent));
  assert.deepEqual(["team", "org", "history", "mission", "work"].map(r => run(`amRouteAllowed(${JSON.stringify(r)})`)),
    [true, true, false, false, true]);
  // the rail copied the drawer: the worker's pages are gone from it too
  const railShown = [...doc.querySelectorAll(".rail-item")].filter(a => !a.classList.contains("hidden")).map(a => a.dataset.route);
  assert.deepEqual(railShown, ["", "team", "work", "org"]);
});

T("switched to Me, the same admin is a worker: no admin furniture, and it is remembered", () => {
  run(`amSet(false);`);
  assert.equal(run(`amOn()`), false);
  assert.ok(!body().contains("admin-mode"));
  assert.ok(hidden("drawerTeam") && hidden("drawerOrg") && !hidden("drawerHistory") && !hidden("drawerMission"));
  assert.ok(hidden("adminHome") && hidden("assignLaunch") && hidden("adminAccessBtn"));
  assert.ok(!hidden("amSwitch") && !doc.getElementById("amSwitch").classList.contains("is-admin"), "the switch should still be there, showing Me");
  assert.equal(run(`amAdminHere()`), false, "in Me view the deck must treat this admin as a worker");
  assert.equal(run(`localStorage.getItem("ez-adminmode-v1:u1")`), "0", "the choice is not remembered for this account");
  assert.deepEqual(["team", "history"].map(r => run(`amRouteAllowed(${JSON.stringify(r)})`)), [false, true]);
  run(`amApply();`);
  assert.equal(run(`amOn()`), false, "a re-apply forgot the choice");
  run(`amSet(true);`);
  assert.equal(run(`amOn()`), true);
});

T("an org owner who is not an Ez admin gets the switch, Organization, and no Team", () => {
  run(`isAdmin = false; canAssignTasks = false; isMember = true; orgIsOwner = () => true; localStorage.clear(); amApply();`);
  assert.equal(run(`amCapable()`), true);
  assert.ok(body().contains("admin-mode"));
  assert.ok(hidden("drawerTeam"), "Team is an Ez Agency admin page; an owner cannot read what it reads");
  assert.ok(!hidden("drawerOrg") && hidden("adminAccessBtn") && hidden("assignLaunch"));
  run(`delete globalThis.orgIsOwner; isMember = false;`);
});

T("the classic screen is untouched: the role decides, the switch is absent", () => {
  run(`document.body.classList.remove("ui-next"); isAdmin = true; canAssignTasks = true; localStorage.clear(); amApply();`);
  assert.equal(run(`amOn()`), false);
  assert.ok(!body().contains("admin-mode"));
  assert.ok(!hidden("drawerTeam") && !hidden("drawerOrg") && hidden("drawerHistory") && !hidden("drawerMission"));
  assert.ok(doc.getElementById("appScreen").classList.contains("has-team") && !hidden("teamPanel"));
  assert.ok(hidden("amSwitch") && hidden("adminHome"));
  assert.equal(run(`amAdminHere()`), true);
  assert.deepEqual(["team", "history", "mission"].map(r => run(`amRouteAllowed(${JSON.stringify(r)})`)), [true, false, true]);
  run(`document.body.classList.add("ui-next");`);
});

T("sign-out clears the mode so the next account does not inherit it", () => {
  run(`isAdmin = true; canAssignTasks = true; amApply(); amReset();`);
  assert.ok(!body().contains("admin-mode") && hidden("adminHome") && hidden("amSwitch"));
});

/* ---------- the home ---------- */
const H = 3600000, NOW = new Date(2026, 8, 12, 14, 0).getTime();
const fixture = () => ({ at: NOW,
  caps: { admin: true, assign: true, owner: true, member: false, org: true, orgName: "Ez Agency" },
  pending: [{ uid: "p1", name: "Jordan Lee", email: "jordan@ez.com" }],
  assigns: [
    { id: "a1", done: true, ack: false, toName: "Sandy", store: "Alpha", task: "Copy", doneAt: NOW - 20 * 60000, comment: "Drafts up" },
    { id: "a2", done: false, dueDate: "2026-09-02", store: "Beta", task: "Embed", toName: "Prashanna" },
    { id: "a3", done: false, dueDate: "2026-09-30", store: "Gamma", task: "Review" },
    { id: "a4", done: true, ack: true, doneAt: NOW - 3 * H },
    { id: "a5", done: true, ack: false, toName: "Ada", task: "Plan", doneAt: NOW - 5 * H }
  ],
  team: [
    { uid: "u1", name: "Prashanna", status: "done", task: "Review", store: "Gamma", netMs: 6 * H, doc: { raw: {}, state: { worker: "Prashanna" } } },
    { uid: "u2", name: "Sandy", status: "active", task: "Copy", store: "Alpha", netMs: 2 * H, doc: { raw: {}, state: { worker: "Sandy" } } },
    { uid: "u3", name: "Ada", status: "break", task: "Plan", store: "", netMs: 4 * H, doc: { raw: {}, state: { worker: "Ada" } } }
  ],
  gaps: [{ type: "Email campaign", at: 2, label: "Design review", roleId: "designer" }],
  errors: {} });
const host = () => doc.getElementById("adminHome");
const draw = (d) => { run(`amLast = ${JSON.stringify(d)}; amRenderHome($("adminHome"), amLast);`); return host(); };

T("the home derives the queue: approvals, completions to acknowledge, overdue, gaps; and the team in shift order", () => {
  const g = runJ(`amDerive(${JSON.stringify(fixture())})`);
  assert.deepEqual(g.unacked.map(r => r.id), ["a1", "a5"]);
  assert.deepEqual(g.late.map(r => r.id), ["a2"], "overdue is due before today and not done");
  assert.equal(g.open.length, 2);
  assert.deepEqual(g.doneToday.map(r => r.id), ["a1", "a4", "a5"]);
  assert.deepEqual(g.team.map(t => t.name), ["Sandy", "Ada", "Prashanna"], "on shift first, then on break, then clocked out");
  assert.equal(g.onShift, 1); assert.equal(g.onBreak, 1); assert.equal(g.hoursToday, 12 * H);
});

T("drawn: every item that needs the admin is a row with its action on it", () => {
  const h = draw(fixture());
  assert.equal(h.querySelectorAll('.am-needs .am-row').length, 5, "1 approval + 2 completions + 1 overdue + 1 gap");
  assert.ok(h.querySelector('.am-row[data-act="approve"] .am-go'), "no Approve button on the approval");
  assert.ok(h.querySelector('.am-x[data-act="reject"]'), "no reject on the approval");
  assert.equal(h.querySelectorAll('.am-row[data-act="ack"]').length, 2);
  assert.ok(h.querySelector('.am-link[data-act="ackall"]'), "two completions but no Acknowledge all");
  assert.ok(/Overdue · due 2026-09-02/.test(h.querySelector('.am-row[data-act="late"]').textContent));
  assert.ok(/Email campaign will stop at Design review/.test(h.querySelector('.am-row[data-act="gap"]').textContent));
  // the roster and the numbers live on Team; the home carries one line
  assert.ok(!h.querySelector(".am-team") && !h.querySelector(".am-tiles"), "the home still carries the roster or the tiles");
  const pulse = h.querySelector('.am-pulse[data-act="team"]');
  assert.ok(pulse, "no team pulse");
  assert.ok(/1 on shift · 1 on break · 2 open · 1 overdue/.test(pulse.textContent), pulse.textContent);
  assert.ok(/Assign work/.test(h.textContent) && /Invite/.test(h.textContent) && /Export Excel/.test(h.textContent));
});

T("pressing a row does the thing: approve, reject, assign, fix a gap, open the team", () => {
  draw(fixture());
  run(`__calls.length = 0;`);
  host().querySelector('.am-row[data-act="approve"] .am-go').click();
  host().querySelector('.am-x[data-act="reject"]').click();
  host().querySelector('.am-act[data-act="assign"]').click();
  host().querySelector('.am-row[data-act="gap"]').click();
  host().querySelector('.am-pulse').click();
  assert.deepEqual(runJ(`__calls`), [["approve", "p1", "jordan@ez.com"], ["reject", "p1", "jordan@ez.com"], ["assign"], ["go", "org"], ["go", "team"]]);
});

/* Shape 1: a screen that is confidently wrong. */
T("nothing to do says so; a read that failed says THAT, not 'nothing to do'", () => {
  const empty = fixture(); empty.pending = []; empty.assigns = []; empty.team = []; empty.gaps = [];
  let h = draw(empty);
  assert.ok(/Nothing needs you right now/.test(h.textContent));
  assert.ok(/nobody on shift · 0 open/.test(h.querySelector(".am-pulse").textContent));
  const broken = fixture(); broken.pending = null; broken.assigns = null; broken.team = null;
  broken.errors = { pending: true, assigns: true, team: true }; broken.gaps = [];
  h = draw(broken);
  assert.ok(!/Nothing needs you/.test(h.textContent), "a failed read was reported as nothing to do");
  assert.ok(/Could not reach the approvals/.test(h.textContent) && /Could not reach the assignments/.test(h.textContent));
  assert.ok(/could not reach the team/.test(h.querySelector(".am-pulse").textContent), "a failed team read was not said on the pulse");
});

/* ---------- team performance: the board under Needs you ---------- */
const QD = () => {
  const now = new Date(2026, 8, 12).getTime(), DAY = 86400000;
  let n = 0;
  // an approved review document, as js/reviews.js writes it
  const rv = (about, scores, extra) => {
    const tenths = scores.quality * 5 + scores.brief * 3 + scores.handoff * 2;
    const at = now - DAY;
    return Object.assign({ id: "it" + (++n) + ":work:" + about, itemId: "it" + n, nodeId: null, typeId: "t", aboutUid: about, aboutRoleId: null,
      status: "approved", round: 1, submission: { link: null, note: "here", at: at - 1000, byUid: about, iteration: null, dueAt: at, onTime: true },
      decision: { kind: "approved", feedback: "Clean and on brief.", scores, byUid: "u9", at }, history: [],
      weightedTenths: tenths, score: tenths / 10, scores, byUid: "u9", at, month: "2026-09", firstPass: true, revisions: 0, onTime: true,
      title: "Brief", stepLabel: "Write", store: "Alpha", updatedAt: at, version: 2 }, extra || {});
  };
  const pending = { id: "it99:work:u4", itemId: "it99", nodeId: null, typeId: "t", aboutUid: "u4", aboutRoleId: "staff", status: "submitted", round: 2,
    submission: { link: "https://x.example/doc", note: "Second go", at: now - 3600000, byUid: "u4", iteration: null, dueAt: null, onTime: null },
    decision: null, history: [{ round: 1, submission: { link: null, note: "first", at: now - 2 * DAY, byUid: "u4" }, decision: { kind: "changes", feedback: "Tighten it", scores: null, byUid: "u9", at: now - DAY } }],
    reviewerUid: null, title: "Landing page", stepLabel: "", store: "Beta", score: null, weightedTenths: null, scores: null, updatedAt: now - 3600000, version: 3 };
  return {
    at: now, caps: { admin: false, assign: false, owner: true, member: true, org: true, orgName: "Ez" },
    pending: null, assigns: null, team: null, gaps: [], errors: {},
    members: [{ uid: "u2", name: "Sandy", roleId: "manager" }, { uid: "u3", name: "Ada", roleId: "staff" }, { uid: "u4", name: "Bo", roleId: "staff" }],
    roles: [{ id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "t", name: "Task", statuses: [{ key: "open" }, { key: "done" }] }, { id: "v", name: "Video", statuses: [] }],
    reviews: Array.from({ length: 9 }, () => rv("u3", { quality: 5, brief: 4, handoff: 5 }))
      .concat(Array.from({ length: 2 }, () => rv("u4", { quality: 3, brief: 4, handoff: 3 })))
      .concat([rv("u2", { quality: 4, brief: 4, handoff: 4 }, { typeId: "v" }), pending])
  };
};
T("the board draws under Needs you: standout with a reason, the counts, ranked rows with every column, and building data below the minimum", () => {
  run(`amRt = { period: "month", roleId: "", typeId: "" }; rvIsReviewer = () => true; orgPersonName = uid => ({ u2: "Sandy", u3: "Ada", u4: "Bo", u9: "Lead" })[uid] || uid;`);
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(QD())})`);
  const q = doc.querySelector(".am-quality");
  assert.ok(q, "no performance panel");
  assert.match(q.querySelector(".am-card-standout").textContent, /Ada/);
  assert.match(q.querySelector(".am-card-standout").textContent, /4\.70/, "5×.5 + 4×.3 + 5×.2 is 4.70");
  assert.match(q.querySelector(".am-card-standout").textContent, /Consistently strong work/);
  assert.match(q.querySelector(".am-card-reviewed").textContent, /12/);
  assert.match(q.querySelector(".am-card-waiting").textContent, /1/);
  const rows = [...q.querySelectorAll(".am-lb-row")];
  assert.deepEqual(rows.map(r => r.querySelector(".am-lb-who b").textContent), ["Ada", "Bo", "Sandy"]);
  assert.deepEqual([...q.querySelectorAll(".am-lb-head span")].map(x => x.textContent), ["", "Employee", "Rating", "Reviewed", "On time", "First pass", "Revisions"]);
  assert.match(rows[0].querySelector(".am-lb-rating").textContent, /4\.70/);
  assert.match(rows[0].querySelector(".am-lb-rating").textContent, /9 reviewed/);
  assert.match(rows[0].textContent, /100%on time · 9/, "on time carries its count");
  assert.match(rows[0].textContent, /100%first pass · 9/);
  assert.match(rows[1].querySelector(".am-lb-rating").textContent, /Building data/);
  assert.match(rows[1].querySelector(".am-lb-rating").textContent, /2 of 8 reviewed/);
  assert.match(rows[1].querySelector(".am-lb-rating").textContent, /3\.30 so far/);
  assert.match(rows[2].querySelector(".am-lb-rating").textContent, /1 of 8/);
  assert.match(q.querySelector(".am-panel-h em").textContent, /12 approved this month · 1 awaiting review/);
  // the queue: the pending submission is a row with Review on it, naming the person and the round
  const qr = q.querySelector('.am-row[data-act="rvopen"]');
  assert.ok(qr, "no Needs your review row");
  assert.match(qr.textContent, /Landing page/); assert.match(qr.textContent, /Bo · Staff/); assert.match(qr.textContent, /round 2/);
  assert.match(q.querySelector(".am-foot").textContent, /execution quality × 50% \+ brief accuracy × 30% \+ handoff readiness × 20%/);
  assert.match(q.querySelector(".am-foot").textContent, /never zero/);
});
T("the filters narrow the board: period, role, and kind of work; a failed read says could not reach", () => {
  doc.querySelector('[data-act="rtperiod"][data-id="week"]').click();
  assert.equal(run("amRt.period"), "week");
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(QD())})`);
  assert.match(doc.querySelector(".am-panel-h em").textContent, /12 approved this week/);
  // role: only staff are compared, and the manager's row is gone
  run(`amRt.roleId = "staff";`);
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(QD())})`);
  let rows = [...doc.querySelectorAll(".am-lb-row")].map(r => r.querySelector(".am-lb-who b").textContent);
  assert.deepEqual(rows, ["Ada", "Bo"]);
  assert.match(doc.querySelector(".am-card-reviewed").textContent, /11/, "the manager's approval must leave the count with the role filter");
  // kind of work: only the video counts, and Ada has nothing under it
  run(`amRt.roleId = ""; amRt.typeId = "v";`);
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(QD())})`);
  rows = [...doc.querySelectorAll(".am-lb-row")];
  assert.match(rows.find(r => /Sandy/.test(r.textContent)).querySelector(".am-lb-rating").textContent, /1 of 8/);
  assert.match(rows.find(r => /Ada/.test(r.textContent)).querySelector(".am-lb-rating").textContent, /No reviews yet/);
  assert.match(doc.querySelector(".am-card-reviewed").textContent, /1/);
  assert.equal(doc.querySelector('select[data-act="rttype"]').value, "v", "the select does not show the filter it applies");
  // the selects drive the filter through the change handler
  run(`amLast = ${JSON.stringify(QD())}; amRenderHome($("adminHome"), amLast);`);
  const sel = doc.querySelector('select[data-act="rttype"]'); sel.value = ""; sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(run("amRt.typeId"), "");
  const d = QD(); d.errors.reviews = true; d.reviews = null;
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(d)})`);
  assert.match(doc.querySelector(".am-quality").textContent, /Could not reach the reviews/);
  assert.doesNotMatch(doc.querySelector(".am-card-standout").textContent, /Ada/);
  // a home with no org draws no board at all, rather than an empty one
  const bare = QD(); delete bare.members;
  doc.getElementById("adminHome").innerHTML = run(`amHomeHTML(${JSON.stringify(bare)})`);
  assert.equal(doc.querySelector(".am-quality"), null);
  run(`amRt = { period: "month", roleId: "", typeId: "" };`);
});
T("pressing a queue row opens the review sheet; pressing a person opens the work behind their number", () => {
  run(`__calls.length = 0; rvReviewSheet = r => __calls.push(["review", r.id]); openSheet = html => __calls.push(["sheet", html]);`);
  draw(QD());
  doc.querySelector('.am-row[data-act="rvopen"] .am-go').click();
  doc.querySelector('.am-lb-row[data-id="u3"]').click();
  const calls = runJ("__calls");
  assert.deepEqual(calls[0], ["review", "it99:work:u4"]);
  assert.equal(calls[1][0], "sheet");
  assert.match(calls[1][1], /Ada/); assert.match(calls[1][1], /4\.70 \/ 5 across 9 approved contributions this month/);
  assert.match(calls[1][1], /Clean and on brief/, "the explanation behind the number is not in the sheet");
  assert.match(calls[1][1], /reviewed by Lead/);
});

T("an owner who is not an Ez admin gets the org's part of the home and none of the team's", () => {
  const d = fixture(); d.caps = { admin: false, assign: false, owner: true, member: true, org: true, orgName: "Studio North" };
  const h = draw(d);
  assert.equal(h.querySelectorAll('.am-row[data-act="approve"], .am-row[data-act="ack"], .am-row[data-act="late"]').length, 0);
  assert.equal(h.querySelectorAll('.am-row[data-act="gap"]').length, 1);
  assert.ok(!h.querySelector(".am-pulse"), "an owner cannot read the team's shifts, so no pulse");
  assert.ok(/Invite/.test(h.textContent) && !/Export Excel/.test(h.textContent) && !/>Team</.test(h.innerHTML));
});

/* Written, never read - shape 3: the mode is only real if the files that
   used to gate on isAdmin now ask it. */
T("sign-in, sign-out, the router, the queue, the notifications and the approvals all go through the mode", () => {
  const src = f => readFileSync(join(here, "..", "js", f), "utf8");
  assert.ok(/amApply\(\)/.test(src("auth.js")) && /amReset\(\)/.test(src("auth.js")));
  assert.ok(!/drawerTeam"\)\.classList\.toggle\("hidden", !isAdmin\)/.test(src("auth.js")), "auth.js still gates the drawer itself");
  assert.ok(/amRouteAllowed/.test(src("nav.js")));
  assert.ok(/amAdminHere/.test(src("assign.js")) && /amAdminHere/.test(src("notify.js")));
  assert.ok((src("assign.js").match(/amRefresh\(\)/g) || []).length >= 2, "completions and rejections do not refresh the home");
  assert.ok(/amRefresh\(\)/.test(src("team.js")), "an approval does not refresh the home");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
