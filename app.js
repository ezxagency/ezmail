/* ============================================================
   CONFIG — edit these four things and nothing else.
   ============================================================ */
const CONFIG = {
  // The team's WhatsApp group invite link (Group info > Invite via link).
  // WhatsApp doesn't support pre-filling text into a group chat, so the
  // report text is auto-copied to the clipboard when this link opens —
  // the worker just pastes it once inside the chat.
  whatsappGroupLink: "https://chat.whatsapp.com/Kyqbe2xXvQxHK9OkIfWXTy",

  clients: [
    "Store Alpha", "Store Beta", "Store Gamma",
    "Store Delta", "Store Epsilon", "Store Zeta"
  ],

  // Keep this list SHORT (5-6). Long task lists kill accuracy.
  tasks: [
    "Copy", "Design", "Task Review", "Task Assign", "Embed"
  ],

  pauseReasons: ["Lunch", "Travel", "Meeting", "Other"]
};

/* ============================================================
   FIREBASE — paste your project's config below.
   Get it from Firebase console > Project settings > Your apps.
   ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyDmSVB6MWWCA_dqdQIrGoZxFSA_fw1OcqY",
  authDomain: "ez-agency-timeclock.firebaseapp.com",
  projectId: "ez-agency-timeclock",
  storageBucket: "ez-agency-timeclock.firebasestorage.app",
  messagingSenderId: "233171568445",
  appId: "1:233171568445:web:883b9f8038b3a346762754"
};
// Anyone on this list is made (or kept) admin on every login - add an
// email here to grant admin access, even to an account that already
// exists and signed in as a regular worker before. Removing an email
// downgrades it back to "worker" on its next login, same way.
const ADMIN_EMAILS = ["ezagency2nd@gmail.com"].map(e => e.toLowerCase());
// Can assign tasks (bottom-nav shortcut) without full admin access -
// no team roster, no approvals, no export, no remove-member. Keep this
// list and the matching Firestore rules (isAssignerEmail()) in sync by
// hand for now - same manual-sync tradeoff as ADMIN_EMAILS already has.
const ASSIGNER_EMAILS = ["prashuchiha34@gmail.com"].map(e => e.toLowerCase());

const FB_READY = !firebaseConfig.apiKey.includes("PASTE");
let auth = null, db = null;
if (FB_READY) {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
}

/* ============================================================
   STORAGE — per-user document in Firestore
   ============================================================ */
const Store = (() => {
  let uid = null, email = null;
  function setUser(u, e) { uid = u; email = e; }
  async function read() {
    if (!uid) return null;
    try {
      const doc = await db.collection("appState").doc(uid).get();
      return doc.exists && doc.data().json ? JSON.parse(doc.data().json) : null;
    } catch (e) { console.error(e); return null; }
  }
  async function write(v) {
    if (!uid) return;
    try {
      await db.collection("appState").doc(uid).set({
        json: JSON.stringify(v), email, name: v.worker || null, updatedAt: Date.now()
      });
    } catch (e) { console.error(e); }
  }
  return { read, write, setUser };
})();

/* ============================================================
   STATE
   shift = { client, startedAt,
             segs:  [{ task, startedAt, endedAt, via }],   // via: start|switch|resume
             breaks:[{ reason, startedAt, endedAt }] }
   Invariant: while ACTIVE exactly one open seg; while ON_BREAK none.
   Therefore  sum(segs) === net working time, always.
   ============================================================ */
let S = { worker:"", status:"IDLE", shift:null, history:[], lastReport:null };

const $ = id => document.getElementById(id);
const save = () => Store.write(S);
const esc = s => String(s).replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c]));

const pad = n => String(n).padStart(2,"0");
const clock = ts => { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const dayStamp = ts => new Date(ts).toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"});

function hms(ms){ const s = Math.max(0, Math.floor(ms/1000));
  return pad(Math.floor(s/3600)) + ":" + pad(Math.floor(s/60)%60) + ":" + pad(s%60); }
function humanDur(ms){
  const s = Math.max(0, Math.round(ms/1000));
  if (s < 60) return s + "s";
  const m = Math.round(s/60);
  return m < 60 ? m + "m" : Math.floor(m/60) + "h " + pad(m%60) + "m";
}

const openSeg   = sh => (sh.segs || []).find(s => !s.endedAt);
// The task clock times the CURRENT task only: the open segment, or - while
// on break - the last one worked, frozen at the moment the break started.
// It must NOT sum every segment: the invariant above guarantees
// sum(segs) === net working time, so a total would just reproduce the
// shift clock digit for digit and the second ring would say nothing.
function taskClockMs(sh, now = Date.now()) {
  if (!sh) return 0;
  const segs = sh.segs || [];
  const seg = openSeg(sh) || segs[segs.length - 1];
  return seg ? segMs(seg, now) : 0;
}
const openBreak = sh => (sh.breaks || []).find(b => !b.endedAt);
const breakMs = (sh, now = Date.now()) => (sh.breaks||[]).reduce((t,b)=>t+((b.endedAt||now)-b.startedAt),0);
const netMs   = (sh, end = Date.now()) => (end - sh.startedAt) - breakMs(sh, end);
const segMs   = (s, now = Date.now()) => (s.endedAt || now) - s.startedAt;
const currentStore = sh => {
  const segs = sh.segs || [];
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].client) return segs[i].client;
  return sh.client;
};

function taskTally(sh, now = Date.now()){
  const m = new Map();
  let store = sh.client;
  (sh.segs||[]).forEach(s => {
    if (s.client) store = s.client;
    const key = store + " " + s.task;
    const cur = m.get(key) || { store, task: s.task, ms: 0 };
    cur.ms += segMs(s, now);
    m.set(key, cur);
  });
  return [...m.values()].sort((a,b) => b.ms - a.ms);
}
const taskLabel = t => (t.store||"").toUpperCase() + " " + t.task.toUpperCase() + " WORK";

/* ============================================================
   RENDER
   ============================================================ */
function render(){
  const st = S.status;
  $("band").dataset.s = st;

  // The band's headline is now always WHO you are (with the person glyph in
  // the markup). The store / break reason it used to carry moves down to the
  // status line, so that signal isn't lost - just demoted.
  $("bandMetaName").textContent = S.worker ? S.worker.toUpperCase() : "Not on shift";

  $("shiftMeta").classList.remove("is-ready");
  if (st === "IDLE"){
    $("bandState").textContent = "Clocked out";
    $("shiftMeta").textContent = "Ready";
    $("shiftMeta").classList.add("is-ready");
    $("taskMeta").textContent = "Idle";
  } else if (st === "ACTIVE"){
    const seg = openSeg(S.shift);
    $("bandState").textContent = "Clocked in · " + currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = seg ? seg.task : "Current task";
  } else {
    const b = openBreak(S.shift);
    $("bandState").textContent = "On break · " + (b.reason||"Break").toUpperCase()
      + " · " + currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = "Paused";
  }

  renderDock();
  renderPunches();
  updateDrawerIdentity();
  refreshOpenPage();
  tick();
}

const DOCK_ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>',
  switch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
};

function renderDock(){
  const d = $("dock"); d.innerHTML = "";
  const mk = (label, cls, fn, icon) => {
    const b = document.createElement("button");
    b.className = "btn " + cls;
    b.innerHTML = (icon ? `<span class="btn-icon">${DOCK_ICONS[icon]}</span>` : "") + esc(label);
    b.onclick = fn; return b;
  };

  if (S.status === "IDLE"){
    d.append(mk("Clock in", "btn-go", askClockIn, "clock"));
  } else if (S.status === "ACTIVE"){
    d.append(mk("Switch task", "", askSwitch, "switch"));
    const row = document.createElement("div"); row.className = "row";
    row.append(mk("Pause", "btn-break btn-sm", askPause, "pause"), mk("Clock out", "btn-ghost btn-sm", askWrapUp, "stop"));
    d.append(row);
  } else {
    const last = [...(S.shift.segs||[])].pop();
    d.append(mk("Resume · " + (last ? last.task : "work"), "btn-go", resume, "clock"));
    d.append(mk("Clock out", "btn-ghost btn-sm", askWrapUp, "stop"));
  }
}

/* One shift's punch card as a flat event list - shared by the dashboard
   card and the Daily Mission page's timeline. */
function punchEvents(sh){
  const ev = [];
  ev.push({ t: sh.startedAt, k: "In", cls: "", n: sh.client });
  (sh.segs||[]).forEach((s, i, arr) => {
    if (s.via !== "switch") return;
    // One row per switch: which store, which task - never two rows for
    // the same action, even when the switch also changed the store.
    let store = s.client;
    if (!store) for (let j = i - 1; j >= 0; j--) { if (arr[j].client) { store = arr[j].client; break; } }
    ev.push({ t: s.startedAt, k: store || sh.client, cls: "k-store", n: s.task });
  });
  (sh.breaks||[]).forEach(b => {
    ev.push({ t: b.startedAt, k: "Break", cls: "k-break", n: b.reason });
    if (b.endedAt){
      const back = (sh.segs||[]).find(s => s.via === "resume" && s.startedAt === b.endedAt);
      ev.push({ t: b.endedAt, k: "Resume", cls: "", n: (back ? back.task + " · " : "") + humanDur(b.endedAt - b.startedAt) });
    }
  });
  if (sh.endedAt) ev.push({ t: sh.endedAt, k: "Out", cls: "k-break", n: humanDur(sh.netMs != null ? sh.netMs : netMs(sh, sh.endedAt)) + " net" });
  ev.sort((a,b) => a.t - b.t);
  return ev;
}

function renderPunches(){
  const ul = $("punches"), sh = S.shift;
  ul.innerHTML = "";
  $("empty").style.display = sh ? "none" : "block";
  if (!sh) return;

  punchEvents(sh).forEach(e => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="punch-t">${clock(e.t)}</span>`
      + `<span class="punch-k ${e.cls}">${e.k}</span>`
      + `<span class="punch-n">${esc(e.n || "")}</span>`;
    ul.append(li);
  });
  if (ul.lastElementChild) ul.lastElementChild.classList.add("stamp-in");
}

function setRingTime(id, ms){
  const s = hms(ms), i = s.lastIndexOf(":");
  const el = $(id);
  el.querySelector(".ring-main").textContent = s.slice(0, i);
  el.querySelector(".ring-sec").textContent = s.slice(i + 1);
}

// Rings are a real progress indicator, not decoration: one full clockwise
// lap = one cycle (8h for the shift ring, 1h for the task ring). Once a
// lap completes it stays behind as a dim fill and a fresh bright arc
// starts sweeping from the top again for the next lap.
const SHIFT_CYCLE_MS = 8 * 3600000;
const TASK_CYCLE_MS = 3600000;
function updateRingProgress(ringId, elapsedMs, cycleMs){
  const ring = $(ringId);
  const lapFill = ring.querySelector(".ring-lap-fill");
  const progress = ring.querySelector(".ring-progress");
  const completedLaps = Math.floor(Math.max(0, elapsedMs) / cycleMs);
  const p = (Math.max(0, elapsedMs) % cycleMs) / cycleMs;
  lapFill.classList.toggle("on", completedLaps >= 1);
  if (p < 0.002) { progress.setAttribute("d", ""); return; }
  // r95.5 + the 9-wide stroke lands the ring's outer edge exactly on the 200
  // viewBox, so the drawn circle fills its box. At r86 the svg wasted 14% of
  // its own width, which made the ring read ~11px small against the comp.
  const theta = p * 360, rad = (theta * Math.PI) / 180;
  const x = (100 + 95.5 * Math.sin(rad)).toFixed(2);
  const y = (100 - 95.5 * Math.cos(rad)).toFixed(2);
  progress.setAttribute("d", `M100,4.5 A95.5,95.5 0 ${theta > 180 ? 1 : 0} 1 ${x},${y}`);
}

function tick(){
  const bar = $("shiftbar");
  updateMissionTick();
  pomoTick();
  if (S.status === "IDLE"){
    setRingTime("shiftClock", 0);
    setRingTime("taskClock", 0);
    updateRingProgress("shiftRing", 0, SHIFT_CYCLE_MS);
    updateRingProgress("taskRing", 0, TASK_CYCLE_MS);
    bar.innerHTML = "";
    return;
  }

  const sh = S.shift, now = Date.now();
  const shiftMs = netMs(sh, now);
  const taskMs = taskClockMs(sh, now);

  setRingTime("shiftClock", shiftMs);
  setRingTime("taskClock", taskMs);
  updateRingProgress("shiftRing", shiftMs, SHIFT_CYCLE_MS);
  updateRingProgress("taskRing", taskMs, TASK_CYCLE_MS);

  if (S.status === "ACTIVE"){
    bar.innerHTML = `<span>Task</span> <b>${humanDur(taskMs)}</b>`
      + (breakMs(sh, now) ? ` <span>· break ${humanDur(breakMs(sh, now))}</span>` : "");
  } else {
    bar.innerHTML = `<span>Shift</span> <b>${humanDur(shiftMs)}</b> <span>· paused</span>`;
  }
}

/* ============================================================
   SHEETS
   ============================================================ */
function openSheet(html, setup){
  $("sheetBody").innerHTML = html;
  $("scrim").classList.add("on");
  $("sheet").classList.add("on");
  if (setup) setup();
}
function closeSheet(){ $("scrim").classList.remove("on"); $("sheet").classList.remove("on"); }
$("scrim").onclick = () => {};   // gated: tapping outside never skips a required field

/* Optionally carries one action ("Undo"). An action toast lingers longer -
   it is asking for a decision, not just narrating - and a new toast always
   cancels the old timer so a quick pair of actions can't cut the second
   toast short. */
let toastTimer = null;
function toast(msg, action){
  const t = $("toast");
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.classList.toggle("has-act", !!action);
  if (action){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { clearTimeout(toastTimer); t.classList.remove("on"); action.run(); };
    t.append(b);
  }
  t.classList.add("on");
  toastTimer = setTimeout(() => t.classList.remove("on"), action ? 6000 : 2100);
}

function chipGroup(list, allowOther){
  return list.map(x => `<button type="button" class="chip" data-v="${esc(x)}" aria-pressed="false">${esc(x)}</button>`).join("")
    + (allowOther ? `<button type="button" class="chip" data-v="__other" aria-pressed="false">Other…</button>` : "");
}
function wireChipsIn(container, onPick){
  const chips = container.querySelectorAll(".chip");
  chips.forEach(c => c.onclick = () => {
    chips.forEach(x => x.setAttribute("aria-pressed","false"));
    c.setAttribute("aria-pressed","true");
    onPick(c.dataset.v);
  });
}
function wireChips(onPick){ wireChipsIn($("sheetBody"), onPick); }
const OTHER_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-#]{1,39}$/;

/* ---------- worker name (once) ---------- */
function askName(){
  openSheet(`
    <h2>Who's on shift?</h2>
    <p class="hint">Your name goes on every report sent to the office. Asked once on this phone.</p>
    <label class="fld"><span>Your name <b class="req">*</b></span>
      <input type="text" id="nm" autocomplete="name" placeholder="e.g. John Smith"></label>
    <button class="btn btn-go" id="ok" disabled>Save name</button>
  `, () => {
    const nm = $("nm"), ok = $("ok");
    nm.oninput = () => ok.disabled = nm.value.trim().length < 2;
    ok.onclick = async () => { S.worker = nm.value.trim(); await save(); closeSheet(); render(); };
    nm.focus();
  });
}

/* ---------- Clock in: store + first task (both mandatory) ---------- */
function askClockIn(){
  openSheet(`
    <h2>Clock in</h2>
    <p class="hint">Store decides who gets billed. Task starts the second clock.</p>

    <label class="fld"><span>Store <b class="req">*</b></span>
      <input type="text" id="cl" autocomplete="organization" placeholder="Enter store name"></label>

    <label class="fld"><span>Starting task <b class="req">*</b></span></label>
    <div class="chips">${chipGroup(CONFIG.tasks, true)}</div>
    <label class="fld" id="tkOtherWrap" style="display:none"><span>Task name <b class="req">*</b></span>
      <input type="text" id="tkOther" placeholder="Short name"></label>

    <button class="btn btn-go" id="ok" disabled>Start shift</button>
    <button class="btn btn-ghost btn-sm" id="cancel">Back</button>
  `, () => {
    let task = "";
    const cl=$("cl");
    const tkOther=$("tkOther"), tkWrap=$("tkOtherWrap"), ok=$("ok");

    const store = () => cl.value.trim();
    const taskV = () => task === "__other" ? tkOther.value.trim() : task;
    const valid = () => {
      const sOk = OTHER_RE.test(store());
      const tOk = task === "__other" ? OTHER_RE.test(taskV()) : !!task;
      return sOk && tOk;
    };
    const sync = () => ok.disabled = !valid();

    cl.oninput = sync;
    tkOther.oninput = sync;
    wireChips(v => { task = v; tkWrap.style.display = v === "__other" ? "block" : "none"; if (v==="__other") tkOther.focus(); sync(); });

    $("cancel").onclick = closeSheet;
    ok.onclick = async () => {
      const now = Date.now();
      S.shift = { client: store(), startedAt: now, segs: [], breaks: [] };
      S.shift.segs.push({ task: taskV(), startedAt: now, endedAt: null, via: "start" });
      S.status = "ACTIVE";
      await save(); closeSheet(); render();
    };
  });
}

/* ---------- Switch task (mandatory) ---------- */
function askSwitch(){
  const seg = openSeg(S.shift);
  const cur = seg.task;
  const curStore = currentStore(S.shift);
  openSheet(`
    <h2>Switch task</h2>
    <p class="hint">Still on the clock — this only splits your time. Currently on <b>${esc(cur)}</b> for ${humanDur(segMs(seg))} at <b>${esc(curStore)}</b>.</p>
    <label class="fld"><span>New task <b class="req">*</b></span></label>
    <div class="chips">${chipGroup(CONFIG.tasks, true)}</div>
    <label class="fld" id="tkOtherWrap" style="display:none"><span>Task name <b class="req">*</b></span>
      <input type="text" id="tkOther" placeholder="Short name"></label>

    <label class="fld"><span>Store <span style="text-transform:none;font-weight:600;color:var(--ink-soft)">— optional, leave blank to stay at ${esc(curStore)}</span></span>
      <input type="text" id="cl" autocomplete="organization" placeholder="Enter store name"></label>

    <button class="btn" id="ok" disabled>Switch</button>
    <button class="btn btn-ghost btn-sm" id="cancel">Back</button>
  `, () => {
    let task = "";
    const tkOther=$("tkOther"), tkWrap=$("tkOtherWrap"), cl=$("cl"), ok=$("ok");

    const taskV = () => task === "__other" ? tkOther.value.trim() : task;
    const storeV = () => cl.value.trim();
    const valid = () => {
      const tOk = task === "__other" ? OTHER_RE.test(taskV()) : !!task;
      const sv = storeV();
      const sOk = !sv || OTHER_RE.test(sv);
      const changed = taskV() !== cur || (sv && sv !== curStore);
      return tOk && sOk && changed;
    };
    const sync = () => ok.disabled = !valid();

    tkOther.oninput = sync;
    cl.oninput = sync;
    wireChips(v => { task = v; tkWrap.style.display = v === "__other" ? "block" : "none"; if (v==="__other") tkOther.focus(); sync(); });

    $("cancel").onclick = closeSheet;
    ok.onclick = async () => {
      const now = Date.now();
      seg.endedAt = now;
      const newStore = storeV();
      const seg2 = { task: taskV(), startedAt: now, endedAt: null, via: "switch" };
      if (newStore && newStore !== curStore){ seg2.client = newStore; }
      S.shift.segs.push(seg2);
      await save(); closeSheet(); render();
      toast("Now on " + taskV() + (seg2.client ? " · " + seg2.client : ""));
    };
  });
}

/* ---------- Pause (mandatory reason) ---------- */
function askPause(){
  openSheet(`
    <h2>Take a break</h2>
    <p class="hint">The task clock stops too. Break time is subtracted from your hours.</p>
    <label class="fld"><span>Reason <b class="req">*</b></span></label>
    <div class="chips">${chipGroup(CONFIG.pauseReasons.filter(r=>r!=="Other"), true)}</div>
    <label class="fld" id="otherWrap" style="display:none"><span>What for? <b class="req">*</b></span>
      <input type="text" id="oth" placeholder="Short note"></label>
    <button class="btn btn-break" id="ok" disabled>Start break</button>
    <button class="btn btn-ghost btn-sm" id="cancel">Back</button>
  `, () => {
    let picked = "";
    const ok=$("ok"), wrap=$("otherWrap"), oth=$("oth");
    const val = () => picked === "__other" ? oth.value.trim() : picked;
    const sync = () => ok.disabled = !(picked && (picked !== "__other" || OTHER_RE.test(val())));
    oth.oninput = sync;
    wireChips(v => { picked = v; wrap.style.display = v === "__other" ? "block" : "none"; if (v==="__other") oth.focus(); sync(); });
    $("cancel").onclick = closeSheet;
    ok.onclick = async () => {
      const now = Date.now();
      openSeg(S.shift).endedAt = now;                       // task clock stops with the shift clock
      S.shift.breaks.push({ reason: val(), startedAt: now, endedAt: null });
      S.status = "ON_BREAK";
      await save(); closeSheet(); render();
    };
  });
}

async function resume(){
  const now = Date.now();
  const b = openBreak(S.shift); b.endedAt = now;
  const last = [...S.shift.segs].pop();
  S.shift.segs.push({ task: last.task, startedAt: now, endedAt: null, via: "resume" });
  S.status = "ACTIVE";
  await save(); render();
}

/* ---------- Clock out (wrap-up + rating, both mandatory) ---------- */
function askWrapUp(){
  const sh = S.shift, now = Date.now();
  const tally = taskTally(sh, now)
    .map(t => `<li><span>${esc(taskLabel(t))}</span><b>${humanDur(t.ms)}</b></li>`).join("");

  openSheet(`
    <h2>Wrap up</h2>
    <p class="hint">Your task clocks for this shift:</p>
    <ul class="tally">${tally}</ul>
    <div id="wrapAssignedDone"></div>
    <label class="fld"><span>Anything to add? <b class="req">*</b></span>
      <textarea id="note" placeholder="Anything left open, anything blocking you."></textarea></label>
    <label class="fld"><span>Rate your day <b class="req">*</b></span></label>
    <div class="stars">${[1,2,3,4,5].map(n=>`<button type="button" class="star" data-n="${n}" aria-pressed="false">${n}</button>`).join("")}</div>
    <p class="hint">1 = rough day · 5 = everything clicked</p>
    <button class="btn btn-go" id="ok" disabled>Close shift</button>
    <button class="btn btn-ghost btn-sm" id="cancel">Back</button>
  `, () => {
    let rating = 0;
    const note = $("note"), ok = $("ok");
    const sync = () => ok.disabled = !(note.value.trim().length >= 3 && rating > 0);
    $("sheetBody").querySelectorAll(".star").forEach(s => s.onclick = () => {
      rating = +s.dataset.n;
      $("sheetBody").querySelectorAll(".star").forEach(x => x.setAttribute("aria-pressed", +x.dataset.n <= rating));
      sync();
    });
    note.oninput = sync;
    $("cancel").onclick = closeSheet;
    ok.onclick = () => closeShift(note.value.trim(), rating);
    loadCompletedAssignmentsForShift(sh.startedAt);
  });
}

// Shows any assigned tasks marked done since this shift started - loaded
// after the sheet is already open so Clock Out never waits on a fetch.
async function loadCompletedAssignmentsForShift(shiftStart){
  const box = $("wrapAssignedDone");
  if (!box || !auth.currentUser) return;
  try {
    const snap = await db.collection("assignments")
      .where("toUid", "==", auth.currentUser.uid)
      .where("done", "==", true)
      .get();
    const rows = [];
    snap.forEach(doc => { const d = doc.data(); if (d.doneAt && d.doneAt >= shiftStart) rows.push(d); });
    if (!rows.length) return;
    box.innerHTML = `
      <p class="hint">Assigned tasks completed this shift:</p>
      <ul class="tally">${rows.map(a => `<li><span>${esc(a.store)} · ${esc(a.task)}</span></li>`).join("")}</ul>
    `;
  } catch (e) {
    console.error(e);
  }
}

async function closeShift(note, rating){
  const now = Date.now(), sh = S.shift;

  const b = openBreak(sh); if (b) b.endedAt = now;          // clocking out mid-break closes it
  const s = openSeg(sh);   if (s) s.endedAt = now;

  const rec = {
    worker: S.worker, client: sh.client,
    startedAt: sh.startedAt, endedAt: now,
    breakMs: breakMs(sh, now), netMs: netMs(sh, now),
    segs: sh.segs, breaks: sh.breaks, note, rating
  };

  S.history.unshift(rec);
  S.lastReport = rec;
  S.shift = null; S.status = "IDLE";
  await save(); closeSheet(); render();
  showReport(rec);
}

/* ---------- Report + WhatsApp ---------- */
function copyTextLegacy(text){
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.fontSize = "16px"; // stops iOS auto-zooming into the field
  document.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
// Must be fully awaited BEFORE any navigation/app-switch - clipboard writes
// lose their permission grant the instant the page loses focus, so calling
// window.open() right after firing this without waiting silently drops it.
async function copyText(text){
  if (navigator.clipboard && navigator.clipboard.writeText){
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  return copyTextLegacy(text);
}

function reportText(r){
  const tasks = taskTally(r, r.endedAt).map(t => `  · ${taskLabel(t)} — ${humanDur(t.ms)}`).join("\n");
  const brk = r.breaks.filter(b=>b.endedAt)
    .map(b => `  · ${b.reason} ${clock(b.startedAt)}–${clock(b.endedAt)} (${humanDur(b.endedAt-b.startedAt)})`).join("\n");
  const lbl = s => (s + ":").padEnd(17);

  return [
    "SHIFT REPORT", dayStamp(r.startedAt), "",
    lbl("Team member") + r.worker,
    lbl("Store") + r.client,
    lbl("Clock In Time") + clock(r.startedAt),
    lbl("Clock Out Time") + clock(r.endedAt),
    lbl("Total worked") + humanDur(r.netMs),
    lbl("Break") + (r.breakMs ? humanDur(r.breakMs) : "none"),
    brk || null, "",
    "TASKS", tasks, "",
    "Rating: " + r.rating + "/5", "",
    "Notes:", r.note
  ].filter(x => x !== null).join("\n");
}

const CHART_COLORS = ["#00AE0B", "#C9A876", "#B5533C", "rgba(255,255,255,.75)", "rgba(255,255,255,.5)", "rgba(255,255,255,.3)"];
const BREAK_COLOR = "#C7C2D1";

function taskChartHTML(tally, breakMs){
  const items = tally.map((t,i) => ({ label: taskLabel(t), ms: t.ms, color: CHART_COLORS[i % CHART_COLORS.length] }));
  if (breakMs) items.push({ label: "BREAK", ms: breakMs, color: BREAK_COLOR });
  if (!items.length) return "";

  const total = items.reduce((t,x) => t + x.ms, 0) || 1;
  let acc = 0;
  const stops = items.map(x => {
    const pct = x.ms / total * 100;
    const seg = `${x.color} ${acc}% ${acc+pct}%`;
    acc += pct;
    return seg;
  }).join(", ");

  const legend = items.map(x => `
    <li>
      <span class="chart-swatch" style="background:${x.color}"></span>
      <span class="chart-bar-label">${esc(x.label)}</span>
      <span class="chart-bar-value">${humanDur(x.ms)} · ${Math.round(x.ms/total*100)}%</span>
    </li>`).join("");

  const bars = items.map(x => `
    <div class="chart-bar-row">
      <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${(x.ms/total*100).toFixed(1)}%;background:${x.color}"></div></div>
    </div>`).join("");

  return `
    <div class="chart-wrap">
      <div class="donut" style="background:conic-gradient(${stops})"></div>
      <ul class="chart-legend">${legend}</ul>
    </div>
    <div class="chart-bars">${bars}</div>
  `;
}

function showReport(r){
  const txt = reportText(r);
  const chart = taskChartHTML(taskTally(r, r.endedAt), r.breakMs);
  openSheet(`
    <h2>Shift closed</h2>
    <p class="hint">Send it to the group now. It's also saved here for the Excel export.</p>
    ${chart}
    <div class="preview">${esc(txt)}</div>
    <button class="btn btn-wa" id="wa">Send on WhatsApp</button>
    <button class="btn btn-ghost btn-sm" id="cp">Copy text</button>
    <button class="btn btn-ghost btn-sm" id="dn">Done</button>
  `, () => {
    $("wa").onclick = async () => {
      const ok = await copyText(txt);
      toast(ok ? "Copied — paste it in the group" : "Opening group — copy the text above first");
      window.open(CONFIG.whatsappGroupLink, "_blank");
    };
    $("cp").onclick = async () => {
      toast(await copyText(txt) ? "Copied" : "Copy failed — select the text above");
    };
    $("dn").onclick = closeSheet;
  });
}

// ---------- Excel helpers (ExcelJS - the free SheetJS build silently drops
// cell styles/colors on write, confirmed by inspecting its output; ExcelJS
// actually writes them) ----------
function styleHeaderRow(ws, rowNum, numCols){
  const row = ws.getRow(rowNum);
  for (let c = 1; c <= numCols; c++){
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  }
}
async function downloadWorkbook(wb, filename){
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function addTableSheet(wb, sheetName, rows, colWidths){
  const ws = wb.addWorksheet(sheetName);
  if (rows.length){
    const headers = Object.keys(rows[0]);
    ws.addRow(headers);
    rows.forEach(r => ws.addRow(headers.map(h => r[h])));
    styleHeaderRow(ws, 1, headers.length);
  }
  if (colWidths) ws.columns = colWidths.map(w => ({ width: w }));
  return ws;
}

async function exportExcel(){
  const shifts = S.history.map(r => ({
    "Date": dayStamp(r.startedAt),
    "Team Member": r.worker,
    "Store": r.client,
    "Clock In Time": clock(r.startedAt),
    "Clock Out Time": clock(r.endedAt),
    "Break (min)": Math.round(r.breakMs/60000),
    "Total Worked (hrs)": +(r.netMs/3600000).toFixed(2),
    "Rating": r.rating,
    "Notes": r.note
  }));

  const detail = [];
  S.history.forEach(r => {
    let store = r.client;
    (r.segs||[]).filter(s=>s.endedAt).forEach(s => {
      if (s.client) store = s.client;
      detail.push({
        "Date": dayStamp(r.startedAt),
        "Team Member": r.worker,
        "Store": store,
        "Task": taskLabel({ store, task: s.task }),
        "Start": clock(s.startedAt),
        "End": clock(s.endedAt),
        "Minutes": Math.round(segMs(s)/60000),
        "Hours": +(segMs(s)/3600000).toFixed(2)
      });
    });
  });

  const name = "shifts-" + new Date().toISOString().slice(0,10);

  if (window.ExcelJS){
    const wb = new ExcelJS.Workbook();
    addTableSheet(wb, "Shifts", shifts, [14,16,16,9,10,11,10,7,48]);
    addTableSheet(wb, "Task Detail", detail, [14,16,16,18,8,8,9,8]);
    await downloadWorkbook(wb, name + ".xlsx");
    toast("Excel file downloaded");
    return;
  }

  const csv = rows => {
    const head = Object.keys(rows[0]);
    const q = v => `"${String(v).replace(/"/g,'""')}"`;
    return [head.join(",")].concat(rows.map(r => head.map(h => q(r[h])).join(","))).join("\n");
  };
  const dl = (rows, suffix) => {
    if (!rows.length) return;
    const url = URL.createObjectURL(new Blob(["\ufeff"+csv(rows)], {type:"text/csv"}));
    const a = document.createElement("a"); a.href = url; a.download = name + suffix + ".csv"; a.click();
    URL.revokeObjectURL(url);
  };
  dl(shifts, "-shifts"); dl(detail, "-tasks");
  toast("CSV files downloaded");
}

/* ---------- the panes' vertical-dot menus ----------
   The comp's bottom nav carries only three icons, so Assign task and Profile
   live here instead of being dropped. Rendered as a sheet rather than a
   popover so it reuses the app's one dismissal path on every screen size. */
function menuSheet(title, items){
  openSheet(`
    <h2>${esc(title)}</h2>
    ${items.map((it, i) => `<button class="btn ${it.cls || "btn-ghost"} btn-sm" id="menuItem${i}">${esc(it.label)}</button>`).join("")}
    <button class="btn btn-ghost btn-sm" id="menuClose">Close</button>
  `, () => {
    items.forEach((it, i) => $("menuItem" + i).onclick = () => { closeSheet(); it.run(); });
    $("menuClose").onclick = closeSheet;
  });
}

// Assign lives in the drawer now, so it is not repeated here.
function openCardMenu(){
  menuSheet("Daily Mission", [
    { label: "Open full page", cls: "btn-go", run: () => go("mission") },
    { label: "History", run: () => go("history") },
    { label: "Profile", run: showProfile }
  ]);
}

function openTeamMenu(){
  menuSheet("Team", [
    { label: "Full team page", cls: "btn-go", run: showTeam },
    { label: "Export team report", run: exportAllExcel }
  ]);
}

$("cardMenu").onclick = openCardMenu;
$("teamMenu").onclick = openTeamMenu;
// the person glyph + name in the header is the profile control
$("bandMeta").onclick = showProfile;

function showProfile(){
  const email = (auth && auth.currentUser && auth.currentUser.email) || "";
  openSheet(`
    <h2>Profile</h2>
    <label class="fld"><span>Name</span>
      <input type="text" id="profName" value="${esc(S.worker||"")}" placeholder="Your name"></label>
    <p class="hint">${esc(email)}</p>
    <button class="btn btn-go" id="profSave">Save name</button>
    <button class="btn btn-ghost btn-sm" id="profSignOut">Sign out</button>
    <button class="btn btn-ghost btn-sm" id="profClose">Close</button>
  `, () => {
    $("profSave").onclick = async () => {
      const v = $("profName").value.trim();
      if (v.length < 2) return;
      S.worker = v; await save(); render();
      closeSheet(); toast("Name updated");
    };
    $("profSignOut").onclick = () => auth.signOut();
    $("profClose").onclick = closeSheet;
  });
}

/* ============================================================
   OFF-CANVAS DRAWER + ROUTER
   The three features that used to sit in the bottom nav are full pages
   now, reached from the hamburger beside the wordmark. Routes live in the
   hash so the browser's back button and deep links both behave.
   ============================================================ */
const PAGE_IDS = { mission: "missionScreen", history: "historyScreen", assign: "assignScreen", team: "teamScreen" };

function currentRoute(){
  const h = location.hash.replace(/^#\/?/, "");
  return PAGE_IDS.hasOwnProperty(h) ? h : "";
}
function go(route){ location.hash = "#/" + route; }

let drawerPrevFocus = null;
function openDrawer(){
  drawerPrevFocus = document.activeElement;
  $("drawer").classList.add("on");
  $("drawerScrim").classList.add("on");
  $("menuBtn").setAttribute("aria-expanded", "true");
  const active = $("drawer").querySelector(".drawer-item.active") || $("drawer").querySelector(".drawer-item");
  if (active) active.focus();
}
function closeDrawer(){
  if (!$("drawer").classList.contains("on")) return;
  $("drawer").classList.remove("on");
  $("drawerScrim").classList.remove("on");
  $("menuBtn").setAttribute("aria-expanded", "false");
  if (drawerPrevFocus && drawerPrevFocus.focus) drawerPrevFocus.focus();
  drawerPrevFocus = null;
}

$("menuBtn").onclick = openDrawer;
$("drawerClose").onclick = closeDrawer;
$("drawerScrim").onclick = closeDrawer;
$("drawerProfile").onclick = () => { closeDrawer(); showProfile(); };
$("drawerSignOut").onclick = () => { closeDrawer(); if (auth) auth.signOut(); };
// clicking the route you are already on changes nothing in the hash, so the
// drawer has to dismiss itself
document.querySelectorAll(".drawer-item").forEach(a => {
  a.addEventListener("click", () => { if ((a.dataset.route || "") === currentRoute()) closeDrawer(); });
});
// roving arrows inside the drawer, Raycast-style
$("drawer").addEventListener("keydown", e => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = [...$("drawer").querySelectorAll(".drawer-item:not(.hidden)")];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const next = e.key === "Home" ? items[0]
    : e.key === "End" ? items[items.length - 1]
    : e.key === "ArrowDown" ? (items[i + 1] || items[0])
    : (items[i - 1] || items[items.length - 1]);
  next.focus();
});

function updateDrawerIdentity(){
  const email = (auth && auth.currentUser && auth.currentUser.email) || "";
  const name = S.worker || (email ? email.split("@")[0] : "") || "Not signed in";
  $("drawerName").textContent = name;
  $("drawerMail").textContent = email;
  $("drawerAvatar").textContent = (S.worker || email || "·").trim().charAt(0).toUpperCase() || "·";
}

/* Keyboard: 1-5 jump straight to a page (guarded away from inputs and open
   sheets), Esc closes the drawer or walks a page back to the dashboard. */
document.addEventListener("keydown", e => {
  if ($("appScreen").classList.contains("hidden")) return;
  if (e.key === "Escape"){
    if ($("drawer").classList.contains("on")) { closeDrawer(); e.preventDefault(); }
    else if (!$("sheet").classList.contains("on") && currentRoute()) { go(""); e.preventDefault(); }
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if ($("sheet").classList.contains("on")) return;
  const map = { "1": "", "2": "mission", "3": "history", "4": "assign", "5": "team" };
  if (!(e.key in map)) return;
  const r = map[e.key];
  if (r === "assign" && !canAssignTasks) return;
  if (r === "team" && !isAdmin) return;
  go(r);
});

function applyRoute(){
  let r = currentRoute();
  // role guards: a deep link to a page you can't use lands on the dashboard
  if ((r === "assign" && !canAssignTasks) || (r === "team" && !isAdmin)) { r = ""; if (location.hash) location.replace("#/"); }
  Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.toggle("hidden", k !== r));
  document.querySelectorAll(".drawer-item").forEach(a =>
    a.classList.toggle("active", (a.dataset.route || "") === r));
  closeDrawer();
  // The inline assign flow shares its af* element ids with the sheet version
  // (roster quick-assign). Unmount it off-route so $() can never find a stale
  // copy first and wire the wrong nodes.
  if (r !== "assign" && $("assignFlowMount").innerHTML){
    $("assignFlowMount").innerHTML = "";
    afOpen = null; afInPage = false;
  }
  if (r === "mission") renderMissionPage();
  else if (r === "history") renderHistoryPage();
  else if (r === "assign") enterAssignPage();
  else if (r === "team") loadTeamScreen();
}
window.addEventListener("hashchange", applyRoute);
document.querySelectorAll("[data-back]").forEach(b => b.onclick = () => go(""));

// re-render whichever page is open when the shift state changes underneath it
function refreshOpenPage(){
  const r = currentRoute();
  if (r === "mission" && !$("missionScreen").classList.contains("hidden")) renderMissionPage();
  else if (r === "history" && !$("historyScreen").classList.contains("hidden")) renderHistoryPage();
}

/* ============================================================
   DAILY MISSION PAGE — today's shift as a full tool: live status,
   contextual controls, headline numbers, per-task time, timeline.
   ============================================================ */
const todaysClosedShifts = () => {
  const key = dayStamp(Date.now());
  return S.history.filter(r => dayStamp(r.startedAt) === key);
};

function missionModel(){
  const now = Date.now();
  const closed = todaysClosedShifts();
  const live = (S.shift && S.status !== "IDLE") ? S.shift : null;
  const all = live ? closed.concat([live]) : closed.slice();
  let net = closed.reduce((t, r) => t + r.netMs, 0);
  let brk = closed.reduce((t, r) => t + (r.breakMs || 0), 0);
  if (live) { net += netMs(live, now); brk += breakMs(live, now); }
  const tally = new Map();
  const stores = new Set();
  all.forEach(r => {
    taskTally(r, r.endedAt || now).forEach(t => {
      stores.add(t.store);
      const cur = tally.get(t.store + "\n" + t.task) || { store: t.store, task: t.task, ms: 0 };
      cur.ms += t.ms;
      tally.set(t.store + "\n" + t.task, cur);
    });
  });
  return { closed, live, all, net, brk,
    tally: [...tally.values()].sort((a, b) => b.ms - a.ms), stores: [...stores] };
}

const MISSION_STATE = {
  IDLE:     { cls: "", label: "Clocked out" },
  ACTIVE:   { cls: "is-active", label: "On shift" },
  ON_BREAK: { cls: "is-break", label: "On break" }
};

function missionActionsHTML(){
  if (S.status === "IDLE")
    return `<button class="btn btn-go btn-sm" id="msClockIn">Clock in</button>`;
  if (S.status === "ACTIVE")
    return `<button class="btn btn-sm" id="msSwitch">Switch task</button>
            <button class="btn btn-break btn-sm" id="msPause">Pause</button>
            <button class="btn btn-ghost btn-sm" id="msOut">Clock out</button>`;
  const last = [...(S.shift.segs || [])].pop();
  return `<button class="btn btn-go btn-sm" id="msResume">Resume · ${esc(last ? last.task : "work")}</button>
          <button class="btn btn-ghost btn-sm" id="msOut">Clock out</button>`;
}

function renderMissionPage(){
  const box = $("missionBody");
  if (!box) return;
  const m = missionModel();
  const st = MISSION_STATE[S.status] || MISSION_STATE.IDLE;
  $("missionDate").textContent = "Today · " + dayStamp(Date.now());

  const seg = S.shift ? openSeg(S.shift) : null;
  const statusNote = S.status === "ACTIVE"
    ? `Working <b>${esc(seg ? seg.task : "")}</b> at ${esc(currentStore(S.shift).toUpperCase())}`
    : S.status === "ON_BREAK"
      ? `Paused · ${esc((openBreak(S.shift) || {}).reason || "Break")}`
      : m.closed.length ? "Done for now — today's record below." : "Not on shift yet.";

  if (!m.all.length){
    box.innerHTML = `
      <div class="fpage-bar">
        <span class="fpage-status ${st.cls}">${st.label}</span>
        <div class="fpage-bar-acts">${missionActionsHTML()}</div>
      </div>
      <div class="fpage-panel">
        <div class="empty">
          <span class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="12" height="17" rx="2"/><path d="M8.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/><circle cx="18" cy="16" r="4.2" fill="#33333a"/><path d="M18 14.2V16l1.1 1"/></svg>
          </span>
          Nothing on the card yet. Clock in and today's mission builds itself here.
        </div>
      </div>`;
    wireMissionActions();
    return;
  }

  const maxMs = m.tally.length ? m.tally[0].ms : 1;
  const shiftsHTML = m.all.map((sh, i) => {
    const isLive = !sh.endedAt;
    const label = m.all.length > 1
      ? `Shift ${i + 1}${isLive ? " · live" : ""}`
      : (isLive ? "Live shift" : "Shift");
    return `
      <p class="hx-day">${label} · in ${clock(sh.startedAt)}${sh.endedAt ? ` · out ${clock(sh.endedAt)}` : ""}</p>
      <ul class="punches">
        ${punchEvents(sh).map(e => `
          <li><span class="punch-t">${clock(e.t)}</span>
              <span class="punch-k ${e.cls}">${esc(e.k)}</span>
              <span class="punch-n">${esc(e.n || "")}</span></li>`).join("")}
      </ul>`;
  }).join("");

  box.innerHTML = `
    <div class="fpage-bar">
      <div>
        <span class="fpage-status ${st.cls}">${st.label}</span>
        <p class="fpage-bar-note" style="margin-top:8px">${statusNote}</p>
      </div>
      <div class="fpage-bar-acts">${missionActionsHTML()}</div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile"><p class="stat-tile-label">Net worked</p><p class="stat-tile-value" id="msNet">${humanDur(m.net)}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">On break</p><p class="stat-tile-value" id="msBreak">${m.brk ? humanDur(m.brk) : "—"}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Tasks touched</p><p class="stat-tile-value">${m.tally.length}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Stores</p><p class="stat-tile-value">${m.stores.length}</p>
        ${m.stores.length ? `<p class="stat-tile-sub">${esc(m.stores.join(", "))}</p>` : ""}</div>
    </div>

    ${m.tally.length ? `
    <div class="fpage-panel">
      <p class="fpage-section-title">Where the time went</p>
      ${m.tally.map(t => `
        <div class="tbar-row">
          <span class="tbar-name" title="${esc(t.store)} · ${esc(t.task)}">${esc(t.store)} · ${esc(t.task)}</span>
          <span class="tbar-track"><span class="tbar-fill" style="width:${Math.max(3, Math.round(t.ms / maxMs * 100))}%"></span></span>
          <span class="tbar-ms">${humanDur(t.ms)}</span>
        </div>`).join("")}
    </div>` : ""}

    <div class="fpage-panel">
      <p class="fpage-section-title">Timeline</p>
      ${shiftsHTML}
    </div>`;
  wireMissionActions();
}

function wireMissionActions(){
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on("msClockIn", askClockIn);
  on("msSwitch", askSwitch);
  on("msPause", askPause);
  on("msResume", resume);
  on("msOut", askWrapUp);
}

// the per-second heartbeat only touches the two numbers that move
function updateMissionTick(){
  if ($("missionScreen").classList.contains("hidden")) return;
  const netEl = $("msNet"), brkEl = $("msBreak");
  if (!netEl) return;
  const m = missionModel();
  netEl.textContent = humanDur(m.net);
  if (brkEl) brkEl.textContent = m.brk ? humanDur(m.brk) : "—";
}

/* ============================================================
   HISTORY PAGE — every closed shift, filterable, each one expandable
   into the full story, with the Excel export alongside.
   ============================================================ */
let hxRange = "all";   // all | 7 | 30 — survives leaving the page
let hxQuery = "";
let hxOpenKeys = new Set();

const hxKey = r => String(r.startedAt);

function hxFiltered(){
  const q = hxQuery.trim().toLowerCase();
  const cut = hxRange === "all" ? 0 : Date.now() - Number(hxRange) * 86400000;
  return S.history.filter(r => {
    if (r.startedAt < cut) return false;
    if (!q) return true;
    const hay = [r.client, r.note, ...taskTally(r, r.endedAt).map(t => t.store + " " + t.task)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderHistoryPage(){
  const box = $("historyBody");
  if (!box) return;

  if (!S.history.length){
    box.innerHTML = `
      <div class="fpage-panel">
        <div class="empty">
          <span class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.8"/><path d="M9 2h6"/></svg>
          </span>
          No closed shifts yet. Your first clock-out lands here, ready to export.
        </div>
      </div>`;
    return;
  }

  box.innerHTML = `
    <div id="hxStats"></div>
    <div class="fpage-filters">
      <button type="button" class="chip" data-range="all">All time</button>
      <button type="button" class="chip" data-range="7">Last 7 days</button>
      <button type="button" class="chip" data-range="30">Last 30 days</button>
      <label class="fpage-search"><input type="text" id="hxSearch" placeholder="Search store, task or note…" value="${esc(hxQuery)}" autocomplete="off"></label>
    </div>
    <div id="hxList"></div>`;

  box.querySelectorAll(".chip[data-range]").forEach(c => {
    c.setAttribute("aria-pressed", String(c.dataset.range === hxRange));
    c.onclick = () => { hxRange = c.dataset.range; renderHistoryPage(); };
  });
  const search = $("hxSearch");
  search.oninput = () => { hxQuery = search.value; renderHistoryList(); };
  renderHistoryList();
}

function renderHistoryList(){
  const rows = hxFiltered();
  const stats = $("hxStats"), list = $("hxList");
  if (!stats || !list) return;

  const total = rows.reduce((t, r) => t + r.netMs, 0);
  const rated = rows.filter(r => r.rating);
  const avgRating = rated.length ? (rated.reduce((t, r) => t + r.rating, 0) / rated.length).toFixed(1) : null;
  stats.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><p class="stat-tile-label">Shifts</p><p class="stat-tile-value">${rows.length}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Net worked</p><p class="stat-tile-value">${humanDur(total)}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Avg shift</p><p class="stat-tile-value">${rows.length ? humanDur(total / rows.length) : "—"}</p></div>
      <div class="stat-tile"><p class="stat-tile-label">Avg rating</p><p class="stat-tile-value">${avgRating ? avgRating + `<small>/ 5</small>` : "—"}</p></div>
    </div>
    <div class="fpage-bar">
      <p class="fpage-bar-note">${rows.length} shift${rows.length === 1 ? "" : "s"} shown${hxRange !== "all" || hxQuery ? " · filtered" : ""}</p>
      <div class="fpage-bar-acts">
        <button class="btn btn-go btn-sm" id="hxExport" ${S.history.length ? "" : "disabled"}>Export to Excel</button>
      </div>
    </div>`;
  $("hxExport").onclick = exportExcel;

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
    const open = hxOpenKeys.has(hxKey(r));
    const maxMs = tally.length ? tally[0].ms : 1;
    html += `
      <li class="hx-row${open ? " is-open" : ""}" data-k="${esc(hxKey(r))}">
        <button type="button" class="hx-head" aria-expanded="${open}">
          <span class="hx-when"><span class="hx-date">${day}</span>
            <span class="hx-clock">${clock(r.startedAt)}–${clock(r.endedAt)}</span></span>
          <span class="hx-mid"><span class="hx-store">${esc(r.client)}</span>
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
            <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(hxKey(r))}">Copy report</button>
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
    if (open) hxOpenKeys.add(k); else hxOpenKeys.delete(k);
  });
  list.querySelectorAll("button[data-copy]").forEach(b => b.onclick = async () => {
    const r = S.history.find(x => hxKey(x) === b.dataset.copy);
    if (!r) return;
    toast(await copyText(reportText(r)) ? "Report copied" : "Copy failed");
  });
}

/* ============================================================
   ASSIGN PAGE — the staged flow mounted inline, with the live
   assignment log beside it (log gated to what your role can read).
   ============================================================ */
function enterAssignPage(){
  openAssignFlow();                       // route === "assign" mounts it inline
  loadCompletionLog(true, $("assignLogBox"));
}

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

/* ============================================================
   AUTH + ADMIN
   ============================================================ */
function screen(show){
  $("loginScreen").classList.toggle("hidden", show !== "login");
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

/* One appState read feeds both the today table and the roster below it -
   they were two separate .get() calls over the same collection. */
async function loadTeamData(){
  const list = $("teamList"), today = $("teamToday");
  if (!list) return;
  if (today) today.innerHTML = `<p class="hint">Loading today's work…</p>`;
  list.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const snap = await db.collection("appState").get();
    const docs = [];
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (s) docs.push({ id: doc.id, raw: data, state: s });
    });
    renderTodaysWork(docs);
    renderTeamRoster(docs);
  } catch (e) {
    console.error(e);
    if (today) today.innerHTML = "";
    list.innerHTML = `<div class="empty">Couldn't load team data — check Firestore rules allow admin reads.</div>`;
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
      <p class="hint" style="margin:0">Today's work</p>
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
}

function renderTeamRoster(docs){
  const list = $("teamList");
  list.innerHTML = "";
  if (!docs.length){ list.innerHTML = `<div class="empty">No team members have signed in yet.</div>`; return; }
  const now = Date.now();
  const shortDate = (new Date().getMonth() + 1) + "/" + new Date().getDate();
  docs.forEach(d => {
    const s = d.state, w = todaysWorkFor(s, now);
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.innerHTML = `
      <div><div class="h-c">${esc(s.worker || d.raw.email || "Unnamed")}</div><div class="h-d">${esc(d.raw.email||"")} · ${esc((s.status||"").replace("_"," "))}</div></div>
      <div style="text-align:right">
        <div class="h-h">${humanDur(w ? w.net : 0)} today · ${shortDate}</div>
        <div class="h-d">${humanDur(w ? w.brk : 0)} break</div>
      </div>
    `;
    li.onclick = () => viewWorker(d.raw, s, d.id);
    list.append(li);
  });
}

// Team is a full page (not a sheet) - admin gets the whole viewport to
// work with instead of a small bottom sheet. It routes like the other
// pages so back buttons and deep links behave; the router calls the loader.
function showTeam(){ go("team"); }
function loadTeamScreen(){
  $("teamPageClose").onclick = () => go("");
  $("teamExportAll").onclick = exportAllExcel;
  loadTeamPending();
  loadTeamData();
  ackCompletedAssignments(); // clears the notification badge; log below stays regardless
  loadCompletionLog(true, $("teamRecentlyDone"));
}

// All assignments (open + done) in one table - who, what store, what
// task, current status, and every date that matters. Fetched once per
// Team-page visit and paginated client-side, 8 rows at a time, to avoid
// needing a composite Firestore index for an orderBy.
let assignLogRows = null;
let assignLogShown = 8;
let assignLogBox = null;   // whichever container the log was last rendered into
async function loadCompletionLog(reset, box){
  box = box || assignLogBox || $("teamRecentlyDone");
  if (!box) return;
  assignLogBox = box;
  if (reset || assignLogRows === null) {
    box.innerHTML = `<p class="hint" style="margin-bottom:8px">Loading assignments…</p>`
      + `<div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
    try {
      const snap = await db.collection("assignments").get();
      const rows = [];
      // keep the doc id - the row's Delete button needs something to act on
      snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
      rows.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
      assignLogRows = rows;
      assignLogShown = 8;
    } catch (e) {
      console.error(e);
      assignLogRows = [];
      box.innerHTML = `<div class="empty">Couldn't load assignments — check your connection and Firestore rules.</div>`;
      return;
    }
  }
  renderCompletionLog();
}
function renderCompletionLog(){
  const box = assignLogBox || $("teamRecentlyDone");
  if (!box) return;
  const rows = assignLogRows || [];
  if (!rows.length) {
    // on the Assign page an empty log is a real state that needs words; on the
    // Team page the section simply stays out of the way
    box.innerHTML = box.id === "assignLogBox"
      ? `<p class="fpage-section-title">Assignments</p><div class="empty">Nothing assigned yet. The first one you send lands here with its status.</div>`
      : "";
    return;
  }
  // one row per thread - a six-task group is one line with a progress count,
  // and its Delete removes the whole group, matching how it was assigned
  const threads = groupAssignments(rows);
  const visible = threads.slice(0, assignLogShown);
  assignLogThreads = visible; // the Edit buttons index into what is on screen
  box.innerHTML = `
    <p class="hint" style="margin-bottom:8px">Assignments:</p>
    <div class="table-card">
      <table class="assign-table">
        <thead><tr>
          <th>To</th><th>Store</th><th>Task</th><th>Status</th><th>Assigned</th><th>Due</th><th>Completed</th><th></th>
        </tr></thead>
        <tbody>
          ${visible.map((t, i) => {
            const r = t.rows[0];
            const doneN = t.rows.filter(x => x.done).length, all = doneN === t.rows.length;
            const doneAts = t.rows.map(x => x.doneAt).filter(Boolean);
            const doneAt = all && doneAts.length ? Math.max(...doneAts) : null;
            return `
            <tr>
              <td data-label="To">${esc(r.toName || "Someone")}</td>
              <td data-label="Store">${esc(threadStores(t).join(", ") || "—")}</td>
              <td data-label="Task">${esc(threadTasks(t).join(", ") || "—")}${t.rows.length > 1 ? ` <span class="thread-count">${doneN}/${t.rows.length}</span>` : ""}</td>
              <td data-label="Status" class="nowrap"><span class="assign-status ${all ? "done" : "open"}">${all ? "Done" : "Open"}</span>${seenMark(t)}</td>
              <td data-label="Assigned">${r.createdAt ? dayStamp(r.createdAt) : "—"}</td>
              <td data-label="Due" class="nowrap">${threadDueCell(t)}</td>
              <td data-label="Completed">${doneAt ? dayStamp(doneAt) + " " + clock(doneAt) : "—"}</td>
              <td class="assign-del-cell"><div class="row-acts">
                ${all || !canAssignTasks ? "" : `
                <button type="button" class="assign-del assign-edit" data-edit="${i}"
                        aria-label="Edit this assignment" title="Edit this assignment">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                </button>`}
                ${!isAdmin ? "" : `
                <button type="button" class="assign-del" data-del="${esc(t.rows.map(x => x.id).join(","))}"
                        aria-label="Delete this assignment" title="Delete this assignment">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
                </button>`}
              </div></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${threads.length > assignLogShown ? `<button class="btn btn-ghost btn-sm assign-log-more" style="width:auto;margin-bottom:18px">Load more (${threads.length - assignLogShown} older)</button>` : ""}
  `;
  const moreBtn = box.querySelector(".assign-log-more");
  if (moreBtn) moreBtn.onclick = () => { assignLogShown += 8; renderCompletionLog(); };
  box.querySelectorAll("button[data-del]").forEach(b => b.onclick = () => deleteAssignment(b.dataset.del));
  box.querySelectorAll("button[data-edit]").forEach(b => b.onclick = () => {
    const t = assignLogThreads[Number(b.dataset.edit)];
    if (t) openAssignEdit(t);
  });
}

let assignLogThreads = [];   // the threads currently rendered in the log

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
  const row = (assignLogRows || []).find(r => r.id === ids[0]);
  const what = !row ? "this assignment"
    : ids.length > 1
      ? `all ${ids.length} tasks in this group for ${row.toName || "someone"}`
      : `${row.task || "task"} at ${row.store || "—"} for ${row.toName || "someone"}`;
  if (!confirm(`Delete ${what}?\n\nThis removes it for them too, and can't be undone.`)) return;
  try {
    const batch = db.batch();
    ids.forEach(id => batch.delete(db.collection("assignments").doc(id)));
    await batch.commit();
    assignLogRows = (assignLogRows || []).filter(r => !ids.includes(r.id));
    renderCompletionLog();
    loadTeamPane();
    toast(ids.length > 1 ? "Group deleted" : "Assignment deleted");
  } catch (e) {
    console.error(e);
    toast("Couldn't delete — check Firestore rules allow admin deletes");
  }
}

/* ============================================================
   TEAM PANE — the admin's third column on desktop. Collapsed it is a
   notification: standing counts plus the most recent completion. Expanded
   it swaps places with the punch card and shows every assignment.
   Narrow screens never see it; they use showTeam()'s full page instead.
   ============================================================ */
let teamPaneRows = null;      // every assignment, newest first
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
    const snap = await db.collection("assignments").get();
    const rows = [];
    snap.forEach(doc => rows.push(doc.data()));
    rows.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
    teamPaneRows = rows;
  } catch (e) { console.error(e); teamPaneRows = []; }
  try {
    const p = await db.collection("users").where("role","==","pending").get();
    teamPendingCount = p.size;
  } catch (e) { console.error(e); teamPendingCount = 0; }
  renderTeamPane();
}

function renderTeamPane(){
  const counts = $("teamPanelCounts"), latest = $("teamPanelLatest"), table = $("teamPanelTable");
  if (!counts || !latest || !table) return;
  const rows = teamPaneRows || [];

  // The three states are counted as a partition, not overlapping sets - an
  // overdue task is not also counted as open, or the numbers don't add up to
  // the table you see after Proceed. Counted per thread, same as the table
  // shows them, so a six-task group reads as one thing everywhere.
  const threads = groupAssignments(rows);
  const doneCount = threads.filter(t => threadState(t) === "done").length;
  const late = threads.filter(t => threadState(t) === "late").length;
  const openNow = threads.filter(t => threadState(t) === "open").length;

  // Same pips the expanded table uses, so the collapsed card reads as its
  // legend rather than as a separate vocabulary. Zeroes stay in place but
  // dimmed, so the row keeps a stable shape and the eye lands on what's live.
  const stat = (n, label, cls) =>
    `<li class="team-stat is-${cls}${n ? "" : " is-zero"}">
       <span class="team-dot is-${cls}">${STATUS_GLYPH[cls]}</span><b>${n}</b> ${label}
     </li>`;
  counts.innerHTML = (rows.length || teamPendingCount)
    ? `<ul class="team-stats">${stat(doneCount, "done", "done")}${stat(late, "overdue", "late")}${stat(openNow, "open", "open")}</ul>`
      + (teamPendingCount ? `<p class="team-approve">${teamPendingCount} waiting for approval</p>` : "")
    : `<p class="team-approve">No assignments yet.</p>`;

  const done = rows.filter(r => r.done && r.doneAt).sort((a,b) => b.doneAt - a.doneAt)[0];
  latest.innerHTML = done
    ? `<div class="team-latest-who">${esc(done.toName || "Someone")} finished ${esc(done.task || "a task")}</div>
       <div class="team-latest-what">${esc(done.store || "—")}<span class="team-latest-when"> · ${whenLabel(done.doneAt)}</span></div>`
    : `<div class="team-latest-none">Nothing finished yet. Completed tasks land here.</div>`;

  if (!rows.length){
    table.innerHTML = `<tbody><tr><td class="team-table-empty">No assignments yet.</td></tr></tbody>`;
    return;
  }
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
    <button class="btn" id="xl" ${hist.length ? "" : "disabled"}>Export to Excel</button>
    <button class="btn btn-ghost btn-sm" id="dn">Close</button>
    <button class="btn btn-break btn-sm" id="delWorker">Remove Member</button>
  `, () => {
    $("assign").onclick = () => askAssignTask(uid, name);
    $("xl").onclick = () => exportWorkerExcel(name, data.email || "", hist);
    $("dn").onclick = closeSheet;
    $("delWorker").onclick = () => deleteWorker(uid, name);
  });
}

/* ============================================================
   ASSIGN TASK — one decision at a time.

   Who → where → what → details. Each answer unlocks the next, and the line
   at the top composes into a sentence you can read back before committing,
   so the confirmation is the form rather than a separate summary step.
   Replaces the old two-surface flow (full-page member picker, then a form).
   ============================================================ */
let afState = null;      // the answers so far
let afOpen = null;       // key of the dropdown currently open, if any
let afEdit = null;       // the thread being edited, or null when assigning fresh
let afInPage = false;    // mounted inline on the Assign page vs. in a sheet

const AF_ORDER = ["who", "where", "what", "details"];

// one key per store x task combination; a newline can't appear in either
// name (both come from single-line inputs), so it is a safe separator
const pairKey = (store, task) => store + "\n" + task;
// the combos that will actually be written: the cross product minus any the
// admin dropped in the fine-tune list
function afActivePairs(){
  const out = [];
  afState.stores.forEach(store => afState.tasks.forEach(task => {
    if (!afState.skip[pairKey(store, task)]) out.push({ store, task });
  }));
  return out;
}
// where/what are multi-select; the key here is also the afState field
const AF_MULTI = { where: "stores", what: "tasks" };
const afDone = key => {
  const s = afState || {};
  if (key === "who")     return !!s.uid;
  if (key === "where")   return (s.stores || []).length > 0;
  if (key === "what")    return (s.tasks || []).length > 0;
  if (key === "details") return (s.note || "").trim().length >= 3;
  return false;
};
// a step is reachable once everything before it is answered
const afUnlocked = key => AF_ORDER.slice(0, AF_ORDER.indexOf(key)).every(afDone);

function afDueLabel(iso){
  const p = String(iso).split("-").map(Number);
  if (p.length !== 3 || p.some(isNaN)) return iso;
  return new Date(p[0], p[1] - 1, p[2])
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function afRenderSentence(){
  const s = afState, el = $("afSentence");
  if (!el) return;
  const tok = (v, ph) => v
    ? `<b class="af-tok">${esc(v)}</b>`
    : `<i class="af-slot">${esc(ph)}</i>`;
  const total = (s.stores.length || 1) * (s.tasks.length || 1);
  const act = (s.stores.length && s.tasks.length) ? afActivePairs().length : total;
  const dropped = total - act;
  // every store x task pair still lands as its own tick-able item, but they
  // travel together - say so before they commit, and own up to any combos
  // dropped in the fine-tune list
  const count = total > 1
    ? `<span class="af-count">${act === 1 ? "1 task" : act + " tasks · one group"}${dropped ? ` · ${dropped} dropped` : ""}</span>`
    : "";
  el.innerHTML = tok(s.name, "Someone")
    + ` at ` + tok(s.stores.join(", "), "a store")
    + ` — ` + tok(s.tasks.join(", "), "a task")
    + (s.due ? `, due <b class="af-tok">${esc(afDueLabel(s.due))}</b>` : "")
    + count;
}

// Locks, pips and the Assign button all derive from afDone() so there is one
// source of truth for "is this step answered".
function afSync(){
  AF_ORDER.forEach(key => {
    const step = $("afStep" + key);
    if (!step) return;
    step.classList.toggle("is-done", afDone(key));
    step.classList.toggle("is-locked", !afUnlocked(key));
    step.querySelectorAll("button,input,textarea").forEach(c => { c.disabled = !afUnlocked(key); });
  });
  afRenderSentence();
  const save = $("afSave");
  // dropping every combo in the fine-tune list leaves nothing to assign
  if (save) save.disabled = !AF_ORDER.every(afDone) || afActivePairs().length === 0;
}

function afCloseMenu(){
  if (!afOpen) return;
  const panel = $("afPanel" + afOpen), trig = $("afTrig" + afOpen);
  if (panel) panel.hidden = true;
  if (trig) trig.setAttribute("aria-expanded", "false");
  afOpen = null;
}

/* A dropdown, not a <select>: the native control can't show the second line
   of context each option carries, and can't be styled to match the sheet. */
function afDropdownMarkup(key, label, placeholder){
  return `
    <div class="af-step is-locked" id="afStep${key}">
      <div class="af-step-head">
        <span class="af-pip" aria-hidden="true"></span>
        <span class="af-step-label">${esc(label)}</span>
      </div>
      <button type="button" class="af-trigger" id="afTrig${key}"
              aria-expanded="false" aria-controls="afPanel${key}">
        <span class="af-value" id="afVal${key}">${esc(placeholder)}</span>
        <svg class="af-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="af-panel" id="afPanel${key}" hidden></div>
      <div class="af-custom" id="afCustom${key}" hidden>
        <input type="text" id="afInput${key}" placeholder="Type a name" autocomplete="off">
        <button type="button" class="af-custom-ok" id="afOk${key}">Use</button>
      </div>
    </div>`;
}

const AF_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>';

function afWireDropdown(key, getItems, onPick, customLabel){
  const trig = $("afTrig" + key), panel = $("afPanel" + key);
  const custom = $("afCustom" + key), input = $("afInput" + key), ok = $("afOk" + key);
  const multi = AF_MULTI[key];

  const paint = () => {
    const items = getItems();
    const chosen = multi ? afState[multi] : [];
    panel.innerHTML = (items.length
      ? items.map(it => {
          const on = multi && chosen.includes(it.value);
          return `
          <button type="button" class="af-opt${on ? " is-on" : ""}" data-v="${esc(it.value)}"${multi ? ` aria-pressed="${on}"` : ""}>
            ${multi ? `<span class="af-check" aria-hidden="true">${on ? AF_TICK : ""}</span>` : ""}
            <span class="af-opt-main">${esc(it.label)}</span>
            ${it.meta ? `<span class="af-opt-meta">${esc(it.meta)}</span>` : ""}
          </button>`;
        }).join("")
      : `<p class="af-opt-none">Nothing to choose from yet.</p>`)
      + (customLabel ? `<button type="button" class="af-opt af-opt-new" data-v="__new">${esc(customLabel)}</button>` : "")
      + (multi ? `<button type="button" class="af-opt af-opt-done" data-v="__done">Done choosing</button>` : "");

    panel.querySelectorAll("button[data-v]").forEach(b => {
      b.onclick = () => {
        const v = b.dataset.v;
        if (v === "__done"){ afCloseMenu(); afAdvance(key); return; }
        if (v === "__new"){
          afCloseMenu();
          custom.hidden = false;
          input.value = "";
          input.focus();
          return;
        }
        // multi-select keeps the panel open and repaints in place, so picking
        // three stores is three clicks rather than three round trips
        if (multi){ onPick(v); paint(); return; }
        afCloseMenu();
        custom.hidden = true;
        onPick(v, b.querySelector(".af-opt-main").textContent);
      };
    });
  };

  const open = () => {
    if (afOpen && afOpen !== key) afCloseMenu();
    paint();
    panel.hidden = false;
    trig.setAttribute("aria-expanded", "true");
    afOpen = key;
    const first = panel.querySelector("button");
    if (first) first.focus();
  };

  trig.onclick = () => (afOpen === key ? afCloseMenu() : open());
  trig.onkeydown = e => { if (e.key === "ArrowDown"){ e.preventDefault(); open(); } };

  // roving focus inside the panel; Esc always returns you to the trigger
  panel.onkeydown = e => {
    const opts = [...panel.querySelectorAll("button")];
    const i = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown"){ e.preventDefault(); (opts[i + 1] || opts[0]).focus(); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); (opts[i - 1] || opts[opts.length - 1]).focus(); }
    else if (e.key === "Escape"){ e.preventDefault(); afCloseMenu(); trig.focus(); }
  };

  const commit = () => {
    const v = input.value.trim();
    if (!OTHER_RE.test(v)) { input.focus(); return; }
    custom.hidden = true;
    onPick(v, v);
  };
  ok.onclick = commit;
  input.onkeydown = e => {
    if (e.key === "Enter"){ e.preventDefault(); commit(); }
    else if (e.key === "Escape"){ e.preventDefault(); custom.hidden = true; trig.focus(); }
  };
}

// step the admin forward rather than making them hunt for the next control
function afAdvance(key){
  const next = AF_ORDER[AF_ORDER.indexOf(key) + 1];
  const el = next && ($("afTrig" + next) || $("afNote"));
  if (el && !el.disabled) el.focus();
}

function afSet(key, value, label){
  if (key === "who"){ afState.uid = value; afState.name = label; }
  const val = $("afVal" + key);
  if (val) val.textContent = label;
  afSync();
  afAdvance(key);
}

const AF_PLACEHOLDER = { where: "Choose stores", what: "Choose tasks" };

// toggle one value in a multi-select step
function afToggle(key, value){
  const field = AF_MULTI[key], arr = afState[field];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  const val = $("afVal" + key);
  if (val) val.textContent = arr.length ? arr.join(", ") : AF_PLACEHOLDER[key];
  afRenderPairs();
  afSync();
}

/* The fine-tune list (features it only earns with 2+ combos): every store x
   task pair the selection implies, each with a toggle to drop it - so "Design
   at AVERON but Task Assign only at Football" is expressible. The one due
   date in Details covers the whole group. */
function afRenderPairs(){
  const box = $("afPairs");
  if (!box) return;
  const combos = [];
  afState.stores.forEach(store => afState.tasks.forEach(task =>
    combos.push({ store, task, k: pairKey(store, task) })));
  if (combos.length < 2){
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="af-step-head">
      <span class="af-pip" aria-hidden="true"></span>
      <span class="af-step-label">Fine-tune</span>
      <span class="af-pairs-hint">optional · drop a combo you don't mean</span>
    </div>
    ${combos.map(c => {
      const off = !!afState.skip[c.k];
      return `
      <div class="af-pair${off ? " is-off" : ""}" data-k="${esc(c.k)}">
        <button type="button" class="af-pair-tog" aria-pressed="${!off}"
                title="${off ? "Include this one again" : "Drop this one"}">${AF_TICK}</button>
        <span class="af-pair-name">${esc(c.store)} · ${esc(c.task)}</span>
      </div>`;
    }).join("")}`;
  box.querySelectorAll(".af-pair").forEach(row => {
    const k = row.dataset.k;
    row.querySelector(".af-pair-tog").onclick = () => {
      if (afState.skip[k]) delete afState.skip[k]; else afState.skip[k] = true;
      afRenderPairs();
      afSync();
    };
  });
}

async function openAssignFlow(preUid, preName, editThread){
  afEdit = editThread || null;
  // editing prefills the flow from the thread's still-open rows: the due
  // date is the one most of them carry (older groups could vary per line),
  // and combos absent from the cross product start dropped
  const openRows = afEdit ? afEdit.rows.filter(r => !r.done) : [];
  let sharedDue = "";
  if (openRows.length){
    const freq = new Map();
    openRows.forEach(r => freq.set(r.dueDate || "", (freq.get(r.dueDate || "") || 0) + 1));
    sharedDue = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  afState = {
    uid: preUid || "", name: preName || "",
    stores: [...new Set(openRows.map(r => r.store).filter(Boolean))],
    tasks:  [...new Set(openRows.map(r => r.task).filter(Boolean))],
    note: openRows.length ? (openRows[0].note || "") : "",
    due: sharedDue, skip: {}
  };
  if (openRows.length){
    const have = new Set(openRows.map(r => pairKey(r.store, r.task)));
    afState.stores.forEach(store => afState.tasks.forEach(task => {
      const k = pairKey(store, task);
      if (!have.has(k)) afState.skip[k] = true;
    }));
  }
  afOpen = null;
  // On the Assign page the flow mounts inline; everywhere else (roster
  // quick-assign, small screens' menus) it stays a sheet. Only ever one
  // instance at a time, so the af* element ids stay unique.
  afInPage = currentRoute() === "assign" && !!$("assignFlowMount");
  let members = [], stores = [];

  const body = `
    <p class="af-sentence" id="afSentence"></p>
    ${afDropdownMarkup("who", "Who", "Choose a team member")}
    ${afDropdownMarkup("where", "Where", AF_PLACEHOLDER.where)}
    ${afDropdownMarkup("what", "What", AF_PLACEHOLDER.what)}
    <div class="af-pairs" id="afPairs" hidden></div>
    <div class="af-step is-locked" id="afStepdetails">
      <div class="af-step-head">
        <span class="af-pip" aria-hidden="true"></span>
        <span class="af-step-label">Details</span>
      </div>
      <textarea id="afNote" placeholder="What should they do?"></textarea>
      <label class="af-due"><span>Due date</span><input type="date" id="afDue"></label>
    </div>
    <button class="btn btn-go" id="afSave" disabled>${afEdit ? "Save changes" : "Assign"}</button>
    <button class="btn btn-ghost btn-sm" id="afCancel">${afInPage ? (afEdit ? "Discard edit" : "Start over") : "Cancel"}</button>
  `;
  const setup = () => {
    afWireDropdown("who", () => members, (v, l) => afSet("who", v, l));
    afWireDropdown("where", () => stores, v => afToggle("where", v), "+ Another store");
    afWireDropdown("what", () => CONFIG.tasks.map(t => ({ value: t, label: t })),
      v => afToggle("what", v), "+ Another task");

    $("afNote").oninput = () => { afState.note = $("afNote").value; afSync(); };
    $("afDue").onchange = () => { afState.due = $("afDue").value; afRenderSentence(); };
    $("afCancel").onclick = () => {
      afCloseMenu(); afEdit = null;
      if (afInPage) openAssignFlow();   // inline: reset back to a fresh flow
      else closeSheet();
    };
    $("afSave").onclick = afSubmit;

    if (preUid) $("afValwho").textContent = preName || "Selected";
    if (afEdit){
      if (afState.stores.length) $("afValwhere").textContent = afState.stores.join(", ");
      if (afState.tasks.length)  $("afValwhat").textContent  = afState.tasks.join(", ");
      $("afNote").value = afState.note;
      if (afState.due) $("afDue").value = afState.due;
    }
    afRenderPairs();
    afSync();
    loadAssignOptions().then(d => { members = d.members; stores = d.stores; });
  };

  if (afInPage){
    const mount = $("assignFlowMount");
    const title = document.querySelector("#assignScreen .fpage-section-title");
    if (title) title.textContent = afEdit ? "Edit assignment" : "New assignment";
    mount.innerHTML = body;
    setup();
    // editing starts from a log row further down the page - bring the flow up
    if (afEdit || preUid) mount.closest(".assign-flow-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    openSheet(`<h2>${afEdit ? "Edit assignment" : "Assign task"}</h2>` + body, setup);
  }
}

/* Members carry their current open-task count, so you can see who is already
   loaded before piling more on. Stores come from what has actually been
   assigned as well as CONFIG, so the list learns instead of going stale. */
async function loadAssignOptions(){
  let rows = [];
  try {
    const snap = await db.collection("assignments").get();
    snap.forEach(doc => rows.push(doc.data()));
  } catch (e) { console.error(e); }

  const openBy = new Map();
  rows.forEach(r => { if (!r.done && r.toUid) openBy.set(r.toUid, (openBy.get(r.toUid) || 0) + 1); });

  const members = [];
  try {
    const snap = await db.collection("appState").get();
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (!s) return;
      const n = openBy.get(doc.id) || 0;
      members.push({
        value: doc.id,
        label: s.worker || data.email || "Unnamed",
        meta: n ? `${n} open` : "clear"
      });
    });
  } catch (e) { console.error(e); }
  members.sort((a, b) => a.label.localeCompare(b.label));

  const seen = new Map();
  CONFIG.clients.forEach(c => seen.set(c.toLowerCase(), c));
  rows.forEach(r => { if (r.store) seen.set(String(r.store).toLowerCase(), r.store); });
  const stores = [...seen.values()].sort((a, b) => a.localeCompare(b))
    .map(s => ({ value: s, label: s }));

  return { members, stores };
}

/* Every store x task pair becomes its own assignment rather than one record
   holding arrays. It keeps the existing single-value shape - so the roster,
   the tables and the exports need no changes - and it means each one can be
   ticked off on its own, which is how they actually get worked. Pairs born
   from one submit share a groupId, so every surface can fold them back into
   the single thread the admin meant them as; assigned one at a time there is
   no groupId and each stays its own thread. Written as a batch so a partial
   set can't land.

   Editing reuses the same submit: open rows are matched by store+task, so an
   unchanged line keeps its doc id (no phantom "new task" for the assignee),
   removed lines are deleted, added lines join under the same groupId, and
   done rows are left alone apart from the group arithmetic. Whoever saves
   the edit becomes the assignment's face - "who asked me to do this" should
   name the person whose latest version it is. */
async function afSubmit(){
  const s = afState;
  const btn = $("afSave");
  btn.disabled = true;

  const pairs = afActivePairs();
  const col = db.collection("assignments");
  const from = {
    // who assigned it, by name - an email is not an answer to "who asked
    // me to do this"
    fromName: S.worker || "",
    fromEmail: (auth.currentUser && auth.currentUser.email) || ""
  };

  try {
    const batch = db.batch();
    if (afEdit){
      const openRows = afEdit.rows.filter(r => !r.done);
      const doneRows = afEdit.rows.filter(r => r.done);
      const oldByKey = new Map(openRows.map(r => [pairKey(r.store, r.task), r]));
      const total = doneRows.length + pairs.length;
      // a single edited into several needs the groupId it never had
      const groupId = afEdit.groupId || (total > 1 ? col.doc().id : null);
      const createdAt = afEdit.rows[0].createdAt || Date.now();
      const base = {
        toUid: s.uid, toName: s.name, ...from,
        note: s.note.trim(), dueDate: s.due || null,
        groupId, groupSize: total,
        // edited means changed - the receipt resets so it needs seeing again
        seenAt: null
      };
      pairs.forEach(p => {
        const k = pairKey(p.store, p.task), old = oldByKey.get(k);
        if (old){
          oldByKey.delete(k);
          batch.update(col.doc(old.id), base);
        } else {
          batch.set(col.doc(), { ...base, ...p, createdAt, done: false, doneAt: null });
        }
      });
      oldByKey.forEach(old => batch.delete(col.doc(old.id)));
      doneRows.forEach(r => batch.update(col.doc(r.id), { groupId, groupSize: total }));
      await batch.commit();
      toast("Assignment updated");
    } else {
      // groupSize rides on every doc because the open-tasks listener only
      // sees rows still open - "4 of 6 done" needs to know it started as 6
      const groupId = pairs.length > 1 ? col.doc().id : null;
      const base = {
        toUid: s.uid, toName: s.name, ...from,
        note: s.note.trim(), dueDate: s.due || null,
        createdAt: Date.now(), done: false, doneAt: null,
        groupId, groupSize: pairs.length
      };
      pairs.forEach(p => batch.set(col.doc(), { ...base, ...p }));
      await batch.commit();
      toast(pairs.length === 1
        ? `${pairs[0].task} assigned to ${s.name}`
        : `${pairs.length} tasks assigned to ${s.name}`);
    }

    afEdit = null;
    afCloseMenu();
    if (isAdmin) loadTeamPane();
    if (afInPage){
      // inline: clear back to a fresh flow and let the log show what landed
      openAssignFlow();
      loadCompletionLog(true, $("assignLogBox"));
    } else {
      closeSheet();
      // the log may be on screen behind the sheet (Team page) - keep it honest
      if (!$("teamScreen").classList.contains("hidden")) loadCompletionLog(true, $("teamRecentlyDone"));
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast(afEdit ? "Couldn't save — check Firestore rules allow it"
                 : "Couldn't assign — check Firestore rules allow it");
  }
}

// entry points: the card menu opens it cold, the roster opens it with the
// member already chosen
const askAssignTaskPickMember = () => openAssignFlow();
const askAssignTask = (uid, name) => openAssignFlow(uid, name);

/* ---------- worker: tasks assigned to me (v1) - live, not a one-time
   load, so a task assigned while you're already on the page shows up
   (and toasts) without needing a reload ---------- */
let assignedTasksSeen = null; // null = first snapshot hasn't landed yet
let assignedOpenRows = [];    // last snapshot, so "All done" knows the group's ids
function watchAssignedTasks(){
  const box = $("assignedTasksSection"), list = $("assignedTasksList");
  if (!box || !auth.currentUser) return;
  // Fresh subscription, fresh baseline - carrying the previous user's ids
  // over would make every one of this user's existing tasks look new and
  // fire a "New task from ..." toast for each on the first snapshot.
  assignedTasksSeen = null;
  const unsub = db.collection("assignments")
    .where("toUid", "==", auth.currentUser.uid)
    .where("done", "==", false)
    .onSnapshot(snap => {
      const rows = [];
      snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
      rows.sort((a,b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
      assignedOpenRows = rows;

      // The receipt: the queue rendering on their screen is "seen". Stamped
      // only on rows that lack it, so the write this triggers re-enters the
      // listener exactly once and then goes quiet.
      const unseen = rows.filter(r => !r.seenAt);
      if (unseen.length){
        const stamp = db.batch();
        unseen.forEach(r => stamp.update(db.collection("assignments").doc(r.id), { seenAt: Date.now() }));
        stamp.commit().catch(e => console.error(e));
      }

      const threads = groupAssignments(rows);

      // one toast per thread, not per task - six tasks assigned in one go is
      // one piece of news, not six
      if (assignedTasksSeen) {
        threads.forEach(t => {
          const fresh = t.rows.filter(r => !assignedTasksSeen.has(r.id));
          if (!fresh.length) return;
          const from = t.rows[0].fromName || t.rows[0].fromEmail || "admin";
          toast(fresh.length === 1
            ? `New task from ${from}: ${fresh[0].store} · ${fresh[0].task}`
            : `New from ${from}: ${fresh.length} tasks · ${threadStores(t).join(", ")}`);
        });
      }
      assignedTasksSeen = new Set(rows.map(r => r.id));

      // The pane is the non-admin's second block. An admin's third column is
      // already the Team card, so on desktop theirs stays inside the stage
      // flow rather than fighting for the same grid area.
      const app = $("appScreen");
      const count = $("assignedCount");
      if (!rows.length) {
        box.classList.add("hidden");
        app.classList.remove("has-tasks");
        list.innerHTML = "";
        return;
      }
      box.classList.remove("hidden");
      app.classList.toggle("has-tasks", !isAdmin);
      if (count) count.textContent = rows.length + " open";
      renderAssignedBrief(rows);
      list.innerHTML = threads.map(t => t.groupId ? assignedGroupMarkup(t) : `
        <li>
          <div>
            <div class="h-c">${esc(t.rows[0].store)} · ${esc(t.rows[0].task)}</div>
            <div class="h-d">${esc(t.rows[0].note)}</div>
            <div class="h-d">${t.rows[0].dueDate ? "Due " + esc(t.rows[0].dueDate) : "No due date"} · from ${esc(t.rows[0].fromName || t.rows[0].fromEmail || "admin")}</div>
          </div>
          <button class="btn btn-ghost btn-sm" style="width:auto" data-id="${t.rows[0].id}">Done</button>
        </li>
      `).join("");
      list.querySelectorAll("button[data-id]").forEach(b => b.onclick = () => markAssignmentDone(b.dataset.id));
      list.querySelectorAll("button[data-gid]").forEach(b => b.onclick = () => markGroupDone(b.dataset.gid));
    }, e => console.error(e));
  onSessionEnd(() => {
    unsub(); assignedTasksSeen = null; assignedOpenRows = [];
    box.classList.add("hidden");
    $("appScreen").classList.remove("has-tasks");
    list.innerHTML = "";
  });
}

/* A batch assigned in one go is one thread: the shared brief (note, due,
   who) told once up top, then each store · task pair as its own tick-able
   line. groupSize keeps the "x of n done" honest once ticked items drop out
   of the open-tasks query. */
function assignedGroupMarkup(t){
  const g = t.rows[0];
  const total = g.groupSize || t.rows.length;
  const doneN = Math.max(0, total - t.rows.length);
  // lines can carry their own due dates; when they do, the header gives the
  // next one and each line owns up to its own, overdue ones in red
  const d = threadDues(t), today = todayISO();
  const dueTxt = !d.min ? "No due date" : (d.varied ? "Next due " : "Due ") + esc(d.min);
  return `
    <li class="assign-group">
      <div class="ag-head">
        <div>
          <div class="h-c">${esc(threadStores(t).join(", "))} · ${esc(threadTasks(t).join(", "))}</div>
          <div class="h-d">${esc(g.note)}</div>
          <div class="h-d">${dueTxt} · from ${esc(g.fromName || g.fromEmail || "admin")} · ${doneN ? `${doneN} of ${total} done` : `${total} tasks`}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="width:auto" data-gid="${esc(t.groupId)}">All done</button>
      </div>
      <ul class="ag-items">
        ${t.rows.map(r => `
          <li${r.dueDate && r.dueDate < today ? ` class="is-late"` : ""}>
            <span class="ag-item-name">${esc(r.store)} · ${esc(r.task)}${
              d.varied ? `<span class="ag-item-due">${r.dueDate ? "due " + esc(r.dueDate) : "no due date"}</span>` : ""}</span>
            <button class="btn btn-ghost btn-sm ag-tick" style="width:auto" data-id="${r.id}">Done</button>
          </li>`).join("")}
      </ul>
    </li>`;
}

// tick off everything still open in a group at once; written as a batch so
// the thread can't half-complete
async function markGroupDone(gid){
  const ids = assignedOpenRows.filter(r => r.groupId === gid).map(r => r.id);
  if (!ids.length) return;
  try {
    const batch = db.batch();
    ids.forEach(id => batch.update(db.collection("assignments").doc(id),
      { done: true, doneAt: Date.now(), ack: false }));
    await batch.commit();
    toast(ids.length === 1 ? "Marked done" : `All ${ids.length} marked done`,
      { label: "Undo", run: () => undoDone(ids) });
  } catch (e) {
    console.error(e);
    toast("Couldn't update — check Firestore rules allow it");
  }
}

// the other half of a Done toast: one mistap shouldn't be a conversation
// with the admin, so the toast offers to reopen what it just closed
async function undoDone(ids){
  try {
    const batch = db.batch();
    ids.forEach(id => batch.update(db.collection("assignments").doc(id),
      { done: false, doneAt: null }));
    await batch.commit();
    toast(ids.length === 1 ? "Brought back" : `Brought all ${ids.length} back`);
  } catch (e) {
    console.error(e);
    toast("Couldn't undo — check Firestore rules allow it");
  }
}

/* The collapsed state of the employee's pane. Same shape as the admin's Team
   card - a status line then the one thing that matters most - but about your
   own queue rather than the team's. The headline is the next thing due, since
   that is the question the card is answering. */
function renderAssignedBrief(rows){
  const counts = $("assignedCounts"), next = $("assignedNext");
  if (!counts || !next) return;

  const today = todayISO();
  const late = rows.filter(r => r.dueDate && r.dueDate < today).length;
  const soon = rows.filter(r => r.dueDate === today).length;
  const stat = (n, label, cls) =>
    `<li class="team-stat is-${cls}${n ? "" : " is-zero"}">
       <span class="team-dot is-${cls}">${STATUS_GLYPH[cls]}</span><b>${n}</b> ${label}
     </li>`;
  counts.innerHTML = `<ul class="team-stats">
      ${stat(rows.length, "open", "open")}${stat(late, "overdue", "late")}${stat(soon, "due today", "done")}
    </ul>`;

  // undated tasks sort last, so the headline is always something with a date
  // if one exists
  const up = [...rows].sort((a, b) =>
    (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"))[0];
  next.innerHTML = up
    ? `<div class="team-latest-who">${esc(up.store || "—")} · ${esc(up.task || "task")}</div>
       <div class="team-latest-what">${esc(up.note || "")}<span class="team-latest-when">${
         up.dueDate ? " · due " + esc(up.dueDate) : " · no due date"}</span></div>`
    : `<div class="team-latest-none">Nothing assigned right now.</div>`;
}

async function markAssignmentDone(id){
  try {
    // ack:false so the admin notification badge picks this up as new
    await db.collection("assignments").doc(id).update({ done: true, doneAt: Date.now(), ack: false });
    toast("Marked done", { label: "Undo", run: () => undoDone([id]) });
  } catch (e) {
    console.error(e);
    toast("Couldn't update — check Firestore rules allow it");
  }
}

/* ---------- admin: notified when a team member completes an assigned task ---------- */
function watchCompletionNotifications(){
  const badge = $("adminNotifBadge");
  if (!badge) return;
  const unsub = db.collection("assignments")
    .where("done", "==", true)
    .where("ack", "==", false)
    .onSnapshot(snap => {
      badge.textContent = snap.size;
      badge.classList.toggle("hidden", snap.empty);
      // keep the Team pane's counts and "latest completion" in step with the
      // badge instead of going stale until the next reload
      loadTeamPane();
    }, e => console.error(e));
  onSessionEnd(() => { unsub(); badge.textContent = "0"; badge.classList.add("hidden"); });
}

async function ackCompletedAssignments(){
  try {
    const snap = await db.collection("assignments").where("done", "==", true).where("ack", "==", false).get();
    if (snap.empty) return [];
    const rows = [];
    const batch = db.batch();
    snap.forEach(doc => { rows.push(doc.data()); batch.update(doc.ref, { ack: true }); });
    await batch.commit();
    return rows;
  } catch (e) {
    console.error(e);
    return [];
  }
}

async function deleteWorker(uid, name){
  if (!confirm(`Delete ${name}? This removes their shift data and app access. This can't be undone.\n\nNote: it does NOT delete their login itself - to fully block them from signing in again, also remove them in Firebase Console > Authentication > Users.`)) return;
  try {
    await db.collection("appState").doc(uid).delete();
    await db.collection("users").doc(uid).delete();
    toast(name + " deleted");
    closeSheet();
    loadTeamData();      // the roster behind the sheet still lists them otherwise
    loadTeamPending();
  } catch (e) {
    console.error(e);
    toast("Couldn't delete - check Firestore rules allow admin deletes");
  }
}

// Single-worker export used by the admin dashboard's per-worker "Export to
// Excel" button. Produces one polished sheet (same summary/task-breakdown/
// history layout as exportAllExcel()'s per-worker sheets) instead of the
// flat two-sheet dump exportExcel() makes for a worker's own self-export.
async function exportWorkerExcel(name, email, hist){
  if (!window.ExcelJS) { toast("Excel export isn't available right now"); return; }
  if (!hist.length) return;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeSheetName(name, new Set()));
  fillWorkerSheet(ws, name, email, hist);

  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "member";
  await downloadWorkbook(wb, "shift-report-" + slug + "-" + new Date().toISOString().slice(0,10) + ".xlsx");
  toast("Excel file downloaded");
}

async function resolveRole(user){
  const ref = db.collection("users").doc(user.uid);
  let doc = await ref.get();
  const shouldBeAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
  if (!doc.exists) {
    // new signups wait for admin approval; designated admin emails skip it
    const role = shouldBeAdmin ? "admin" : "pending";
    await ref.set({ email: user.email, role, createdAt: Date.now() });
    doc = await ref.get();
  } else if (shouldBeAdmin && doc.data().role !== "admin") {
    // an existing account whose email was just added to ADMIN_EMAILS -
    // upgrade it on this login instead of requiring a manual DB edit
    await ref.update({ role: "admin" });
    doc = await ref.get();
  } else if (!shouldBeAdmin && doc.data().role === "admin") {
    // the mirror case: email was removed from ADMIN_EMAILS - drop back
    // to a regular worker, not pending (they were already approved)
    await ref.update({ role: "worker" });
    doc = await ref.get();
  }
  return doc.data().role;
}

if (!FB_READY){
  screen("login");
  $("loginErr").textContent = "Firebase isn't configured yet — paste your project's config into firebaseConfig near the top of the script.";
  $("loginErr").classList.remove("hidden");
  $("loginBtn").disabled = true;
} else {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      endSession();
      screen("login");
      workerStarted = false;
      isAdmin = false;
      canAssignTasks = false;
      S = { worker:"", status:"IDLE", shift:null, history:[], lastReport:null };
      // drop the signed-out uid too, so a stray save() can never write the
      // blank state above over the previous user's stored shift history
      Store.setUser(null, null);
      assignLogRows = null; assignLogBox = null;
      $("bandSignOut").classList.add("hidden");
      $("adminAccessBtn").classList.add("hidden");
      $("drawerAssign").classList.add("hidden");
      $("drawerTeam").classList.add("hidden");
      closeDrawer();
      // the next person to sign in starts on the dashboard, not wherever
      // the previous session happened to be parked
      Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.add("hidden"));
      if (location.hash && location.hash !== "#/") location.replace("#/");
      $("appScreen").classList.remove("panes", "has-team", "has-tasks", "side-open");
      $("teamPanel").classList.add("hidden");
      teamPaneRows = null; teamPendingCount = 0;
      pomoAmbientStop();   // nobody signed in, nothing should be playing
      return;
    }
    try {
      const role = await resolveRole(user);
      if (role === "pending") { screen("pending"); }
      else {
        isAdmin = role === "admin";
        canAssignTasks = isAdmin || ASSIGNER_EMAILS.includes((user.email || "").toLowerCase());
        $("drawerAssign").classList.toggle("hidden", !canAssignTasks);
        $("drawerTeam").classList.toggle("hidden", !isAdmin);
        $("adminAccessBtn").classList.toggle("hidden", !isAdmin);
        // everyone on desktop gets the two-pane shell; the role only decides
        // what the third column holds
        $("appScreen").classList.add("panes");
        $("appScreen").classList.toggle("has-team", isAdmin);
        $("teamPanel").classList.toggle("hidden", !isAdmin);
        if (isAdmin) { watchCompletionNotifications(); loadTeamPane(); }
        Store.setUser(user.uid, user.email);
        screen("app");
        startWorkerApp();
      }
    } catch (e) {
      console.error(e);
      $("loginErr").textContent = "Signed in, but couldn't load your account. Check Firestore rules.";
      $("loginErr").classList.remove("hidden");
    }
  });

  let loginMode = "signin";
  function setLoginMode(mode){
    loginMode = mode;
    const isSignup = mode === "signup";
    $("confirmWrap").classList.toggle("hidden", !isSignup);
    $("loginBtnText").textContent = isSignup ? "Create account" : "Sign in";
    $("loginHint").textContent = isSignup ? "Set up your login — you'll use this every time." : "Sign in to clock in and out.";
    $("switchHint").textContent = isSignup ? "Already have an account?" : "New here?";
    $("modeToggle").textContent = isSignup ? "Sign in" : "Create an account";
    $("loginErr").classList.add("hidden");
  }
  $("modeToggle").onclick = () => setLoginMode(loginMode === "signin" ? "signup" : "signin");

  const AUTH_ERRORS = {
    "auth/email-already-in-use": "That email already has an account — sign in instead.",
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Wrong password.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/quota-exceeded": "Too many emails sent today — try again tomorrow, or ask your admin to check the Firebase project's email quota.",
    "auth/too-many-requests": "Too many attempts — wait a bit before trying again."
  };
  const persistence = () => $("keepSignedIn").checked
    ? firebase.auth.Auth.Persistence.LOCAL
    : firebase.auth.Auth.Persistence.SESSION;

  async function doLogin(){
    const email = $("loginEmail").value.trim();
    const pass = $("loginPass").value;
    $("loginErr").classList.add("hidden");
    if (!email || !pass) return;
    try {
      await auth.setPersistence(persistence());
      if (loginMode === "signup") {
        if (pass.length < 6) throw new Error("Password must be at least 6 characters.");
        if (pass !== $("loginPass2").value) throw new Error("Passwords don't match.");
        await auth.createUserWithEmailAndPassword(email, pass);
      } else {
        await auth.signInWithEmailAndPassword(email, pass);
      }
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Something went wrong — try again.";
      $("loginErr").classList.remove("hidden");
    }
  }
  $("loginBtn").onclick = doLogin;
  $("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  $("googleSignIn").onclick = async () => {
    $("loginErr").classList.add("hidden");
    try {
      await auth.setPersistence(persistence());
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Google sign-in failed — try again.";
      $("loginErr").classList.remove("hidden");
    }
  };

  $("forgotPassword").onclick = async () => {
    const email = $("loginEmail").value.trim();
    $("loginErr").classList.add("hidden");
    if (!email) {
      $("loginErr").textContent = "Enter your email above first, then tap Forgot password.";
      $("loginErr").classList.remove("hidden");
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      toast("Password reset email sent");
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Couldn't send reset email — try again.";
      $("loginErr").classList.remove("hidden");
    }
  };
  $("pendingSignOut").onclick = () => auth.signOut();
}

/* ============================================================
   POMODORO / FOCUS MODE
   The left rail's second personality. All state is local to this
   browser (localStorage) - it is a personal focus tool, not shift
   data, so it never touches Firestore.
   ============================================================ */
const POMO_LS = "ez-pomo-v1";
const POMO_ROUNDS = 4;
// label + the little swatch the dropdown shows; the veil styles live in CSS
const POMO_THEMES = {
  autumn:    { label: "Autumn Ember",    swatch: "linear-gradient(140deg,#5b2c0e,#b06a1c 58%,#2e1608)" },
  golden:    { label: "Golden Hour",     swatch: "linear-gradient(160deg,#3a1c40,#b05038 55%,#ffab40)" },
  sakura:    { label: "Sakura Dusk",     swatch: "linear-gradient(150deg,#2a1028,#8a3c70 55%,#f48fb1)" },
  forest:    { label: "Cozy Forest",     swatch: "linear-gradient(140deg,#0d2818,#1f5e38 58%,#0a1a10)" },
  ocean:     { label: "Ocean Depths",    swatch: "linear-gradient(165deg,#40becb,#0a3a50 55%,#031a2a)" },
  aurora:    { label: "Aurora Borealis", swatch: "linear-gradient(140deg,#04101c,#40eba6 45%,#5e8cff 75%,#040c16)" },
  space:     { label: "Deep Space",      swatch: "linear-gradient(140deg,#0b1030,#3d2a80 55%,#060814)" },
  rainnight: { label: "Midnight Rain",   swatch: "linear-gradient(160deg,#0a0e22,#28347c 60%,#0a0e1c)" },
  snow:      { label: "First Snow",      swatch: "linear-gradient(160deg,#141a24,#4a5c78 60%,#c8dcf0)" },
  nordic:    { label: "Nordic Fjord",    swatch: "linear-gradient(160deg,#0e161e,#2c4454 60%,#8cbed2)" },
  noir:      { label: "Velvet Noir",     swatch: "linear-gradient(150deg,#0a0710,#2c1c44 60%,#060409)" },
  dark:      { label: "Minimal Dark",    swatch: "linear-gradient(140deg,#101217,#262a33)" }
};
// every track is synthesized live in Web Audio - no files, no network
const POMO_TRACKS = {
  none:     { label: "None",             sub: "Silence, just the chime" },
  rain:     { label: "Autumn Rain",      sub: "Steady rainfall, soft droplets" },
  storm:    { label: "Rolling Thunder",  sub: "Heavy rain, distant rumbles" },
  fire:     { label: "Cozy Fireplace",   sub: "Crackling logs, deep warmth" },
  ocean:    { label: "Ocean Waves",      sub: "Slow swells, drifting foam" },
  forest:   { label: "Forest Morning",   sub: "Breeze, leaves, far-off birds" },
  wind:     { label: "Gentle Wind",      sub: "Two currents wandering" },
  crickets: { label: "Night Crickets",   sub: "A warm evening field" },
  lofi:     { label: "Lo-fi Beats",      sub: "72 bpm, dusty chords" },
  drone:    { label: "Deep Space Drone", sub: "Slow harmonic drift" },
  brown:    { label: "Brown Noise",      sub: "Pure low focus wash" }
};
const POMO_LIMITS = { focusMin: [1, 90], shortMin: [1, 30], longMin: [5, 45] };

let PM = Object.assign({
  on: false, theme: "autumn",
  focusMin: 25, shortMin: 5, longMin: 20,
  autoBreak: true, autoFocus: false,
  track: "rain", vol: 0.6, muted: false, chime: true,
  phase: "focus", round: 1, running: false, endAt: null, remainMs: 25 * 60000
}, (() => { try { return JSON.parse(localStorage.getItem(POMO_LS) || "{}"); } catch { return {}; } })());

const pomoSave = () => { try { localStorage.setItem(POMO_LS, JSON.stringify(PM)); } catch {} };
const pomoTotalMs = (phase = PM.phase) =>
  (phase === "focus" ? PM.focusMin : phase === "short" ? PM.shortMin : PM.longMin) * 60000;
const pomoRemainMs = () => (PM.running && PM.endAt) ? Math.max(0, PM.endAt - Date.now()) : PM.remainMs;
const POMO_PHASE_LABEL = { focus: "Focus", short: "Short break", long: "Long break" };
const pomoMMSS = ms => { const s = Math.max(0, Math.round(ms / 1000)); return pad(Math.floor(s / 60)) + ":" + pad(s % 60); };

function pomoArcPath(p){
  if (p <= 0.002) return "";
  const theta = Math.min(p, 0.9999) * 360, rad = (theta * Math.PI) / 180;
  const x = (100 + 95.5 * Math.sin(rad)).toFixed(2);
  const y = (100 - 95.5 * Math.cos(rad)).toFixed(2);
  return `M100,4.5 A95.5,95.5 0 ${theta > 180 ? 1 : 0} 1 ${x},${y}`;
}

/* ---------- audio engine: everything is synthesized with Web Audio, so
   the app stays a static bundle with no media files to host or fetch.
   Ambient runs only while the timer runs; the chime is one-shot. ---------- */
let pomoAC = null, pomoMaster = null, pomoAmbient = null;
function pomoCtx(){
  pomoAC = pomoAC || new (window.AudioContext || window.webkitAudioContext)();
  if (pomoAC.state === "suspended") pomoAC.resume();
  if (!pomoMaster){
    // master -> gentle compressor -> out: the compressor glues the layered
    // voices and catches event peaks (thunder, pops) before they spike
    pomoMaster = pomoAC.createGain();
    const comp = pomoAC.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 24; comp.ratio.value = 3;
    comp.attack.value = 0.01; comp.release.value = 0.4;
    pomoMaster.connect(comp); comp.connect(pomoAC.destination);
  }
  pomoMaster.gain.value = PM.muted ? 0 : PM.vol;
  return pomoAC;
}
let pomoNoiseBuf = null, pomoBrownBuf = null;
function pomoNoise(ctx){
  if (!pomoNoiseBuf){
    pomoNoiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = pomoNoiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return pomoNoiseBuf;
}
// true brown noise (integrated white), far smoother down low than
// lowpassed white - the difference is very audible on the focus washes
function pomoBrown(ctx){
  if (!pomoBrownBuf){
    pomoBrownBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = pomoBrownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++){
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return pomoBrownBuf;
}

function pomoAmbientStop(){
  if (!pomoAmbient) return;
  try { pomoAmbient.stop(); } catch (e) {}
  pomoAmbient = null;
}

/* Build one soundscape. Every voice is placed in stereo, modulated by slow
   LFOs so nothing loops audibly, and coloured events (thunder, crackles,
   birds, droplets) arrive on randomized clocks. `force` lets the settings
   sheet audition a track for a few seconds while the timer is paused. */
function pomoAmbientStart(force){
  pomoAmbientStop();
  if (PM.track === "none" || PM.muted || (!PM.running && !force)) return;
  const ctx = pomoCtx();
  const bus = ctx.createGain(); bus.connect(pomoMaster);
  const stops = [], timers = [];
  const R = (a, b) => a + Math.random() * (b - a);

  const pan = (node, p) => {
    if (!ctx.createStereoPanner){ node.connect(bus); return null; }
    const sp = ctx.createStereoPanner(); sp.pan.value = p;
    node.connect(sp); sp.connect(bus); return sp;
  };
  const noiseVoice = (vol, type, freq, q, at, buf) => {
    const src = ctx.createBufferSource(); src.buffer = buf || pomoNoise(ctx); src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); pan(g, at || 0);
    src.start();
    stops.push(() => { try { src.stop(); } catch (e) {} });
    return { src, f, g };
  };
  const lfo = (target, base, depth, hz) => {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.value = hz; og.gain.value = depth;
    target.value = base; o.connect(og); og.connect(target); o.start();
    stops.push(() => { try { o.stop(); } catch (e) {} });
  };
  const burst = (vol, freq, dur, at, type) => {
    const src = ctx.createBufferSource(); src.buffer = pomoNoise(ctx);
    const f = ctx.createBiquadFilter(); f.type = type || "highpass"; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); pan(g, at || 0);
    src.start(); src.stop(ctx.currentTime + dur + 0.05);
  };
  // a pitched one-shot: sine glide with an envelope (droplets, birds, kicks)
  const blip = (f0, f1, dur, vol, at, type) => {
    const o = ctx.createOscillator(); o.type = type || "sine";
    const g = ctx.createGain();
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); pan(g, at || 0);
    o.start(); o.stop(ctx.currentTime + dur + 0.05);
  };
  const every = (minMs, maxMs, fn) => {
    const go = () => { fn(); timers.push(setTimeout(go, R(minMs, maxMs))); };
    timers.push(setTimeout(go, R(minMs, maxMs)));
  };

  const t = PM.track;
  if (t === "rain"){
    const body = noiseVoice(0.38, "lowpass", 1150, 0, -0.12);
    lfo(body.g.gain, 0.38, 0.07, 0.13);
    noiseVoice(0.09, "highpass", 4800, 0, 0.22);
    every(2200, 7000, () => blip(R(900, 1400), R(320, 480), 0.14, 0.035, R(-0.5, 0.5)));
  } else if (t === "storm"){
    const body = noiseVoice(0.48, "lowpass", 900, 0, -0.1);
    lfo(body.g.gain, 0.48, 0.09, 0.1);
    noiseVoice(0.08, "highpass", 4200, 0, 0.25);
    every(12000, 32000, () => {
      // a thunder roll: slow-attack brown rumble that dies over seconds
      const src = ctx.createBufferSource(); src.buffer = pomoBrown(ctx);
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 140;
      const g = ctx.createGain();
      const now = ctx.currentTime, dur = R(2.4, 4);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(R(0.22, 0.34), now + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(f); f.connect(g); pan(g, R(-0.6, 0.6));
      src.start(); src.stop(now + dur + 0.1);
    });
  } else if (t === "fire"){
    const rumble = noiseVoice(0.42, "lowpass", 240, 0, 0, pomoBrown(ctx));
    lfo(rumble.g.gain, 0.42, 0.09, 0.28);
    every(80, 420, () => burst(R(0.12, 0.3), R(1900, 5400), R(0.025, 0.08), R(-0.35, 0.35)));
    every(3000, 9000, () => blip(110, 60, 0.18, 0.1, R(-0.2, 0.2)));   // a log settling
  } else if (t === "ocean"){
    const swell = noiseVoice(0.05, "lowpass", 620, 0, -0.1);
    // two incommensurate LFOs make the set of waves never quite repeat
    lfo(swell.g.gain, 0.3, 0.22, 0.055);
    lfo(swell.f.frequency, 620, 160, 0.085);
    const foam = noiseVoice(0.05, "highpass", 2600, 0, 0.3);
    lfo(foam.g.gain, 0.09, 0.06, 0.055);
  } else if (t === "forest"){
    const w = noiseVoice(0.3, "bandpass", 360, 0.8, -0.15);
    lfo(w.f.frequency, 360, 130, 0.05);
    lfo(w.g.gain, 0.3, 0.1, 0.09);
    noiseVoice(0.05, "highpass", 4200, 0, 0.2);
    every(2500, 8000, () => {
      const n = 2 + Math.floor(Math.random() * 3), at = R(-0.6, 0.6), f0 = R(2600, 4200);
      for (let i = 0; i < n; i++)
        timers.push(setTimeout(() => blip(f0 * R(0.95, 1.1), f0 * R(0.6, 0.8), 0.11, 0.04, at), i * R(130, 200)));
    });
  } else if (t === "wind"){
    const a = noiseVoice(0.34, "bandpass", 330, 0.9, -0.3);
    lfo(a.f.frequency, 330, 150, 0.06);
    lfo(a.g.gain, 0.34, 0.12, 0.1);
    const b = noiseVoice(0.26, "bandpass", 520, 0.9, 0.3);
    lfo(b.f.frequency, 520, 200, 0.043);
    lfo(b.g.gain, 0.26, 0.1, 0.076);
    noiseVoice(0.05, "highpass", 3800, 0, 0);
  } else if (t === "crickets"){
    noiseVoice(0.06, "lowpass", 260, 0, 0, pomoBrown(ctx));
    // each cricket: a carrier with a fast tremolo, gated open in short bursts
    const cricket = (freq, rate, at, minMs, maxMs) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
      const trem = ctx.createGain(); lfo(trem.gain, 0.5, 0.5, rate);
      const gate = ctx.createGain(); gate.gain.value = 0.0001;
      o.connect(trem); trem.connect(gate); pan(gate, at);
      o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
      every(minMs, maxMs, () => {
        const now = ctx.currentTime;
        gate.gain.setValueAtTime(0.0001, now);
        gate.gain.exponentialRampToValueAtTime(0.045, now + 0.03);
        gate.gain.setValueAtTime(0.045, now + 0.3);
        gate.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      });
    };
    cricket(4300, 27, -0.4, 800, 1300);
    cricket(4650, 31, 0.45, 1000, 1700);
  } else if (t === "lofi"){
    // four dusty chords, a heartbeat kick, swung hats, vinyl dust
    const CH = [
      [174.6, 261.6, 349.2, 440.0],   // Fmaj7
      [220.0, 261.6, 329.6, 392.0],   // Am7
      [146.8, 220.0, 293.7, 349.2],   // Dm7
      [196.0, 233.1, 293.7, 392.0]    // Gm7
    ];
    const filt = ctx.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = 780;
    lfo(filt.frequency, 780, 120, 0.05);
    const padBus = ctx.createGain(); padBus.gain.value = 1;
    filt.connect(padBus); pan(padBus, -0.08);
    const oscs = CH[0].map(fr => {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = fr;
      o.detune.value = R(-8, 8);
      const g = ctx.createGain(); g.gain.value = 0.045;
      o.connect(g); g.connect(filt); o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
      return o;
    });
    let bar = 0;
    timers.push(setInterval(() => {
      bar = (bar + 1) % CH.length;
      oscs.forEach((o, i) => o.frequency.setTargetAtTime(CH[bar][i], ctx.currentTime, 0.5));
    }, 6667)); // two bars at 72 bpm
    const BEAT = 60000 / 72;
    timers.push(setInterval(() => blip(120, 44, 0.2, 0.1, 0), BEAT));
    timers.push(setTimeout(() =>
      timers.push(setInterval(() => burst(0.028, 7000, 0.03, 0.25), BEAT)), BEAT / 2 + 40)); // swung hat
    every(300, 1500, () => burst(R(0.03, 0.06), 5200, 0.02, R(-0.3, 0.3)));
  } else if (t === "drone"){
    [[55, 0.06], [110.4, 0.05], [164.6, 0.035], [220.5, 0.025]].forEach(([fr, vol], i) => {
      const o = ctx.createOscillator(); o.type = i < 2 ? "sine" : "triangle";
      o.frequency.value = fr; o.detune.value = R(-4, 4);
      const f = ctx.createBiquadFilter(); f.type = "lowpass";
      lfo(f.frequency, 800, 420, 0.02);
      const g = ctx.createGain(); g.gain.value = vol;
      lfo(g.gain, vol, vol * 0.35, R(0.02, 0.05));
      o.connect(f); f.connect(g); pan(g, i % 2 ? 0.25 : -0.25);
      o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
    });
    const shimmer = ctx.createOscillator(); shimmer.type = "sine"; shimmer.frequency.value = 1318.5;
    const sg = ctx.createGain(); lfo(sg.gain, 0.012, 0.01, 0.03);
    shimmer.connect(sg); pan(sg, 0.1); shimmer.start();
    stops.push(() => { try { shimmer.stop(); } catch (e) {} });
  } else if (t === "brown"){
    noiseVoice(0.5, "lowpass", 900, 0, 0, pomoBrown(ctx));
  }

  pomoAmbient = { stop(){
    stops.forEach(fn => fn());
    timers.forEach(tm => { clearTimeout(tm); clearInterval(tm); });
    try { bus.disconnect(); } catch (e) {}
  } };
}

// audition a track from the settings sheet without starting the timer:
// it plays for a few seconds, then bows out unless the timer is running
let pomoPreviewTimer = null;
function pomoPreview(){
  clearTimeout(pomoPreviewTimer);
  pomoAmbientStart(true);
  pomoPreviewTimer = setTimeout(() => { if (!PM.running) pomoAmbientStop(); }, 6000);
}

function pomoChime(){
  if (!PM.chime) return;
  try {
    const ctx = pomoCtx();
    [[880, 0], [1174.7, 0.18]].forEach(([fr, at]) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 1.1);
      o.connect(g); g.connect(pomoMaster);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 1.2);
    });
  } catch (e) { console.error(e); }
}
function pomoApplyVolume(){ if (pomoMaster) pomoMaster.gain.value = PM.muted ? 0 : PM.vol; }

/* ---------- engine ---------- */
function pomoSetMode(on){
  PM.on = on;
  $("appScreen").classList.toggle("pomo-on", on);
  $("modeClocks").classList.toggle("is-on", !on);
  $("modeFocus").classList.toggle("is-on", on);
  $("modeClocks").setAttribute("aria-selected", String(!on));
  $("modeFocus").setAttribute("aria-selected", String(on));
  pomoApplyTheme(on ? PM.theme : null);
  if (!on){ if (PM.running) pomoPause(); pomoAmbientStop(); }
  pomoRender();
  pomoSave();
}

// swap through transparent so a theme-to-theme change is also a fade
function pomoApplyTheme(theme){
  const app = $("appScreen");
  if (!theme){ delete app.dataset.ptheme; return; }
  if (app.dataset.ptheme === theme) return;
  if (!app.dataset.ptheme){ app.dataset.ptheme = theme; return; }
  const veil = app.querySelector(".theme-veil");
  veil.style.opacity = "0";
  setTimeout(() => { app.dataset.ptheme = theme; veil.style.opacity = ""; }, 200);
}

function pomoStart(){
  PM.running = true;
  PM.endAt = Date.now() + pomoRemainMs();
  pomoCtx();               // unlock audio inside the user gesture
  pomoAmbientStart();
  pomoRender(); pomoSave();
}
function pomoPause(){
  PM.remainMs = pomoRemainMs();
  PM.running = false; PM.endAt = null;
  pomoAmbientStop();
  pomoRender(); pomoSave();
}
function pomoResetPhase(){
  PM.remainMs = pomoTotalMs();
  if (PM.running) PM.endAt = Date.now() + PM.remainMs;
  pomoRender(); pomoSave();
}

/* One session ended (naturally or skipped). Standard rules: focus 1-3 earn a
   short break, focus 4 earns the long one; a finished break starts the next
   focus round; the long break wraps the set back to round 1. */
function pomoAdvance(natural){
  const wasRunning = PM.running;
  let auto = false;
  if (PM.phase === "focus"){
    PM.phase = PM.round >= POMO_ROUNDS ? "long" : "short";
    auto = PM.autoBreak;
  } else {
    PM.round = PM.phase === "long" ? 1 : Math.min(POMO_ROUNDS, PM.round + 1);
    PM.phase = "focus";
    auto = PM.autoFocus;
  }
  PM.remainMs = pomoTotalMs();
  PM.running = wasRunning && auto;
  PM.endAt = PM.running ? Date.now() + PM.remainMs : null;
  if (natural){
    pomoChime();
    toast(PM.phase === "focus"
      ? "Break over — round " + PM.round + " of " + POMO_ROUNDS
      : (PM.phase === "long" ? "Set complete — long break earned" : "Focus done — take " + PM.shortMin + " minutes"));
  }
  if (PM.running) pomoAmbientStart(); else pomoAmbientStop();
  pomoRender(); pomoSave();
}

function pomoTick(){
  if (!PM.on) return;
  if (PM.running && pomoRemainMs() <= 0){ pomoAdvance(true); return; }
  if (PM.running) pomoRenderTime();
}

function pomoRenderTime(){
  const remain = pomoRemainMs(), total = pomoTotalMs();
  $("pomoTime").textContent = pomoMMSS(remain);
  $("pomoArc").setAttribute("d", pomoArcPath(1 - remain / total));
}

function pomoRender(){
  const pomo = $("pomo");
  if (!pomo) return;
  pomo.classList.toggle("is-focus", PM.phase === "focus");
  pomo.classList.toggle("is-break", PM.phase !== "focus");
  $("pomoPhase").textContent = POMO_PHASE_LABEL[PM.phase];
  $("pomoRound").textContent = PM.phase === "long"
    ? "Long break · set complete"
    : "Round " + PM.round + " of " + POMO_ROUNDS;
  const done = PM.phase === "focus" ? PM.round - 1 : PM.round;
  $("pomoDots").innerHTML = Array.from({ length: POMO_ROUNDS }, (_, i) =>
    `<span class="pomo-dot${i < done ? " is-done" : (i === done && PM.phase === "focus" ? " is-now" : "")}"></span>`).join("");
  $("pomoPlay").textContent = PM.running ? "Pause"
    : (pomoRemainMs() < pomoTotalMs() ? "Resume" : "Start");
  $("pomoSoundOnIco").classList.toggle("hidden", PM.muted || PM.track === "none");
  $("pomoSoundOffIco").classList.toggle("hidden", !(PM.muted || PM.track === "none"));
  pomoRenderTime();
}

/* ---------- settings sheet ---------- */
function pomoClamp(key, v){
  const lim = POMO_LIMITS[key];
  return Math.max(lim[0], Math.min(lim[1], Math.round(v) || lim[0]));
}
/* One dropdown, af-* skinned: trigger shows the current pick (with a theme
   swatch when given), the panel lists every option and marks the active one.
   Only one panel opens at a time within the sheet. */
function pomoDropdownMarkup(id, items, currentKey){
  const cur = items[currentKey] || Object.values(items)[0];
  return `
    <div class="pdrop" id="${id}">
      <button type="button" class="af-trigger" aria-expanded="false" aria-haspopup="listbox">
        ${cur.swatch ? `<span class="pdrop-swatch" data-role="swatch" style="background:${cur.swatch}"></span>` : ""}
        <span class="af-value">${esc(cur.label)}</span>
        <svg class="af-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="af-panel" role="listbox" hidden>
        ${Object.entries(items).map(([k, it]) => `
          <button type="button" class="af-opt${k === currentKey ? " is-on" : ""}" data-v="${k}" role="option" aria-selected="${String(k === currentKey)}">
            <span class="af-check" aria-hidden="true">${k === currentKey ? AF_TICK : ""}</span>
            ${it.swatch ? `<span class="pdrop-swatch" style="background:${it.swatch}"></span>` : ""}
            <span class="af-opt-main">${esc(it.label)}${it.sub ? `<span class="af-opt-sub">${esc(it.sub)}</span>` : ""}</span>
          </button>`).join("")}
      </div>
    </div>`;
}
function pomoWireDropdown(id, items, onPick){
  const box = $(id), trig = box.querySelector(".af-trigger"), panel = box.querySelector(".af-panel");
  const close = () => { panel.hidden = true; trig.setAttribute("aria-expanded", "false"); };
  trig.onclick = () => {
    const opening = panel.hidden;
    // close any sibling dropdown first - one open panel at a time
    document.querySelectorAll(".pdrop .af-panel").forEach(p => { p.hidden = true; });
    document.querySelectorAll(".pdrop .af-trigger").forEach(x => x.setAttribute("aria-expanded", "false"));
    if (opening){ panel.hidden = false; trig.setAttribute("aria-expanded", "true"); }
  };
  panel.querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
    const k = b.dataset.v, it = items[k];
    panel.querySelectorAll("[data-v]").forEach(x => {
      const on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-selected", String(on));
      x.querySelector(".af-check").innerHTML = on ? AF_TICK : "";
    });
    trig.querySelector(".af-value").textContent = it.label;
    const sw = trig.querySelector("[data-role=swatch]");
    if (sw && it.swatch) sw.style.background = it.swatch;
    close();
    onPick(k);
  });
}

function openPomoSettings(){
  const sw = (id, label, sub, on) => `
    <div class="prow">
      <span class="prow-label">${label}<span class="prow-sub">${sub}</span></span>
      <button type="button" class="pswitch" id="${id}" role="switch" aria-pressed="${String(on)}" aria-label="${label}"></button>
    </div>`;
  openSheet(`
    <h2>Focus settings</h2>
    <p class="hint">Tune the timer, the scenery and the sound. Everything here sticks on this device.</p>

    <label class="fld"><span>Theme</span></label>
    ${pomoDropdownMarkup("pThemeDrop", POMO_THEMES, PM.theme)}

    <label class="fld"><span>Ambient sound</span></label>
    ${pomoDropdownMarkup("pTrackDrop", POMO_TRACKS, PM.track)}
    <div class="pvol">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>
      <input type="range" id="pVol" min="0" max="100" value="${Math.round(PM.vol * 100)}" aria-label="Volume">
    </div>
    ${sw("pChime", "Completion chime", "A soft bell when a session ends", PM.chime)}

    <label class="fld" style="margin-top:10px"><span>Session lengths (minutes)</span></label>
    <div class="pnum-grid">
      <label class="fld"><span>Focus</span><input type="number" id="pFocus" min="1" max="90" value="${PM.focusMin}"></label>
      <label class="fld"><span>Short</span><input type="number" id="pShort" min="1" max="30" value="${PM.shortMin}"></label>
      <label class="fld"><span>Long</span><input type="number" id="pLong" min="5" max="45" value="${PM.longMin}"></label>
    </div>
    ${sw("pAutoBreak", "Auto-start breaks", "Roll into the break when focus ends", PM.autoBreak)}
    ${sw("pAutoFocus", "Auto-start focus", "Roll into focus when a break ends", PM.autoFocus)}

    <button class="btn btn-go" id="pDone">Done</button>
  `, () => {
    pomoWireDropdown("pThemeDrop", POMO_THEMES, k => {
      PM.theme = k;
      if (PM.on) pomoApplyTheme(k);
      pomoSave();
    });
    pomoWireDropdown("pTrackDrop", POMO_TRACKS, k => {
      PM.track = k;
      if (PM.running) pomoAmbientStart();
      else if (k !== "none" && !PM.muted) pomoPreview();  // audition it briefly
      else pomoAmbientStop();
      pomoRender(); pomoSave();
    });
    // a changed length applies to the current session immediately unless it
    // is mid-run - a running session keeps the deal it started with
    const num = (id, key) => {
      $(id).onchange = () => {
        PM[key] = pomoClamp(key, Number($(id).value));
        $(id).value = PM[key];
        if (!PM.running) PM.remainMs = pomoTotalMs();
        pomoRender(); pomoSave();
      };
    };
    num("pFocus", "focusMin"); num("pShort", "shortMin"); num("pLong", "longMin");
    const wireSwitch = (id, key, after) => {
      $(id).onclick = () => {
        PM[key] = !PM[key];
        $(id).setAttribute("aria-pressed", String(PM[key]));
        if (after) after();
        pomoSave();
      };
    };
    wireSwitch("pAutoBreak", "autoBreak");
    wireSwitch("pAutoFocus", "autoFocus");
    wireSwitch("pChime", "chime", () => { if (PM.chime) pomoChime(); });
    $("pVol").oninput = () => { PM.vol = Number($("pVol").value) / 100; pomoApplyVolume(); pomoSave(); };
    $("pDone").onclick = () => { if (!PM.running) pomoAmbientStop(); closeSheet(); };
  });
}

/* ---------- boot ---------- */
(function pomoInit(){
  const pomo = $("pomo");
  if (!pomo) return;
  pomo.removeAttribute("hidden");   // CSS classes own visibility from here on
  // saved prefs may predate the current theme/track catalogs
  if (!POMO_THEMES[PM.theme]) PM.theme = "autumn";
  if (!POMO_TRACKS[PM.track]) PM.track = "rain";
  // a session that was running when the tab closed: settle it honestly
  if (PM.running && PM.endAt && PM.endAt <= Date.now()){
    PM.running = false; PM.remainMs = 0;
    pomoAdvance(false);
    PM.running = false; PM.endAt = null;
  } else if (!PM.running){
    PM.endAt = null;
    PM.remainMs = Math.min(PM.remainMs, pomoTotalMs()) || pomoTotalMs();
  }
  $("modeClocks").onclick = () => pomoSetMode(false);
  $("modeFocus").onclick = () => pomoSetMode(true);
  $("pomoPlay").onclick = () => PM.running ? pomoPause() : pomoStart();
  $("pomoReset").onclick = pomoResetPhase;
  $("pomoSkip").onclick = () => pomoAdvance(false);
  $("pomoGear").onclick = openPomoSettings;
  $("pomoSound").onclick = () => {
    PM.muted = !PM.muted;
    pomoApplyVolume();
    if (!PM.muted && PM.running) pomoAmbientStart();
    if (PM.muted) pomoAmbientStop();
    pomoRender(); pomoSave();
  };
  pomoSetMode(PM.on);
})();