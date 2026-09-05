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
  const uid = orgUid();
  if (!uid) return null;
  const ptr = await db.collection("memberOf").doc(uid).get();
  const orgId = ptr.exists ? ptr.data().orgId : null;
  if (!orgId) return null;

  const orgDoc = await db.collection("orgs").doc(orgId).get();
  // the pointer outlived the membership (removed from the org, or it was
  // never real): treat it as no org rather than an error the user can't act on
  if (!orgDoc.exists) return null;

  const [memSnap, roleSnap, dirRows] = await Promise.all([
    db.collection("orgs").doc(orgId).collection("members").get(),
    db.collection("orgs").doc(orgId).collection("roles").get(),
    // the roster stores uids; names live in the directory every signed-in
    // account may already read, so being polite costs no new permission
    loadDirectory()
  ]);
  const dir = {};
  (dirRows || []).forEach(r => { dir[r.uid] = r; });
  const members = memSnap.docs.map(d => Object.assign({ uid: d.id }, d.data()));
  const roles = roleSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  const me = members.find(m => m.uid === uid);
  return { orgId, org: orgDoc.data(), members, roles, dir, myRoleId: me ? me.roleId : null };
}

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
      roleId: "owner", joinedAt: Date.now()
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

  const membersHtml = (orgS.members || [])
    .map(m => '<div class="org-row"><span class="org-row-main"><b>' + esc(orgPersonName(m.uid)) + '</b>' +
      '<small>' + esc(orgRoleName(m.roleId)) + '</small></span></div>').join("");

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
      '<div class="org-sec-head"><h3>People<span class="org-count">' + (orgS.members || []).length + '</span></h3>' +
        (owner ? '<button type="button" class="org-btn org-btn-sm" id="orgInviteBtn">Invite</button>' : '') +
      '</div>' +
      '<div class="org-list">' + membersHtml + '</div>' +
    '</section>';

  if (owner && $("orgAddRole")) $("orgAddRole").onclick = () => orgRoleSheet(null);
  if (owner && $("orgInviteBtn")) $("orgInviteBtn").onclick = () => orgInviteSheet();
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
      roleId: d.roleId, invite: token, joinedAt: Date.now()
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
