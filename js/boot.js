/* ============================================================
   WORKER APP BOOT (called once, after login as a worker)
   ============================================================ */
let workerStarted = false;
let isAdmin = false;
// module-level so the card's dot menu can decide whether to offer "Assign
// task" - the bottom nav no longer carries that entry
let canAssignTasks = false;

// Anything started for a signed-in user that outlives a single render -
// the tick timer, wake listeners, Firestore subscriptions. Sign-out has to
// tear all of it down: without this a second sign-in stacks a fresh copy of
// each on top of the old ones, and the PREVIOUS user's assignment listener
// keeps firing and overwriting "Assigned to you" for whoever signed in next.
let sessionCleanups = [];
const onSessionEnd = fn => sessionCleanups.push(fn);
function endSession(){
  sessionCleanups.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  sessionCleanups = [];
}

async function startWorkerApp(){
  if (workerStarted) return;
  workerStarted = true;

  const saved = await Store.read();
  if (saved) S = Object.assign(S, saved);
  userPhoto = Store.getPhoto();

  // repair a state corrupted by a crash mid-shift
  if (S.status !== "IDLE" && !S.shift) S.status = "IDLE";
  if (S.status === "ACTIVE"   && S.shift && !openSeg(S.shift))   S.status = "IDLE";
  // a break with no open entry means resume() got interrupted after closing
  // the break but before reopening a seg - finish what it started (same
  // move resume() itself makes) instead of leaving ACTIVE with no open seg,
  // which crashes the next Switch/Pause tap
  if (S.status === "ON_BREAK" && S.shift && !openBreak(S.shift)){
    const last = [...S.shift.segs].pop();
    if (last) S.shift.segs.push({ task: last.task, startedAt: Date.now(), endedAt: null, via: "resume" });
    S.status = last ? "ACTIVE" : "IDLE";
  }

  // a shift left open across a shutdown/long gap would otherwise keep
  // silently accruing real elapsed time forever - flag it instead
  const STALE_SHIFT_MS = 16 * 3600000;
  const staleShift = S.status !== "IDLE" && S.shift && (Date.now() - S.shift.startedAt) > STALE_SHIFT_MS;

  render();
  watchAssignedTasks();
  watchCampaigns();
  watchNotifications();
  syncDirectory();   // keep this account's name findable for @mentions
  backfillDirectory();   // admin only: seed the directory with the whole team
  applyRoute();   // honor a deep link (#/history etc.) present at sign-in

  const timer = setInterval(tick, 1000);
  onSessionEnd(() => clearInterval(timer));
  const wake = () => { if (!document.hidden) tick(); };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
  onSessionEnd(() => {
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("pageshow", wake);
  });

  if (FB_READY) {
    $("bandSignOut").classList.remove("hidden");
    $("bandSignOut").onclick = () => auth.signOut();
    $("adminAccessBtn").onclick = () => showTeam();
  }

  $("teamProceed").onclick = () => setSidePaneOpen(true);
  $("teamCollapse").onclick = () => setSidePaneOpen(false);
  $("assignedProceed").onclick = () => setSidePaneOpen(true);
  $("assignedCollapse").onclick = () => setSidePaneOpen(false);
  $("cardRestore").onclick = () => setSidePaneOpen(false);
  $("assignPanelMenu").onclick = openCardMenu;

  // the quick-assign icons: header + section heads, shown only to people
  // who can actually assign (auth.js toggles their visibility)
  $("bandAssignBtn").onclick = () => openAssignFlow();
  $("cardAssignBtn").onclick = () => openAssignFlow();
  $("teamPanelAssignBtn").onclick = () => openAssignFlow();

  if (staleShift) {
    toast("Shift left open a long time — please review and close it");
    askWrapUp();
  } else if (!S.worker) {
    askName();
  }
}

