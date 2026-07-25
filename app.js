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

  if (st === "IDLE"){
    $("bandState").textContent = "Clocked out";
    $("bandMeta").textContent  = S.worker ? S.worker.toUpperCase() : "Not on shift";
    $("shiftMeta").textContent = "Ready";
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

function renderDock(){
  const d = $("dock"); d.innerHTML = "";
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = "btn " + cls; b.textContent = label; b.onclick = fn; return b;
  };

  if (S.status === "IDLE"){
    d.append(mk("Clock in", "btn-go", askClockIn));
  } else if (S.status === "ACTIVE"){
    d.append(mk("Switch task", "", askSwitch));
    const row = document.createElement("div"); row.className = "row";
    row.append(mk("Pause", "btn-break btn-sm", askPause), mk("Clock out", "btn-ghost btn-sm", askWrapUp));
    d.append(row);
  } else {
    const last = [...(S.shift.segs||[])].pop();
    d.append(mk("Resume · " + (last ? last.task : "work"), "btn-go", resume));
    d.append(mk("Clock out", "btn-ghost btn-sm", askWrapUp));
  }
}

function renderPunches(){
  const ul = $("punches"), sh = S.shift;
  ul.innerHTML = "";
  $("empty").style.display = sh ? "none" : "block";
  if (!sh) return;

  const ev = [];
  ev.push({ t: sh.startedAt, k: "In", cls: "", n: sh.client });
  (sh.segs||[]).forEach(s => {
    if (s.via === "switch") ev.push({ t: s.startedAt, k: "Task", cls: "k-task", n: s.task });
    if (s.client) ev.push({ t: s.startedAt, k: "Store", cls: "k-store", n: s.client });
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

function tick(){
  const bar = $("shiftbar");
  if (S.status === "IDLE"){
    $("shiftClock").textContent = "00:00:00";
    $("taskClock").textContent = "00:00:00";
    bar.innerHTML = "";
    return;
  }

  const sh = S.shift, now = Date.now();
  const shiftMs = netMs(sh, now);
  const taskMs = taskClockMs(sh, now);

  $("shiftClock").textContent = hms(shiftMs);
  $("taskClock").textContent = hms(taskMs);

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

const CHART_COLORS = ["#7B2CBF", "#00F5D4", "#2D006B", "#9B4DDB", "#00C7AC", "#E4D6F5"];
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

function exportExcel(){
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

  if (window.XLSX){
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(shifts);
    ws1["!cols"] = [{wch:14},{wch:16},{wch:16},{wch:9},{wch:10},{wch:11},{wch:10},{wch:7},{wch:48}];
    const ws2 = XLSX.utils.json_to_sheet(detail);
    ws2["!cols"] = [{wch:14},{wch:16},{wch:16},{wch:18},{wch:8},{wch:8},{wch:9},{wch:8}];
    XLSX.utils.book_append_sheet(wb, ws1, "Shifts");
    XLSX.utils.book_append_sheet(wb, ws2, "Task Detail");
    XLSX.writeFile(wb, name + ".xlsx");
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

/* ============================================================
   WORKER APP BOOT (called once, after login as a worker)
   ============================================================ */
let workerStarted = false;
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
  $("adminScreen").classList.toggle("hidden", show !== "admin");
}

async function loadPending(){
  const pending = $("adminPending");
  try {
    const snap = await db.collection("users").where("role", "==", "pending").get();
    pending.innerHTML = "";
    if (snap.empty) return;
    pending.insertAdjacentHTML("afterbegin", `<li class="admin-sub" style="margin:0 0 4px;list-style:none">Pending approval</li>`);
    snap.forEach(doc => {
      const data = doc.data();
      const li = document.createElement("li");
      li.className = "admin-row";
      li.innerHTML = `
        <div><div class="a-name">${esc(data.email || "Unknown")}</div><div class="a-email">Waiting for approval</div></div>
        <div class="a-right"><button class="btn btn-go btn-sm" style="width:auto" id="approve-${doc.id}">Approve</button></div>
      `;
      pending.append(li);
      document.getElementById("approve-" + doc.id).onclick = async (e) => {
        e.stopPropagation();
        await db.collection("users").doc(doc.id).update({ role: "worker" });
        loadPending();
        toast(data.email + " approved");
      };
    });
  } catch (e) {
    console.error(e);
  }
}

async function startAdmin(email){
  screen("admin");
  $("adminSub").textContent = email;
  loadPending();
  const list = $("adminList");
  list.innerHTML = `<li class="empty">Loading…</li>`;
  try {
    const snap = await db.collection("appState").get();
    list.innerHTML = "";
    if (snap.empty){ list.innerHTML = `<li class="empty">No workers have signed in yet.</li>`; return; }
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (!s) return;
      const statusCls = s.status === "ACTIVE" ? "st-active" : s.status === "ON_BREAK" ? "st-break" : "st-idle";
      const todayKey = dayStamp(Date.now());
      let todayMs = (s.history||[]).filter(r => dayStamp(r.startedAt) === todayKey).reduce((t,r)=>t+r.netMs,0);
      if (s.shift && s.status !== "IDLE") todayMs += netMs(s.shift);
      const li = document.createElement("li");
      li.className = "admin-row";
      li.innerHTML = `
        <div><div class="a-name">${esc(s.worker || data.email || "Unnamed")}</div><div class="a-email">${esc(data.email||"")}</div></div>
        <div class="a-right"><span class="a-status ${statusCls}">${esc((s.status||"").replace("_"," "))}</span><div class="a-email" style="margin-top:6px">${humanDur(todayMs)} today</div></div>
      `;
      li.onclick = () => viewWorker(data, s);
      list.append(li);
    });
  } catch (e) {
    console.error(e);
    list.innerHTML = `<li class="empty">Couldn't load team data — check Firestore rules allow admin reads.</li>`;
  }
}

/* ---------- team-wide Excel export (one sheet per worker + overview) ---------- */
function barify(value, max, width = 18){
  if (!max || max <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function safeSheetName(base, used){
  let name = String(base).replace(/[\\\/\?\*\[\]:]/g, "").trim().slice(0, 28) || "Worker";
  let final = name, i = 2;
  while (used.has(final.toLowerCase())) { final = name.slice(0, 25) + " " + i; i++; }
  used.add(final.toLowerCase());
  return final;
}

async function exportAllExcel(){
  if (!window.XLSX) { toast("Excel export isn't available right now"); return; }
  toast("Building workbook…");
  let snap;
  try { snap = await db.collection("appState").get(); }
  catch (e) { console.error(e); toast("Couldn't load team data"); return; }
  if (snap.empty) { toast("No worker data yet"); return; }

  const workers = [];
  snap.forEach(doc => {
    const data = doc.data();
    let s; try { s = JSON.parse(data.json); } catch { s = null; }
    if (s) workers.push({ email: data.email || "", s });
  });
  if (!workers.length) { toast("No worker data yet"); return; }

  const rows = workers.map(w => {
    const hist = w.s.history || [];
    const totalMs = hist.reduce((t,r) => t + r.netMs, 0);
    const avgRating = hist.length ? hist.reduce((t,r) => t + r.rating, 0) / hist.length : 0;
    return { name: w.s.worker || w.email || "Unnamed", email: w.email, hist, totalMs, avgRating };
  }).sort((a,b) => b.totalMs - a.totalMs);
  const maxHrs = Math.max(1, ...rows.map(r => r.totalMs / 3600000));

  const wb = XLSX.utils.book_new();

  const ovAoa = [
    ["Team Overview"],
    ["Generated " + new Date().toLocaleString()],
    [],
    ["Team Member", "Email", "Shifts", "Total Hours", "Avg Rating", "Hours"]
  ];
  rows.forEach(r => {
    const hrs = +(r.totalMs / 3600000).toFixed(2);
    ovAoa.push([r.name, r.email, r.hist.length, hrs, +r.avgRating.toFixed(1), barify(hrs, maxHrs)]);
  });
  const wsOv = XLSX.utils.aoa_to_sheet(ovAoa);
  wsOv["!cols"] = [{wch:20},{wch:26},{wch:8},{wch:12},{wch:10},{wch:22}];
  XLSX.utils.book_append_sheet(wb, wsOv, "Overview");

  const used = new Set(["overview"]);
  rows.forEach(r => {
    const sheetTitle = safeSheetName(r.name, used);
    const hrs = +(r.totalMs / 3600000).toFixed(2);

    const tally = new Map();
    r.hist.forEach(shift => {
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

    const aoa = [
      [r.name],
      [r.email],
      [],
      ["Shifts", "Total Hours", "Avg Rating"],
      [r.hist.length, hrs, +r.avgRating.toFixed(1)],
      [],
      ["TASK BREAKDOWN"],
      ["Store / Task", "Hours", "% of total", "Chart"]
    ];
    taskRows.forEach(t => {
      const th = +(t.ms / 3600000).toFixed(2);
      const pct = Math.round(t.ms / (r.totalMs || 1) * 100);
      aoa.push([taskLabel(t), th, pct + "%", barify(t.ms, maxTaskMs)]);
    });
    aoa.push([]);
    aoa.push(["SHIFT HISTORY"]);
    aoa.push(["Date", "Store", "In", "Out", "Break (min)", "Hours", "Rating", "Notes"]);
    r.hist.forEach(shift => {
      aoa.push([
        dayStamp(shift.startedAt), shift.client, clock(shift.startedAt), clock(shift.endedAt),
        Math.round(shift.breakMs / 60000), +(shift.netMs / 3600000).toFixed(2), shift.rating, shift.note
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{wch:24},{wch:14},{wch:12},{wch:12},{wch:12},{wch:10},{wch:8},{wch:40}];
    XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  });

  XLSX.writeFile(wb, "team-report-" + new Date().toISOString().slice(0,10) + ".xlsx");
  toast("Team report downloaded");
}

function viewWorker(data, s){
  const hist = s.history || [];
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
    <h2>${esc(s.worker || data.email || "Worker")}</h2>
    <p class="hint">${hist.length} shift${hist.length===1?"":"s"} · ${humanDur(total)} net worked</p>
    <ul class="hist">${rows}</ul>
    <button class="btn" id="xl" ${hist.length ? "" : "disabled"}>Export to Excel</button>
    <button class="btn btn-ghost btn-sm" id="dn">Close</button>
  `, () => {
    $("xl").onclick = () => { const backup = S; S = s; exportExcel(); S = backup; };
    $("dn").onclick = closeSheet;
  });
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
      if (role === "admin") { startAdmin(user.email); }
      else if (role === "pending") { screen("pending"); }
      else { Store.setUser(user.uid, user.email); screen("app"); startWorkerApp(); }
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
    $("loginBtn").textContent = isSignup ? "Create account" : "Sign in";
    $("loginHint").textContent = isSignup ? "Set up your login — you'll use this every time." : "Sign in to clock in and out.";
    $("modeToggle").textContent = isSignup ? "Already have an account? Sign in" : "New here? Create an account";
    $("loginErr").classList.add("hidden");
  }
  $("modeToggle").onclick = () => setLoginMode(loginMode === "signin" ? "signup" : "signin");

  const AUTH_ERRORS = {
    "auth/email-already-in-use": "That email already has an account — sign in instead.",
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Wrong password.",
    "auth/invalid-credential": "Wrong email or password."
  };
  async function doLogin(){
    const email = $("loginEmail").value.trim();
    const pass = $("loginPass").value;
    $("loginErr").classList.add("hidden");
    if (!email || !pass) return;
    try {
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
  $("adminLogout").onclick = () => auth.signOut();
  $("adminExportAll").onclick = exportAllExcel;
  $("pendingSignOut").onclick = () => auth.signOut();
}