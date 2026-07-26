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
// First login using this email is automatically made admin.
const ADMIN_EMAIL = "ezagency2nd@gmail.com";

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
function taskClockMs(sh, now = Date.now()) {
  if (!sh) return 0;
  return (sh.segs || []).reduce((total, seg) => total + segMs(seg, now), 0);
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

  $("shiftMeta").classList.remove("is-ready");
  if (st === "IDLE"){
    $("bandState").textContent = "Clocked out";
    $("bandMeta").textContent  = S.worker ? S.worker.toUpperCase() : "Not on shift";
    $("shiftMeta").textContent = "Ready";
    $("shiftMeta").classList.add("is-ready");
    $("taskMeta").textContent = "Idle";
  } else if (st === "ACTIVE"){
    const seg = openSeg(S.shift);
    $("bandState").textContent = "Clocked in";
    $("bandMeta").textContent  = currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = seg ? seg.task : "Current task";
  } else {
    const b = openBreak(S.shift);
    $("bandState").textContent = "On break";
    $("bandMeta").textContent  = (b.reason||"Break").toUpperCase() + " · " + currentStore(S.shift).toUpperCase();
    $("shiftMeta").textContent = "Net working";
    $("taskMeta").textContent = "Paused";
  }

  renderDock();
  renderPunches();
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

function renderPunches(){
  const ul = $("punches"), sh = S.shift;
  ul.innerHTML = "";
  $("empty").style.display = sh ? "none" : "block";
  if (!sh) return;

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
  ev.sort((a,b) => a.t - b.t);

  ev.forEach(e => {
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
  const theta = p * 360, rad = (theta * Math.PI) / 180;
  const x = (100 + 86 * Math.sin(rad)).toFixed(2);
  const y = (100 - 86 * Math.cos(rad)).toFixed(2);
  progress.setAttribute("d", `M100,14 A86,86 0 ${theta > 180 ? 1 : 0} 1 ${x},${y}`);
}

function tick(){
  const bar = $("shiftbar");
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

function toast(msg){ const t = $("toast"); t.textContent = msg; t.classList.add("on"); setTimeout(()=>t.classList.remove("on"), 2100); }

function chipGroup(list, allowOther){
  return list.map(x => `<button type="button" class="chip" data-v="${esc(x)}" aria-pressed="false">${esc(x)}</button>`).join("")
    + (allowOther ? `<button type="button" class="chip" data-v="__other" aria-pressed="false">Other…</button>` : "");
}
function wireChips(onPick){
  const chips = $("sheetBody").querySelectorAll(".chip");
  chips.forEach(c => c.onclick = () => {
    chips.forEach(x => x.setAttribute("aria-pressed","false"));
    c.setAttribute("aria-pressed","true");
    onPick(c.dataset.v);
  });
}
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
  });
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

/* ---------- History + Excel ---------- */
function showHistory(){
  const rows = S.history.length ? S.history.map(r => `
    <li>
      <div>
        <div class="h-c">${esc(r.client)}</div>
        <div class="h-d">${dayStamp(r.startedAt)} · ${clock(r.startedAt)}–${clock(r.endedAt)} · ${taskTally(r, r.endedAt).length} task${taskTally(r,r.endedAt).length===1?"":"s"} · ${r.rating}/5</div>
      </div>
      <div class="h-h">${humanDur(r.netMs)}</div>
    </li>`).join("") : `<div class="empty">No closed shifts yet.</div>`;

  const total = S.history.reduce((t,r) => t + r.netMs, 0);

  openSheet(`
    <h2>History</h2>
    <p class="hint">${S.history.length} shift${S.history.length===1?"":"s"} · ${humanDur(total)} net worked</p>
    <ul class="hist">${rows}</ul>
    <button class="btn" id="xl" ${S.history.length ? "" : "disabled"}>Export to Excel</button>
    <button class="btn btn-ghost btn-sm" id="dn">Close</button>
  `, () => {
    $("xl").onclick = exportExcel; $("dn").onclick = closeSheet;
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

$("btnHistory").onclick = showHistory;

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

function setActiveNav(id){
  ["navDashboard","navCard","navHistory","navTeam","navProfile"].forEach(n => $(n).classList.toggle("active", n === id));
}
$("navDashboard").onclick = () => setActiveNav("navDashboard");
$("navCard").onclick = () => {
  setActiveNav("navCard");
  document.querySelector(".card").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("navHistory").onclick = () => { setActiveNav("navHistory"); showHistory(); };
$("navTeam").onclick = () => { setActiveNav("navTeam"); showTeam(); };
$("navProfile").onclick = () => { setActiveNav("navProfile"); showProfile(); };

/* ============================================================
   WORKER APP BOOT (called once, after login as a worker)
   ============================================================ */
let workerStarted = false;
let isAdmin = false;
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
  setInterval(tick, 1000);
  const wake = () => { if (!document.hidden) tick(); };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);

  if (FB_READY) {
    $("bandSignOut").classList.remove("hidden");
    $("bandSignOut").onclick = () => auth.signOut();
  }

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
        $("teamPendingHint") && $("teamPendingHint").remove();
        loadTeamPending();
      };
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadTeamList(){
  const list = $("teamList");
  if (!list) return;
  list.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const snap = await db.collection("appState").get();
    list.innerHTML = "";
    if (snap.empty){ list.innerHTML = `<div class="empty">No team members have signed in yet.</div>`; return; }
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (!s) return;
      const todayKey = dayStamp(Date.now());
      let todayMs = (s.history||[]).filter(r => dayStamp(r.startedAt) === todayKey).reduce((t,r)=>t+r.netMs,0);
      if (s.shift && s.status !== "IDLE") todayMs += netMs(s.shift);
      const li = document.createElement("li");
      li.style.cursor = "pointer";
      li.innerHTML = `
        <div><div class="h-c">${esc(s.worker || data.email || "Unnamed")}</div><div class="h-d">${esc(data.email||"")} · ${esc((s.status||"").replace("_"," "))}</div></div>
        <div class="h-h">${humanDur(todayMs)} today</div>
      `;
      li.onclick = () => viewWorker(data, s, doc.id);
      list.append(li);
    });
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class="empty">Couldn't load team data — check Firestore rules allow admin reads.</div>`;
  }
}

function showTeam(){
  openSheet(`
    <h2>Team</h2>
    <p class="hint">Everyone who's signed in, plus anyone waiting for approval.</p>
    <button class="btn btn-go btn-sm" id="teamExportAll" style="width:auto;margin-bottom:18px">Export Team Report</button>
    <ul class="hist" id="teamPending"></ul>
    <ul class="hist" id="teamList"></ul>
    <button class="btn btn-ghost btn-sm" id="teamClose">Close</button>
  `, () => {
    $("teamExportAll").onclick = exportAllExcel;
    $("teamClose").onclick = closeSheet;
    loadTeamPending();
    loadTeamList();
  });
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
    <button class="btn" id="xl" ${hist.length ? "" : "disabled"}>Export to Excel</button>
    <button class="btn btn-ghost btn-sm" id="dn">Close</button>
    <button class="btn btn-break btn-sm" id="delWorker">Remove Member</button>
  `, () => {
    $("xl").onclick = () => exportWorkerExcel(name, data.email || "", hist);
    $("dn").onclick = closeSheet;
    $("delWorker").onclick = () => deleteWorker(uid, name);
  });
}

async function deleteWorker(uid, name){
  if (!confirm(`Delete ${name}? This removes their shift data and app access. This can't be undone.\n\nNote: it does NOT delete their login itself - to fully block them from signing in again, also remove them in Firebase Console > Authentication > Users.`)) return;
  try {
    await db.collection("appState").doc(uid).delete();
    await db.collection("users").doc(uid).delete();
    toast(name + " deleted");
    closeSheet();
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
  if (!doc.exists) {
    // new signups wait for admin approval; only the designated admin email skips it
    const role = (user.email||"").toLowerCase() === ADMIN_EMAIL.toLowerCase() ? "admin" : "pending";
    await ref.set({ email: user.email, role, createdAt: Date.now() });
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
      screen("login");
      workerStarted = false;
      S = { worker:"", status:"IDLE", shift:null, history:[], lastReport:null };
      $("bandSignOut").classList.add("hidden");
      return;
    }
    try {
      const role = await resolveRole(user);
      if (role === "pending") { screen("pending"); }
      else {
        isAdmin = role === "admin";
        $("navTeam").classList.toggle("hidden", !isAdmin);
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