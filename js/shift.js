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
    ok.onclick = async () => { S.worker = nm.value.trim(); await save(); syncDirectory(); closeSheet(); render(); };
    nm.focus();
  }, { dismissible: false });   // the one sheet with no way around it
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
      // re-entrancy guard: a second tap before save() resolves would
      // otherwise close this same seg again and push a duplicate open one
      if (seg.endedAt) return;
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
      const seg = openSeg(S.shift);
      if (!seg) return;   // re-entrancy guard: a second tap already closed the seg
      const now = Date.now();
      seg.endedAt = now;                                    // task clock stops with the shift clock
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
  if (!S.shift) return;   // re-entrancy guard: a second tap already closed this shift
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

/* Resizes/crops/compresses in the browser rather than uploading to Firebase
   Storage - this app never wired that SDK in, and everything else here is
   already just client + Firestore with no separate backend. A 220x220 JPEG
   at .85 quality lands around 15-30KB, comfortably clear of Firestore's 1MB
   document cap even riding alongside the rest of appState/{uid}. Center-
   cropped to a square first so it doesn't warp inside the round avatar. */
function profileProcessImage(file){
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith("image/")) { reject(new Error("That's not an image file.")); return; }
    if (file.size > 15 * 1024 * 1024) { reject(new Error("That image is too large — try one under 15MB.")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
        const out = 220;
        const canvas = document.createElement("canvas");
        canvas.width = out; canvas.height = out;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out, out);   // clean backdrop for a transparent PNG
        ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function showProfile(){
  const email = (auth && auth.currentUser && auth.currentUser.email) || "";
  const initial = (S.worker || email || "·").trim().charAt(0).toUpperCase() || "·";
  openSheet(`
    <h2>Profile</h2>
    <div class="prof-avatar-row">
      <div class="prof-avatar${userPhoto ? " has-photo" : ""}" id="profAvatar"${userPhoto ? ` style="background-image:url('${userPhoto}')"` : ""}>${userPhoto ? "" : esc(initial)}</div>
      <div class="prof-avatar-acts">
        <button type="button" class="prof-avatar-btn" id="profPhotoPick">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h1.2l.9-1.5A2 2 0 0 1 9.8 3.5h4.4a2 2 0 0 1 1.7 1L17 6h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="12.5" r="3.3"/></svg>
          ${userPhoto ? "Change photo" : "Add photo"}
        </button>
        ${userPhoto ? `<button type="button" class="prof-avatar-btn is-danger" id="profPhotoRemove">Remove</button>` : ""}
      </div>
      <input type="file" accept="image/*" id="profPhotoInput" class="visually-hidden">
    </div>
    <label class="fld"><span>Name</span>
      <input type="text" id="profName" value="${esc(S.worker||"")}" placeholder="Your name"></label>
    <p class="hint">${esc(email)}</p>
    <button class="btn btn-go" id="profSave">Save name</button>
    <button class="btn btn-ghost btn-sm" id="profResetPw">Change password</button>
    <button class="btn btn-ghost btn-sm" id="profSignOut">Sign out</button>
    <button class="btn btn-ghost btn-sm" id="profClose">Close</button>
  `, () => {
    $("profSave").onclick = async () => {
      const v = $("profName").value.trim();
      if (v.length < 2) return;
      S.worker = v; await save(); syncDirectory(); render();
      closeSheet(); toast("Name updated");
    };
    $("profPhotoPick").onclick = () => $("profPhotoInput").click();
    $("profPhotoInput").onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";   // picking the same file twice in a row still fires change
      if (!file) return;
      const btn = $("profPhotoPick");
      const restingLabel = btn.innerHTML;
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        const dataUrl = await profileProcessImage(file);
        await Store.writePhoto(dataUrl);
        userPhoto = dataUrl;
        updateDrawerIdentity();
        toast("Photo updated");
        showProfile();   // rebuilds the sheet so the preview + Remove button reflect it
      } catch (err) {
        console.error(err);
        toast(err.message || "Couldn't update your photo — try again.");
        btn.disabled = false; btn.innerHTML = restingLabel;
      }
    };
    if ($("profPhotoRemove")){
      $("profPhotoRemove").onclick = async () => {
        try {
          await Store.writePhoto(null);
          userPhoto = null;
          updateDrawerIdentity();
          toast("Photo removed");
          showProfile();
        } catch (err) {
          console.error(err);
          toast("Couldn't remove your photo — try again.");
        }
      };
    }
    $("profResetPw").onclick = async () => {
      if (!email) return;
      try {
        await auth.sendPasswordResetEmail(email);
        toast("Password reset email sent");
      } catch (err) {
        toast(err.message || "Couldn't send reset email — try again.");
      }
    };
    $("profSignOut").onclick = () => auth.signOut();
    $("profClose").onclick = closeSheet;
  });
}

