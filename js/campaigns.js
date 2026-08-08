/* ============================================================
   CAMPAIGNS — the baton-pass pipeline (v2).

   One campaign = one piece of work travelling a chain of stages the admin
   designed. Exactly one stage holds the baton at a time; finishing a stage
   IS the handoff. v2 grows four muscles on the v1 skeleton:

   - Stages can carry a time budget (days). The baton arriving starts the
     clock: the age chip stops guessing ("3d in stage") and starts judging
     ("due tomorrow", "overdue 2d"). Templates remember the budgets.
   - A stage can have SEVERAL owners — all must approve before the baton
     advances. Each approval is recorded; any owner can still send back.
   - A stage can target a ROLE ("anyone who is a designer") instead of a
     person; it resolves to the least-loaded member with that craft at
     create time. Templates survive team changes this way.
   - Admins get a Board view: columns are stages, cards are campaigns,
     dragging a card IS jumping the baton.
   - A stage can be sent to the CLIENT: an unguessable link (no login)
     shows them the work and takes Approve / Request changes. Their
     decision lands in the campaign's detail for the stage owner to act on.

   Storage: campaigns/{id} (chain + baton + links + history in one doc),
   campaignTemplates/{id} (saved chains: stages, budgets, owners or roles),
   clientReviews/{token} (the token IS the capability — random doc id in a
   link; see client-review.html), directory/{uid}.craft (role labels).

   v1 docs stay readable: stages written before owners[] existed carry
   uid/uname — cgOwnersOf() normalizes both shapes everywhere.
   ============================================================ */

const CG_DAY = 86400000;

/* ---------- live cache + drawer badge ---------- */
let cgRows = null;        // every campaign this account may see; null = loading
let cgBatonSeen = null;   // "id:cur" pairs already on screen; null = first snapshot
let cgLiveOpen = false;   // the Live section's disclosure survives re-renders
let cgView = localStorage.getItem("cgView") || "list";   // admin: list | board

const cgStage = c => c.stages && c.stages[c.cur] ? c.stages[c.cur] : null;
const cgOwnersOf = s => s ? (s.owners || (s.uid ? [{ uid: s.uid, uname: s.uname }] : [])) : [];
const cgOwnerNames = s => cgOwnersOf(s).map(o => o.uname).join(", ");
const cgApproved = s => ((s && s.approvals) || []).filter(u => cgOwnersOf(s).some(o => o.uid === u));

// my turn = I own the current stage and haven't approved this round yet
const cgIsMyTurn = c => {
  const s = cgStage(c), me = auth.currentUser;
  return c.status === "active" && s && me
    && cgOwnersOf(s).some(o => o.uid === me.uid)
    && !cgApproved(s).includes(me.uid);
};
const cgAgeDays = c => {
  const s = cgStage(c);
  return s && s.enteredAt ? Math.floor((Date.now() - s.enteredAt) / CG_DAY) : 0;
};
// display name for whoever's signed in now - a real name if they've set
// one, else their email's local part, else "Someone"
const cgMyName = () => {
  const me = auth.currentUser;
  return S.worker || (me && me.email ? me.email.split("@")[0] : "Someone");
};

/* The chip judges when it can, guesses when it can't: a stage with a time
   budget compares against its deadline; one without falls back to raw age
   (quiet, then amber ~2 days, red ~4). */
function cgDueInfo(c){
  if (c.status !== "active") return null;
  const s = cgStage(c);
  if (!s) return null;
  if (s.dueAt){
    const left = Math.floor((s.dueAt - Date.now()) / CG_DAY);
    if (left < 0)  return { cls: " is-red",   label: "overdue " + (-left) + "d" };
    if (left === 0) return { cls: " is-amber", label: "due today" };
    if (left === 1) return { cls: " is-amber", label: "due tomorrow" };
    return { cls: "", label: "due in " + left + "d" };
  }
  const d = cgAgeDays(c);
  return { cls: d >= 4 ? " is-red" : d >= 2 ? " is-amber" : "", label: d ? d + "d in stage" : "today" };
}
function cgAgeChip(c){
  const i = cgDueInfo(c);
  return i ? `<span class="cg-age${i.cls}">${i.label}</span>` : "";
}
// stuck-longest-first: overdue distance when a deadline exists, raw age
// (zeroed at the amber threshold) when it doesn't — comparable enough
const cgStuckScore = c => {
  const s = cgStage(c);
  if (!s) return -Infinity;
  if (s.dueAt) return Date.now() - s.dueAt;
  return (Date.now() - (s.enteredAt || Date.now())) - 2 * CG_DAY;
};

let cgLoadError = false;   // the page says so instead of skeleting forever
function watchCampaigns(){
  if (!db || !auth.currentUser) return;
  const uid = auth.currentUser.uid;
  cgRows = null; cgBatonSeen = null; cgLoadError = false;
  const q = isAdmin
    ? db.collection("campaigns")
    : db.collection("campaigns").where("memberUids", "array-contains", uid);
  const unsub = q.onSnapshot(snap => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    // a doc with no chain (malformed write, hand-edited in the console)
    // must degrade to an empty track, not crash every render after it
    rows.forEach(c => { if (!Array.isArray(c.stages)) c.stages = []; });
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (cgBatonSeen){
      rows.filter(cgIsMyTurn)
        .filter(c => !cgBatonSeen.has(c.id + ":" + c.cur))
        .forEach(c => toast(`Your turn: ${c.title} · ${(cgStage(c) || {}).name || ""}`));
    }
    cgBatonSeen = new Set(rows.filter(c => c.status === "active").map(c => c.id + ":" + c.cur));
    cgRows = rows;
    cgLoadError = false;
    cgStampSeen(rows);

    cgPaintBadge(rows.filter(cgIsMyTurn).length);
    if (currentRoute() === "campaigns") renderCampaignsPage();
    // batons also live in the dashboard queue and the admin's Team pane now -
    // a campaign changing repaints those surfaces too
    if (typeof renderAssignedQueue === "function") renderAssignedQueue();
    if (isAdmin && typeof renderTeamPane === "function") renderTeamPane();

    const root = $("cgDetailRoot");
    if (root){
      const c = rows.find(x => x.id === root.dataset.id);
      // from a member's filtered snapshot, deleted and reassigned-away look
      // identical - the toast must not claim more than it knows
      if (!c){ closeSheet(); toast("That campaign left your list — reassigned or deleted"); }
      else if (String(c.updatedAt || "") !== root.dataset.u) cgOpenDetail(c.id);
    }
  }, e => {
    console.error(e);
    cgLoadError = true;
    if (cgRows === null) cgRows = [];
    if (currentRoute() === "campaigns") renderCampaignsPage();
  });
  onSessionEnd(() => { unsub(); cgRows = null; cgBatonSeen = null; cgLiveOpen = false; cgLoadError = false; cgPaintBadge(0); });
}

/* ---------- the receipt, mirrored from assignments' seenAt ----------
   A baton rendering on its owner's screen is "seen": each owner's uid is
   stamped into the current stage's seenBy (per round - cgReceive clears
   it), inside a transaction so a concurrent pass can't be clobbered, and
   WITHOUT touching updatedAt so the stamp doesn't churn open sheets.
   Stamped only when missing, so the loop goes quiet after one write. */
function cgStampSeen(rows){
  const me = auth.currentUser;
  if (!me) return;
  rows.filter(cgIsMyTurn).forEach(c => {
    const s = cgStage(c);
    if (!s || (s.seenBy || []).includes(me.uid)) return;
    const ref = db.collection("campaigns").doc(c.id);
    db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) return;
      const cc = doc.data();
      if (cc.status !== "active" || cc.cur !== c.cur) return;
      const stages = cc.stages.map(x => ({ ...x }));
      const st = stages[cc.cur];
      if (!st || (st.seenBy || []).includes(me.uid)) return;
      st.seenBy = [...(st.seenBy || []), me.uid];
      tx.update(ref, { stages });
    }).catch(e => console.error(e));
  });
}

function cgPaintBadge(n){
  const b = $("cgNavBadge");
  if (b){ b.textContent = n; b.classList.toggle("hidden", !n); }
  // the drawer badge lives behind a closed drawer - the hamburger itself
  // carries a dot so "work is waiting" is visible without opening anything
  const m = $("menuBtn");
  if (m) m.classList.toggle("has-baton", n > 0);
}

/* ---------- batons as dashboard-queue rows ----------
   The worker's "Assigned to you" card merges these at render time: same
   card, same store groups, same due sorting - a baton is just a row whose
   expanded body says Pass instead of Done. The campaign doc stays the only
   source of truth; these rows are a view, never written anywhere. */
const cgISO = ts => {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};
function cgBatonRows(){
  if (!cgRows || !auth.currentUser) return [];
  return cgRows.filter(cgIsMyTurn).map(c => {
    const s = cgStage(c);
    const h = cgLastNote(c);
    const own = cgOwnersOf(s);
    return {
      id: "cg:" + c.id, cg: c.id,
      store: c.store || "—",
      task: c.title + " · " + s.name,
      note: (h && h.note) || c.brief || "",
      fromName: h ? h.by : ((c.createdBy && c.createdBy.name) || ""),
      dueDate: s.dueAt ? cgISO(s.dueAt) : (c.dueDate || null),
      createdAt: s.enteredAt || c.createdAt,
      canBack: c.cur > 0,
      multi: own.length > 1 ? `${cgApproved(s).length}/${own.length} approved` : ""
    };
  });
}

/* ---------- notifications (ride the existing bell) ---------- */
async function cgNotify(uids, msg, c, opts){
  const me = auth.currentUser;
  if (!me) return;
  try {
    const dir = await loadDirectory();
    const isAdminUid = u => {
      const p = dir.find(x => x.uid === u);
      return p && ADMIN_EMAILS.includes((p.email || "").toLowerCase());
    };
    const base = {
      kind: "campaign", campaignId: c.id || null, title: c.title || "",
      msg, fromUid: me.uid,
      fromName: cgMyName(),
      createdAt: Date.now(), read: false
    };
    const batch = db.batch();
    const col = db.collection("notifications");
    const roleDoc = opts && opts.admins && !isAdmin;
    // an admin recipient is skipped ONLY when the toRole doc in this same
    // batch already covers them - otherwise an admin who owns a stage would
    // hear nothing at all when the baton reaches them
    [...new Set(uids)].filter(u => u && u !== me.uid && !(roleDoc && isAdminUid(u)))
      .forEach(u => batch.set(col.doc(), { ...base, toUid: u }));
    if (roleDoc) batch.set(col.doc(), { ...base, toRole: "admin" });
    await batch.commit();
  } catch (e) { console.error(e); }
}

/* ---------- the page ---------- */
function renderCampaignsPage(){
  const box = $("campaignsBody");
  if (!box) return;
  if (cgRows === null){
    box.innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
    return;
  }
  if (cgLoadError){
    box.innerHTML = `<div class="fpage-panel"><div class="empty">Couldn't load campaigns — check your connection (or that the Firestore rules are published), then reload.</div></div>`;
    return;
  }

  const act = cgRows.filter(c => c.status === "active");
  const live = cgRows.filter(c => c.status === "live")
    .sort((a, b) => (b.liveAt || 0) - (a.liveAt || 0));
  const mine = act.filter(cgIsMyTurn);
  const flight = [...act].sort((a, b) => cgStuckScore(b) - cgStuckScore(a));
  const board = isAdmin && cgView === "board";

  const note = act.length
    ? `${act.length} in flight${mine.length ? ` · <b>${mine.length} waiting on you</b>` : ""}${live.length ? ` · ${live.length} live` : ""}`
    : (live.length ? `Nothing in flight · ${live.length} live` : "No campaigns yet");

  box.innerHTML = `
    <div class="fpage-bar">
      <p class="fpage-bar-note">${note}</p>
      <div class="fpage-bar-acts">
        ${isAdmin ? `
          <span class="cg-viewtog" role="group" aria-label="View">
            <button type="button" class="cg-viewtog-b${board ? "" : " is-on"}" data-v="list">List</button>
            <button type="button" class="cg-viewtog-b${board ? " is-on" : ""}" data-v="board">Board</button>
          </span>
          <button type="button" class="icon-btn" id="cgRolesBtn" aria-label="Roles" title="Roles">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6 17c0-1.8 1.5-3 3-3s3 1.2 3 3"/><path d="M14 10h4M14 14h4"/></svg>
          </button>
          <button class="btn btn-go btn-sm" id="cgNewBtn">New campaign</button>` : ""}
      </div>
    </div>

    ${mine.length ? `
    <p class="fpage-section-title">Your turn</p>
    <div class="cg-turns">${mine.map(cgTurnCard).join("")}</div>` : ""}

    ${board ? cgBoardHTML(act, live) : `
    <p class="fpage-section-title">In flight</p>
    ${flight.length ? `<ul class="cg-list">${flight.map(cgRowHTML).join("")}</ul>` : `
      <div class="fpage-panel"><div class="empty">
        ${isAdmin
          ? "Nothing in flight. Start one with New campaign — build the chain once, save it as a template, reuse it forever."
          : "Nothing in flight for you right now. When a campaign reaches your stage, it lands here — and you'll hear about it."}
      </div></div>`}

    ${live.length ? `
    <button type="button" class="cg-live-head${cgLiveOpen ? " is-open" : ""}" id="cgLiveHead" aria-expanded="${cgLiveOpen}">
      ${CARET_SVG("cg-live-caret")} Live <span class="cg-live-count">${live.length}</span>
    </button>
    <ul class="cg-list cg-list-live${cgLiveOpen ? "" : " hidden"}" id="cgLiveList">
      ${live.slice(0, 12).map(cgRowHTML).join("")}
    </ul>` : ""}`}`;

  if (isAdmin){
    const nb = $("cgNewBtn"), rb = $("cgRolesBtn");
    if (nb) nb.onclick = () => cgEditorSheet(null);
    if (rb) rb.onclick = cgRolesSheet;
    box.querySelectorAll(".cg-viewtog-b").forEach(b => b.onclick = () => {
      cgView = b.dataset.v;
      try { localStorage.setItem("cgView", cgView); } catch {}
      renderCampaignsPage();
    });
    if (board) cgWireBoard(box);
  }
  const lh = $("cgLiveHead");
  if (lh) lh.onclick = () => { cgLiveOpen = !cgLiveOpen; renderCampaignsPage(); };
  box.querySelectorAll("[data-cg]").forEach(el => {
    el.onclick = e => {
      if (e.target.closest("[data-cga]")) return;
      cgOpenDetail(el.dataset.cg);
    };
    // divs/lis wearing role=button must honour the keys real buttons get free
    el.onkeydown = e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== el) return;
      e.preventDefault();
      cgOpenDetail(el.dataset.cg);
    };
  });
  box.querySelectorAll("[data-cga]").forEach(b => b.onclick = () => {
    const id = b.closest("[data-cg]").dataset.cg;
    if (b.dataset.cga === "pass") cgPassSheet(id);
    else if (b.dataset.cga === "back") cgBackSheet(id);
  });
}

function cgTrack(c){
  // done means the stage actually finished (doneAt), not merely "behind the
  // baton" - a stage inserted before the baton via Edit must not show a tick
  return `<span class="cg-track" aria-hidden="true">${c.stages.map((s, i) => {
    const cls = c.status === "live" || s.doneAt ? "is-done" : (c.status === "active" && i === c.cur) ? "is-cur" : "";
    return `<i class="cg-dot ${cls}" title="${esc(s.name)} · ${esc(cgOwnerNames(s))}"></i>`;
  }).join("")}</span>`;
}

const cgRoundsChip = s => (s && s.rounds > 1) ? `<span class="cg-rounds">R${s.rounds}</span>` : "";
// "2/3" on a multi-owner stage mid-approval
function cgApChip(s){
  const own = cgOwnersOf(s);
  if (own.length < 2) return "";
  return `<span class="cg-ap">${cgApproved(s).length}/${own.length}</span>`;
}

function cgLastNote(c){
  for (let i = (c.history || []).length - 1; i >= 0; i--){
    const h = c.history[i];
    if ((h.type === "forward" || h.type === "back" || h.type === "approve") && h.note) return h;
  }
  return null;
}

function cgTurnCard(c){
  const s = cgStage(c) || {};
  const own = cgOwnersOf(s);
  const multi = own.length > 1;
  const last = c.cur >= c.stages.length - 1;
  const h = cgLastNote(c);
  const today = todayISO();
  const late = c.dueDate && c.dueDate < today;
  return `
  <div class="cg-turn" data-cg="${esc(c.id)}" role="button" tabindex="0">
    <div class="cg-turn-top">
      <span class="cg-turn-stage">${esc(s.name || "")}${cgRoundsChip(s)}${cgApChip(s)}</span>
      ${cgAgeChip(c)}
    </div>
    <p class="cg-turn-title">${esc(c.title)}</p>
    <p class="cg-turn-meta">${esc(c.store || "")}${c.dueDate ? ` · ${late ? "overdue" : "due"} ${esc(c.dueDate)}` : ""}${multi ? ` · with ${esc(own.filter(o => o.uid !== auth.currentUser.uid).map(o => o.uname).join(", "))}` : ""}</p>
    ${h ? `<p class="cg-turn-note">“${esc(h.note)}” <span>— ${esc(h.by)}</span></p>` : ""}
    ${cgTrack(c)}
    <div class="cg-turn-acts">
      <button type="button" class="btn btn-go btn-sm" data-cga="pass">${
        multi ? (last ? "Approve · go live" : "Approve") : (last ? "Pass · go live" : "Pass forward")}</button>
      ${c.cur > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-cga="back">Send back</button>` : ""}
    </div>
  </div>`;
}

function cgRowHTML(c){
  const s = cgStage(c);
  const liveRow = c.status === "live";
  const mid = liveRow
    ? `live ${c.liveAt ? whenLabel(c.liveAt).toLowerCase() : ""}`
    : `${esc(s ? s.name : "")} · ${esc(s ? cgOwnerNames(s) : "")}${cgIsMyTurn(c) ? " (you)" : ""}`;
  return `
  <li class="cg-row${liveRow ? " is-live" : ""}${cgIsMyTurn(c) ? " is-mine" : ""}" data-cg="${esc(c.id)}" role="button" tabindex="0">
    <div class="cg-row-main">
      <span class="cg-row-title">${esc(c.title)}</span>
      <span class="cg-row-meta">${esc(c.store || "")}${c.store ? " · " : ""}${mid}${cgRoundsChip(s)}${liveRow ? "" : cgApChip(s)}</span>
    </div>
    ${cgTrack(c)}
    ${liveRow ? `<span class="cg-live-mark">LIVE</span>` : cgAgeChip(c)}
  </li>`;
}

function enterCampaignsPage(){ renderCampaignsPage(); }

/* ---------- the Board (admin): columns are stages, dragging is jumping ----------
   Columns are every stage name across in-flight campaigns, in first-
   appearance order, plus LIVE at the end. Dropping a card on a column the
   campaign's chain doesn't contain is refused with words, not silence. */
function cgBoardHTML(act, live){
  const cols = [];
  act.forEach(c => c.stages.forEach(s => { if (!cols.includes(s.name)) cols.push(s.name); }));
  const card = c => `
    <div class="cg-card" draggable="true" data-cg="${esc(c.id)}" role="button" tabindex="0">
      <b>${esc(c.title)}</b>
      <span>${esc(c.store || "")}${c.store ? " · " : ""}${esc(cgOwnerNames(cgStage(c)) || "")}</span>
      <div class="cg-card-foot">${cgTrack(c)}${cgAgeChip(c)}</div>
    </div>`;
  const liveCard = c => `
    <div class="cg-card is-live" data-cg="${esc(c.id)}" role="button" tabindex="0">
      <b>${esc(c.title)}</b>
      <span>${c.liveAt ? esc(whenLabel(c.liveAt).toLowerCase()) : ""}</span>
    </div>`;
  return `
  <div class="cg-board" id="cgBoard">
    ${cols.map(name => {
      const cards = act.filter(c => (cgStage(c) || {}).name === name);
      return `
      <div class="cg-col" data-col="${esc(name)}">
        <p class="cg-col-head">${esc(name)}${cards.length ? ` <span>${cards.length}</span>` : ""}</p>
        <div class="cg-col-body">${cards.map(card).join("")}</div>
      </div>`;
    }).join("")}
    <div class="cg-col cg-col-live" data-col="__live">
      <p class="cg-col-head">LIVE${live.length ? ` <span>${live.length}</span>` : ""}</p>
      <div class="cg-col-body">${live.slice(0, 8).map(liveCard).join("")}</div>
    </div>
  </div>`;
}

function cgWireBoard(box){
  box.querySelectorAll(".cg-card[draggable]").forEach(card => {
    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", card.dataset.cg);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("is-drag");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-drag"));
  });
  box.querySelectorAll(".cg-col").forEach(col => {
    col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("is-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("is-over"));
    col.addEventListener("drop", e => {
      e.preventDefault();
      col.classList.remove("is-over");
      const id = e.dataTransfer.getData("text/plain");
      const c = cgFind(id);
      if (!c) return;
      const name = col.dataset.col;
      if (name === "__live"){
        // shipping by drop is one gesture from irreversible-feeling - confirm
        if (confirm(`Ship "${c.title}" as LIVE?`)) cgJumpTo(id, "live");
        return;
      }
      // chains may repeat a stage name (two "Review"s) - collect every match:
      // already-current means no-op, else prefer the first unfinished one
      const idxs = c.stages.map((s, i) => s.name === name ? i : -1).filter(i => i >= 0);
      if (!idxs.length){ toast(`"${c.title}" has no ${name} stage`); return; }
      if (c.status === "active" && idxs.includes(c.cur)) return;
      const idx = idxs.find(i => !c.stages[i].doneAt);
      cgJumpTo(id, idx === undefined ? idxs[0] : idx);
    });
  });
}

/* ---------- detail sheet: the whole story of one campaign ---------- */
function cgFind(id){ return (cgRows || []).find(c => c.id === id) || null; }

function cgHistLine(h){
  const t = h.type;
  if (t === "created") return `${esc(h.by)} created the campaign`;
  if (t === "forward") return `${esc(h.by)} passed ${esc(h.from || "")} → ${esc(h.to || "")}`;
  if (t === "approve") return `${esc(h.by)} approved ${esc(h.from || "")}`;
  if (t === "back")    return `${esc(h.by)} sent ${esc(h.from || "")} back to ${esc(h.to || "")}`;
  if (t === "jump")    return `${esc(h.by)} moved the baton ${esc(h.from || "")} → ${esc(h.to || "")}`;
  if (t === "client")  return `${esc(h.by)} sent ${esc(h.to || "the work")} to the client`;
  if (t === "live")    return `${esc(h.by)} shipped it — LIVE`;
  if (t === "edit")    return `${esc(h.by)} edited the campaign`;
  return esc(h.by || "");
}

function cgLinkLabel(url){
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname : "";
    return (u.hostname.replace(/^www\./, "") + path).slice(0, 44);
  } catch { return url.slice(0, 44); }
}

function cgOpenDetail(id){
  const c = cgFind(id);
  if (!c) return;
  const me = auth.currentUser;
  const mine = cgIsMyTurn(c);
  const cs = cgStage(c);
  const iOwnCur = c.status === "active" && cs && cgOwnersOf(cs).some(o => o.uid === me.uid);
  // owner who already approved: no buttons, but say why there are none
  const waiting = iOwnCur && !mine;
  const today = todayISO();
  const late = c.status === "active" && c.dueDate && c.dueDate < today;

  const stages = c.stages.map((s, i) => {
    const done = c.status === "live" || !!s.doneAt;
    const cur = c.status === "active" && i === c.cur;
    const own = cgOwnersOf(s);
    const ap = cgApproved(s);
    // the receipt: every owner of the holding stage has had it on screen
    const seen = cur && own.length && own.every(o => (s.seenBy || []).includes(o.uid));
    const state = done
      ? (s.doneAt ? "done " + whenLabel(s.doneAt).toLowerCase() : "done")
      : cur
        ? `${seen ? "seen · " : ""}${own.length > 1 ? ap.length + "/" + own.length + " approved · " : ""}${
            s.dueAt ? (s.dueAt < Date.now() ? "overdue" : "due " + dayStamp(s.dueAt)) : "holding" + (cgAgeDays(c) ? " · " + cgAgeDays(c) + "d" : "")}`
        : `waiting${s.days ? " · " + s.days + "d budget" : ""}`;
    return `
    <li class="cg-stg${done ? " is-done" : ""}${cur ? " is-cur" : ""}">
      <span class="cg-stg-pip">${done ? AF_TICK : ""}</span>
      <span class="cg-stg-main">
        <span class="cg-stg-name">${esc(s.name)}${cgRoundsChip(s)}${s.role ? `<span class="cg-role-tag">${esc(s.role)}</span>` : ""}</span>
        <span class="cg-stg-who">${own.map(o =>
          `${esc(o.uname)}${o.uid === me.uid ? " (you)" : ""}${cur && own.length > 1 && ap.includes(o.uid) ? " ✓" : ""}`).join(", ")}</span>
      </span>
      <span class="cg-stg-state">${state}</span>
    </li>`;
  }).join("");

  const links = (c.links || []).slice().reverse();
  const hist = (c.history || []).slice().reverse();
  const canClientLink = c.status === "active" && (isAdmin || iOwnCur);

  openSheet(`
    <div id="cgDetailRoot" data-id="${esc(c.id)}" data-u="${esc(String(c.updatedAt || ""))}">
      <h2 class="cg-dt-title">${esc(c.title)}</h2>
      <p class="cg-dt-meta">
        ${c.status === "live"
          ? `<span class="cg-live-mark">LIVE</span> ${c.liveAt ? esc(whenLabel(c.liveAt).toLowerCase()) : ""}`
          : `${esc(c.store || "")}${c.dueDate ? ` · ${late ? "<b>overdue</b>" : "due"} ${esc(c.dueDate)}` : ""}`}
      </p>
      ${c.brief ? `<p class="cg-dt-brief">${esc(c.brief)}</p>` : ""}

      <ul class="cg-stages">${stages}</ul>

      ${links.length ? `
      <p class="cg-dt-label">The work</p>
      <ul class="cg-links">${links.map(l => `
        <li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(cgLinkLabel(l.url))}</a>
        <span>${esc(l.stage)} · ${esc(l.by)}</span></li>`).join("")}
      </ul>` : ""}

      <div id="cgCrWrap">
        <p class="cg-dt-label">Client approval</p>
        <div id="cgCrBox"><div class="skel skel-row"></div></div>
        ${canClientLink ? `<button type="button" class="btn btn-ghost btn-sm" id="cgCrNew">New client link</button>` : ""}
      </div>

      <p class="cg-dt-label">History</p>
      <ul class="cg-hist">${hist.slice(0, 14).map(h => `
        <li><span class="cg-hist-t">${esc(whenLabel(h.t))}</span>
          <span class="cg-hist-w">${cgHistLine(h)}${h.note ? `<i>“${esc(h.note)}”</i>` : ""}</span></li>`).join("")}
        ${hist.length > 14 ? `<li class="cg-hist-more">…and ${hist.length - 14} earlier</li>` : ""}
      </ul>

      ${waiting ? `<p class="hint">You approved this round — waiting on ${esc(cgOwnersOf(cs).filter(o => !cgApproved(cs).includes(o.uid)).map(o => o.uname).join(", ") || "the others")}.</p>` : ""}
      ${mine ? `
      <button class="btn btn-go" id="cgDtPass">${cgOwnersOf(cs).length > 1
        ? (c.cur >= c.stages.length - 1 ? "Approve · go live" : "Approve")
        : (c.cur >= c.stages.length - 1 ? "Pass forward · go live" : "Pass forward")}</button>` : ""}
      ${(mine || waiting) && c.cur > 0 ? `<button class="btn btn-sm" id="cgDtBack">Send back</button>` : ""}
      ${isAdmin ? `
      <div class="cg-admin-acts">
        <button class="btn btn-ghost btn-sm" id="cgDtEdit">Edit</button>
        <button class="btn btn-ghost btn-sm" id="cgDtJump">${c.status === "active" ? "Move baton" : "Bring it back"}</button>
        <button class="btn btn-ghost btn-sm cg-danger" id="cgDtDel">Delete</button>
      </div>` : ""}
      <button class="btn btn-ghost btn-sm" id="cgDtClose">Close</button>
    </div>
  `, () => {
    $("cgDtClose").onclick = closeSheet;
    const on = (bid, fn) => { const b = $(bid); if (b) b.onclick = fn; };
    on("cgDtPass", () => cgPassSheet(c.id));
    on("cgDtBack", () => cgBackSheet(c.id));
    on("cgDtEdit", () => cgEditorSheet(c));
    on("cgDtJump", () => cgJumpSheet(c.id));
    on("cgCrNew", () => cgNewClientLink(c));
    on("cgDtDel", async () => {
      if (!confirm(`Delete "${c.title}"? The whole track, its links and history go with it. This can't be undone.`)) return;
      try {
        // the confirm dialog promises the campaign's links go with it too -
        // a stale clientReviews doc left behind stays a live, unauthenticated,
        // still-answerable link for whoever's holding it
        const batch = db.batch();
        const reviews = await db.collection("clientReviews").where("campaignId", "==", c.id).get();
        reviews.forEach(doc => batch.delete(doc.ref));
        batch.delete(db.collection("campaigns").doc(c.id));
        await batch.commit();
        closeSheet();
        toast("Campaign deleted");
      } catch (e) { console.error(e); toast("Couldn't delete — check Firestore rules allow it"); }
    });
    cgLoadClientReviews(c, canClientLink);
  });
}

/* ---------- client approval ----------
   The link is the key: clientReviews/{token} with a random doc id, opened
   by client-review.html?t=TOKEN with no login. The client sees the work
   links and answers Approve / Request changes; the answer lands here for
   the stage owner to act on. Their decision never moves the baton itself —
   the team does, with the client's words in hand. */
async function cgLoadClientReviews(c, canCreate){
  const box = $("cgCrBox");
  if (!box) return;
  try {
    const snap = await db.collection("clientReviews").where("campaignId", "==", c.id).get();
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const wrap = $("cgCrWrap");
    if (!rows.length){
      if (!canCreate && wrap) wrap.classList.add("hidden");
      else box.innerHTML = `<p class="cg-cr-none">No client link yet — send one and their Approve / Request changes lands right here.</p>`;
      return;
    }
    const STATE = {
      pending:  { cls: "is-wait", label: "waiting on client" },
      approved: { cls: "is-ok",   label: "client approved" },
      changes:  { cls: "is-chg",  label: "changes requested" }
    };
    box.innerHTML = `<ul class="cg-cr-list">${rows.map(r => {
      const st = STATE[r.status] || STATE.pending;
      return `
      <li class="cg-cr">
        <span class="cg-cr-pill ${st.cls}">${st.label}</span>
        <span class="cg-cr-main">
          <span class="cg-cr-stage">${esc(r.stage || "")} · sent ${esc(whenLabel(r.createdAt || 0).toLowerCase())}</span>
          ${r.comment ? `<span class="cg-cr-note">“${esc(r.comment)}”</span>` : ""}
        </span>
        ${r.status === "pending" ? `<button type="button" class="cg-cr-copy" data-t="${esc(r.id)}" title="Copy link">Copy link</button>` : ""}
      </li>`;
    }).join("")}</ul>`;
    box.querySelectorAll(".cg-cr-copy").forEach(b => b.onclick = async () => {
      const url = new URL("client-review.html?t=" + b.dataset.t, location.href).href;
      toast(await copyText(url) ? "Client link copied" : "Copy failed");
    });
  } catch (e) {
    console.error(e);
    box.innerHTML = `<p class="cg-cr-none">Couldn't load client reviews.</p>`;
  }
}

async function cgNewClientLink(c){
  const me = auth.currentUser;
  const myName = cgMyName();
  const st = cgStage(c);
  if (!st) return;
  try {
    const now = Date.now();
    const ref = db.collection("clientReviews").doc();
    await ref.set({
      campaignId: c.id, title: c.title, store: c.store || "",
      stage: st.name, brief: c.brief || "",
      // the client sees what the team has produced so far, newest first
      links: (c.links || []).slice(-8).reverse().map(l => ({ url: l.url, stage: l.stage })),
      status: "pending", comment: "", decidedAt: null,
      createdAt: now, createdBy: myName
    });
    // the send is part of the campaign's story - appended atomically, so a
    // baton move committing at the same moment keeps its history entry
    await db.collection("campaigns").doc(c.id).update({
      history: firebase.firestore.FieldValue.arrayUnion({ t: now, type: "client", by: myName, to: st.name }),
      updatedAt: now
    });
    const url = new URL("client-review.html?t=" + ref.id, location.href).href;
    toast(await copyText(url) ? "Client link copied — send it over" : "Link created — copy it from the list");
  } catch (e) {
    console.error(e);
    toast("Couldn't create the link — check Firestore rules allow it");
  }
}

/* ---------- moving the baton ----------
   Every move runs in a transaction: two people acting on a stale view at
   once can't both win — the second one is told the campaign moved. */

// a stage receiving the baton: another round, a fresh approval slate, and
// its time budget (if any) starts counting from right now
function cgReceive(stages, i, now){
  const s = stages[i];
  if (s.enteredAt) s.rounds = (s.rounds || 1) + 1;
  s.enteredAt = now;
  s.doneAt = null;
  s.approvals = [];
  s.seenBy = [];   // a fresh round needs seeing freshly
  s.dueAt = s.days ? now + s.days * CG_DAY : null;
}

async function cgMove(id, kind, note, links){
  const me = auth.currentUser;
  const myName = cgMyName();
  const ref = db.collection("campaigns").doc(id);
  let tell = null;

  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error("This campaign was deleted");
    const c = doc.data();
    if (c.status !== "active") throw new Error("This campaign is already live");
    const stages = c.stages.map(s => ({ ...s }));
    const st = stages[c.cur];
    const owners = cgOwnersOf(st);
    const iAmOwner = owners.some(o => o.uid === me.uid);
    if (!isAdmin && !iAmOwner)
      throw new Error("This campaign just moved — it isn't on your stage anymore");

    const now = Date.now();
    const newLinks = (links || []).map(u => ({ url: u, stage: st.name, by: myName, at: now }));
    const patch = { updatedAt: now, links: [...(c.links || []), ...newLinks] };

    if (kind === "pass"){
      const ap = (st.approvals || []).filter(u => owners.some(o => o.uid === u));
      if (iAmOwner && ap.includes(me.uid))
        throw new Error("You already approved this round — waiting on the others");
      const newAp = iAmOwner ? [...ap, me.uid] : ap;
      const allIn = owners.length > 0 && owners.every(o => newAp.includes(o.uid));

      if (allIn){
        st.doneAt = now;
        st.approvals = newAp;
        if (c.cur + 1 >= stages.length){
          patch.status = "live"; patch.liveAt = now;
          patch.history = [...(c.history || []), { t: now, type: "live", by: myName, byUid: me.uid, note: note || "" }];
          tell = { live: true, c: { ...c, id } };
        } else {
          cgReceive(stages, c.cur + 1, now);
          patch.cur = c.cur + 1;
          patch.history = [...(c.history || []),
            { t: now, type: "forward", by: myName, byUid: me.uid, from: st.name, to: stages[c.cur + 1].name, note: note || "" }];
          tell = { uids: cgOwnersOf(stages[c.cur + 1]).map(o => o.uid), admins: true,
                   msg: `${myName} passed "${c.title}" forward — ${stages[c.cur + 1].name}`, c: { ...c, id } };
        }
      } else {
        // my approval lands; the baton stays until the co-owners weigh in
        st.approvals = newAp;
        patch.history = [...(c.history || []),
          { t: now, type: "approve", by: myName, from: st.name, note: note || "" }];
        tell = { uids: owners.filter(o => !newAp.includes(o.uid)).map(o => o.uid),
                 msg: `${myName} approved "${c.title}" · ${st.name} (${newAp.length}/${owners.length}) — waiting on you`,
                 c: { ...c, id } };
      }
    } else { // back
      if (c.cur === 0) throw new Error("This is the first stage — nothing behind it");
      const t = c.cur - 1;
      cgReceive(stages, t, now);
      st.approvals = [];   // the interrupted round doesn't carry stale ticks
      patch.cur = t;
      patch.history = [...(c.history || []),
        { t: now, type: "back", by: myName, from: st.name, to: stages[t].name, note: note || "" }];
      tell = { uids: cgOwnersOf(stages[t]).map(o => o.uid), admins: true,
               msg: `${myName} sent "${c.title}" back — ${stages[t].name} (round ${stages[t].rounds})`,
               c: { ...c, id } };
    }
    patch.stages = stages;
    tx.update(ref, patch);
  });

  if (tell){
    if (tell.live) cgNotify(tell.c.memberUids || [], `"${tell.c.title}" is LIVE 🎉`, tell.c, { admins: true }).catch(e => console.error(e));
    else cgNotify(tell.uids || [], tell.msg, tell.c, tell.admins ? { admins: true } : undefined).catch(e => console.error(e));
  }
}

/* The other half of a Pass toast: one mistap shouldn't need the next
   person or an admin to unwind. Undo works while the move is mine, recent,
   and untouched - the receiving stage hasn't approved anything yet. */
async function cgUndoPass(id){
  const me = auth.currentUser;
  const myName = cgMyName();
  const ref = db.collection("campaigns").doc(id);
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error("This campaign was deleted");
    const c = doc.data();
    const h = (c.history || [])[(c.history || []).length - 1];
    // byUid, not the display name - two teammates can share a name (or both
    // default to "Someone"), and a name string was never proof of identity
    if (!h || (h.type !== "forward" && h.type !== "live") || h.byUid !== me.uid || Date.now() - h.t > 5 * 60000)
      throw new Error("Too late to undo — use Send back instead");
    const now = Date.now();
    const stages = c.stages.map(s => ({ ...s }));
    if (h.type === "live"){
      const i = Math.min(c.cur, stages.length - 1);
      stages[i].doneAt = null;
      stages[i].approvals = [];
      tx.update(ref, {
        status: "active", liveAt: null, stages, updatedAt: now,
        history: [...c.history, { t: now, type: "jump", by: myName, from: "LIVE", to: stages[i].name }]
      });
    } else {
      const i = c.cur - 1;
      if (c.status !== "active" || i < 0 || stages[i].name !== h.from
          || (stages[c.cur].approvals || []).length)
        throw new Error("The campaign moved on — can't undo now");
      stages[i].doneAt = null;
      stages[i].approvals = (stages[i].approvals || []).filter(u => u !== me.uid);
      // the recalled round doesn't count against the receiving stage
      stages[c.cur].rounds = Math.max(1, (stages[c.cur].rounds || 1) - 1);
      stages[c.cur].enteredAt = null;
      stages[c.cur].dueAt = null;
      stages[c.cur].seenBy = [];
      tx.update(ref, {
        stages, cur: i, updatedAt: now,
        history: [...c.history, { t: now, type: "back", by: myName, from: stages[c.cur].name, to: stages[i].name, note: "undo" }]
      });
    }
  });
  toast("Brought back");
}

const cgLinkRowHTML = placeholder => `
  <div class="cg-link-row">
    <input type="text" class="cg-link-in" placeholder="${esc(placeholder)}" autocomplete="off">
    <button type="button" class="cg-link-x" aria-label="Remove this link" title="Remove this link">×</button>
  </div>`;
function cgLinkInputs(){
  return `
    <div id="cgLinksIn">${cgLinkRowHTML("Link to the work (Doc, Figma, preview…)")}</div>
    <button type="button" class="btn btn-ghost btn-sm" id="cgAddLink">+ Another link</button>`;
}
// a click into "+ Another link" with nothing to paste there shouldn't leave
// a dead empty box behind - every row, including the first, can remove itself
function cgWireLinkRow(row){
  row.querySelector(".cg-link-x").onclick = () => row.remove();
}
function cgWireLinkInputs(){
  document.querySelectorAll("#cgLinksIn .cg-link-row").forEach(cgWireLinkRow);
  $("cgAddLink").onclick = () => {
    const box = $("cgLinksIn");
    box.insertAdjacentHTML("beforeend", cgLinkRowHTML("Another link"));
    const row = box.lastElementChild;
    cgWireLinkRow(row);
    row.querySelector("input").focus();
  };
}
function cgCleanUrl(raw){
  let v = String(raw || "").trim();
  if (!v) return null;
  // no real link needs these; in markup they only ever mean trouble
  if (/["'<>`\s]/.test(v)) return null;
  if (!/^https?:\/\//i.test(v)){
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
    v = "https://" + v;
  }
  try { new URL(v); return v; } catch { return null; }
}
function cgCollectLinks(){
  const out = [];
  let bad = false;
  document.querySelectorAll(".cg-link-in").forEach(i => {
    if (!i.value.trim()) return;
    const u = cgCleanUrl(i.value);
    if (u) out.push(u); else bad = true;
  });
  return { out, bad };
}

function cgPassSheet(id){
  const c = cgFind(id);
  if (!c) return;
  const st = cgStage(c) || {};
  const own = cgOwnersOf(st);
  const multi = own.length > 1;
  const others = own.filter(o => !cgApproved(st).includes(o.uid) && o.uid !== auth.currentUser.uid);
  const last = c.cur >= c.stages.length - 1;
  const next = last ? null : c.stages[c.cur + 1];
  // with co-owners still to approve, my pass is an approval, not the handoff
  const willHold = multi && others.length > 0;
  openSheet(`
    <h2>${willHold ? "Approve" : last ? "Ship it" : "Pass forward"}</h2>
    <p class="hint">${willHold
      ? `Your approval on <b>${esc(st.name)}</b> — the baton moves once ${esc(others.map(o => o.uname).join(", "))} also approve${others.length === 1 ? "s" : ""}.`
      : last
        ? `<b>${esc(st.name)}</b> is the last stage — passing sets <b>${esc(c.title)}</b> LIVE.`
        : `<b>${esc(st.name)}</b> done → hands to <b>${esc(cgOwnerNames(next))}</b> for <b>${esc(next.name)}</b>.`}</p>
    <textarea id="cgPassNote" placeholder="Anything the next person should know? (optional)"></textarea>
    ${cgLinkInputs()}
    <button class="btn btn-go" id="cgPassGo">${willHold ? "Approve" : last ? "Go live" : "Pass forward"}</button>
    <button class="btn btn-ghost btn-sm" id="cgPassCancel">Cancel</button>
  `, () => {
    cgWireLinkInputs();
    $("cgPassCancel").onclick = () => cgOpenDetail(id);
    $("cgPassGo").onclick = async () => {
      const { out, bad } = cgCollectLinks();
      if (bad){ toast("One of those links doesn't look right — use a full web address"); return; }
      const btn = $("cgPassGo");
      btn.disabled = true;
      try {
        await cgMove(id, "pass", $("cgPassNote").value.trim(), out);
        closeSheet();
        if (willHold) toast("Approved — waiting on the others");
        else toast(last ? "LIVE — nice work 🎉" : "Passed forward",
          { label: "Undo", run: () => cgUndoPass(id).catch(e => { console.error(e); toast(e.message || "Couldn't undo"); }) });
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        toast(e.message || "Couldn't move it — try again");
      }
    };
    $("cgPassNote").focus();
  });
}

function cgBackSheet(id){
  const c = cgFind(id);
  if (!c || c.cur === 0) return;
  const prev = c.stages[c.cur - 1];
  openSheet(`
    <h2>Send back</h2>
    <p class="hint">Back to <b>${esc(cgOwnerNames(prev))}</b> for another round of <b>${esc(prev.name)}</b>. Say exactly what needs fixing — they only have your words to go on.</p>
    <textarea id="cgBackNote" placeholder="What needs to change?"></textarea>
    ${cgLinkInputs()}
    <button class="btn btn-go" id="cgBackGo" disabled>Send back</button>
    <button class="btn btn-ghost btn-sm" id="cgBackCancel">Cancel</button>
  `, () => {
    cgWireLinkInputs();
    const ta = $("cgBackNote"), btn = $("cgBackGo");
    ta.oninput = () => { btn.disabled = ta.value.trim().length < 3; };
    $("cgBackCancel").onclick = () => cgOpenDetail(id);
    btn.onclick = async () => {
      const { out, bad } = cgCollectLinks();
      if (bad){ toast("One of those links doesn't look right — use a full web address"); return; }
      btn.disabled = true;
      try {
        await cgMove(id, "back", ta.value.trim(), out);
        closeSheet();
        toast("Sent back to " + cgOwnerNames(prev));
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        toast(e.message || "Couldn't move it — try again");
      }
    };
    ta.focus();
  });
}

/* ---------- admin: jump the baton anywhere (sheet + board drops) ---------- */
async function cgJumpTo(id, target){
  if (!isAdmin) return;
  const me = auth.currentUser;
  const myName = cgMyName();
  const ref = db.collection("campaigns").doc(id);
  let tell = null;
  try {
    await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("This campaign was deleted");
      const cc = doc.data();
      const now = Date.now();
      const stages = cc.stages.map(s => ({ ...s }));
      const from = (stages[cc.cur] || {}).name || "";
      if (target === "live"){
        if (cc.status === "live") return;
        tx.update(ref, {
          status: "live", liveAt: now, updatedAt: now,
          history: [...(cc.history || []), { t: now, type: "live", by: myName, note: "marked live by admin" }]
        });
        tell = { live: true, c: { ...cc, id } };
      } else {
        const i = Number(target);
        if (cc.status === "active" && i === cc.cur) return;
        cgReceive(stages, i, now);
        tx.update(ref, {
          stages, cur: i, status: "active", liveAt: null, updatedAt: now,
          history: [...(cc.history || []), { t: now, type: "jump", by: myName, from, to: stages[i].name }]
        });
        tell = { uids: cgOwnersOf(stages[i]).map(o => o.uid),
                 msg: `${myName} moved "${cc.title}" to you — ${stages[i].name}`, c: { ...cc, id } };
      }
    });
    if (tell){
      if (tell.live) cgNotify(tell.c.memberUids || [], `"${tell.c.title}" is LIVE 🎉`, tell.c, { admins: true }).catch(e => console.error(e));
      else cgNotify(tell.uids || [], tell.msg, tell.c).catch(e => console.error(e));
      toast("Baton moved");
    }
  } catch (e) { console.error(e); toast(e.message || "Couldn't move it"); }
}

function cgJumpSheet(id){
  const c = cgFind(id);
  if (!c || !isAdmin) return;
  openSheet(`
    <h2>Move baton</h2>
    <p class="hint">Drop it on any stage of <b>${esc(c.title)}</b> — or straight to Live.</p>
    <div class="cg-jump">
      ${c.stages.map((s, i) => {
        const holds = c.status === "active" && i === c.cur;
        return `
        <button type="button" class="cg-jump-opt${holds ? " is-cur" : ""}" data-j="${i}" ${holds ? "disabled" : ""}>
          <b>${esc(s.name)}</b><span>${esc(cgOwnerNames(s))}${holds ? " · holds it now" : ""}</span>
        </button>`;
      }).join("")}
      ${c.status === "active" ? `<button type="button" class="cg-jump-opt cg-jump-live" data-j="live"><b>LIVE</b><span>ship it as done</span></button>` : ""}
    </div>
    <button class="btn btn-ghost btn-sm" id="cgJumpCancel">Cancel</button>
  `, () => {
    $("cgJumpCancel").onclick = () => cgOpenDetail(id);
    document.querySelectorAll(".cg-jump-opt[data-j]").forEach(b => b.onclick = async () => {
      await cgJumpTo(id, b.dataset.j === "live" ? "live" : Number(b.dataset.j));
      closeSheet();
    });
  });
}

/* ---------- admin: create / edit — the chain builder ----------
   Each stage row: a name, an optional day budget, and either named owners
   (one or several — all must approve) or a role target ("anyone who is a
   designer") that resolves to the least-loaded member with that craft when
   the campaign is created. Templates capture all of it. */
let cgEdStages = [];   // [{name, days, role, uids:[uid,...]}]
let cgEdMembers = [];  // directory rows for the owner selects

const cgEdCrafts = () =>
  [...new Set(cgEdMembers.map(p => (p.craft || "").trim()).filter(Boolean))].sort();

function cgEdPersonOpts(sel){
  return cgEdMembers.map(p =>
    `<option value="${esc(p.uid)}"${p.uid === sel ? " selected" : ""}>${esc(p.name)}${p.craft ? " · " + esc(p.craft) : ""}</option>`).join("");
}

function cgEdRowsHTML(){
  const crafts = cgEdCrafts();
  return cgEdStages.map((s, i) => {
    const uids = s.uids && s.uids.length ? s.uids : [""];
    // "any designer" is the live choice only while no person holds the
    // stage; a resolved role stage shows its actual person
    const roleOn = !!s.role && !uids[0];
    return `
    <div class="cg-srow" data-i="${i}">
      <div class="cg-srow-head">
        <span class="cg-srow-step">Stage ${i + 1}</span>
        <span class="cg-srow-btns">
          <button type="button" class="cg-srow-b" data-mv="-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="cg-srow-b" data-mv="1" title="Move down" ${i === cgEdStages.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="cg-srow-b cg-srow-x" data-del="1" title="Remove stage">×</button>
        </span>
      </div>
      <label class="cg-fld"><span>Stage name</span>
        <input type="text" class="cg-srow-name" value="${esc(s.name)}" placeholder="e.g. Copy, Design, Embed…" autocomplete="off">
      </label>
      <div class="cg-srow-grid">
        <label class="cg-fld"><span>Owner</span>
          <select class="cg-srow-who" data-o="0">
            <option value="">Choose…</option>
            <optgroup label="People">${cgEdPersonOpts(roleOn ? "" : uids[0])}</optgroup>
            ${crafts.length ? `<optgroup label="Anyone who is…">${crafts.map(cr =>
              `<option value="role:${esc(cr)}"${roleOn && s.role === cr ? " selected" : ""}>any ${esc(cr)}</option>`).join("")}</optgroup>` : ""}
          </select>
        </label>
        <label class="cg-fld"><span>Days</span>
          <input type="number" class="cg-srow-days" min="1" max="60" value="${s.days || ""}" placeholder="—" title="Time budget in days (optional)">
        </label>
      </div>
      ${roleOn ? "" : uids.slice(1).map((u, k) => `
      <label class="cg-fld"><span>Co-owner — must also approve</span>
        <select class="cg-srow-who" data-o="${k + 1}">
          <option value="">— remove —</option>
          ${cgEdPersonOpts(u)}
        </select>
      </label>`).join("")}
      ${!roleOn && uids[0] ? `<button type="button" class="cg-srow-addco">+ Co-owner</button>` : ""}
    </div>`;
  }).join("");
}

function cgEdPaintRows(){
  const box = $("cgEdRows");
  box.innerHTML = cgEdRowsHTML();
  box.querySelectorAll(".cg-srow").forEach(row => {
    const i = Number(row.dataset.i);
    const s = cgEdStages[i];
    row.querySelector(".cg-srow-name").oninput = e => { s.name = e.target.value; };
    row.querySelector(".cg-srow-days").oninput = e => {
      const n = parseInt(e.target.value, 10);
      s.days = (n && n > 0) ? Math.min(n, 60) : null;
    };
    row.querySelectorAll(".cg-srow-who").forEach(selEl => {
      const o = Number(selEl.dataset.o);
      selEl.onchange = e => {
        const v = e.target.value;
        if (o === 0){
          if (v.startsWith("role:")){ s.role = v.slice(5); s.uids = []; }
          else { s.role = null; s.uids = s.uids || []; s.uids[0] = v; }
        } else {
          if (!v) s.uids.splice(o, 1); else s.uids[o] = v;
        }
        cgEdPaintRows();
      };
    });
    const add = row.querySelector(".cg-srow-addco");
    if (add) add.onclick = () => { s.uids.push(""); cgEdPaintRows(); };
    row.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => {
      const j = i + Number(b.dataset.mv);
      if (j < 0 || j >= cgEdStages.length) return;
      [cgEdStages[i], cgEdStages[j]] = [cgEdStages[j], cgEdStages[i]];
      cgEdPaintRows();
    });
    row.querySelector("[data-del]").onclick = () => { cgEdStages.splice(i, 1); cgEdPaintRows(); };
  });
}

// least-loaded member with the craft: fewest batons in hand, and open
// simple assignments count too - half a picture routes work wrong
function cgResolveRole(craft){
  const pool = cgEdMembers.filter(p => (p.craft || "").trim().toLowerCase() === craft.toLowerCase());
  if (!pool.length) return null;
  const load = new Map();
  (cgRows || []).filter(c => c.status === "active").forEach(c => {
    cgOwnersOf(cgStage(c)).forEach(o => load.set(o.uid, (load.get(o.uid) || 0) + 1));
  });
  (typeof assignRows !== "undefined" && assignRows ? assignRows : [])
    .filter(r => !r.done && r.toUid)
    .forEach(r => load.set(r.toUid, (load.get(r.toUid) || 0) + 1));
  return [...pool].sort((a, b) =>
    (load.get(a.uid) || 0) - (load.get(b.uid) || 0) || a.name.localeCompare(b.name))[0];
}

async function cgLoadTemplates(){
  try {
    const snap = await db.collection("campaignTemplates").get();
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch (e) { console.error(e); return []; }
}

// template/campaign stages → the builder's working shape (v1 rows carried
// a single uid; v2 rows carry owners[] or a role). A role stage that has
// already RESOLVED to people keeps those people: editing a campaign must
// never re-run the roulette and swap out whoever is mid-work - only a
// template's role stage (no owners yet) resolves at submit.
function cgToEdShape(s){
  return {
    name: s.name || "",
    days: s.days || null,
    role: s.role || null,
    uids: s.owners ? s.owners.map(o => o.uid) : (s.uid ? [s.uid] : [])
  };
}

async function cgEditorSheet(edit){
  if (!isAdmin) return;
  const dir = await loadDirectory();
  cgEdMembers = dir.filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
  cgEdStages = edit
    ? edit.stages.map(cgToEdShape)
    : [{ name: "", days: null, role: null, uids: [] }, { name: "", days: null, role: null, uids: [] }];
  const templates = edit ? [] : await cgLoadTemplates();

  const stores = [...new Set([...CONFIG.clients, ...(cgRows || []).map(c => c.store).filter(Boolean)])].sort();

  openSheet(`
    <h2>${edit ? "Edit campaign" : "New campaign"}</h2>
    ${templates.length ? `
    <p class="cg-dt-label">Start from a template</p>
    <div class="cg-tpls">${templates.map((t, i) => `
      <span class="cg-tpl" data-t="${i}"><button type="button" class="cg-tpl-use">${esc(t.name)} <small>${t.stages.length}</small></button><button type="button" class="cg-tpl-del" title="Delete template">×</button></span>`).join("")}
    </div>` : ""}
    <label class="fld"><span>Campaign name</span>
      <input type="text" id="cgEdTitle" placeholder="e.g. August Newsletter" value="${esc(edit ? edit.title : "")}" autocomplete="off"></label>
    <label class="fld"><span>Store / client</span>
      <input type="text" id="cgEdStore" list="cgStoreList" placeholder="Type or pick one" value="${esc(edit ? edit.store || "" : "")}" autocomplete="off"></label>
    <datalist id="cgStoreList">${stores.map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <label class="fld"><span>Due date — whole campaign, optional</span>
      <input type="date" id="cgEdDue" value="${esc(edit ? edit.dueDate || "" : "")}"></label>
    <label class="fld"><span>Brief — optional</span>
      <textarea id="cgEdBrief" placeholder="What is this campaign about?">${esc(edit ? edit.brief || "" : "")}</textarea></label>
    <p class="cg-dt-label">The chain</p>
    <p class="cg-ed-help">Work travels top to bottom. Each stage gets a name, an owner and — if you want the clock running — a day budget. Give a stage several owners and all of them must approve.</p>
    <div id="cgEdRows"></div>
    <button type="button" class="btn btn-ghost btn-sm" id="cgEdAdd">+ Add stage</button>
    <label class="cg-tpl-save"><input type="checkbox" id="cgEdSaveTpl"><span>Save this chain as a template</span></label>
    <input type="text" id="cgEdTplName" class="hidden" placeholder="Template name — e.g. Email Marketing" autocomplete="off">
    <button class="btn btn-go" id="cgEdGo">${edit ? "Save changes" : "Create campaign"}</button>
    <button class="btn btn-ghost btn-sm" id="cgEdCancel">Cancel</button>
  `, () => {
    cgEdPaintRows();
    $("cgEdAdd").onclick = () => { cgEdStages.push({ name: "", days: null, role: null, uids: [] }); cgEdPaintRows(); };
    $("cgEdCancel").onclick = () => { if (edit) cgOpenDetail(edit.id); else closeSheet(); };
    $("cgEdSaveTpl").onchange = e => $("cgEdTplName").classList.toggle("hidden", !e.target.checked);

    document.querySelectorAll(".cg-tpl").forEach(el => {
      const t = templates[Number(el.dataset.t)];
      el.querySelector(".cg-tpl-use").onclick = () => {
        // template owners may have left the team — keep only ones still known
        cgEdStages = t.stages.map(s => {
          const shape = cgToEdShape(s);
          shape.uids = shape.uids.filter(u => cgEdMembers.some(m => m.uid === u));
          return shape;
        });
        cgEdPaintRows();
        if (!$("cgEdTitle").value) $("cgEdTitle").focus();
      };
      el.querySelector(".cg-tpl-del").onclick = async () => {
        if (!confirm(`Delete the "${t.name}" template?`)) return;
        try { await db.collection("campaignTemplates").doc(t.id).delete(); el.remove(); }
        catch (e) { console.error(e); toast("Couldn't delete the template"); }
      };
    });

    $("cgEdGo").onclick = () => cgEdSubmit(edit);
    if (!edit) $("cgEdTitle").focus();
  });
}

async function cgEdSubmit(edit){
  const title = $("cgEdTitle").value.trim();
  // a row is real once it says anything; blank padding rows are dropped
  const rows = cgEdStages
    .map(s => ({ name: s.name.trim(), days: s.days || null, role: s.role,
                 uids: [...new Set((s.uids || []).filter(Boolean))] }))
    .filter(s => s.name || s.role || s.uids.length);
  if (title.length < 2){ toast("Give the campaign a name"); $("cgEdTitle").focus(); return; }
  if (!rows.length){ toast("The chain needs at least one stage"); return; }
  if (rows.some(s => !s.name)){ toast("Every stage needs a name"); return; }

  // resolve owners: named people ride as-is; a role target resolves only
  // while it has no people yet (campaign creation, or a template's role
  // stage) - an already-resolved stage keeps its person on every later edit
  const resolved = [];
  for (const r of rows){
    if (r.role && !r.uids.length){
      const p = cgResolveRole(r.role);
      if (!p){ toast(`Nobody has the "${r.role}" role anymore — pick a person for ${r.name}`); return; }
      resolved.push({ ...r, owners: [{ uid: p.uid, uname: p.name }] });
    } else {
      if (!r.uids.length){ toast(`${r.name} needs an owner`); return; }
      resolved.push({ ...r, owners: r.uids.map(u => {
        const p = cgEdMembers.find(m => m.uid === u);
        return { uid: u, uname: p ? p.name : "Unknown" };
      })});
    }
  }

  const btn = $("cgEdGo");
  btn.disabled = true;
  const me = auth.currentUser;
  const myName = cgMyName();
  const now = Date.now();
  const common = {
    title,
    store: $("cgEdStore").value.trim(),
    brief: $("cgEdBrief").value.trim(),
    dueDate: $("cgEdDue").value || null,
    memberUids: [...new Set(resolved.flatMap(s => s.owners.map(o => o.uid)))],
    updatedAt: now
  };

  try {
    if ($("cgEdSaveTpl").checked){
      const tn = $("cgEdTplName").value.trim();
      if (tn.length < 2){ toast("Name the template first"); btn.disabled = false; $("cgEdTplName").focus(); return; }
      // role stages template as the role (they re-resolve per campaign);
      // named stages template their people as defaults
      await db.collection("campaignTemplates").add({
        name: tn,
        stages: rows.map(r => r.role
          ? { name: r.name, days: r.days, role: r.role }
          : { name: r.name, days: r.days,
              owners: r.uids.map(u => {
                const p = cgEdMembers.find(m => m.uid === u);
                return { uid: u, uname: p ? p.name : "Unknown" };
              }) }),
        updatedAt: now
      });
    }

    if (edit){
      /* Editing keeps every stage's earned state - and merges against the
         doc as it is NOW, inside a transaction, not against the snapshot
         the editor opened with: a baton pass landing mid-edit is matched
         like any other stage state instead of being silently reverted.
         Rows match old stages by name (first unused match), carrying
         rounds/doneAt/enteredAt/approvals/dueAt/seenBy across; approvals
         shed anyone no longer an owner. The baton stays on the stage it
         was on; if that stage was removed, the earliest unfinished stage
         takes it; if nothing unfinished remains, the last stage reopens
         rather than stranding the campaign active-but-unpassable. */
      const ref = db.collection("campaigns").doc(edit.id);
      let fresh = [], gone = [], curName = "";
      await db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error("This campaign was deleted meanwhile");
        const live = doc.data();
        if (!Array.isArray(live.stages)) live.stages = [];
        const pool = live.stages.map((s, i) => ({ ...s, i, used: false }));
        let curNew = -1;
        const stages = resolved.map((r, idx) => {
          const m = pool.find(p => !p.used && p.name.toLowerCase() === r.name.toLowerCase());
          const base = { name: r.name, days: r.days, role: r.role || null, owners: r.owners };
          if (m){
            m.used = true;
            if (m.i === live.cur) curNew = idx;
            const keepAp = (m.approvals || []).filter(u => r.owners.some(o => o.uid === u));
            const out = { ...base, rounds: m.rounds || 1, doneAt: m.doneAt || null,
                          enteredAt: m.enteredAt || null, approvals: keepAp,
                          dueAt: m.dueAt || null, seenBy: m.seenBy || [] };
            // a changed budget on a stage already holding the baton
            // re-anchors its deadline to when the baton actually arrived
            if (out.enteredAt && (r.days || null) !== (m.days || null))
              out.dueAt = r.days ? out.enteredAt + r.days * CG_DAY : null;
            return out;
          }
          return { ...base, rounds: 1, doneAt: null, enteredAt: null, approvals: [], dueAt: null, seenBy: [] };
        });
        let cur = curNew;
        if (live.status === "active"){
          if (cur < 0) cur = stages.findIndex(s => !s.doneAt);
          if (cur < 0){
            cur = stages.length - 1;
            stages[cur].doneAt = null;
            stages[cur].approvals = [];
          }
          if (!stages[cur].enteredAt){
            stages[cur].enteredAt = now;
            stages[cur].dueAt = stages[cur].days ? now + stages[cur].days * CG_DAY : null;
            stages[cur].seenBy = [];
          }
        } else cur = Math.min(live.cur, stages.length - 1);

        const prevOwners = cgOwnersOf(live.stages[live.cur] || {}).map(o => o.uid);
        const nowOwners = cgOwnersOf(stages[cur]).map(o => o.uid);
        if (live.status === "active"){
          fresh = nowOwners.filter(u => !prevOwners.includes(u));
          gone = prevOwners.filter(u => !nowOwners.includes(u));
        }
        curName = stages[cur].name;
        tx.update(ref, {
          ...common, stages, cur,
          history: [...(live.history || []), { t: now, type: "edit", by: myName }]
        });
      });
      const c2 = { id: edit.id, title, memberUids: common.memberUids };
      if (fresh.length)
        cgNotify(fresh, `${myName} put "${title}" in your court — ${curName}`, c2).catch(e => console.error(e));
      if (gone.length)
        cgNotify(gone, `${myName} took "${title}" off your plate`, c2).catch(e => console.error(e));
      closeSheet();
      toast("Campaign updated");
    } else {
      const stages = resolved.map((r, i) => ({
        name: r.name, days: r.days, role: r.role || null, owners: r.owners,
        rounds: 1, doneAt: null, approvals: [],
        enteredAt: i === 0 ? now : null,
        dueAt: i === 0 && r.days ? now + r.days * CG_DAY : null
      }));
      const ref = await db.collection("campaigns").add({
        ...common, stages, status: "active", cur: 0, liveAt: null, links: [],
        createdAt: now, createdBy: { uid: me.uid, name: myName },
        history: [{ t: now, type: "created", by: myName }]
      });
      cgNotify(stages[0].owners.map(o => o.uid),
        `${myName} started "${title}" — you're up first: ${stages[0].name}`,
        { id: ref.id, title, memberUids: common.memberUids }).catch(e => console.error(e));
      closeSheet();
      toast(`"${title}" is rolling — ${stages[0].owners.map(o => o.uname).join(", ")} ${stages[0].owners.length > 1 ? "are" : "is"} up`);
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast("Couldn't save — check Firestore rules allow it");
  }
}

/* ---------- admin: role labels ----------
   Freeform words on directory/{uid}.craft. They surface in the chain
   builder's owner pickers AND power "anyone who is a …" role targets. */
async function cgRolesSheet(){
  if (!isAdmin) return;
  const dir = (await loadDirectory()).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`
    <h2>Roles</h2>
    <p class="hint">A word per person for what they do. It shows in the chain builder — and a stage can target "any designer" and route itself to whoever's least loaded.</p>
    <div class="cg-roles">${dir.map((p, i) => `
      <label class="cg-role-row">
        <span class="cg-role-who">${esc(p.name)}<small>${esc(p.email || "")}</small></span>
        <input type="text" data-uid="${esc(p.uid)}" value="${esc(p.craft || "")}" placeholder="e.g. designer" autocomplete="off">
      </label>`).join("")}
    </div>
    <button class="btn btn-go" id="cgRolesSave">Save</button>
    <button class="btn btn-ghost btn-sm" id="cgRolesCancel">Cancel</button>
  `, () => {
    $("cgRolesCancel").onclick = closeSheet;
    $("cgRolesSave").onclick = async () => {
      const btn = $("cgRolesSave");
      btn.disabled = true;
      try {
        const batch = db.batch();
        let n = 0;
        document.querySelectorAll(".cg-role-row input").forEach(inp => {
          const p = dir.find(x => x.uid === inp.dataset.uid);
          const v = inp.value.trim();
          if (p && (p.craft || "") !== v){
            batch.set(db.collection("directory").doc(p.uid), { craft: v }, { merge: true });
            n++;
          }
        });
        if (n) await batch.commit();
        notifDir = null;
        closeSheet();
        toast(n ? "Roles saved" : "Nothing changed");
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        toast("Couldn't save — check Firestore rules allow it");
      }
    };
  });
}
