/* ============================================================
   PERSONAL MODE
   The third face of the Clocks/Focus switch: a private task list for
   whatever isn't shift work - own errands, side projects, anything you
   want to track and work through with the same Pomodoro/music tools.
   Local only, like the Pomodoro's own state: keyed by uid in
   localStorage, never written to Firestore, never visible to an admin.
   ============================================================ */
const PT_LS = "ez-personal-v1";
const PT_MODE_LS = "ez-appmode-v1";   // which tab this account left selected
let PTasks = [];      // this account's tasks, newest first
let ptUid = null;     // whose list PTasks currently is; null = nobody signed in

/* ---------- Focus Anchor: the promoted task in Personal mode's center
   column. Client-side only, same as the mode switch itself - nothing here
   is persisted, so it resets every reload same as a browser tab would. */
let ptActiveId = null;        // id of the task promoted to the anchor, or null
let ptRoundResolved = true;   // false right after a focus round ends with an
                               // active task, until "Mark complete"/"Another
                               // round" is chosen - drives the resolve prompt
let ptSessionDone = 0;        // tasks completed since this page load

const ptKey = () => PT_LS + ":" + ptUid;
const ptSave = () => {
  if (!ptUid) return;
  try { localStorage.setItem(ptKey(), JSON.stringify(PTasks)); } catch (e) {}
};

/* Bring one account's saved list in. Called on sign-in, AFTER pomoLoadFor:
   pomo restores clocks/focus from its own state first, and the saved tab
   ("personal") overrides it here when that's where they left off. */
function ptLoadFor(uid){
  ptUid = uid;
  try { PTasks = JSON.parse(localStorage.getItem(ptKey()) || "[]"); }
  catch (e) { PTasks = []; }
  ptActiveId = null; ptRoundResolved = true; ptSessionDone = 0;
  let mode = null;
  try { mode = localStorage.getItem(PT_MODE_LS + ":" + ptUid); } catch (e) {}
  if (mode === "personal") setAppMode("personal");
  ptRender();
}
/* Called on sign-out, alongside pomoUnload - the next person who signs in
   on this device must never see the last person's personal list. */
function ptUnload(){
  ptUid = null;
  PTasks = [];
  ptActiveId = null; ptRoundResolved = true; ptSessionDone = 0;
  ptRender();
}

const PT_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>';
const PT_FOCUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>';


function ptRender(){
  const list = $("ptList");
  if (!list) return;
  // open tasks first, each group newest-first; a done task doesn't jump
  // around the list the moment you tick it, it just dims in place... except
  // it does need to leave the open group, so it settles at the top of "done"
  const open = PTasks.filter(t => !t.done);
  const done = PTasks.filter(t => t.done);
  const count = $("ptCount");
  if (count) count.textContent = open.length ? open.length + " open" : "";
  if (!PTasks.length){
    list.innerHTML = `<li class="pt-empty">Nothing here yet — add a task above.</li>`;
    renderFocusAnchor();
    return;
  }
  const row = t => `
    <li class="pt-row${t.done ? " is-done" : ""}${t.id === ptActiveId ? " is-anchored" : ""}" data-id="${t.id}">
      <button type="button" class="pt-check" aria-label="${t.done ? "Mark not done" : "Mark done"}">${PT_CHECK_SVG}</button>
      <span class="pt-text">${esc(t.text)}</span>
      ${t.id === ptActiveId ? `<span class="pt-anchor-tag">Focused</span>` : ""}
      ${t.done ? "" : `<button type="button" class="pt-focus" aria-label="Focus on this task" title="Focus on this">${PT_FOCUS_SVG}</button>`}
      <button type="button" class="pt-del" aria-label="Delete task" title="Delete">×</button>
    </li>`;
  list.innerHTML = open.map(row).join("") + done.map(row).join("");
  list.querySelectorAll(".pt-check").forEach(b =>
    b.onclick = () => ptToggle(b.closest(".pt-row").dataset.id));
  list.querySelectorAll(".pt-del").forEach(b =>
    b.onclick = () => ptRemoveAnimated(b.closest(".pt-row")));
  list.querySelectorAll(".pt-focus").forEach(b =>
    b.onclick = () => ptSetActive(b.closest(".pt-row").dataset.id));
  renderFocusAnchor();
}

/* Promotes a task to the Focus Anchor center column. A fresh promotion (not
   just a re-render landing on the same id) always counts as a clean start -
   any unresolved prompt from a previous task doesn't carry over. */
function ptSetActive(id){
  if (ptActiveId === id) return;
  ptActiveId = id;
  ptRoundResolved = true;
  ptRender();
  const anchor = $("focusAnchor");
  if (anchor){
    anchor.classList.remove("is-new");
    void anchor.offsetWidth;   // restart the entrance animation on every promotion
    anchor.classList.add("is-new");
  }
}

/* Animated exit shared by the x button (shrink+fade) and a swipe
   (fly-off in the swipe's direction) - the row leaves like an object,
   then the real delete re-renders the list without it. */
function ptRemoveAnimated(row, dir){
  if (!row || row.classList.contains("is-leaving")) return;
  const id = row.dataset.id;
  row.classList.add("is-leaving");
  if (dir) row.classList.add(dir);
  setTimeout(() => ptDelete(id), 260);
}

function ptToggle(id){
  const t = PTasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  ptSessionDone += t.done ? 1 : -1;
  if (t.done && typeof buzz === "function") buzz(12);   // checking off feels like something
  ptSave();
  ptRender();
}
function ptDelete(id){
  PTasks = PTasks.filter(x => x.id !== id);
  ptSave();
  ptRender();
}

/* ---------- the Focus Anchor itself (Personal mode's center column) ----------
   One render function, one state machine, same pattern as the rest of the
   app's JS-built markup rather than a maze of pre-built hidden blocks:
     - on a break, with an active task, not yet resolved -> resolve prompt
     - on a break otherwise                              -> session summary
     - no active task                                    -> empty state
     - anything else (idle or an actual running round)    -> the task itself
   Cheap enough to call from both discrete state changes (task promoted,
   round advances, mode switch) and pomoTick()'s once-a-second pass (so the
   elapsed/break countdown and the glow actually keep moving) - it no-ops
   immediately unless Personal mode is the one on screen. */
function renderFocusAnchor(){
  const anchor = $("focusAnchor"), inner = $("anchorInner");
  if (!anchor || !inner) return;
  if (!$("appScreen").classList.contains("personal-on")) return;

  const task = ptActiveId ? PTasks.find(t => t.id === ptActiveId) : null;
  if (!task || task.done) ptActiveId = null;

  const onBreak = PM.phase !== "focus";
  const focusing = PM.phase === "focus" && PM.running;

  if (onBreak && ptActiveId && !ptRoundResolved){
    inner.innerHTML = `
      <p class="anchor-eyebrow">Up next</p>
      <h2 class="anchor-title">${esc(task.text)}</h2>
      <div class="anchor-rule"></div>
      <div class="anchor-acts">
        <button type="button" class="anchor-act" id="anchorComplete">Mark complete</button>
        <span class="anchor-act-sep" aria-hidden="true">·</span>
        <button type="button" class="anchor-act" id="anchorAnother">Another round</button>
      </div>`;
    $("anchorComplete").onclick = () => ptToggle(ptActiveId);
    $("anchorAnother").onclick = () => { ptRoundResolved = true; pomoAdvance(false); };
    return;
  }
  if (onBreak){
    inner.innerHTML = `
      <p class="anchor-eyebrow">Up next</p>
      <p class="anchor-break-count">${ptSessionDone} task${ptSessionDone === 1 ? "" : "s"} completed this session</p>
      <p class="anchor-break-time">Break ends in ${pomoMMSS(pomoRemainMs())}</p>`;
    return;
  }
  if (!ptActiveId){
    inner.innerHTML = `<p class="anchor-empty">Select a task</p>`;
    return;
  }
  const elapsed = pomoMMSS(pomoTotalMs("focus") - pomoRemainMs());
  // same done/now math pomoRender() uses for the ring's own dots, so this
  // row and the timer can never silently drift out of sync with each other
  const doneRounds = PM.round - 1;
  const dots = Array.from({ length: POMO_ROUNDS }, (_, i) =>
    `<span class="pomo-dot${i < doneRounds ? " is-done" : (i === doneRounds && focusing ? " is-now" : "")}"></span>`).join("");
  // Not another countdown - the rail's ring already owns that. This is the
  // zoomed-out number: how far through the whole 4-round set, completed
  // rounds plus this round's own fraction, folded into one value.
  const sessionFrac = Math.max(0, Math.min(1, (doneRounds + (pomoTotalMs("focus") - pomoRemainMs()) / pomoTotalMs("focus")) / POMO_ROUNDS));
  const pct = Math.round(sessionFrac * 100);
  // stroke-dasharray/-dashoffset instead of a computed arc path: a path's
  // "d" isn't reliably transitionable across browsers, so every render used
  // to make the ring jump straight to its new position. Circumference of
  // r=44 is fixed, so only the offset needs recalculating each tick, and
  // the CSS transition on it does the smooth fill for free.
  const ringCirc = 2 * Math.PI * 44;
  const ringOffset = ringCirc * (1 - sessionFrac);
  inner.innerHTML = `
    <div class="anchor-ring-wrap">
      <svg class="anchor-ring" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <linearGradient id="anchorRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#6bf07d"/>
            <stop offset="100%" stop-color="#00AE0B"/>
          </linearGradient>
        </defs>
        <circle class="anchor-ring-track" cx="50" cy="50" r="44"></circle>
        <circle class="anchor-ring-fill" cx="50" cy="50" r="44"
                stroke-dasharray="${ringCirc.toFixed(2)}" style="stroke-dashoffset:${ringOffset.toFixed(2)}"></circle>
      </svg>
      <span class="anchor-ring-pct"><b>${pct}%</b><small>Session</small></span>
    </div>
    <p class="anchor-eyebrow">${focusing ? "Focusing on" : "Up next"}</p>
    <h2 class="anchor-title">${esc(task.text)}</h2>
    <div class="anchor-rule"></div>
    <p class="anchor-meta">Round ${PM.round} of ${POMO_ROUNDS} · ${elapsed} elapsed</p>
    <div class="anchor-dots">${dots}</div>`;
}

/* ---------- the three-way mode switch itself ----------
   This owns which tab and panel is showing; pomoSetMode owns what the
   timer needs (theme veil, idle-sound cleanup). The timer is ON for both
   Focus and Personal - Personal is the task list PLUS the full pomo
   (music, themes, settings, the alarm), so working a personal task has
   every focus tool right there. A running session carries across any
   tab switch; the Focus tab's live dot is the tell. */
function setAppMode(mode){   // "clocks" | "focus" | "personal"
  const app = $("appScreen");
  app.classList.toggle("personal-on", mode === "personal");
  const ptSection = $("personalTasksSection");
  if (ptSection) ptSection.classList.toggle("hidden", mode !== "personal");
  // Focus mode gets its own card (today's pomos/time/streak) in place of
  // Daily Mission, which is shift/punch data - irrelevant mid focus session.
  // personal-on hides missionCard on its own (see personal.css); this only
  // needs to arbitrate clocks vs focus.
  const missionCard = $("missionCard"), focusCard = $("focusCard");
  if (missionCard) missionCard.classList.toggle("hidden", mode === "focus");
  if (focusCard) focusCard.classList.toggle("hidden", mode !== "focus");
  [["modeClocks", "clocks"], ["modeFocus", "focus"], ["modePersonal", "personal"]].forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    const on = key === mode;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-selected", String(on));
  });
  pomoSetMode(mode !== "clocks");
  if (mode === "personal") ptRender();
  if (mode === "focus" && typeof pomoRenderFocusCard === "function") pomoRenderFocusCard();
  // remember the tab per account, so a reload lands back where they were
  if (ptUid) try { localStorage.setItem(PT_MODE_LS + ":" + ptUid, mode); } catch (e) {}
}

(function ptInit(){
  const panel = $("personalTasksSection");
  if (!panel) return;
  const modePersonal = $("modePersonal");
  if (modePersonal) modePersonal.onclick = () => setAppMode("personal");

  $("ptAddForm").onsubmit = (e) => {
    e.preventDefault();
    const input = $("ptInput");
    const text = input.value.trim();
    if (!text) return;
    PTasks.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text, done: false
    });
    input.value = "";
    ptSave();
    ptRender();
    // only the just-added row animates in - re-renders from toggles
    // shouldn't make the whole list dance
    const first = $("ptList").querySelector(".pt-row");
    if (first) first.classList.add("is-new");
  };
})();
