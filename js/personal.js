/* ============================================================
   PERSONAL MODE
   The third face of the Clocks/Focus switch: a private task list for
   whatever isn't shift work - own errands, side projects, anything you
   want to track and work through with the same Pomodoro/music tools.
   Local only, like the Pomodoro's own state: keyed by uid in
   localStorage, never written to Firestore, never visible to an admin.
   ============================================================ */
const PT_LS = "ez-personal-v1";
let PTasks = [];      // this account's tasks, newest first
let ptUid = null;     // whose list PTasks currently is; null = nobody signed in

const ptKey = () => PT_LS + ":" + ptUid;
const ptSave = () => {
  if (!ptUid) return;
  try { localStorage.setItem(ptKey(), JSON.stringify(PTasks)); } catch (e) {}
};

/* Bring one account's saved list in. Called on sign-in, alongside pomoLoadFor. */
function ptLoadFor(uid){
  ptUid = uid;
  try { PTasks = JSON.parse(localStorage.getItem(ptKey()) || "[]"); }
  catch (e) { PTasks = []; }
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
  if (!PTasks.length){
    list.innerHTML = `<li class="pt-empty">Nothing here yet — add a task above.</li>`;
    return;
  }
  // open tasks first, each group newest-first; a done task doesn't jump
  // around the list the moment you tick it, it just dims in place... except
  // it does need to leave the open group, so it settles at the top of "done"
  const open = PTasks.filter(t => !t.done);
  const done = PTasks.filter(t => t.done);
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
    b.onclick = () => ptDelete(b.closest(".pt-row").dataset.id));
}

function ptToggle(id){
  const t = PTasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  ptSave();
  ptRender();
}
function ptDelete(id){
  PTasks = PTasks.filter(x => x.id !== id);
  ptSave();
  ptRender();
}

/* ---------- the three-way mode switch itself ----------
   Focus keeps owning its own on/off (the theme veil, whether ambient
   sound is idle) via pomoSetMode; this owns which of the three tabs is
   showing and which panel is visible. A running Focus session carries on
   behind Personal exactly like it already does behind Clocks - the Focus
   tab's live dot is the tell either way. */
function setAppMode(mode){   // "clocks" | "focus" | "personal"
  const app = $("appScreen");
  app.classList.toggle("personal-on", mode === "personal");
  [["modeClocks", "clocks"], ["modeFocus", "focus"], ["modePersonal", "personal"]].forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    const on = key === mode;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-selected", String(on));
  });
  pomoSetMode(mode === "focus");
  if (mode === "personal") ptRender();
}

(function ptInit(){
  const panel = $("personalPanel");
  if (!panel) return;
  panel.removeAttribute("hidden");
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
  };
})();
