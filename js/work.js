/* ============================================================
   WORK — the runtime side of the model. The Organization page is
   where a type is DESIGNED; this is where work of that type gets
   made, moved and finished.

   Every control on this page is generated from the ItemType. There
   is no hand-written form for "shift swap" or "video" anywhere,
   because the moment one exists the model has failed (spec, ground
   rule 1): a new industry would need code again.

   Nothing here decides anything either. Every change goes through
   itemSave() -> itemCommit(), so what a person may do is answered
   in one place and this file only draws the answer.
   ============================================================ */

let wkTypes = null;     // the org's ItemTypes; null until first load
let wkTypeId = null;    // which one is on screen
let wkRows = [];        // the items showing now
let wkOrphans = [];     // work whose type is gone - reachable from no other tab

// not a type id: the repair tab. Prefixed so it can never collide with
// one an org invents, since these files share one global scope.
const WK_ORPHAN = "__wk_orphans__";

/* ---------- the eleven, as controls ----------
   One entry per field type, each answering the same two questions:
   what does the person see, and what comes back when they are done.
   The pair lives together so neither can drift from the other. */
const WK_CONTROL = {
  text:     { html: (f, v) => '<input type="text" maxlength="500" value="' + esc(v == null ? "" : v) + '">',
              read: el => el.value },
  longtext: { html: (f, v) => '<textarea rows="4">' + esc(v == null ? "" : v) + '</textarea>',
              read: el => el.value },
  number:   { html: (f, v) => '<input type="number" value="' + esc(v == null ? "" : v) + '">',
              read: el => (el.value === "" ? null : Number(el.value)) },
  money:    { html: (f, v) => '<input type="number" step="0.01" value="' + esc(v == null ? "" : v) + '">',
              read: el => (el.value === "" ? null : Number(el.value)) },
  date:     { html: (f, v) => '<input type="date" value="' + esc(v || "") + '">',
              read: el => (el.value || null) },
  url:      { html: (f, v) => '<input type="url" placeholder="https://" value="' + esc(v || "") + '">',
              read: el => el.value.trim() },
  file:     { html: (f, v) => '<input type="url" placeholder="Link to the file" value="' + esc(v || "") + '">',
              read: el => (el.value.trim() || null) },
  checkbox: { html: (f, v) => '<label class="wk-check"><input type="checkbox"' + (v ? " checked" : "") + '> Yes</label>',
              read: el => el.querySelector("input").checked },
  select:   { html: (f, v) => '<select><option value="">—</option>' +
                (f.options || []).map(o => '<option value="' + esc(o) + '"' + (o === v ? " selected" : "") + '>' + esc(o) + '</option>').join("") + '</select>',
              read: el => (el.value || null) },
  multiselect: { html: (f, v) => '<div class="wk-multi">' +
                (f.options || []).map(o => '<label class="wk-check"><input type="checkbox" value="' + esc(o) + '"' +
                  ((v || []).indexOf(o) >= 0 ? " checked" : "") + '> ' + esc(o) + '</label>').join("") + '</div>',
              read: el => [...el.querySelectorAll("input:checked")].map(i => i.value) },
  // a person is picked from this org's roster - never typed, so a value
  // is always a uid the org actually contains
  user:     { html: (f, v) => '<select><option value="">—</option>' +
                ((orgS && orgS.members) || []).map(m => '<option value="' + esc(m.uid) + '"' +
                  (m.uid === v ? " selected" : "") + '>' + esc(orgPersonName(m.uid)) + '</option>').join("") + '</select>',
              read: el => (el.value || null) }
};

const wkType = id => (wkTypes || []).find(t => t.id === id) || null;
const wkStatusLabel = (type, key) => {
  const s = ((type && type.statuses) || []).find(x => x.key === key);
  return s ? (s.label || s.key) : (key || "—");
};

/* ---------- page ---------- */

async function enterWorkPage(){
  // automation without a server: whatever is overdue gets chased the
  // moment somebody looks. Deliberately not awaited - the page must not
  // wait on it, and it is refused harmlessly for anyone whose role may
  // not update work across the org.
  itemsChaseOverdue().catch(e => console.warn(e));
  const box = $("workBody");
  if (!box) return;
  box.innerHTML = '<p class="org-note">Loading…</p>';
  const s = await orgEnsure();
  if (!s) {
    box.innerHTML = (orgWhyNone === "error")
      ? '<p class="org-note">Could not reach your organization. Check your connection and refresh.</p>'
      : '<p class="org-note">You are not in an organization yet. An owner can create one on the Organization page.</p>';
    return;
  }
  try { wkTypes = await itemTypesLoad(); }
  catch (e) {
    console.error(e);
    box.innerHTML = '<p class="org-note">Could not load work types. Check your connection and try again.</p>';
    return;
  }
  if (!wkTypes.length) {
    box.innerHTML = '<div class="org-empty"><h2>No work types yet</h2>' +
      '<p>A work type describes a kind of work — its fields and the stages it moves through. ' +
      'An owner creates the first one on the Organization page.</p></div>';
    return;
  }
  /* Work whose type was deleted is reachable from NO tab, because the
     tabs are the types. That is how work could be deleted from here and
     still be sitting on somebody's dashboard: it was never deleted, this
     page just had nowhere to draw it. Looked for once per visit; the tab
     only exists when there is something in it. */
  try { wkOrphans = (await itemsOrphans()).rows; }
  catch (e) { console.error(e); wkOrphans = []; }

  if (!wkTypeId || (wkTypeId !== WK_ORPHAN && !wkType(wkTypeId))) wkTypeId = wkTypes[0].id;
  if (wkTypeId === WK_ORPHAN && !wkOrphans.length) wkTypeId = wkTypes[0].id;
  await wkRender();
}

async function wkRender(){
  const orphanTab = wkTypeId === WK_ORPHAN;
  const type = orphanTab ? null : wkType(wkTypeId);
  const box = $("workBody");
  box.innerHTML = '<div class="wk-tabs">' +
      wkTypes.map(t => '<button type="button" class="wk-tab' + (t.id === wkTypeId ? " on" : "") + '" data-type="' +
        esc(t.id) + '">' + esc(t.name || t.id) + '</button>').join("") +
      (wkOrphans.length
        ? '<button type="button" class="wk-tab wk-tab-broken' + (orphanTab ? " on" : "") + '" data-type="' +
          WK_ORPHAN + '">Needs attention <span class="wk-tab-n">' + wkOrphans.length + '</span></button>'
        : "") +
      (orphanTab ? ""
        : '<button type="button" class="org-btn org-btn-sm wk-new" id="wkNew">New ' + esc((type.name || "item").toLowerCase()) + '</button>') +
    '</div>' +
    '<div id="wkList" class="org-list"><p class="org-note">Loading…</p></div>';

  box.querySelectorAll(".wk-tab").forEach(b => b.onclick = () => {
    wkTypeId = b.dataset.type; wkRender();
  });
  if ($("wkNew")) $("wkNew").onclick = () => wkItemSheet(null);

  if (orphanTab) { wkPaintOrphans(); return; }

  // one array-contains lookup, which is the whole point of facets: no
  // per-type index has to exist in advance for this to be fast.
  // Guarded because this ran unguarded once: a failing query left the
  // tabs drawn and the list on "Loading…" with no way to tell whether
  // the page was slow or broken, which is the worst of both.
  try {
    wkRows = await itemsByFacet("type:" + itemSlug(wkTypeId), 60);
  } catch (e) {
    console.error(e);
    $("wkList").innerHTML = '<p class="org-note">Could not load this work. Refresh to try again.</p>';
    return;
  }
  wkRows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  wkPaintList();
}

function wkPaintList(){
  const type = wkType(wkTypeId);
  const box = $("wkList");
  if (!wkRows.length) {
    box.innerHTML = '<p class="org-note">Nothing here yet.</p>';
    return;
  }
  const now = Date.now();
  box.innerHTML = wkRows.map(it => {
    const who = (it.assigneeIds || []).map(orgPersonName).join(", ");
    // the deadline is copied onto the Item when its stop activates, so a
    // list of fifty says what is late without reading fifty runs
    const l = hoLate(it.dueAt, now);
    return '<button type="button" class="org-row wk-row" data-id="' + esc(it.id) + '">' +
      '<span class="org-row-main"><b>' + esc(it.title) + '</b><small>' +
        esc(wkStatusLabel(type, it.status)) + (who ? " · " + esc(who) : "") + '</small></span>' +
      (l.late ? '<span class="wk-late">' + esc(wkLateLabel(l)) + '</span>' : "") +
      '<span class="wk-pill">' + esc(wkStatusLabel(type, it.status)) + '</span>' +
      '</button>';
  }).join("");
  box.querySelectorAll(".wk-row").forEach(b =>
    b.onclick = () => wkItemSheet(wkRows.find(r => r.id === b.dataset.id) || null));
}

/* ---------- the repair tab ----------
   One row per piece of work whose type is gone, and the only action that
   is still honest: delete it. It cannot be opened (there are no fields to
   draw), moved (no statuses to move between) or finished (the chokepoint
   refuses) - so this offers none of those rather than four buttons that
   all fail differently. Who is still holding it is named, because that is
   whose dashboard it is stuck on. */
function wkPaintOrphans(){
  const box = $("wkList");
  if (!box) return;
  if (!wkOrphans.length){ box.innerHTML = '<p class="org-note">Nothing needs attention.</p>'; return; }
  box.innerHTML =
    '<p class="org-note">These point at a work type that no longer exists. Nobody can open or finish them, ' +
    'and they stay on the dashboard of whoever holds them until they are cleared.</p>' +
    wkOrphans.map(it => {
      const who = (it.assigneeIds || []).map(orgPersonName).join(", ");
      return '<div class="org-row wk-row wk-row-broken">' +
        '<span class="org-row-main"><b>' + esc(it.title || "(untitled)") + '</b><small>' +
          'was a ' + esc(it.typeId || "—") + (who ? " · still with " + esc(who) : " · with nobody") + '</small></span>' +
        '<button type="button" class="org-btn org-btn-sm org-btn-danger wk-orphan-del" data-id="' + esc(it.id) + '">Delete</button>' +
        '</div>';
    }).join("");
  box.querySelectorAll(".wk-orphan-del").forEach(b => b.onclick = async () => {
    const it = wkOrphans.find(x => x.id === b.dataset.id);
    if (!it) return;
    b.disabled = true; b.textContent = "Deleting…";
    const r = await itemsDeleteOrphan(it);
    if (!r.ok){
      b.disabled = false; b.textContent = "Delete";
      toast(r.error === "denied" ? "Your role cannot delete work."
        : "Could not delete it (" + (r.error || "unknown") + ")");
      return;
    }
    wkOrphans = wkOrphans.filter(x => x.id !== it.id);
    toast("Cleared — it leaves every dashboard it was on");
    if (!wkOrphans.length && wkTypes.length) wkTypeId = wkTypes[0].id;
    wkRender();
  });
}

/* ---------- one item ---------- */

function wkFieldHtml(f, v){
  const c = WK_CONTROL[f.type];
  if (!c) return "";
  return '<label class="org-field wk-f" data-key="' + esc(f.key) + '" data-type="' + esc(f.type) + '">' +
    '<span>' + esc(f.label || f.key) + (f.required ? " *" : "") + '</span>' +
    c.html(f, v) + '</label>';
}

function wkReadFields(type){
  const out = {};
  document.querySelectorAll(".wk-f").forEach(el => {
    const key = el.dataset.key, c = WK_CONTROL[el.dataset.type];
    if (!c) return;
    // checkbox and multiselect read the wrapper; everything else reads
    // the one control inside the label
    const target = (el.dataset.type === "checkbox") ? el.querySelector(".wk-check")
                 : (el.dataset.type === "multiselect") ? el.querySelector(".wk-multi")
                 : el.querySelector("input, select, textarea");
    if (target) out[key] = c.read(target);
  });
  return out;
}

function wkItemSheet(item){
  const type = wkType(wkTypeId);
  const editing = !!item;
  const statusBtns = (type.statuses || []).map(st =>
    '<button type="button" class="wk-status' + (item && item.status === st.key ? " on" : "") + '" data-status="' +
    esc(st.key) + '">' + esc(st.label || st.key) + '</button>').join("");
  const assignees = ((orgS && orgS.members) || []).map(m =>
    '<label class="wk-check"><input type="checkbox" class="wk-assignee" value="' + esc(m.uid) + '"' +
    ((item && (item.assigneeIds || []).indexOf(m.uid) >= 0) ? " checked" : "") + '> ' + esc(orgPersonName(m.uid)) + '</label>').join("");

  // a run drives the status and the people, so the controls for them go
  // read-only rather than sitting there offering to disagree with it
  const onTrack = !!(editing && item.workflowRunId);

  openSheet(
    '<h3 class="sheet-title">' + (editing ? esc(item.title) : "New " + esc((type.name || "item").toLowerCase())) + '</h3>' +
    '<div id="wkHandoff"></div>' +
    '<label class="org-field"><span>Title *</span>' +
      '<input id="wkTitle" type="text" maxlength="200" value="' + esc(editing ? item.title : "") + '"></label>' +
    (type.fields || []).map(f => wkFieldHtml(f, editing ? (item.fields || {})[f.key] : undefined)).join("") +
    (onTrack
      ? ''
      : '<div class="org-field"><span>People</span><div class="wk-multi">' + (assignees || '<p class="org-note">No one to assign yet.</p>') + '</div></div>') +
    (editing && !onTrack ? '<div class="org-field"><span>Status</span><div class="wk-statuses">' + statusBtns + '</div></div>' : '') +
    '<div class="org-actions">' +
      '<button type="button" class="org-btn" id="wkSave">' + (editing ? "Save" : "Create") + '</button>' +
      (editing ? '<button type="button" class="org-btn org-btn-danger" id="wkDelete">Delete</button>' : '') +
    '</div>' +
    '<div id="wkErrs"></div>',
    () => {
      $("wkSave").onclick = () => wkSave(item);
      if (editing && $("wkDelete")) $("wkDelete").onclick = () => wkDelete(item);
      document.querySelectorAll(".wk-status").forEach(b =>
        b.onclick = () => wkSetStatus(item, b.dataset.status));
      if (onTrack) wkPaintHandoff(item, type);
    }
  );
}

/* "2 days late" beats a timestamp: nobody converts epoch milliseconds
   into a feeling about whether to chase somebody. */
function wkLateLabel(l){
  const days = Math.floor(l.msLate / HO_DAY);
  if (days >= 1) return days + (days === 1 ? " day late" : " days late");
  const hours = Math.floor(l.msLate / 3600000);
  return hours >= 1 ? hours + (hours === 1 ? " hour late" : " hours late") : "just late";
}

/* ---------- the handoff, as the person sees it ----------
   Whose turn it is, one control if it is yours, and where the work has
   already been. Loaded after the sheet is open rather than before it,
   because a sheet that waits on a read is a sheet that feels broken. */
async function wkPaintHandoff(item, type){
  const box = $("wkHandoff");
  if (!box) return;
  box.innerHTML = '<p class="org-note">Loading the handoff…</p>';
  const h = await itemsHandoffLoad(item);
  if (!box.isConnected) return;                 // they closed it while we read
  if (!h) { box.innerHTML = '<p class="org-note">This work points at a handoff that is no longer there.</p>'; return; }

  const uid = auth.currentUser ? auth.currentUser.uid : null;
  const owner = (orgS && orgS.myRoleId === "owner");
  const stops = hoActiveStops(h.nodeRuns);
  const mine = stops.find(nr => hoMayAdvance(h.blueprint, nr, uid, h.members, false).ok) || null;
  const holders = hoHolders(h.blueprint, h.nodeRuns, h.members);
  const stalled = hoStalled(h.blueprint, h.nodeRuns, h.members);
  const trail = hoTrail(h.blueprint, h.nodeRuns);
  const label = nr => {
    const n = ((h.blueprint && h.blueprint.nodes) || []).find(x => x.id === nr.nodeId);
    return (n && n.config && n.config.label) || nr.nodeId;
  };

  const due = hoDue(h.blueprint, h.nodeRuns, Date.now());
  const dueLine = due.due
    ? '<div class="wk-due' + (due.late ? " late" : "") + '">' +
        esc(due.late ? wkLateLabel(due) : "Due " +
          new Date(due.dueAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })) +
      '</div>'
    : "";
  const head = h.run.status === "completed"
    ? '<div class="wk-baton done"><b>Finished</b><small>It reached the end of its handoff.</small></div>'
    : stalled
      // the silent failure, said out loud: a stop nobody can act on does
      // not error, it just stops, and looks exactly like work in progress
      ? '<div class="wk-baton stuck"><b>Stuck at ' + esc(stalled.label) + '</b>' +
        '<small>Nobody holds ' + esc(stalled.role === HO_ANY ? "this stop" : orgRoleName(stalled.role)) +
        ', so it cannot move. Put somebody in that role.</small></div>'
      : mine
        ? '<div class="wk-baton mine"><b>Your turn — ' + esc(label(mine)) + '</b>' +
          '<small>Finish it and the work moves to whoever is next.</small></div>'
        : '<div class="wk-baton"><b>With ' + esc(holders.map(orgPersonName).join(", ") || "nobody yet") + '</b>' +
          '<small>' + esc(stops.length ? label(stops[0]) : "Waiting") + '</small></div>';

  const trailHtml = trail.length
    ? '<div class="wk-trail">' + trail.map(t =>
        '<div class="wk-leg' + (t.status === "completed" ? " done" : "") + '">' +
          '<span class="wk-leg-dot"></span>' +
          '<span class="wk-leg-main"><b>' + esc(t.label) + '</b><small>' +
            esc(t.status === "completed"
              ? (t.by ? "done by " + orgPersonName(t.by) + (t.as === "override" ? " (as owner)" : "") : "done")
              : "here now") + '</small></span>' +
        '</div>').join("") + '</div>'
    : "";

  box.innerHTML = head + dueLine + trailHtml +
    ((mine || (owner && stops.length && !stalled))
      ? '<div class="org-actions"><button type="button" class="org-btn" id="wkAdvance">' +
        (mine ? "Mark this done" : "Move it on (override)") + '</button></div>'
      : "");

  if ($("wkAdvance")) $("wkAdvance").onclick = () =>
    wkAdvance(item, type, (mine || stops[0]).id, $("wkAdvance"));
}

async function wkAdvance(item, type, nodeRunId, btn){
  btn.disabled = true; btn.textContent = "Passing it on…";
  const r = await itemsAdvanceHandoff(item, type, nodeRunId, {});
  if (!r.ok) {
    btn.disabled = false; btn.textContent = "Mark this done";
    toast(r.error === "not-yours" ? "This stop is not yours to move."
      : r.error === "not-active" ? "Somebody already moved it on."
      : "Could not move it on.");
    return;
  }
  closeSheet();
  toast(r.as === "override" ? "Moved on as owner." : "Done — it has moved to whoever is next.");
  enterWorkPage();
}

// the engine hands back every problem at once, so the sheet shows every
// problem at once - a form that reveals one error per save is abandoned
function wkShowErrors(details){
  const box = $("wkErrs");
  if (!box) return;
  box.innerHTML = '<div class="wk-errs">' +
    (details || []).map(d => '<p>' + esc(d.message) + '</p>').join("") + '</div>';
}

async function wkSave(item){
  const type = wkType(wkTypeId);
  const btn = $("wkSave");
  btn.disabled = true; btn.textContent = "Saving…";
  const fields = wkReadFields(type);
  const title = ($("wkTitle").value || "").trim();
  const assigneeIds = [...document.querySelectorAll(".wk-assignee:checked")].map(i => i.value);

  let r;
  if (!item) r = await itemSave(type, null, { kind: "create", title, fields, assigneeIds });
  else {
    r = await itemSave(type, item, { kind: "update", title, fields });
    if (r.ok) r = await itemSave(type, r.item, { kind: "assign", assigneeIds });
  }
  btn.disabled = false; btn.textContent = item ? "Save" : "Create";
  if (!r.ok) {
    if (r.error === "invalid") { wkShowErrors(r.details); return; }
    toast(r.error === "denied" ? "Your role cannot do that." : "Could not save.");
    return;
  }
  closeSheet();
  toast(item ? "Saved." : "Created.");
  wkRender();
}

async function wkSetStatus(item, status){
  const r = await itemSave(wkType(wkTypeId), item, { kind: "set_status", status });
  if (!r.ok) { toast(r.error === "denied" ? "Your role cannot do that." : "Could not change the status."); return; }
  closeSheet();
  toast("Moved to " + wkStatusLabel(wkType(wkTypeId), status) + ".");
  wkRender();
}

async function wkDelete(item){
  const r = await itemSave(wkType(wkTypeId), item, { kind: "delete" });
  if (!r.ok) { toast(r.error === "denied" ? "Your role cannot do that." : "Could not delete."); return; }
  closeSheet();
  toast("Deleted.");
  wkRender();
}
