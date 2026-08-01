/* ============================================================
   DIRECTORY + IN-APP NOTIFICATIONS
   Two small collections:
   - directory/{uid}: name + email, written by each account about itself
     on sign-in and whenever the name changes. It exists because workers
     cannot read appState, and @mention autocomplete needs the whole
     company's names.
   - notifications/{id}: one doc per person to tell. toUid targets a
     member; toRole:"admin" targets whoever is admin. Read state lives on
     the doc, so the badge is simply "my unread docs".
   ============================================================ */

/* ---------- directory ---------- */
async function syncDirectory(){
  if (!db || !auth || !auth.currentUser) return;
  const u = auth.currentUser;
  try {
    await db.collection("directory").doc(u.uid).set({
      name: S.worker || (u.email ? u.email.split("@")[0] : "Someone"),
      email: u.email || "",
      updatedAt: Date.now()
    });
  } catch (e) { console.error(e); }
}

let notifDir = null;   // cached directory rows; null until first load
async function loadDirectory(){
  if (notifDir) return notifDir;
  try {
    const snap = await db.collection("directory").get();
    const rows = [];
    snap.forEach(doc => rows.push({ uid: doc.id, ...doc.data() }));
    notifDir = rows;
  } catch (e) { console.error(e); notifDir = []; }
  return notifDir;
}

/* ---------- @mention autocomplete ----------
   Typing @ inside the textarea opens a picker of directory names filtered
   by what follows the @; picking one splices "@Full Name " in at the caret. */
function wireMentionBox(ta, pop){
  loadDirectory();   // warm the cache while they type
  const close = () => { pop.hidden = true; };
  const tokenRe = /@([A-Za-z0-9][A-Za-z0-9 ]{0,24})?$/;
  ta.addEventListener("input", () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(tokenRe);
    if (!m){ close(); return; }
    const q = (m[1] || "").toLowerCase();
    const me = (auth.currentUser || {}).uid;
    const opts = (notifDir || [])
      .filter(p => p.uid !== me && p.name && p.name.toLowerCase().startsWith(q))
      .slice(0, 6);
    if (!opts.length){ close(); return; }
    pop.innerHTML = opts.map((p, i) => `
      <button type="button" class="af-opt" data-i="${i}">
        <span class="af-opt-main">${esc(p.name)}</span>
        ${p.email ? `<span class="af-opt-meta">${esc(p.email)}</span>` : ""}
      </button>`).join("");
    pop.hidden = false;
    pop.querySelectorAll("button").forEach(b => b.onclick = () => {
      const head = upto.replace(tokenRe, "@" + opts[Number(b.dataset.i)].name + " ");
      const tail = ta.value.slice(ta.selectionStart);
      ta.value = head + tail;
      close();
      ta.focus();
      ta.setSelectionRange(head.length, head.length);
    });
  });
  ta.addEventListener("keydown", e => {
    if (e.key === "Escape" && !pop.hidden){ e.preventDefault(); close(); }
  });
}

// every directory person whose "@Name" appears in the text, case-insensitive
function parseMentions(text, dir){
  return dir.filter(p => {
    if (!p.name) return false;
    const re = new RegExp("@" + p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return re.test(text);
  });
}

/* One comment fans out to: every tagged member (minus the author and minus
   admins, who are covered by the role doc) plus a single toRole:"admin" doc
   so the admin always sees the comment - unless the author IS the admin. */
async function dispatchMentionNotifications(comment, assignmentId, row){
  const dir = await loadDirectory();
  const me = auth.currentUser;
  if (!me) return;
  const base = {
    fromUid: me.uid,
    fromName: S.worker || (me.email ? me.email.split("@")[0] : "Someone"),
    text: comment,
    store: (row && row.store) || "",
    task: (row && row.task) || "",
    assignmentId: assignmentId || null,
    createdAt: Date.now(),
    read: false
  };
  const mentioned = parseMentions(comment, dir)
    .filter(p => p.uid !== me.uid)
    .filter(p => !ADMIN_EMAILS.includes((p.email || "").toLowerCase()));
  const batch = db.batch();
  const col = db.collection("notifications");
  mentioned.forEach(p => batch.set(col.doc(), { ...base, toUid: p.uid }));
  if (!isAdmin) batch.set(col.doc(), { ...base, toRole: "admin" });
  if (!mentioned.length && isAdmin) return;   // nothing to write
  await batch.commit();
}

/* ---------- the bell ---------- */
let notifRows = [];   // current unread, newest first
function watchNotifications(){
  const bell = $("notifBell"), badge = $("notifBadge");
  if (!bell || !auth.currentUser) return;
  bell.classList.remove("hidden");
  bell.onclick = openNotifCenter;

  let mine = [], forAdmins = [];
  const paint = () => {
    notifRows = mine.concat(forAdmins).sort((a, b) => b.createdAt - a.createdAt);
    badge.textContent = notifRows.length;
    badge.classList.toggle("hidden", !notifRows.length);
  };
  const u1 = db.collection("notifications")
    .where("toUid", "==", auth.currentUser.uid).where("read", "==", false)
    .onSnapshot(s => { mine = []; s.forEach(d => mine.push({ id: d.id, ...d.data() })); paint(); },
      e => console.error(e));
  let u2 = null;
  if (isAdmin) u2 = db.collection("notifications")
    .where("toRole", "==", "admin").where("read", "==", false)
    .onSnapshot(s => { forAdmins = []; s.forEach(d => forAdmins.push({ id: d.id, ...d.data() })); paint(); },
      e => console.error(e));

  onSessionEnd(() => {
    u1(); if (u2) u2();
    notifRows = []; notifDir = null;
    bell.classList.add("hidden");
    badge.classList.add("hidden");
  });
}

function openNotifCenter(){
  const rows = notifRows.slice();   // the snapshot empties once marked read
  openSheet(`
    <h2>Notifications</h2>
    ${rows.length ? `<ul class="hist notif-list">
      ${rows.map((n, i) => `
        <li class="notif-item" data-i="${i}">
          <div>
            <div class="h-c">${esc(n.fromName || "Someone")} · ${esc([n.store, n.task].filter(Boolean).join(" · ") || "task")}</div>
            ${n.text ? `<div class="h-d notif-text">${esc(n.text)}</div>` : ""}
            <div class="h-d">${whenLabel(n.createdAt)}</div>
          </div>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:.6"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </li>`).join("")}
    </ul>` : `<div class="empty">You're all caught up.</div>`}
    <button class="btn btn-ghost btn-sm" id="ntClose">Close</button>
  `, () => {
    $("ntClose").onclick = closeSheet;
    // opening the centre is reading it
    if (rows.length){
      const batch = db.batch();
      rows.forEach(n => batch.update(db.collection("notifications").doc(n.id), { read: true }));
      batch.commit().catch(e => console.error(e));
    }
    // the task reference link: land where the task actually lives
    document.querySelectorAll(".notif-item").forEach(li => li.onclick = () => {
      closeSheet();
      if (isAdmin){ go("team"); return; }
      go("");
      // desktop non-admins keep the queue in the side pane - open it
      const app = $("appScreen");
      if (app.classList.contains("has-tasks")) setSidePaneOpen(true);
    });
  });
}
