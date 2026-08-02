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
    // merge, never replace: the doc also carries the craft (role label) the
    // admin set - a plain set() here erased it on every sign-in
    await db.collection("directory").doc(u.uid).set({
      name: S.worker || (u.email ? u.email.split("@")[0] : "Someone"),
      email: u.email || "",
      updatedAt: Date.now()
    }, { merge: true });
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

/* An admin session refreshes the WHOLE directory from appState, so every
   teammate is @-mentionable immediately - not only the ones who happen to
   have signed in since the directory collection was born. Runs at admin
   boot AND whenever an admin surface has the team fetched anyway (Team
   page, Team pane), writing only entries that are missing or changed -
   so one healthy admin visit anywhere heals the list for everyone. */
async function backfillDirectoryFrom(docs){
  if (!isAdmin || !docs || !docs.length) return;
  try {
    const have = new Map((await loadDirectory()).map(p => [p.uid, p]));
    const batch = db.batch();
    let n = 0;
    docs.forEach(d => {
      const name = (d.state && d.state.worker) || d.raw.name || d.raw.email || "";
      const email = d.raw.email || "";
      if (!name) return;
      const cur = have.get(d.id);
      if (cur && cur.name === name && cur.email === email) return;
      batch.set(db.collection("directory").doc(d.id), { name, email, updatedAt: Date.now() }, { merge: true });
      n++;
    });
    if (n){
      await batch.commit();
      notifDir = null;   // next autocomplete re-reads the fresh list
    }
  } catch (e) { console.error(e); }
}

async function backfillDirectory(){
  if (!isAdmin) return;
  try {
    const snap = await db.collection("appState").get();
    const docs = [];
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      docs.push({ id: doc.id, raw: data, state: s });
    });
    await backfillDirectoryFrom(docs);
  } catch (e) { console.error(e); }
}

/* ---------- @mention autocomplete ----------
   Typing @ inside the textarea opens a picker of directory names filtered
   by what follows the @; picking one splices "@Full Name " in at the caret. */
function wireMentionBox(ta, pop){
  loadDirectory();   // warm the cache while they type
  const close = () => { pop.hidden = true; };
  const tokenRe = /@([A-Za-z0-9][A-Za-z0-9 ]{0,24})?$/;
  let seq = 0;   // drops a stale async paint if they kept typing
  const paint = async () => {
    const my = ++seq;
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(tokenRe);
    if (!m){ close(); return; }
    // a bare "@" waits for the directory and lists EVERYONE - the whole
    // point is not having to remember a colleague's exact name
    const dir = await loadDirectory();
    if (my !== seq) return;   // they typed on; a newer paint owns the popup
    const q = (m[1] || "").toLowerCase();
    const me = (auth.currentUser || {}).uid;
    const opts = dir
      .filter(p => p.uid !== me && p.name && p.name.toLowerCase().startsWith(q))
      .slice(0, 8);
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
  };
  ta.addEventListener("input", paint);
  // clicking back into an "@" they already typed reopens the list
  ta.addEventListener("focus", paint);
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

/* Every completion fans out: a toRole:"admin" doc so the admin's bell
   rings for the finished task itself (comment or not - unless the author
   IS the admin), plus one doc per @tagged member (minus the author and
   minus admins, who are already covered by the role doc). */
async function dispatchMentionNotifications(comment, assignmentId, row){
  const me = auth.currentUser;
  if (!me) return;
  const base = {
    fromUid: me.uid,
    fromName: S.worker || (me.email ? me.email.split("@")[0] : "Someone"),
    text: comment || "",
    store: (row && row.store) || "",
    task: (row && row.task) || "",
    assignmentId: assignmentId || null,
    createdAt: Date.now(),
    read: false
  };
  const mentioned = !comment ? [] : parseMentions(comment, await loadDirectory())
    .filter(p => p.uid !== me.uid)
    .filter(p => !ADMIN_EMAILS.includes((p.email || "").toLowerCase()));
  if (!mentioned.length && isAdmin) return;   // admin finishing own task: nothing to tell
  const batch = db.batch();
  const col = db.collection("notifications");
  // a tag is an OFFER of work, not an FYI: the tagged teammate gets
  // Accept / Decline in their inbox, and the doc keeps the outcome
  mentioned.forEach(p => batch.set(col.doc(), { ...base, toUid: p.uid, kind: "handoff", status: "pending" }));
  if (!isAdmin) batch.set(col.doc(), { ...base, toRole: "admin" });
  await batch.commit();
}

/* ---------- comment-tag hand-offs ----------
   Accepting writes a real assignment addressed to the accepter (the rules
   allow self-addressed creates), so the work lands straight on their
   dashboard card as an open task - and the admin hears. Declining tells
   the tagger. Either way the offer doc keeps its decided state. */
async function handoffAccept(n){
  const me = auth.currentUser;
  const myName = S.worker || (me.email ? me.email.split("@")[0] : "Someone");
  const now = Date.now();
  await db.collection("assignments").add({
    toUid: me.uid, toName: myName,
    fromName: n.fromName || "teammate", fromEmail: "",
    store: n.store || "", task: n.task || "",
    note: n.text || "",
    snote: "Accepted hand-off from " + (n.fromName || "a teammate"),
    dueDate: null, createdAt: now, done: false, doneAt: null,
    groupId: null, groupSize: 1, seenAt: null
  });
  await db.collection("notifications").doc(n.id).update({ status: "accepted" });
  if (!isAdmin) await db.collection("notifications").add({
    toRole: "admin", kind: "handoff-news",
    msg: `${myName} accepted ${n.fromName || "a teammate"}'s hand-off — ${[n.store, n.task].filter(Boolean).join(" · ") || "a task"}`,
    fromUid: me.uid, fromName: myName, createdAt: now, read: false
  });
  toast("Added to your queue");
}
async function handoffDecline(n){
  const me = auth.currentUser;
  const myName = S.worker || (me.email ? me.email.split("@")[0] : "Someone");
  await db.collection("notifications").doc(n.id).update({ status: "declined" });
  if (n.fromUid && n.fromUid !== me.uid) await db.collection("notifications").add({
    toUid: n.fromUid, kind: "handoff-news",
    msg: `${myName} declined the hand-off — ${[n.store, n.task].filter(Boolean).join(" · ") || "a task"}`,
    fromUid: me.uid, fromName: myName, createdAt: Date.now(), read: false
  });
  toast("Declined — " + (n.fromName || "they") + " will know");
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

/* The centre is an inbox, not a badge-drain: EVERY notification ever sent
   to this account stays listed (newest first, capped at the latest 50).
   Unread ones wear a green dot; opening the centre marks them read, which
   clears the bell badge but removes nothing from the list. Fetched without
   an orderBy and sorted client-side so no composite index is needed. */
async function fetchNotifHistory(){
  const me = auth.currentUser;
  if (!me) return [];
  const out = [];
  const q1 = await db.collection("notifications").where("toUid", "==", me.uid).get();
  q1.forEach(d => out.push({ id: d.id, ...d.data() }));
  if (isAdmin){
    const q2 = await db.collection("notifications").where("toRole", "==", "admin").get();
    q2.forEach(d => out.push({ id: d.id, ...d.data() }));
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out.slice(0, 50);
}

function openNotifCenter(){
  openSheet(`
    <h2>Notifications</h2>
    <div id="ntBody">
      <div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>
    </div>
    <button class="btn btn-ghost btn-sm" id="ntClose">Close</button>
  `, () => { $("ntClose").onclick = closeSheet; });

  fetchNotifHistory().then(rows => {
    const body = $("ntBody");
    if (!body) return;   // the sheet moved on while we were fetching
    const meUid = (auth.currentUser || {}).uid;
    body.innerHTML = rows.length ? `<ul class="hist notif-list">
      ${rows.map((n, i) => {
        const head = n.msg ? esc(n.msg)
          : n.kind === "campaign" ? "A campaign moved"
          : esc(n.fromName || "Someone") + " finished " + esc([n.store, n.task].filter(Boolean).join(" · ") || "a task");
        const pending = n.kind === "handoff" && n.status === "pending" && n.toUid === meUid;
        const decided = n.kind === "handoff" && n.status && n.status !== "pending";
        return `
        <li class="notif-item${n.read ? "" : " is-unread"}" data-i="${i}">
          <div>
            <div class="h-c">${head}${decided ? ` <span class="hf-chip is-${esc(n.status)}">${esc(n.status)}</span>` : ""}</div>
            ${n.text ? `<div class="h-d notif-text">${esc(n.text)}</div>` : ""}
            <div class="h-d">${whenLabel(n.createdAt)}</div>
            ${pending ? `
            <div class="hf-acts">
              <button type="button" class="hf-btn hf-acc" data-hf="acc" data-i="${i}">Accept</button>
              <button type="button" class="hf-btn hf-dec" data-hf="dec" data-i="${i}">Decline</button>
            </div>` : ""}
          </div>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:.6"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </li>`;
      }).join("")}
    </ul>` : `<div class="empty">Nothing here yet. Task comments that tag you and campaign handoffs land here — and stay.</div>`;

    // Accept / Decline act right here in the inbox; the row click below
    // must not also fire, and the list repaints with the decided state
    body.querySelectorAll("[data-hf]").forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const n = rows[Number(b.dataset.i)];
      b.closest(".hf-acts").querySelectorAll("button").forEach(x => { x.disabled = true; });
      try {
        if (b.dataset.hf === "acc") await handoffAccept(n);
        else await handoffDecline(n);
        openNotifCenter();
      } catch (err) {
        console.error(err);
        toast("Couldn't do that — make sure the updated Firestore rules are published");
        openNotifCenter();
      }
    });

    // opening the centre reads the unread; the docs stay for next time
    const unread = rows.filter(n => !n.read);
    if (unread.length){
      const batch = db.batch();
      unread.forEach(n => batch.update(db.collection("notifications").doc(n.id), { read: true }));
      batch.commit().catch(e => console.error(e));
    }
    // the task reference link: land where the task actually lives
    body.querySelectorAll(".notif-item").forEach(li => li.onclick = () => {
      const n = rows[Number(li.dataset.i)];
      closeSheet();
      // campaign news lands on the campaign itself, not just the list page
      if (n && n.kind === "campaign"){
        go("campaigns");
        if (n.campaignId && typeof cgOpenDetail === "function")
          setTimeout(() => cgOpenDetail(n.campaignId), 80);
        return;
      }
      if (isAdmin){ go("team"); return; }
      go("");
      // desktop non-admins keep the queue in the side pane - open it
      const app = $("appScreen");
      if (app.classList.contains("has-tasks")) setSidePaneOpen(true);
    });
  }).catch(e => {
    console.error(e);
    const body = $("ntBody");
    if (body) body.innerHTML = `<div class="empty">Couldn't load notifications — check your connection.</div>`;
  });
}
