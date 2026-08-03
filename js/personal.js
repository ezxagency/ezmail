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
  ptRender();
}

const PT_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>';

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
    return;
  }
  const row = t => `
    <li class="pt-row${t.done ? " is-done" : ""}" data-id="${t.id}">
      <button type="button" class="pt-check" aria-label="${t.done ? "Mark not done" : "Mark done"}">${PT_CHECK_SVG}</button>
      <span class="pt-text">${esc(t.text)}</span>
      <button type="button" class="pt-del" aria-label="Delete task" title="Delete">×</button>
    </li>`;
  list.innerHTML = open.map(row).join("") + done.map(row).join("");
  list.querySelectorAll(".pt-check").forEach(b =>
    b.onclick = () => ptToggle(b.closest(".pt-row").dataset.id));
  list.querySelectorAll(".pt-del").forEach(b =>
    b.onclick = () => ptRemoveAnimated(b.closest(".pt-row")));
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
  t.doneAt = t.done ? Date.now() : null;
  if (t.done && typeof buzz === "function") buzz(12);   // checking off feels like something
  ptSave();
  ptRender();
}
function ptDelete(id){
  PTasks = PTasks.filter(x => x.id !== id);
  ptSave();
  ptRender();
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
  [["modeClocks", "clocks"], ["modeFocus", "focus"], ["modePersonal", "personal"]].forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    const on = key === mode;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-selected", String(on));
  });
  pomoSetMode(mode !== "clocks");
  if (mode === "personal") ptRender();
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
      text, done: false, createdAt: Date.now(), doneAt: null
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
