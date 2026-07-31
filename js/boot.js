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

  // repair a state corrupted by a crash mid-shift
  if (S.status !== "IDLE" && !S.shift) S.status = "IDLE";
  if (S.status === "ACTIVE"   && S.shift && !openSeg(S.shift))   S.status = "IDLE";
  if (S.status === "ON_BREAK" && S.shift && !openBreak(S.shift)) S.status = "ACTIVE";

  // a shift left open across a shutdown/long gap would otherwise keep
  // silently accruing real elapsed time forever - flag it instead
  const STALE_SHIFT_MS = 16 * 3600000;
  const staleShift = S.status !== "IDLE" && S.shift && (Date.now() - S.shift.startedAt) > STALE_SHIFT_MS;

  render();
  watchAssignedTasks();
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

  if (staleShift) {
    toast("Shift left open a long time — please review and close it");
    askWrapUp();
  } else if (!S.worker) {
    askName();
  }
}

