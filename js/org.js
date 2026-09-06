/* ============================================================
   ORGANIZATION — the tenancy screen: who is in this org, and what
   each role may do. First UI from docs/platform-spec.md.

   Everything here is additive. No existing page reads an org, so an
   agency that never opens this screen behaves exactly as before -
   which is the whole point of building the model beside the running
   app rather than underneath it.

   The decisions worth knowing:

   - Orgs are not enumerable (firestore.rules says so deliberately: a
     tenant list is a customer list), so the client cannot go looking
     for its own. memberOf/{uid} is the one pointer it may read about
     itself. It authorizes nothing - the org's members doc is what
     proves membership - so a stale or forged pointer just gets you
     refused by that org.
   - Creating an org is TWO writes that must both land: the org doc,
     then the founding seat. The rules allow the second only because
     the first named you as ownerUid, so if the seat fails the org is
     left unreachable by anyone, including you. orgCreate() therefore
     seats before it celebrates, and says so plainly when it can't.
   - The roles editor writes exactly the rows js/permissions.js parses.
     PERM_CATALOG is the single source for which pairs exist, so a
     switch on this screen can never be wired to a check nobody makes.
   ============================================================ */

let orgS = null;   // { orgId, org, members, roles, myRoleId } | null while loading
/* Why the last load produced nothing. Both outcomes return null, but they
   are not the same thing to a person: "you have no organization" is a
   next step, while "something failed" is a reason to try again. Telling
   someone the first when the second happened sends them off to create an
   org they already have. */
let orgWhyNone = null;   // null | "none" | "error" 

const orgUid = () => (auth.currentUser ? auth.currentUser.uid : null);
const orgIsOwner = () => !!orgS && orgS.myRoleId === "owner";
const orgNewId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* Roles a brand-new org starts with. Not a template pack (those come in
   phase 5) - just enough that the first admin sees the grammar working
   on real rows instead of an empty screen they have to imagine. */
const ORG_SEED_ROLES = [
  { id: "owner",   name: "Owner",   permissions: ["*:*:org"] },
  { id: "manager", name: "Manager", permissions: [
      "item:create:org", "item:read:org", "item:update:org", "item:delete:org",
      "member:read:org", "member:invite:org", "workflow:read:org", "report:read:org"] },
  { id: "staff",   name: "Staff",   permissions: [
      "item:create:org", "item:read:org", "item:update:assigned", "workflow:read:org"] }
];

/* ---------- load ---------- */

async function orgLoad(){
  orgWhyNone = "none";
  const uid = orgUid();
  if (!uid) return null;
  // A denied or offline read must answer "no org", never throw. Callers
  // treat null as "cannot proceed", which is the safe direction - and a
  // rejection here would otherwise escape into whichever page asked,
  // leaving it stuck on its loading line with nothing to show for it.
  // The window this closes is real: Pages ships new JS the instant main
  // moves, while the rules that JS needs are still deploying behind it.
  let ptr;
  try { ptr = await db.collection("memberOf").doc(uid).get(); }
  catch (e) { console.error(e); orgWhyNone = "error"; return null; }
  let orgId = ptr.exists ? ptr.data().orgId : null;

  // No pointer does not mean no org. Someone an owner seated directly -
  // a team that existed long before the org did - has a membership and
  // was never handed a pointer to it, because that document is theirs
  // alone to write. So look for the membership itself, then write the
  // pointer on their own behalf: the lookup happens once, and every
  // load after this one takes the cheap path above.
  if (!orgId) {
    try {
      const mine = await db.collectionGroup("members").where("uid", "==", uid).limit(1).get();
      if (!mine.empty) {
        orgId = mine.docs[0].ref.parent.parent.id;
        db.collection("memberOf").doc(uid).set({ orgId, at: Date.now() }).catch(e => console.error(e));
      }
    } catch (e) { console.error(e); orgWhyNone = "error"; return null; }
  }
  if (!orgId) return null;

  let orgDoc;
  try { orgDoc = await db.collection("orgs").doc(orgId).get(); }
  catch (e) { console.error(e); orgWhyNone = "error"; return null; }
  // the pointer outlived the membership (removed from the org, or it was
  // never real): treat it as no org rather than an error the user can't act on
  if (!orgDoc.exists) return null;

  let memSnap, roleSnap, typeSnap, autoSnap, dirRows;
  try { [memSnap, roleSnap, typeSnap, autoSnap, dirRows] = await Promise.all([
    db.collection("orgs").doc(orgId).collection("members").get(),
    db.collection("orgs").doc(orgId).collection("roles").get(),
    db.collection("orgs").doc(orgId).collection("itemTypes").get(),
    db.collection("orgs").doc(orgId).collection("automations").get(),
    // the roster stores uids; names live in the directory every signed-in
    // account may already read, so being polite costs no new permission
    loadDirectory(orgId)
  ]); } catch (e) { console.error(e); orgWhyNone = "error"; return null; }
  const dir = {};
  (dirRows || []).forEach(r => { dir[r.uid] = r; });
  const members = memSnap.docs.map(d => Object.assign({ uid: d.id }, d.data()));
  const roles = roleSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  const types = typeSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  const automations = autoSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  orgWhyNone = null;
  const me = members.find(m => m.uid === uid);
  /* Self-healing, the same shape as the memberOf pointer above. A
     directory entry written before the directory was tenant-scoped
     carries no orgId, so this org's own scoped read cannot see it and its
     owner would be looking at a roster of uids. An owner stamps them
     once, in the background, and never notices it happened. */
  if (me && me.roleId === "owner") orgHealDirectory(orgId, members, dir);
  return { orgId, org: orgDoc.data(), members, roles, types, automations, dir, myRoleId: me ? me.roleId : null };
}

/* Stamp this org's id onto the directory entries of people who are in it
   and whose entry does not say so. Deliberately writes ONLY orgId - the
   rules refuse anything else, because holding a roster is not a licence
   to rewrite somebody's name. Fire-and-forget: a page must never wait on
   a migration, and if it fails the only cost is that it runs again. */
async function orgHealDirectory(orgId, members, dir){
  const missing = (members || []).filter(m => m && m.uid && !dir[m.uid]);
  if (!missing.length) return;
  try {
    const batch = db.batch();
    missing.forEach(m => batch.set(db.collection("directory").doc(m.uid), { orgId }, { merge: true }));
    await batch.commit();
    dirInvalidate();   // the names will be there the next time it is read
  } catch (e) { console.warn("Could not stamp the directory for this org:", e); }
}

/* The org context, loaded once and reused. The Organization PAGE is not
   the only thing that needs to know which tenant we are in - js/items.js
   needs it on every write - so the lookup lives here, cached, rather than
   being re-derived by whoever asks. Returns null when this account is in
   no org, which callers must treat as "cannot proceed", never as "allow". */
async function orgEnsure(){
  if (orgS) return orgS;
  orgS = await orgLoad();
  return orgS;
}

/* Drop the cache. Anything that changes the org's SHAPE - its roles,
   its kinds of work - has to call this, or the running app keeps
   answering from a picture of an org that no longer exists. It lives
   here rather than being assigned across files because orgS is this
   file's to own; js/items.js should not know the variable's name. */
function orgInvalidate(){ orgS = null; dirInvalidate(); }

/* ---------- page entry ---------- */

function enterOrgPage(){
  const box = $("orgBody");
  if (!box) return;
  box.innerHTML = '<p class="org-note">Loading…</p>';
  orgLoad().then(s => {
    orgS = s;
    if (!orgS) orgRenderEmpty();
    else orgRender();
  }).catch(e => {
    console.error(e);
    box.innerHTML = '<p class="org-note">Could not load the organization. Check your connection and try again.</p>';
  });
}

/* ---------- no org yet ---------- */

function orgRenderEmpty(){
  $("orgBody").innerHTML =
    '<div class="org-empty">' +
      '<h2>Create your organization</h2>' +
      '<p>An organization is the wall around your data. People, roles and work all live inside it, and nothing crosses to another one.</p>' +
      '<label class="org-field"><span>Organization name</span>' +
        '<input id="orgNewName" type="text" maxlength="60" placeholder="Ez Agency" autocomplete="organization">' +
      '</label>' +
      '<button type="button" class="org-btn" id="orgCreateBtn">Create organization</button>' +
    '</div>';
  $("orgCreateBtn").onclick = () => {
    const name = ($("orgNewName").value || "").trim();
    if (name.length < 2) { toast("Give the organization a name first."); return; }
    orgCreate(name);
  };
}

async function orgCreate(name){
  const uid = orgUid();
  if (!uid) return;
  const btn = $("orgCreateBtn");
  btn.disabled = true; btn.textContent = "Creating…";
  const orgId = orgNewId();
  try {
    // 1. the org, naming me as founder - the rules read ownerUid from
    //    this document to decide whether step 2 is allowed at all
    await db.collection("orgs").doc(orgId).set({
      name, ownerUid: uid, createdAt: Date.now()
    });
    // 2. the founding seat. Until this lands nobody is a member, which
    //    means nobody - me included - can read or write anything under
    //    the org. It is the write that must not be skipped on failure.
    await db.collection("orgs").doc(orgId).collection("members").doc(uid).set({
      // uid is stored as a FIELD as well as the document id: a
      // collection-group query cannot filter on an id, and that query is
      // how a person finds this row when nobody has handed them a pointer
      uid, roleId: "owner", joinedAt: Date.now()
    });
    // 3. starter roles, then the pointer that lets me find all this again
    const batch = db.batch();
    ORG_SEED_ROLES.forEach(r => batch.set(
      db.collection("orgs").doc(orgId).collection("roles").doc(r.id),
      { name: r.name, permissions: r.permissions }
    ));
    await batch.commit();
    await db.collection("memberOf").doc(uid).set({ orgId, at: Date.now() });
    toast("Organization created.");
    enterOrgPage();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Create organization";
    toast("Could not finish creating the organization. Nothing was changed for your team.");
  }
}

/* ---------- the org ---------- */

const orgRoleName = id => {
  const r = (orgS.roles || []).find(x => x.id === id);
  return r ? r.name : id || "No role";
};
const orgPersonName = uid => {
  const d = orgS && orgS.dir ? orgS.dir[uid] : null;
  if (d && d.name) return d.name;
  if (d && d.email) return d.email.split("@")[0];
  return uid === orgUid() ? "You" : uid.slice(0, 6);
};

function orgRender(){
  const owner = orgIsOwner();
  const rolesHtml = (orgS.roles || [])
    .slice().sort((a, b) => (a.id === "owner" ? -1 : b.id === "owner" ? 1 : a.name.localeCompare(b.name)))
    .map(r => {
      const n = (r.permissions || []).length;
      const summary = r.id === "owner"
        ? "Everything, everywhere in this organization"
        : n + (n === 1 ? " permission" : " permissions");
      return '<button type="button" class="org-row org-role" data-role="' + esc(r.id) + '"' +
        (owner && r.id !== "owner" ? "" : " disabled") + '>' +
        '<span class="org-row-main"><b>' + esc(r.name) + '</b><small>' + esc(summary) + '</small></span>' +
        (owner && r.id !== "owner" ? '<span class="org-row-go">Edit</span>' : '<span class="org-row-lock">Locked</span>') +
        '</button>';
    }).join("");

  const typesHtml = (orgS.types || []).length
    ? (orgS.types || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(t => {
        const n = (t.fields || []).length, st = (t.statuses || []).length;
        const summary = n + (n === 1 ? " field" : " fields") + " · " + st + (st === 1 ? " status" : " statuses");
        return '<button type="button" class="org-row org-type" data-type="' + esc(t.id) + '"' + (owner ? "" : " disabled") + '>' +
          '<span class="org-row-main"><b>' + esc(t.name || t.id) + '</b><small>' + esc(summary) + '</small></span>' +
          (owner ? '<span class="org-row-go">Edit</span>' : '') +
          '</button>';
      }).join("")
    : '<p class="org-note">No work types yet.' + (owner ? ' Start from a template below, or create one to describe the work your team actually does.' : '') + '</p>';

  const autoHtml = (orgS.automations || []).length
    ? (orgS.automations || []).map(a =>
        '<button type="button" class="org-row org-auto" data-auto="' + esc(a.id) + '"' + (owner ? "" : " disabled") + '>' +
          '<span class="org-row-main"><b>' + esc(a.name || "Rule") + '</b><small>' + esc(orgAutoSummary(a)) + '</small></span>' +
          (owner ? '<span class="org-row-go">Edit</span>' : '') +
        '</button>').join("")
    : '<p class="org-note">No rules yet.' + (owner ? ' Create one to make something happen by itself.' : '') + '</p>';

  // owner first, then by name: a roster you scan for a person, not a row
  const membersHtml = (orgS.members || []).slice()
    .sort((a, b) => a.roleId === "owner" ? -1 : b.roleId === "owner" ? 1
      : orgPersonName(a.uid).localeCompare(orgPersonName(b.uid)))
    .map(m => {
      const nm = orgPersonName(m.uid);
      return '<button type="button" class="org-row org-member" data-member="' + esc(m.uid) + '">' +
        '<span class="org-av">' + esc(orgInitial(nm)) + '</span>' +
        '<span class="org-row-main"><b>' + esc(nm) + '</b>' +
          '<small>' + esc(orgRoleName(m.roleId)) + '</small></span>' +
        '<span class="org-row-go">' + (owner ? "Manage" : "View") + '</span>' +
        '</button>';
    }).join("");

  $("orgBody").innerHTML =
    '<section class="org-sec">' +
      '<div class="org-sec-head"><h2>' + esc(orgS.org.name || "Organization") + '</h2>' +
        '<span class="org-badge">' + esc(orgRoleName(orgS.myRoleId)) + '</span></div>' +
      '<p class="org-note">Everything below is scoped to this organization. No role reaches outside it.</p>' +
    '</section>' +
    '<section class="org-sec">' +
      '<div class="org-sec-head"><h3>Roles</h3>' +
        (owner ? '<button type="button" class="org-btn org-btn-sm" id="orgAddRole">New role</button>' : '') +
      '</div>' +
      '<div class="org-list">' + rolesHtml + '</div>' +
      (owner ? '' : '<p class="org-note">Only an owner can change roles.</p>') +
    '</section>' +
    '<section class="org-sec">' +
      '<div class="org-sec-head"><h3>Work types</h3>' +
        (owner ? '<button type="button" class="org-btn org-btn-sm" id="orgPackBtn">Templates</button>' +
                 '<button type="button" class="org-btn org-btn-sm" id="orgAddType">New type</button>' : '') +
      '</div>' +
      '<div class="org-list">' + typesHtml + '</div>' +
      '<p class="org-note">A work type is what makes this fit your business: the fields your work actually has, and the stages it moves through.</p>' +
    '</section>' +
    '<section class="org-sec">' +
      '<div class="org-sec-head"><h3>Rules</h3>' +
        (owner ? '<button type="button" class="org-btn org-btn-sm" id="orgAddAuto">New rule</button>' : '') +
      '</div>' +
      '<div class="org-list">' + autoHtml + '</div>' +
      '<p class="org-note">A rule watches for something happening and does one thing about it, every time, without anyone remembering to.</p>' +
    '</section>' +
    (owner ? '<section class="org-sec">' +
      '<div class="org-sec-head"><h3>Bring existing work across</h3></div>' +
      '<div class="org-list">' +
        '<button type="button" class="org-row" id="orgImportTasks"><span class="org-row-main">' +
          '<b>Import assigned tasks</b><small>Copies every assignment into Work as a Task</small>' +
        '</span><span class="org-row-go">Import</span></button>' +
        '<button type="button" class="org-row" id="orgImportCampaigns"><span class="org-row-main">' +
          '<b>Import campaigns</b><small>Copies every campaign into Work, at the stage it is on</small>' +
        '</span><span class="org-row-go">Import</span></button>' +
        '<button type="button" class="org-row" id="orgSeatTeam"><span class="org-row-main">' +
          '<b>Add the whole team</b><small>Seats everyone who already has an account — admins as Managers, workers as Staff</small>' +
        '</span><span class="org-row-go">Seat</span></button>' +
        '<button type="button" class="org-row" id="orgImportChains"><span class="org-row-main">' +
          '<b>Turn campaign chains into workflows</b><small>Each saved chain becomes a draft blueprint you can review and publish</small>' +
        '</span><span class="org-row-go">Convert</span></button>' +
      '</div>' +
      '<p class="org-note">Nothing is deleted or changed — the Assign composer and Campaigns page keep working exactly as they do now. Safe to run more than once: anything already brought across is skipped.</p>' +
    '</section>' : '') +
    '<section class="org-sec">' +
      '<div class="org-sec-head"><h3>People</h3>' +
        (owner ? '<button type="button" class="org-btn org-btn-sm" id="orgInviteBtn">Invite</button>' : '') +
      '</div>' +
      // a roster grows and a settings page should not grow with it - but it
      // opens by default, because hiding your own team behind a tap to save
      // a few pixels is the wrong trade at every size
      '<details class="org-fold" open>' +
        '<summary><b>' + (orgS.members || []).length + '</b> ' +
          ((orgS.members || []).length === 1 ? "person" : "people") + ' in this organization</summary>' +
        '<div class="org-list">' + membersHtml + '</div>' +
      '</details>' +
    '</section>';

  if (owner && $("orgAddRole")) $("orgAddRole").onclick = () => orgRoleSheet(null);
  if (owner && $("orgInviteBtn")) $("orgInviteBtn").onclick = () => orgInviteSheet();
  if (owner && $("orgAddType")) $("orgAddType").onclick = () => orgTypeSheet(null);
  if (owner && $("orgPackBtn")) $("orgPackBtn").onclick = () => orgPackSheet();
  if (owner && $("orgImportTasks")) $("orgImportTasks").onclick = () => orgRunImport("assignment", $("orgImportTasks"));
  if (owner && $("orgImportCampaigns")) $("orgImportCampaigns").onclick = () => orgRunImport("campaign", $("orgImportCampaigns"));
  if (owner && $("orgImportChains")) $("orgImportChains").onclick = () => orgRunImport("chain", $("orgImportChains"));
  if (owner && $("orgSeatTeam")) $("orgSeatTeam").onclick = () => orgSeatTeam($("orgSeatTeam"));
  if (owner && $("orgAddAuto")) $("orgAddAuto").onclick = () => orgAutomationSheet(null);
  $("orgBody").querySelectorAll(".org-auto").forEach(b => {
    if (b.disabled) return;
    b.onclick = () => orgAutomationSheet((orgS.automations || []).find(a => a.id === b.dataset.auto) || null);
  });
  $("orgBody").querySelectorAll(".org-type").forEach(b => {
    if (b.disabled) return;
    b.onclick = () => orgTypeSheet((orgS.types || []).find(t => t.id === b.dataset.type) || null);
  });
  $("orgBody").querySelectorAll(".org-member").forEach(b => {
    b.onclick = () => orgMemberSheet((orgS.members || []).find(m => m.uid === b.dataset.member) || null);
  });
  $("orgBody").querySelectorAll(".org-role").forEach(b => {
    if (b.disabled) return;
    b.onclick = () => orgRoleSheet((orgS.roles || []).find(r => r.id === b.dataset.role) || null);
  });
}

/* ---------- the roles editor ---------- */

/* The scope a role currently holds for one pair, read back out of the
   stored rows - so opening the editor shows what is actually enforced,
   not what the UI last thought it wrote. */
const orgScopeOf = (perms, resource, action) => permGrantScope(perms, resource, action);

function orgRoleSheet(role){
  const editing = !!role;
  const perms = role ? (role.permissions || []) : [];
  const groups = PERM_CATALOG.map(g =>
    '<div class="org-perm-group"><h4>' + esc(g.label) + '</h4>' +
      g.actions.map(a => {
        const cur = orgScopeOf(perms, g.resource, a.action);
        const opts = PERM_SCOPES.map(sc =>
          '<option value="' + esc(sc) + '"' + (sc === cur ? " selected" : "") + '>' +
          esc(ORG_SCOPE_LABEL[sc]) + '</option>').join("");
        return '<label class="org-perm"><span>' + esc(a.label) + '</span>' +
          '<select class="org-scope" data-pair="' + esc(g.resource + ":" + a.action) + '">' + opts + '</select></label>';
      }).join("") +
    '</div>').join("");

  openSheet(
    '<h3 class="sheet-title">' + (editing ? "Edit role" : "New role") + '</h3>' +
    '<label class="org-field"><span>Role name</span>' +
      '<input id="orgRoleName" type="text" maxlength="40" value="' + esc(role ? role.name : "") + '" placeholder="Editor"></label>' +
    '<p class="org-note">How far each permission reaches. <b>Own</b> is what someone created, <b>assigned</b> adds work given to them, and <b>organization</b> is everything here.</p>' +
    '<div class="org-perms">' + groups + '</div>' +
    '<div class="org-actions">' +
      '<button type="button" class="org-btn" id="orgRoleSave">' + (editing ? "Save role" : "Create role") + '</button>' +
      (editing ? '<button type="button" class="org-btn org-btn-danger" id="orgRoleDelete">Delete</button>' : '') +
    '</div>',
    () => {
      $("orgRoleSave").onclick = () => orgSaveRole(role);
      if (editing && $("orgRoleDelete")) $("orgRoleDelete").onclick = () => orgDeleteRole(role);
    }
  );
}

const ORG_SCOPE_LABEL = { none: "No access", own: "Own", assigned: "Assigned", org: "Organization" };

async function orgSaveRole(role){
  const name = ($("orgRoleName").value || "").trim();
  if (name.length < 2) { toast("Give the role a name first."); return; }
  // only rows that grant something are stored: "none" is the absence of a
  // permission, not a permission, and writing it would make the documents
  // read as though every role held every pair
  const permissions = [];
  document.querySelectorAll(".org-scope").forEach(sel => {
    if (sel.value !== "none") permissions.push(sel.dataset.pair + ":" + sel.value);
  });
  const id = role ? role.id : ("r" + orgNewId());
  const btn = $("orgRoleSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("roles").doc(id).set({ name, permissions });
    closeSheet();
    toast(role ? "Role saved." : "Role created.");
    enterOrgPage();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = role ? "Save role" : "Create role";
    toast("Could not save the role.");
  }
}

async function orgDeleteRole(role){
  const held = (orgS.members || []).filter(m => m.roleId === role.id);
  if (held.length) {
    // deleting a role somebody holds would leave them in the org with a
    // roleId pointing at nothing - permissionless, and confusingly so
    toast(held.length === 1
      ? "One person still holds this role. Move them first."
      : held.length + " people still hold this role. Move them first.");
    return;
  }
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("roles").doc(role.id).delete();
    closeSheet();
    toast("Role deleted.");
    enterOrgPage();
  } catch (e) { console.error(e); toast("Could not delete the role."); }
}

/* ============================================================
   INVITATIONS — an owner offers a seat; the holder of the link
   takes it. The token is the capability, exactly as invites/ and
   clientReviews/ already work in this app.

   The link carries the org id as well as the token, because the
   invite lives UNDER the org (orgs/{orgId}/invites/{token}) and a
   client that is not a member yet cannot go looking for which org
   a bare token belongs to - orgs are not enumerable on purpose.
   ============================================================ */

// the same shelf life invites/ already uses: a link nobody took in a
// day is far more likely forgotten in a chat than still wanted
const ORG_INVITE_TTL = 24 * 3600000;

const orgInviteLink = (orgId, token) =>
  location.origin + location.pathname + "?org=" + encodeURIComponent(orgId) + "&join=" + encodeURIComponent(token);

const orgInviteLeft = inv => {
  const ms = (inv.expiresAt || 0) - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? h + "h left" : Math.max(1, Math.round(ms / 60000)) + "m left";
};

async function orgInviteSheet(){
  if (!orgIsOwner()) return;
  const roles = (orgS.roles || []).filter(r => r.id !== "owner");
  if (!roles.length) { toast("Create a role first — an invitation has to offer one."); return; }

  let pending = [];
  try {
    const snap = await db.collection("orgs").doc(orgS.orgId).collection("invites")
      .where("usedBy", "==", null).get();
    pending = snap.docs.map(d => Object.assign({ token: d.id }, d.data()));
  } catch (e) { console.error(e); }

  const roleOpts = roles.map(r =>
    '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>').join("");
  const pendingHtml = pending.length
    ? pending.map(inv =>
        '<div class="org-row"><span class="org-row-main">' +
          '<b>' + esc(orgRoleName(inv.roleId)) + '</b>' +
          '<small>' + esc(orgInviteLeft(inv)) + '</small></span>' +
        '<button type="button" class="org-btn org-btn-sm" data-copy="' + esc(inv.token) + '">Copy</button>' +
        '<button type="button" class="org-btn org-btn-sm org-btn-danger" data-revoke="' + esc(inv.token) + '">Revoke</button>' +
        '</div>').join("")
    : '<p class="org-note">No open invitations.</p>';

  openSheet(
    '<h3 class="sheet-title">Invite someone</h3>' +
    '<p class="org-note">A link that seats whoever opens it, once, at the role you pick. It stops working after 24 hours.</p>' +
    '<label class="org-field"><span>Role they join as</span>' +
      '<select id="orgInviteRole">' + roleOpts + '</select></label>' +
    '<div class="org-actions"><button type="button" class="org-btn" id="orgInviteMint">Create invitation link</button></div>' +
    '<div class="org-sec-head" style="margin-top:22px"><h3>Open invitations</h3></div>' +
    '<div class="org-list" id="orgInviteList">' + pendingHtml + '</div>',
    () => {
      $("orgInviteMint").onclick = orgMintInvite;
      $("orgInviteList").querySelectorAll("[data-copy]").forEach(b =>
        b.onclick = () => orgCopyInvite(b.dataset.copy));
      $("orgInviteList").querySelectorAll("[data-revoke]").forEach(b =>
        b.onclick = () => orgRevokeInvite(b.dataset.revoke));
    }
  );
}

async function orgCopyInvite(token){
  const ok = await copyText(orgInviteLink(orgS.orgId, token));
  toast(ok ? "Invitation link copied." : "Could not copy the link.");
}

async function orgMintInvite(){
  const roleId = $("orgInviteRole").value;
  const btn = $("orgInviteMint");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const ref = db.collection("orgs").doc(orgS.orgId).collection("invites").doc();
    await ref.set({
      roleId, createdBy: orgUid(), createdAt: Date.now(),
      expiresAt: Date.now() + ORG_INVITE_TTL, usedBy: null, usedAt: null
    });
    await orgCopyInvite(ref.id);
    orgInviteSheet();   // reopen so the new link shows in the list
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Create invitation link";
    toast("Could not create the invitation.");
  }
}

async function orgRevokeInvite(token){
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("invites").doc(token).delete();
    toast("Invitation revoked.");
    orgInviteSheet();
  } catch (e) { console.error(e); toast("Could not revoke the invitation."); }
}

/* ---------- taking a seat ----------
   Runs once at boot for everyone, because a person clicking an invite
   link lands on the dashboard, not on this page. Silent unless the URL
   actually carries an invitation. */
async function orgTryJoin(){
  const q = new URLSearchParams(location.search);
  const token = q.get("join"), orgId = q.get("org");
  if (!token || !orgId) return;
  // the params are spent whatever happens next: leaving them in the URL
  // means a refresh re-runs a join that already succeeded or already failed
  const clean = location.origin + location.pathname + location.hash;
  history.replaceState(null, "", clean);

  const uid = orgUid();
  if (!uid) return;
  try {
    const ptr = await db.collection("memberOf").doc(uid).get();
    if (ptr.exists && ptr.data().orgId && ptr.data().orgId !== orgId) {
      toast("You already belong to an organization.");
      return;
    }
    const invRef = db.collection("orgs").doc(orgId).collection("invites").doc(token);
    const inv = await invRef.get();
    if (!inv.exists) { toast("That invitation link is not valid."); return; }
    const d = inv.data();
    if (d.usedBy) { toast("That invitation has already been used."); return; }
    if ((d.expiresAt || 0) <= Date.now()) { toast("That invitation has expired."); return; }

    // the seat NAMES the token - that is what the rules check, and it is
    // why a holder cannot claim a role the invitation never offered
    await db.collection("orgs").doc(orgId).collection("members").doc(uid).set({
      uid, roleId: d.roleId, invite: token, joinedAt: Date.now()
    });
    // burn it, then point ourselves at the org. If burning fails the seat
    // still stands - a taken seat with a live token is untidy, not unsafe,
    // since the rules refuse a second seat for the same person anyway.
    try { await invRef.update({ usedBy: uid, usedAt: Date.now() }); } catch (e) { console.error(e); }
    await db.collection("memberOf").doc(uid).set({ orgId, at: Date.now() });
    toast("You have joined the organization.");
  } catch (e) {
    console.error(e);
    toast("Could not accept that invitation.");
  }
}

/* An import can take a while and must not be startable twice at once -
   a second run mid-flight would read a half-written picture of what is
   already there and duplicate the rest. The button disables itself and
   says what it is doing. */
async function orgRunImport(kind, btn){
  const was = btn.querySelector(".org-row-go").textContent;
  btn.disabled = true;
  btn.querySelector(".org-row-go").textContent = "Working…";
  const r = kind === "chain" ? await itemsImportChains() : await itemsImport(kind);
  btn.disabled = false;
  btn.querySelector(".org-row-go").textContent = was;
  if (!r.ok) {
    toast(r.error === "read-failed" ? "Could not read the existing work."
        : r.error === "type-failed" ? "Could not create the work type."
        : "Could not finish the import.");
    return;
  }
  const bits = [];
  if (r.created) bits.push(r.created + " brought across");
  if (r.skipped) bits.push(r.skipped + " already here");
  if (r.refused) bits.push(r.refused + " skipped");
  toast(bits.length ? bits.join(", ") + "." : "Nothing to bring across.");
  if (r.refused && r.details && r.details.length) console.warn("Rows the import refused:", r.details);
  enterOrgPage();
}

/* ============================================================
   WORK TYPES — the schema an org designs for itself. This is the
   screen that decides whether "fits any industry" is true: a
   restaurant builds Shift Swap here, a studio builds Video, and
   neither costs a line of application code.

   The builder edits a DRAFT and writes it whole. Field definitions
   are order-sensitive (a form reads top to bottom), so they live in
   an array and move by index rather than by sort key - the simplest
   thing that keeps what the designer sees and what the form renders
   the same list.
   ============================================================ */

let orgTypeDraft = null;   // { id, name, statuses[], fields[] } while a sheet is open

const ORG_TYPE_LABEL = {
  text: "Short text", longtext: "Long text", number: "Number", money: "Money",
  date: "Date", select: "Choice", multiselect: "Several choices", user: "Person",
  checkbox: "Yes / no", url: "Link", file: "File"
};
// the types whose meaning IS a fixed list of answers - only these ask for options
const ORG_TYPE_HAS_OPTIONS = ["select", "multiselect"];

async function orgTypeSheet(type){
  orgTypeDraft = type
    ? JSON.parse(JSON.stringify(type))
    : { id: null, name: "", statuses: [{ key: "open", label: "Open" }, { key: "done", label: "Done" }], fields: [] };
  if (!orgTypeDraft.statuses || !orgTypeDraft.statuses.length)
    orgTypeDraft.statuses = [{ key: "open", label: "Open" }];
  orgTypeDraft.fields = orgTypeDraft.fields || [];

  openSheet(
    '<h3 class="sheet-title">' + (type ? "Edit work type" : "New work type") + '</h3>' +
    '<label class="org-field"><span>Name</span>' +
      '<input id="orgTypeName" type="text" maxlength="40" value="' + esc(orgTypeDraft.name) + '" placeholder="Shift swap"></label>' +
    '<p class="org-note">Statuses are the stages this work moves through, in order. The first one is where new work starts.</p>' +
    '<label class="org-field"><span>Statuses, one per line</span>' +
      '<textarea id="orgTypeStatuses" rows="4">' + esc(orgTypeDraft.statuses.map(s => s.label || s.key).join("\n")) + '</textarea></label>' +
    '<div class="org-sec-head" style="margin-top:18px"><h3>Fields</h3>' +
      '<button type="button" class="org-btn org-btn-sm" id="orgTypeAddField">Add field</button></div>' +
    '<div id="orgTypeFields" class="org-list"></div>' +
    '<div class="org-actions">' +
      '<button type="button" class="org-btn" id="orgTypeSave">' + (type ? "Save type" : "Create type") + '</button>' +
      (type ? '<button type="button" class="org-btn org-btn-danger" id="orgTypeDelete">Delete</button>' : '') +
    '</div>',
    () => {
      orgTypeRenderFields();
      $("orgTypeAddField").onclick = () => {
        orgTypeReadFields();
        orgTypeDraft.fields.push({ key: "", label: "", type: "text", required: false, options: [] });
        orgTypeRenderFields();
      };
      $("orgTypeSave").onclick = orgTypeSave;
      if (type && $("orgTypeDelete")) $("orgTypeDelete").onclick = () => orgTypeDelete(type);
    }
  );
}

function orgTypeRenderFields(){
  const box = $("orgTypeFields");
  if (!box) return;
  box.innerHTML = orgTypeDraft.fields.length
    ? orgTypeDraft.fields.map((f, i) => {
        const opts = Object.keys(ORG_TYPE_LABEL).map(k =>
          '<option value="' + k + '"' + (k === f.type ? " selected" : "") + '>' + esc(ORG_TYPE_LABEL[k]) + '</option>').join("");
        return '<div class="org-fieldrow" data-i="' + i + '">' +
          '<input class="oft-label" type="text" maxlength="40" placeholder="Field name" value="' + esc(f.label || "") + '">' +
          '<select class="oft-type">' + opts + '</select>' +
          (ORG_TYPE_HAS_OPTIONS.indexOf(f.type) >= 0
            ? '<input class="oft-options" type="text" placeholder="Choices, comma separated" value="' + esc((f.options || []).join(", ")) + '">'
            : '') +
          '<label class="oft-req"><input type="checkbox" class="oft-required"' + (f.required ? " checked" : "") + '> Required</label>' +
          '<button type="button" class="org-btn org-btn-sm org-btn-danger oft-del">Remove</button>' +
          '</div>';
      }).join("")
    : '<p class="org-note">No fields yet. A type with no fields still works — it just has a title and a status.</p>';

  box.querySelectorAll(".oft-del").forEach(b => b.onclick = () => {
    orgTypeReadFields();
    orgTypeDraft.fields.splice(Number(b.closest(".org-fieldrow").dataset.i), 1);
    orgTypeRenderFields();
  });
  // changing the type can add or remove the options input, so the rows are
  // re-rendered - reading first keeps every other half-typed edit alive
  box.querySelectorAll(".oft-type").forEach(sel => sel.onchange = () => {
    orgTypeReadFields();
    orgTypeRenderFields();
  });
}

/* Pull what is on screen back into the draft. Called before any
   re-render, because the rows ARE the state while a sheet is open. */
function orgTypeReadFields(){
  const box = $("orgTypeFields");
  if (!box) return;
  box.querySelectorAll(".org-fieldrow").forEach(row => {
    const i = Number(row.dataset.i);
    const f = orgTypeDraft.fields[i];
    if (!f) return;
    f.label = row.querySelector(".oft-label").value.trim();
    f.type = row.querySelector(".oft-type").value;
    f.required = row.querySelector(".oft-required").checked;
    const optEl = row.querySelector(".oft-options");
    f.options = optEl
      ? optEl.value.split(",").map(x => x.trim()).filter(Boolean)
      : [];
  });
}

// a key is derived from the label once and then FROZEN: it is what stored
// values and facets are keyed by, so renaming "Priority" to "Urgency"
// must not orphan every value already written under the old key
const orgTypeKeyFor = (label, taken) => {
  let base = itemSlug(label).replace(/-/g, "_") || "field";
  let key = base, n = 2;
  while (taken.indexOf(key) >= 0) key = base + "_" + (n++);
  return key;
};

async function orgTypeSave(){
  orgTypeReadFields();
  const name = ($("orgTypeName").value || "").trim();
  if (name.length < 2) { toast("Give the type a name first."); return; }

  const statuses = ($("orgTypeStatuses").value || "").split("\n")
    .map(x => x.trim()).filter(Boolean)
    .map(label => ({ key: itemSlug(label), label }));
  if (!statuses.length) { toast("A type needs at least one status."); return; }

  const taken = [];
  const fields = [];
  for (const f of orgTypeDraft.fields) {
    if (!f.label) { toast("Every field needs a name."); return; }
    if (ORG_TYPE_HAS_OPTIONS.indexOf(f.type) >= 0 && !(f.options || []).length) {
      toast('"' + f.label + '" is a choice field, so it needs some choices.'); return;
    }
    const key = f.key || orgTypeKeyFor(f.label, taken);
    taken.push(key);
    fields.push({ key, label: f.label, type: f.type, required: !!f.required, options: f.options || [] });
  }

  const btn = $("orgTypeSave");
  btn.disabled = true; btn.textContent = "Saving…";
  const r = await itemTypeSave({ id: orgTypeDraft.id, name, statuses, fields });
  if (!r.ok) { btn.disabled = false; btn.textContent = "Save type"; toast("Could not save the type."); return; }
  closeSheet();
  toast(orgTypeDraft.id ? "Type saved." : "Type created.");
  enterOrgPage();
}

async function orgTypeDelete(type){
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("itemTypes").doc(type.id).delete();
    closeSheet();
    toast("Type deleted. Work already created with it is untouched.");
    enterOrgPage();
  } catch (e) { console.error(e); toast("Could not delete the type."); }
}

/* ============================================================
   SEATING AN EXISTING TEAM.

   The invite link is right for a new person and wrong for a team
   that already has accounts: nobody is going to send twelve links
   to twelve people who have been signing in for months. This
   seats them all from the roster that already exists.

   Roles are mapped from what they already are, not guessed: an
   admin becomes a Manager, a worker becomes Staff, and whoever
   founded the org stays its Owner. Anyone still 'pending' is
   skipped - they are not a member of the team yet, and an import
   is not the place to decide that they should be.

   Additive and safe to run twice: somebody already seated keeps
   the role they have, because an owner may since have changed it
   deliberately and a re-run must not undo that.
   ============================================================ */

const ORG_ROLE_FOR = role => (role === "admin" ? "manager" : "staff");

async function orgSeatTeam(btn){
  if (!orgIsOwner()) return;
  const label = btn.querySelector(".org-row-go");
  const was = label.textContent;
  btn.disabled = true; label.textContent = "Working…";

  let seated = 0, already = 0, skipped = 0;
  try {
    const snap = await db.collection("users").get();
    const seatedIds = new Set((orgS.members || []).map(m => m.uid));
    const roleIds = new Set((orgS.roles || []).map(r => r.id));

    const batch = db.batch();
    let n = 0;
    snap.forEach(doc => {
      const u = doc.data() || {};
      if (u.role !== "admin" && u.role !== "worker") { skipped++; return; }
      if (seatedIds.has(doc.id)) { already++; return; }
      let roleId = ORG_ROLE_FOR(u.role);
      // a role the org does not have would seat someone permissionless,
      // which looks like a bug to them and reads as one to an admin
      if (!roleIds.has(roleId)) roleId = roleIds.has("staff") ? "staff" : (orgS.roles[0] || {}).id;
      if (!roleId) { skipped++; return; }
      batch.set(db.collection("orgs").doc(orgS.orgId).collection("members").doc(doc.id),
        { uid: doc.id, roleId, joinedAt: Date.now(), seatedBy: orgUid() });
      seated++; n++;
    });
    if (n) await batch.commit();
  } catch (e) {
    console.error(e);
    btn.disabled = false; label.textContent = was;
    toast("Could not read the team roster.");
    return;
  }

  btn.disabled = false; label.textContent = was;
  const bits = [];
  if (seated) bits.push(seated + " seated");
  if (already) bits.push(already + " already here");
  if (skipped) bits.push(skipped + " skipped");
  toast(bits.length ? bits.join(", ") + "." : "Nobody to seat.");
  enterOrgPage();
}

/* ============================================================
   AUTOMATIONS — the screen where an org writes its own rules.

   Deliberately one trigger, one optional condition, one action.
   The data model holds many of each and the engine plans them
   all, but a first rule somebody can actually reason about beats
   a builder that can express anything and is understood by
   nobody. Widening this is a UI change, not a model change.
   ============================================================ */

const ORG_TRIGGERS = [
  { verb: "item.created",        label: "work is created" },
  { verb: "item.status_changed", label: "its status changes" },
  { verb: "item.assigned",       label: "it is assigned to someone" },
  { verb: "item.updated",        label: "it is edited" }
];
const ORG_AUTO_ACTIONS = [
  { kind: "notify",     label: "Notify people" },
  { kind: "set_status", label: "Move it to a status" },
  { kind: "assign",     label: "Assign it to someone" },
  { kind: "set_field",  label: "Set a field" }
];

async function orgAutomationsLoad(){
  try {
    const snap = await db.collection("orgs").doc(orgS.orgId).collection("automations").get();
    return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  } catch (e) { console.error(e); return []; }
}

const orgAutoSummary = a => {
  const t = ORG_TRIGGERS.find(x => x.verb === (a.trigger || {}).verb);
  const act = ((a.actions || [])[0] || {}).kind;
  const al = (ORG_AUTO_ACTIONS.find(x => x.kind === act) || {}).label || act || "do nothing";
  return "When " + (t ? t.label : "something happens") + " → " + al.toLowerCase();
};

/* ---------- a person ---------- */

const orgInitial = t => (((t || "?").trim().charAt(0)) || "?").toUpperCase();

/* Somebody's profile: who they are, what they hold, and the two things
   an owner actually wants from a roster - move them, or remove them.

   Changing a role lives HERE, on the person, rather than as a control on
   the roster row: it is a decision about somebody, not a line item, and
   it deserves the pause of opening their card. It also closes a real
   dead end - orgDeleteRole refuses to delete a role somebody still holds
   and tells you to "move them first", which until now was advice with
   nowhere to go. */
function orgMemberSheet(m){
  if (!m) return;
  const owner = orgIsOwner();
  const person = (orgS.dir || {})[m.uid] || {};
  const name = orgPersonName(m.uid);
  const ownerSeat = m.roleId === "owner";
  const isSelf = m.uid === orgUid();
  /* "owner" is deliberately not offered. A second owner is something you
     should have to mean, not something you reach by mistapping a list -
     and the org document's ownerUid, which the founding seat trusts, is
     frozen either way. */
  const roles = (orgS.roles || []).filter(r => r.id !== "owner");
  const joined = m.joinedAt
    ? new Date(m.joinedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "";

  const fact = (label, value) => value
    ? '<div class="org-fact"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>' : "";

  const canEdit = owner && !ownerSeat && roles.length > 0;

  openSheet(
    '<div class="org-person">' +
      '<span class="org-person-av">' + esc(orgInitial(name)) + '</span>' +
      '<div class="org-person-id">' +
        '<h3 class="sheet-title">' + esc(name) + '</h3>' +
        (person.email ? '<p>' + esc(person.email) + '</p>' : '') +
      '</div>' +
    '</div>' +
    '<div class="org-facts">' +
      fact("Role", orgRoleName(m.roleId)) +
      fact("Joined", joined) +
      fact("Craft", person.craft) +
      fact("This is you", isSelf ? "Yes" : "") +
    '</div>' +
    (canEdit
      ? '<label class="org-field"><span>Role</span><select id="omRole">' +
          roles.map(r => '<option value="' + esc(r.id) + '"' +
            (r.id === m.roleId ? " selected" : "") + '>' + esc(r.name) + '</option>').join("") +
        '</select></label>' +
        '<p class="org-note">A role is what the rules mean by "tell the managers" — moving someone changes what reaches them, immediately.</p>' +
        '<div class="org-actions">' +
          '<button type="button" class="org-btn" id="omSave">Save role</button>' +
          (isSelf ? "" : '<button type="button" class="org-btn org-btn-danger" id="omRemove">Remove from organization</button>') +
        '</div>'
      : '<p class="org-note">' + esc(
          ownerSeat ? "The owner's role is fixed — the whole organization hangs from it."
          : !owner   ? "Only an owner can change roles."
          : "Create a role first — there is nothing to move anyone to.") + '</p>'),
    () => {
      if ($("omSave")) $("omSave").onclick = () => orgMemberSaveRole(m);
      if ($("omRemove")) $("omRemove").onclick = () => orgMemberRemove(m, $("omRemove"));
    });
}

async function orgMemberSaveRole(m){
  const roleId = $("omRole").value;
  if (!roleId || roleId === m.roleId) { closeSheet(); return; }
  // read the names BEFORE the cache is dropped - afterwards there is
  // nothing to look them up in
  const who = orgPersonName(m.uid), what = orgRoleName(roleId);
  const btn = $("omSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("members").doc(m.uid).update({ roleId });
    orgInvalidate();
    closeSheet();
    toast(who + " is now " + what + ".");
    enterOrgPage();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Save role";
    toast("Could not change their role.");
  }
}

/* Two taps, not a browser confirm(): the second tap is the confirmation,
   and it costs nothing to change your mind between them. */
async function orgMemberRemove(m, btn){
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Tap again to remove";
    return;
  }
  const who = orgPersonName(m.uid);
  btn.disabled = true; btn.textContent = "Removing…";
  try {
    /* Their seat is the truth about membership, so deleting it is the
       whole removal. Their own memberOf pointer is a document only they
       may write, so it is left dangling on purpose - orgLoad re-derives
       membership from the seats themselves and heals the pointer, which
       means they simply find themselves in no organization. */
    await db.collection("orgs").doc(orgS.orgId).collection("members").doc(m.uid).delete();
    orgInvalidate();
    closeSheet();
    toast(who + " was removed. Work they created stays.");
    enterOrgPage();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Remove from organization";
    toast("Could not remove them.");
  }
}

/* ---------- template packs ---------- */

/* THE ONBOARDING MOMENT. An empty screen asking somebody to design a
   data model before they can log anything is where most of these
   products lose people - the work is real, they just wanted to write
   it down. A pack turns that first question from "what are your
   fields?" into "what kind of place is this?", which everybody can
   answer.

   It is a starting point and the copy says so: everything a pack
   creates is an ordinary role, type or rule the moment it lands, and
   applying one never overwrites something the org already has. */
function orgPackSummary(plan){
  const bits = [];
  const n = (k, one, many) => { const c = plan[k].length; if (c) bits.push(c + " " + (c === 1 ? one : many)); };
  n("itemTypes", "kind of work", "kinds of work");
  n("roles", "role", "roles");
  n("automations", "rule", "rules");
  return bits.length ? bits.join(" · ") : "Nothing new — you already have all of it";
}

function orgPackSheet(){
  const have = {
    roleIds: (orgS.roles || []).map(r => r.id),
    typeIds: (orgS.types || []).map(t => t.id),
    automationIds: (orgS.automations || []).map(a => a.id)
  };
  const rows = PACKS.map(p => {
    const plan = packPlan(p, have);
    const nothing = !plan.roles.length && !plan.itemTypes.length && !plan.automations.length;
    return '<button type="button" class="org-row org-pack" data-pack="' + esc(p.key) + '"' +
      (nothing ? " disabled" : "") + '>' +
      '<span class="org-row-main"><b>' + esc(p.name) + '</b>' +
        '<small>' + esc(p.blurb) + '</small>' +
        '<small class="org-pack-count">' + esc(orgPackSummary(plan)) + '</small></span>' +
      (nothing ? '<span class="org-row-lock">Added</span>' : '<span class="org-row-go">Add</span>') +
      '</button>';
  }).join("");

  openSheet(
    '<h3 class="sheet-title">Start from a template</h3>' +
    '<p class="org-note">Pick whichever is closest. It sets up the kinds of work, the roles and a couple of rules to get going — then rename, delete and add whatever you like. Nothing you already have is touched.</p>' +
    '<div class="org-list">' + rows + '</div>',
    () => {
      $("sheetBody").querySelectorAll(".org-pack").forEach(b => {
        if (b.disabled) return;
        b.onclick = () => orgPackApply(b.dataset.pack, b);
      });
    });
}

async function orgPackApply(key, btn){
  const pack = packByKey(key);
  if (!pack) return;
  const go = btn.querySelector(".org-row-go");
  btn.disabled = true;
  if (go) go.textContent = "Adding…";
  const r = await itemsApplyPack(key);
  if (!r.ok) {
    btn.disabled = false;
    if (go) go.textContent = "Add";
    toast(r.error === "no-org" ? "You are not in an organization yet."
      : r.error === "invalid" ? "That template is not usable — nothing was changed."
      : "Could not add the template.");
    return;
  }
  closeSheet();
  const c = r.created;
  const made = c.itemTypes + c.roles + c.automations;
  toast(made ? pack.name + " added — " + c.itemTypes + " kinds of work, " + c.roles + " roles, " + c.automations + " rules."
             : "You already had everything in " + pack.name + ".");
  enterOrgPage();
}

async function orgAutomationSheet(rule){
  const types = orgS.types || [];
  const roles = (orgS.roles || []).filter(r => r.id !== "owner");
  const a = rule || { name: "", enabled: true, trigger: { verb: "item.created" }, conditions: [], actions: [] };
  const act = (a.actions || [])[0] || { kind: "notify" };
  const cond = (a.conditions || [])[0] || null;

  const opts = (list, val, key, label) => list.map(x =>
    '<option value="' + esc(x[key]) + '"' + (x[key] === val ? " selected" : "") + '>' + esc(x[label]) + '</option>').join("");

  openSheet(
    '<h3 class="sheet-title">' + (rule ? "Edit rule" : "New rule") + '</h3>' +
    '<label class="org-field"><span>Name</span><input id="oaName" type="text" maxlength="60" value="' +
      esc(a.name || "") + '" placeholder="Tell the leads about new swaps"></label>' +

    '<label class="org-field"><span>When</span><select id="oaVerb">' +
      opts(ORG_TRIGGERS, (a.trigger || {}).verb, "verb", "label") + '</select></label>' +
    '<label class="org-field"><span>Of this kind of work</span><select id="oaType">' +
      '<option value="">Any kind</option>' +
      types.map(t => '<option value="' + esc(t.id) + '"' +
        (t.id === (a.trigger || {}).typeId ? " selected" : "") + '>' + esc(t.name || t.id) + '</option>').join("") +
      '</select></label>' +

    '<p class="org-note">Optionally only when a field has a particular value. Leave the field blank to always run.</p>' +
    '<div class="org-fieldrow">' +
      '<input id="oaCondKey" class="oft-label" type="text" maxlength="40" placeholder="Field name" value="' +
        esc(cond ? cond.path : "") + '">' +
      '<input id="oaCondVal" class="oft-label" type="text" maxlength="60" placeholder="equals this value" value="' +
        esc(cond ? String(cond.value) : "") + '">' +
    '</div>' +

    '<label class="org-field" style="margin-top:14px"><span>Then</span><select id="oaAction">' +
      opts(ORG_AUTO_ACTIONS, act.kind, "kind", "label") + '</select></label>' +
    '<div id="oaParams"></div>' +

    '<div class="org-actions">' +
      '<button type="button" class="org-btn" id="oaSave">' + (rule ? "Save rule" : "Create rule") + '</button>' +
      (rule ? '<button type="button" class="org-btn org-btn-danger" id="oaDelete">Delete</button>' : '') +
    '</div>',
    () => {
      const paint = () => {
        const kind = $("oaAction").value;
        const box = $("oaParams");
        if (kind === "notify")
          box.innerHTML = '<label class="org-field"><span>Tell which role</span><select id="oaRole">' +
            roles.map(r => '<option value="' + esc(r.id) + '"' + (r.id === act.toRole ? " selected" : "") +
              '>' + esc(r.name) + '</option>').join("") + '</select></label>' +
            '<label class="org-field"><span>Message</span><input id="oaMsg" type="text" maxlength="140" value="' +
              esc(act.message || "") + '" placeholder="A new swap needs covering"></label>';
        else if (kind === "set_status")
          box.innerHTML = '<label class="org-field"><span>Move it to</span><input id="oaStatus" type="text" maxlength="40" value="' +
            esc(act.status || "") + '" placeholder="review"></label>' +
            '<p class="org-note">Use the status key exactly as the work type spells it.</p>';
        else if (kind === "assign")
          box.innerHTML = '<label class="org-field"><span>Assign to</span><select id="oaWho">' +
            (orgS.members || []).map(m => '<option value="' + esc(m.uid) + '"' +
              ((act.assigneeIds || []).includes(m.uid) ? " selected" : "") + '>' + esc(orgPersonName(m.uid)) + '</option>').join("") +
            '</select></label>';
        else
          box.innerHTML = '<div class="org-fieldrow">' +
            '<input id="oaFieldKey" class="oft-label" type="text" maxlength="40" placeholder="Field name" value="' + esc(act.key || "") + '">' +
            '<input id="oaFieldVal" class="oft-label" type="text" maxlength="60" placeholder="set it to" value="' + esc(act.value == null ? "" : act.value) + '">' +
            '</div>';
      };
      paint();
      $("oaAction").onchange = paint;
      $("oaSave").onclick = () => orgAutomationSave(rule);
      if (rule && $("oaDelete")) $("oaDelete").onclick = () => orgAutomationDelete(rule);
    }
  );
}

async function orgAutomationSave(rule){
  const name = ($("oaName").value || "").trim();
  if (name.length < 2) { toast("Give the rule a name first."); return; }

  const trigger = { verb: $("oaVerb").value };
  if ($("oaType").value) trigger.typeId = $("oaType").value;

  const conditions = [];
  const ck = ($("oaCondKey").value || "").trim();
  if (ck) conditions.push({ source: "field", path: ck, op: "==", value: ($("oaCondVal").value || "").trim() });

  const kind = $("oaAction").value;
  let action = null;
  if (kind === "notify") action = { kind, toRole: $("oaRole") ? $("oaRole").value : null, message: ($("oaMsg").value || "").trim() };
  else if (kind === "set_status") action = { kind, status: ($("oaStatus").value || "").trim() };
  else if (kind === "assign") action = { kind, assigneeIds: $("oaWho") ? [$("oaWho").value] : [] };
  else action = { kind, key: ($("oaFieldKey").value || "").trim(), value: ($("oaFieldVal").value || "").trim() };

  // a rule that would do nothing is worth refusing here rather than
  // letting somebody wonder later why it never seemed to fire
  if (kind === "set_status" && !action.status) { toast("Which status should it move to?"); return; }
  if (kind === "set_field" && !action.key) { toast("Which field should it set?"); return; }

  const btn = $("oaSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const id = rule ? rule.id : ("au" + orgNewId());
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(id)
      .set({ name, enabled: true, trigger, conditions, actions: [action], updatedAt: Date.now() });
    // the running app caches these; a stale cache means a rule someone
    // just wrote appears not to work until they reload
    itemsAutomationsCache = null;
    closeSheet();
    toast(rule ? "Rule saved." : "Rule created.");
    enterOrgPage();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = rule ? "Save rule" : "Create rule";
    toast("Could not save the rule.");
  }
}

async function orgAutomationDelete(rule){
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(rule.id).delete();
    itemsAutomationsCache = null;
    closeSheet();
    toast("Rule deleted.");
    enterOrgPage();
  } catch (e) { console.error(e); toast("Could not delete the rule."); }
}
