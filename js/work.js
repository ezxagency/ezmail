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
  if (!wkTypeId || !wkType(wkTypeId)) wkTypeId = wkTypes[0].id;
  await wkRender();
}

async function wkRender(){
  const type = wkType(wkTypeId);
  const box = $("workBody");
  box.innerHTML = '<div class="wk-tabs">' +
      wkTypes.map(t => '<button type="button" class="wk-tab' + (t.id === wkTypeId ? " on" : "") + '" data-type="' +
        esc(t.id) + '">' + esc(t.name || t.id) + '</button>').join("") +
      '<button type="button" class="org-btn org-btn-sm wk-new" id="wkNew">New ' + esc((type.name || "item").toLowerCase()) + '</button>' +
    '</div>' +
    '<div id="wkList" class="org-list"><p class="org-note">Loading…</p></div>';

  box.querySelectorAll(".wk-tab").forEach(b => b.onclick = () => {
    wkTypeId = b.dataset.type; wkRender();
  });
  $("wkNew").onclick = () => wkItemSheet(null);

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
  box.innerHTML = wkRows.map(it => {
    const who = (it.assigneeIds || []).map(orgPersonName).join(", ");
    return '<button type="button" class="org-row wk-row" data-id="' + esc(it.id) + '">' +
      '<span class="org-row-main"><b>' + esc(it.title) + '</b><small>' +
        esc(wkStatusLabel(type, it.status)) + (who ? " · " + esc(who) : "") + '</small></span>' +
      '<span class="wk-pill">' + esc(wkStatusLabel(type, it.status)) + '</span>' +
      '</button>';
  }).join("");
  box.querySelectorAll(".wk-row").forEach(b =>
    b.onclick = () => wkItemSheet(wkRows.find(r => r.id === b.dataset.id) || null));
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

  openSheet(
    '<h3 class="sheet-title">' + (editing ? esc(item.title) : "New " + esc((type.name || "item").toLowerCase())) + '</h3>' +
    '<label class="org-field"><span>Title *</span>' +
      '<input id="wkTitle" type="text" maxlength="200" value="' + esc(editing ? item.title : "") + '"></label>' +
    (type.fields || []).map(f => wkFieldHtml(f, editing ? (item.fields || {})[f.key] : undefined)).join("") +
    '<div class="org-field"><span>People</span><div class="wk-multi">' + (assignees || '<p class="org-note">No one to assign yet.</p>') + '</div></div>' +
    (editing ? '<div class="org-field"><span>Status</span><div class="wk-statuses">' + statusBtns + '</div></div>' : '') +
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
    }
  );
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
