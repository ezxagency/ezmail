/* ============================================================
   CAMPAIGNS — the baton-pass pipeline.

   One campaign = one piece of work travelling a chain of stages the admin
   designed (Copy → Copy Review → Design → … → Live, or whatever the niche
   calls its steps). Exactly one stage holds the baton at a time; finishing
   a stage IS the handoff. The current owner can pass it forward (with links
   and a comment) or send it back one step (with a required note, which
   bumps the receiving stage's round counter). The last stage passing
   forward sets the whole campaign LIVE.

   Everyone assigned to any stage sees the whole track live; only the
   current owner can move it. Admin can do anything at any time: edit the
   chain mid-flight, reassign owners, jump the baton anywhere, or delete.

   Storage: campaigns/{id} — the chain, the baton position, accumulated
   links and a full history, all in one doc so a single snapshot listener
   powers every surface. campaignTemplates/{id} — saved chains (stages +
   default owners) so a niche's pipeline is built once, not per campaign.
   Role labels live on directory/{uid}.craft: freeform words the admin
   gives people ("copywriter", "designer"), shown in owner pickers to make
   choosing easy — routing stays fully manual in v1.
   ============================================================ */

/* ---------- live cache + drawer badge ---------- */
let cgRows = null;        // every campaign this account may see; null = loading
let cgBatonSeen = null;   // "id:cur" pairs already on screen; null = first snapshot
let cgLiveOpen = false;   // the Live section's disclosure survives re-renders

const cgStage = c => c.stages && c.stages[c.cur] ? c.stages[c.cur] : null;
const cgIsMyTurn = c => {
  const s = cgStage(c);
  return c.status === "active" && s && auth.currentUser && s.uid === auth.currentUser.uid;
};
const cgAgeDays = c => {
  const s = cgStage(c);
  return s && s.enteredAt ? Math.floor((Date.now() - s.enteredAt) / 86400000) : 0;
};
// quiet when fresh, amber when the baton has sat ~2 days, red at ~4 —
// the bottleneck should be visible before it becomes a fire
function cgAgeChip(c){
  if (c.status !== "active") return "";
  const d = cgAgeDays(c);
  const cls = d >= 4 ? " is-red" : d >= 2 ? " is-amber" : "";
  return `<span class="cg-age${cls}">${d ? d + "d in stage" : "today"}</span>`;
}

function watchCampaigns(){
  if (!db || !auth.currentUser) return;
  const uid = auth.currentUser.uid;
  cgRows = null; cgBatonSeen = null;
  // members only ever receive campaigns they are part of; the admin's
  // subscription is the whole board
  const q = isAdmin
    ? db.collection("campaigns")
    : db.collection("campaigns").where("memberUids", "array-contains", uid);
  const unsub = q.onSnapshot(snap => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // a baton newly arrived in my court is news; the first snapshot is
    // baseline, not news
    if (cgBatonSeen){
      rows.filter(cgIsMyTurn)
        .filter(c => !cgBatonSeen.has(c.id + ":" + c.cur))
        .forEach(c => toast(`Your turn: ${c.title} · ${(cgStage(c) || {}).name || ""}`));
    }
    cgBatonSeen = new Set(rows.filter(c => c.status === "active").map(c => c.id + ":" + c.cur));
    cgRows = rows;

    cgPaintBadge(rows.filter(cgIsMyTurn).length);
    if (currentRoute() === "campaigns") renderCampaignsPage();

    // the detail sheet is a live view too: repaint it when its campaign
    // changed underneath, close it if the campaign is gone
    const root = $("cgDetailRoot");
    if (root){
      const c = rows.find(x => x.id === root.dataset.id);
      if (!c){ closeSheet(); toast("That campaign was deleted"); }
      else if (String(c.updatedAt || "") !== root.dataset.u) cgOpenDetail(c.id);
    }
  }, e => console.error(e));
  onSessionEnd(() => { unsub(); cgRows = null; cgBatonSeen = null; cgLiveOpen = false; cgPaintBadge(0); });
}

function cgPaintBadge(n){
  const b = $("cgNavBadge");
  if (b){ b.textContent = n; b.classList.toggle("hidden", !n); }
}

/* ---------- notifications (ride the existing bell) ---------- */
// one doc per person to tell; kind:"campaign" makes the centre render the
// msg text and route taps to the Campaigns page
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
      fromName: S.worker || (me.email ? me.email.split("@")[0] : "Someone"),
      createdAt: Date.now(), read: false
    };
    const batch = db.batch();
    const col = db.collection("notifications");
    // admins hear through the one toRole doc, never twice via their uid
    [...new Set(uids)].filter(u => u && u !== me.uid && !isAdminUid(u))
      .forEach(u => batch.set(col.doc(), { ...base, toUid: u }));
    if (opts && opts.admins && !isAdmin) batch.set(col.doc(), { ...base, toRole: "admin" });
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

  const act = cgRows.filter(c => c.status === "active");
  const live = cgRows.filter(c => c.status === "live")
    .sort((a, b) => (b.liveAt || 0) - (a.liveAt || 0));
  const mine = act.filter(cgIsMyTurn);
  // stuck-longest first: the list doubles as the admin's bottleneck radar
  const flight = [...act].sort((a, b) => cgAgeDays(b) - cgAgeDays(a));

  const note = act.length
    ? `${act.length} in flight${mine.length ? ` · <b>${mine.length} waiting on you</b>` : ""}${live.length ? ` · ${live.length} live` : ""}`
    : (live.length ? `Nothing in flight · ${live.length} live` : "No campaigns yet");

  box.innerHTML = `
    <div class="fpage-bar">
      <p class="fpage-bar-note">${note}</p>
      <div class="fpage-bar-acts">
        ${isAdmin ? `
          <button class="btn btn-ghost btn-sm" id="cgRolesBtn">Roles</button>
          <button class="btn btn-go btn-sm" id="cgNewBtn">New campaign</button>` : ""}
      </div>
    </div>

    ${mine.length ? `
    <p class="fpage-section-title">Your turn</p>
    <div class="cg-turns">${mine.map(cgTurnCard).join("")}</div>` : ""}

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
    </ul>` : ""}`;

  if (isAdmin){
    const nb = $("cgNewBtn"), rb = $("cgRolesBtn");
    if (nb) nb.onclick = () => cgEditorSheet(null);
    if (rb) rb.onclick = cgRolesSheet;
  }
  const lh = $("cgLiveHead");
  if (lh) lh.onclick = () => { cgLiveOpen = !cgLiveOpen; renderCampaignsPage(); };
  box.querySelectorAll("[data-cg]").forEach(el => el.onclick = e => {
    if (e.target.closest("[data-cga]")) return;   // the card's own buttons win
    cgOpenDetail(el.dataset.cg);
  });
  box.querySelectorAll("[data-cga]").forEach(b => b.onclick = () => {
    const id = b.closest("[data-cg]").dataset.cg;
    if (b.dataset.cga === "pass") cgPassSheet(id);
    else if (b.dataset.cga === "back") cgBackSheet(id);
  });
}

// the dot track: one dot per stage — filled = done behind the baton,
// pulsing = holds it now, hollow = still ahead
function cgTrack(c){
  return `<span class="cg-track" aria-hidden="true">${c.stages.map((s, i) => {
    const cls = c.status === "live" || i < c.cur ? "is-done" : i === c.cur ? "is-cur" : "";
    return `<i class="cg-dot ${cls}" title="${esc(s.name)} · ${esc(s.uname)}"></i>`;
  }).join("")}</span>`;
}

const cgRoundsChip = s => (s && s.rounds > 1) ? `<span class="cg-rounds">R${s.rounds}</span>` : "";

// the last words that travelled with the baton — the context the next
// person actually needs, surfaced without opening the detail
function cgLastNote(c){
  for (let i = (c.history || []).length - 1; i >= 0; i--){
    const h = c.history[i];
    if ((h.type === "forward" || h.type === "back") && h.note) return h;
  }
  return null;
}

function cgTurnCard(c){
  const s = cgStage(c) || {};
  const h = cgLastNote(c);
  const today = todayISO();
  const late = c.dueDate && c.dueDate < today;
  return `
  <div class="cg-turn" data-cg="${esc(c.id)}" role="button" tabindex="0">
    <div class="cg-turn-top">
      <span class="cg-turn-stage">${esc(s.name || "")}${cgRoundsChip(s)}</span>
      ${cgAgeChip(c)}
    </div>
    <p class="cg-turn-title">${esc(c.title)}</p>
    <p class="cg-turn-meta">${esc(c.store || "")}${c.dueDate ? ` · ${late ? "overdue" : "due"} ${esc(c.dueDate)}` : ""}</p>
    ${h ? `<p class="cg-turn-note">“${esc(h.note)}” <span>— ${esc(h.by)}</span></p>` : ""}
    ${cgTrack(c)}
    <div class="cg-turn-acts">
      <button type="button" class="btn btn-go btn-sm" data-cga="pass">${c.cur >= c.stages.length - 1 ? "Pass · go live" : "Pass forward"}</button>
      ${c.cur > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-cga="back">Send back</button>` : ""}
    </div>
  </div>`;
}

function cgRowHTML(c){
  const s = cgStage(c);
  const liveRow = c.status === "live";
  const mid = liveRow
    ? `live ${c.liveAt ? whenLabel(c.liveAt).toLowerCase() : ""}`
    : `${esc(s ? s.name : "")} · ${esc(s ? s.uname : "")}${cgIsMyTurn(c) ? " (you)" : ""}`;
  return `
  <li class="cg-row${liveRow ? " is-live" : ""}${cgIsMyTurn(c) ? " is-mine" : ""}" data-cg="${esc(c.id)}" role="button" tabindex="0">
    <div class="cg-row-main">
      <span class="cg-row-title">${esc(c.title)}</span>
      <span class="cg-row-meta">${esc(c.store || "")}${c.store ? " · " : ""}${mid}${cgRoundsChip(s)}</span>
    </div>
    ${cgTrack(c)}
    ${liveRow ? `<span class="cg-live-mark">LIVE</span>` : cgAgeChip(c)}
  </li>`;
}

function enterCampaignsPage(){ renderCampaignsPage(); }

/* ---------- detail sheet: the whole story of one campaign ---------- */
function cgFind(id){ return (cgRows || []).find(c => c.id === id) || null; }

function cgHistLine(h){
  const t = h.type;
  if (t === "created") return `${esc(h.by)} created the campaign`;
  if (t === "forward") return `${esc(h.by)} passed ${esc(h.from || "")} → ${esc(h.to || "")}`;
  if (t === "back")    return `${esc(h.by)} sent ${esc(h.from || "")} back to ${esc(h.to || "")}`;
  if (t === "jump")    return `${esc(h.by)} moved the baton ${esc(h.from || "")} → ${esc(h.to || "")}`;
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
  const mine = cgIsMyTurn(c);
  const today = todayISO();
  const late = c.status === "active" && c.dueDate && c.dueDate < today;

  const stages = c.stages.map((s, i) => {
    const done = c.status === "live" || i < c.cur;
    const cur = c.status === "active" && i === c.cur;
    const state = done
      ? (s.doneAt ? "done " + whenLabel(s.doneAt).toLowerCase() : "done")
      : cur ? `holding${cgAgeDays(c) ? " · " + cgAgeDays(c) + "d" : ""}` : "waiting";
    return `
    <li class="cg-stg${done ? " is-done" : ""}${cur ? " is-cur" : ""}">
      <span class="cg-stg-pip">${done ? AF_TICK : ""}</span>
      <span class="cg-stg-main">
        <span class="cg-stg-name">${esc(s.name)}${cgRoundsChip(s)}</span>
        <span class="cg-stg-who">${esc(s.uname)}${auth.currentUser && s.uid === auth.currentUser.uid ? " (you)" : ""}</span>
      </span>
      <span class="cg-stg-state">${state}</span>
    </li>`;
  }).join("");

  const links = (c.links || []).slice().reverse();
  const hist = (c.history || []).slice().reverse();

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

      <p class="cg-dt-label">History</p>
      <ul class="cg-hist">${hist.slice(0, 14).map(h => `
        <li><span class="cg-hist-t">${esc(whenLabel(h.t))}</span>
          <span class="cg-hist-w">${cgHistLine(h)}${h.note ? `<i>“${esc(h.note)}”</i>` : ""}</span></li>`).join("")}
        ${hist.length > 14 ? `<li class="cg-hist-more">…and ${hist.length - 14} earlier</li>` : ""}
      </ul>

      ${mine ? `
      <button class="btn btn-go" id="cgDtPass">${c.cur >= c.stages.length - 1 ? "Pass forward · go live" : "Pass forward"}</button>
      ${c.cur > 0 ? `<button class="btn btn-sm" id="cgDtBack">Send back</button>` : ""}` : ""}
      ${isAdmin ? `
      <div class="cg-admin-acts">
        <button class="btn btn-ghost btn-sm" id="cgDtEdit">Edit</button>
        ${c.status === "active" ? `<button class="btn btn-ghost btn-sm" id="cgDtJump">Move baton</button>` : ""}
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
    on("cgDtDel", async () => {
      if (!confirm(`Delete "${c.title}"? The whole track, its links and history go with it. This can't be undone.`)) return;
      try {
        await db.collection("campaigns").doc(c.id).delete();
        closeSheet();
        toast("Campaign deleted");
      } catch (e) { console.error(e); toast("Couldn't delete — check Firestore rules allow it"); }
    });
  });
}

/* ---------- moving the baton ----------
   Every move runs in a transaction: two people acting on a stale view at
   once can't both win — the second one is told the campaign moved. */
async function cgMove(id, kind, note, links){
  const me = auth.currentUser;
  const myName = S.worker || (me.email ? me.email.split("@")[0] : "Someone");
  const ref = db.collection("campaigns").doc(id);
  let tell = null;   // computed inside, sent after the commit

  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error("This campaign was deleted");
    const c = doc.data();
    if (c.status !== "active") throw new Error("This campaign is already live");
    const st = c.stages[c.cur];
    if (!isAdmin && !(st && me && st.uid === me.uid))
      throw new Error("This campaign just moved — it isn't on your stage anymore");

    const now = Date.now();
    const stages = c.stages.map(s => ({ ...s }));
    // a stage receiving the baton again is another round of that work
    const receive = i => {
      if (stages[i].enteredAt) stages[i].rounds = (stages[i].rounds || 1) + 1;
      stages[i].enteredAt = now;
      stages[i].doneAt = null;
    };
    const newLinks = (links || []).map(u => ({ url: u, stage: st.name, by: myName, at: now }));
    const patch = { updatedAt: now, links: [...(c.links || []), ...newLinks] };

    if (kind === "pass"){
      stages[c.cur].doneAt = now;
      if (c.cur + 1 >= stages.length){
        patch.status = "live"; patch.liveAt = now;
        patch.history = [...(c.history || []), { t: now, type: "live", by: myName, note: note || "" }];
        tell = { live: true, c: { ...c, id } };
      } else {
        receive(c.cur + 1);
        patch.cur = c.cur + 1;
        patch.history = [...(c.history || []),
          { t: now, type: "forward", by: myName, from: st.name, to: stages[c.cur + 1].name, note: note || "" }];
        tell = { uid: stages[c.cur + 1].uid, msg: `${myName} passed you "${c.title}" — ${stages[c.cur + 1].name}`, c: { ...c, id } };
      }
    } else { // back
      if (c.cur === 0) throw new Error("This is the first stage — nothing behind it");
      const t = c.cur - 1;
      receive(t);
      patch.cur = t;
      patch.history = [...(c.history || []),
        { t: now, type: "back", by: myName, from: st.name, to: stages[t].name, note: note || "" }];
      tell = { uid: stages[t].uid, msg: `${myName} sent "${c.title}" back to you — ${stages[t].name} (round ${stages[t].rounds})`, c: { ...c, id } };
    }
    patch.stages = stages;
    tx.update(ref, patch);
  });

  // fan-out after the commit: the move stands either way
  if (tell){
    if (tell.live) cgNotify(tell.c.memberUids || [], `"${tell.c.title}" is LIVE 🎉`, tell.c, { admins: true }).catch(e => console.error(e));
    else cgNotify([tell.uid], tell.msg, tell.c).catch(e => console.error(e));
  }
}

// shared link-row builder for the pass sheet
function cgLinkInputs(){
  return `
    <div id="cgLinksIn"><input type="text" class="cg-link-in" placeholder="Link to the work (Doc, Figma, preview…)" autocomplete="off"></div>
    <button type="button" class="btn btn-ghost btn-sm" id="cgAddLink">+ Another link</button>`;
}
function cgWireLinkInputs(){
  $("cgAddLink").onclick = () => {
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "cg-link-in";
    inp.placeholder = "Another link"; inp.autocomplete = "off";
    $("cgLinksIn").append(inp);
    inp.focus();
  };
}
// links only ever leave here as http(s) — anything else is refused
function cgCleanUrl(raw){
  let v = String(raw || "").trim();
  if (!v) return null;
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
  const last = c.cur >= c.stages.length - 1;
  const next = last ? null : c.stages[c.cur + 1];
  openSheet(`
    <h2>${last ? "Ship it" : "Pass forward"}</h2>
    <p class="hint">${last
      ? `<b>${esc((cgStage(c) || {}).name || "")}</b> is the last stage — passing sets <b>${esc(c.title)}</b> LIVE.`
      : `<b>${esc((cgStage(c) || {}).name || "")}</b> done → hands to <b>${esc(next.uname)}</b> for <b>${esc(next.name)}</b>.`}</p>
    <textarea id="cgPassNote" placeholder="Anything the next person should know? (optional)"></textarea>
    ${cgLinkInputs()}
    <button class="btn btn-go" id="cgPassGo">${last ? "Go live" : "Pass to " + esc(next.uname)}</button>
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
        toast(last ? "LIVE — nice work 🎉" : "Passed forward");
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
    <p class="hint">Back to <b>${esc(prev.uname)}</b> for another round of <b>${esc(prev.name)}</b>. Say exactly what needs fixing — they only have your words to go on.</p>
    <textarea id="cgBackNote" placeholder="What needs to change?"></textarea>
    <button class="btn btn-go" id="cgBackGo" disabled>Send back</button>
    <button class="btn btn-ghost btn-sm" id="cgBackCancel">Cancel</button>
  `, () => {
    const ta = $("cgBackNote"), btn = $("cgBackGo");
    ta.oninput = () => { btn.disabled = ta.value.trim().length < 3; };
    $("cgBackCancel").onclick = () => cgOpenDetail(id);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await cgMove(id, "back", ta.value.trim());
        closeSheet();
        toast("Sent back to " + prev.uname);
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        toast(e.message || "Couldn't move it — try again");
      }
    };
    ta.focus();
  });
}

/* ---------- admin: jump the baton anywhere ---------- */
function cgJumpSheet(id){
  const c = cgFind(id);
  if (!c || !isAdmin) return;
  openSheet(`
    <h2>Move baton</h2>
    <p class="hint">Drop it on any stage of <b>${esc(c.title)}</b> — or straight to Live.</p>
    <div class="cg-jump">
      ${c.stages.map((s, i) => `
        <button type="button" class="cg-jump-opt${i === c.cur ? " is-cur" : ""}" data-j="${i}" ${i === c.cur ? "disabled" : ""}>
          <b>${esc(s.name)}</b><span>${esc(s.uname)}${i === c.cur ? " · holds it now" : ""}</span>
        </button>`).join("")}
      <button type="button" class="cg-jump-opt cg-jump-live" data-j="live"><b>LIVE</b><span>ship it as done</span></button>
    </div>
    <button class="btn btn-ghost btn-sm" id="cgJumpCancel">Cancel</button>
  `, () => {
    $("cgJumpCancel").onclick = () => cgOpenDetail(id);
    document.querySelectorAll(".cg-jump-opt[data-j]").forEach(b => b.onclick = async () => {
      const me = auth.currentUser;
      const myName = S.worker || (me.email ? me.email.split("@")[0] : "Someone");
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
          if (b.dataset.j === "live"){
            tx.update(ref, {
              status: "live", liveAt: now, updatedAt: now,
              history: [...(cc.history || []), { t: now, type: "live", by: myName, note: "marked live by admin" }]
            });
            tell = { live: true, c: { ...cc, id } };
          } else {
            const i = Number(b.dataset.j);
            if (i === cc.cur) return;
            if (stages[i].enteredAt) stages[i].rounds = (stages[i].rounds || 1) + 1;
            stages[i].enteredAt = now;
            stages[i].doneAt = null;
            tx.update(ref, {
              stages, cur: i, status: "active", liveAt: null, updatedAt: now,
              history: [...(cc.history || []), { t: now, type: "jump", by: myName, from, to: stages[i].name }]
            });
            tell = { uid: stages[i].uid, msg: `${myName} moved "${cc.title}" to you — ${stages[i].name}`, c: { ...cc, id } };
          }
        });
        if (tell){
          if (tell.live) cgNotify(tell.c.memberUids || [], `"${tell.c.title}" is LIVE 🎉`, tell.c, { admins: true }).catch(e => console.error(e));
          else cgNotify([tell.uid], tell.msg, tell.c).catch(e => console.error(e));
        }
        closeSheet();
        toast("Baton moved");
      } catch (e) { console.error(e); toast(e.message || "Couldn't move it"); }
    });
  });
}

/* ---------- admin: create / edit — the chain builder ----------
   Stages are rows the admin writes and orders freely: any names, any
   count, one owner each. Templates capture the whole chain (stages +
   default owners) so a niche's pipeline is two clicks next time. */
let cgEdStages = [];   // [{name, uid, uname}] — the builder's working copy
let cgEdMembers = [];  // directory rows for the owner selects

function cgEdRowsHTML(){
  const opts = sel => `<option value="">Owner…</option>` + cgEdMembers.map(p =>
    `<option value="${esc(p.uid)}"${p.uid === sel ? " selected" : ""}>${esc(p.name)}${p.craft ? " · " + esc(p.craft) : ""}</option>`).join("");
  return cgEdStages.map((s, i) => `
    <div class="cg-srow" data-i="${i}">
      <input type="text" class="cg-srow-name" value="${esc(s.name)}" placeholder="Stage name" autocomplete="off">
      <select class="cg-srow-who">${opts(s.uid)}</select>
      <span class="cg-srow-btns">
        <button type="button" class="cg-srow-b" data-mv="-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="cg-srow-b" data-mv="1" title="Move down" ${i === cgEdStages.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="cg-srow-b cg-srow-x" data-del="1" title="Remove stage">×</button>
      </span>
    </div>`).join("");
}

function cgEdPaintRows(){
  const box = $("cgEdRows");
  box.innerHTML = cgEdRowsHTML();
  box.querySelectorAll(".cg-srow").forEach(row => {
    const i = Number(row.dataset.i);
    row.querySelector(".cg-srow-name").oninput = e => { cgEdStages[i].name = e.target.value; };
    row.querySelector(".cg-srow-who").onchange = e => {
      cgEdStages[i].uid = e.target.value;
      const p = cgEdMembers.find(m => m.uid === e.target.value);
      cgEdStages[i].uname = p ? p.name : "";
    };
    row.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => {
      const j = i + Number(b.dataset.mv);
      if (j < 0 || j >= cgEdStages.length) return;
      [cgEdStages[i], cgEdStages[j]] = [cgEdStages[j], cgEdStages[i]];
      cgEdPaintRows();
    });
    row.querySelector("[data-del]").onclick = () => { cgEdStages.splice(i, 1); cgEdPaintRows(); };
  });
}

async function cgLoadTemplates(){
  try {
    const snap = await db.collection("campaignTemplates").get();
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch (e) { console.error(e); return []; }
}

async function cgEditorSheet(edit){
  if (!isAdmin) return;
  const dir = await loadDirectory();
  cgEdMembers = dir.filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
  cgEdStages = edit
    ? edit.stages.map(s => ({ name: s.name, uid: s.uid, uname: s.uname }))
    : [{ name: "", uid: "", uname: "" }, { name: "", uid: "", uname: "" }];
  const templates = edit ? [] : await cgLoadTemplates();

  // stores learned from campaigns already written, on top of CONFIG
  const stores = [...new Set([...CONFIG.clients, ...(cgRows || []).map(c => c.store).filter(Boolean)])].sort();

  openSheet(`
    <h2>${edit ? "Edit campaign" : "New campaign"}</h2>
    ${templates.length ? `
    <p class="cg-dt-label">Start from a template</p>
    <div class="cg-tpls">${templates.map((t, i) => `
      <span class="cg-tpl" data-t="${i}"><button type="button" class="cg-tpl-use">${esc(t.name)} <small>${t.stages.length}</small></button><button type="button" class="cg-tpl-del" title="Delete template">×</button></span>`).join("")}
    </div>` : ""}
    <input type="text" id="cgEdTitle" placeholder="Campaign name — e.g. August Newsletter" value="${esc(edit ? edit.title : "")}" autocomplete="off">
    <input type="text" id="cgEdStore" list="cgStoreList" placeholder="Store / client" value="${esc(edit ? edit.store || "" : "")}" autocomplete="off">
    <datalist id="cgStoreList">${stores.map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <label class="af-due"><span>Due date</span><input type="date" id="cgEdDue" value="${esc(edit ? edit.dueDate || "" : "")}"></label>
    <textarea id="cgEdBrief" placeholder="The brief — what is this campaign? (optional)">${esc(edit ? edit.brief || "" : "")}</textarea>
    <p class="cg-dt-label">The chain — top to bottom, one owner per stage</p>
    <div id="cgEdRows"></div>
    <button type="button" class="btn btn-ghost btn-sm" id="cgEdAdd">+ Add stage</button>
    <label class="cg-tpl-save"><input type="checkbox" id="cgEdSaveTpl"><span>Save this chain as a template</span></label>
    <input type="text" id="cgEdTplName" class="hidden" placeholder="Template name — e.g. Email Marketing" autocomplete="off">
    <button class="btn btn-go" id="cgEdGo">${edit ? "Save changes" : "Create campaign"}</button>
    <button class="btn btn-ghost btn-sm" id="cgEdCancel">Cancel</button>
  `, () => {
    cgEdPaintRows();
    $("cgEdAdd").onclick = () => { cgEdStages.push({ name: "", uid: "", uname: "" }); cgEdPaintRows(); };
    $("cgEdCancel").onclick = () => { if (edit) cgOpenDetail(edit.id); else closeSheet(); };
    $("cgEdSaveTpl").onchange = e => $("cgEdTplName").classList.toggle("hidden", !e.target.checked);

    document.querySelectorAll(".cg-tpl").forEach(el => {
      const t = templates[Number(el.dataset.t)];
      el.querySelector(".cg-tpl-use").onclick = () => {
        // template owners may have left the team — keep only ones still known
        cgEdStages = t.stages.map(s => {
          const p = cgEdMembers.find(m => m.uid === s.uid);
          return { name: s.name, uid: p ? s.uid : "", uname: p ? s.uname : "" };
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
  const rows = cgEdStages
    .map(s => ({ name: s.name.trim(), uid: s.uid, uname: s.uname }))
    .filter(s => s.name || s.uid);
  if (title.length < 2){ toast("Give the campaign a name"); $("cgEdTitle").focus(); return; }
  if (!rows.length){ toast("The chain needs at least one stage"); return; }
  if (rows.some(s => !s.name)){ toast("Every stage needs a name"); return; }
  if (rows.some(s => !s.uid)){ toast("Every stage needs an owner"); return; }

  const btn = $("cgEdGo");
  btn.disabled = true;
  const me = auth.currentUser;
  const myName = S.worker || (me.email ? me.email.split("@")[0] : "Someone");
  const now = Date.now();
  const common = {
    title,
    store: $("cgEdStore").value.trim(),
    brief: $("cgEdBrief").value.trim(),
    dueDate: $("cgEdDue").value || null,
    memberUids: [...new Set(rows.map(s => s.uid))],
    updatedAt: now
  };

  try {
    if ($("cgEdSaveTpl").checked){
      const tn = $("cgEdTplName").value.trim();
      if (tn.length < 2){ toast("Name the template first"); btn.disabled = false; $("cgEdTplName").focus(); return; }
      await db.collection("campaignTemplates").add({ name: tn, stages: rows, updatedAt: now });
    }

    if (edit){
      /* Editing keeps every stage's earned state: rows are matched to the
         old chain by name (first unused match), carrying rounds/doneAt/
         enteredAt across. The baton stays on the stage it was on; if that
         stage was removed, the earliest unfinished stage takes it. */
      const pool = edit.stages.map((s, i) => ({ ...s, i, used: false }));
      let curNew = -1;
      const stages = rows.map((r, idx) => {
        const m = pool.find(p => !p.used && p.name.toLowerCase() === r.name.toLowerCase());
        if (m){
          m.used = true;
          if (m.i === edit.cur) curNew = idx;
          return { name: r.name, uid: r.uid, uname: r.uname, rounds: m.rounds || 1, doneAt: m.doneAt || null, enteredAt: m.enteredAt || null };
        }
        return { name: r.name, uid: r.uid, uname: r.uname, rounds: 1, doneAt: null, enteredAt: null };
      });
      let cur = curNew;
      if (edit.status === "active"){
        if (cur < 0) cur = Math.max(0, stages.findIndex(s => !s.doneAt));
        if (!stages[cur].enteredAt) stages[cur].enteredAt = now;
      } else cur = Math.min(edit.cur, stages.length - 1);

      const prevOwner = (edit.stages[edit.cur] || {}).uid;
      const patch = {
        ...common, stages, cur,
        history: [...(edit.history || []), { t: now, type: "edit", by: myName }]
      };
      await db.collection("campaigns").doc(edit.id).update(patch);
      const c2 = { ...edit, ...patch };
      if (edit.status === "active" && stages[cur].uid !== prevOwner)
        cgNotify([stages[cur].uid], `${myName} put "${title}" in your court — ${stages[cur].name}`, c2).catch(e => console.error(e));
      closeSheet();
      toast("Campaign updated");
    } else {
      const stages = rows.map((r, i) => ({
        name: r.name, uid: r.uid, uname: r.uname,
        rounds: 1, doneAt: null, enteredAt: i === 0 ? now : null
      }));
      const ref = await db.collection("campaigns").add({
        ...common, status: "active", cur: 0, liveAt: null, links: [],
        createdAt: now, createdBy: { uid: me.uid, name: myName },
        history: [{ t: now, type: "created", by: myName }]
      });
      cgNotify([stages[0].uid], `${myName} started "${title}" — you're up first: ${stages[0].name}`,
        { id: ref.id, title, memberUids: common.memberUids }).catch(e => console.error(e));
      closeSheet();
      toast(`"${title}" is rolling — ${stages[0].uname} is up`);
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast("Couldn't save — check Firestore rules allow it");
  }
}

/* ---------- admin: role labels ----------
   Freeform words on directory/{uid}.craft ("copywriter", "designer",
   "welder" — whatever the niche calls its people). They surface in the
   chain builder's owner pickers; routing stays manual in v1. */
async function cgRolesSheet(){
  if (!isAdmin) return;
  const dir = (await loadDirectory()).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`
    <h2>Roles</h2>
    <p class="hint">A word per person for what they do. It shows up when you build a chain, so picking owners is instant.</p>
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
        notifDir = null;   // pickers re-read the fresh labels
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
