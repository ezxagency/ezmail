/* ============================================================
   ITEMS — Firestore glue for the work model.

   Deliberately dumb, and that is the design. It loads what the
   decision needs, hands it to itemCommit() in js/item-engine.js,
   and writes back whatever comes out. Every rule about what MAY
   happen lives in the engine; nothing here decides anything.

   That is what makes phase 3 cheap: when itemCommit() moves into
   a Cloud Function, only the middle of itemSave() changes - it
   stops calling the engine locally and starts calling the server.
   The callers, the UI and the engine all stay exactly as they are.
   Anything clever added to this file makes that move expensive, so
   nothing clever goes in this file.

   Everything lives UNDER the org (orgs/{orgId}/items, /events,
   /itemTypes) because tenancy is structural there: a query cannot
   cross tenants, and one membership check covers a whole listing
   no matter how many rows it returns.
   ============================================================ */

const itemsCol  = orgId => db.collection("orgs").doc(orgId).collection("items");
const eventsCol = orgId => db.collection("orgs").doc(orgId).collection("events");
const typesCol  = orgId => db.collection("orgs").doc(orgId).collection("itemTypes");

const itemNewId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* The signed-in person's permission rows, resolved through the org they
   belong to. Returns [] when anything is missing, which denies rather
   than allows - the safe direction for an answer we could not compute. */
async function itemActorPermissions(){
  const s = await orgEnsure();
  if (!s || !s.myRoleId) return [];
  const role = (s.roles || []).find(r => r.id === s.myRoleId);
  return role ? (role.permissions || []) : [];
}

/* THE CHOKEPOINT'S OUTER HALF.
   intent = { kind, ...payload }; type = the ItemType; item = current or null.
   Returns exactly what the engine returned, so callers read one shape
   whether the refusal came from permissions, validation or the network. */
async function itemSave(type, item, intent){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  const uid = auth.currentUser ? auth.currentUser.uid : null;
  if (!uid) return { ok: false, error: "no-actor" };

  // THE SWAP THE CHOKEPOINT WAS BUILT FOR. Everything above and below
  // this line is unchanged whichever way it goes: same arguments in, same
  // { ok, item, events } out, so work.js never learns where the decision
  // was made. That was the whole claim in phase 2, and this is it being
  // true rather than asserted.
  if (CONFIG.serverCommit) return itemSaveViaServer(s.orgId, type, item, intent);

  const perms = await itemActorPermissions();
  const decision = itemCommit({
    type, item, intent,
    actor: { uid, orgId: s.orgId },
    allow: (resource, action, ctx) => permCan(perms, resource, action, ctx),
    now: Date.now(),
    id: item ? item.id : itemNewId()
  });
  if (!decision.ok) return decision;

  // A no-op decided nothing, so it writes nothing - not even an
  // updatedAt. Churn that reaches the database is churn every watcher,
  // every automation and every audit reader has to learn to ignore.
  if (!decision.events.length && decision.item === item) return decision;

  try {
    const batch = db.batch();
    const id = (decision.item && decision.item.id) || (item && item.id);
    if (decision.item === null) batch.delete(itemsCol(s.orgId).doc(id));
    else batch.set(itemsCol(s.orgId).doc(id), Object.assign({}, decision.item, { id }));
    // the item and its events land together or not at all: an event
    // describing a change that did not happen is worse than no log
    decision.events.forEach(ev => batch.set(eventsCol(s.orgId).doc(), ev));
    await batch.commit();
    return decision;
  } catch (e) {
    console.error(e);
    return { ok: false, error: "write-failed" };
  }
}

/* Send the intent to the server and hand back exactly the shape the local
   path returns. The mapping matters: the engine's own vocabulary has to
   survive the round trip, or every caller needs a second set of error
   branches for the server case - and the ones that got it wrong would
   only show up in production. */
async function itemSaveViaServer(orgId, type, item, intent){
  try {
    const call = firebase.app().functions("us-central1").httpsCallable("commitItem");
    const res = await call({ orgId, typeId: type.id, itemId: item ? item.id : null, intent });
    return res.data;
  } catch (e) {
    const msg = (e && e.message) || "";
    // "invalid" carries the per-field problems the form paints, so it is
    // passed through rather than flattened into a generic failure
    if (msg === "invalid") return { ok: false, error: "invalid", details: (e && e.details) || [] };
    if (e && e.code === "functions/permission-denied") return { ok: false, error: "denied" };
    if (msg === "unknown-status" || msg === "unknown-intent") return { ok: false, error: msg };
    console.error(e);
    return { ok: false, error: "write-failed" };
  }
}

/* ---------- reads ---------- */

async function itemTypesLoad(){
  const s = await orgEnsure();
  if (!s) return [];
  const snap = await typesCol(s.orgId).get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

async function itemTypeSave(type){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  const id = type.id || ("t" + itemNewId());
  await typesCol(s.orgId).doc(id).set({
    name: type.name, icon: type.icon || null, color: type.color || null,
    fields: type.fields || [], statuses: type.statuses || [],
    workflowId: type.workflowId || null, updatedAt: Date.now()
  });
  return { ok: true, id };
}

/* One array-contains index serves every equality filter any customer
   ever invents - which is the whole reason facets exist. Ranges are not
   welcome here on purpose: they need real composite indexes, and those
   are the scarce thing (200 per database, 1000 billed). */
async function itemsByFacet(facet, limit){
  const s = await orgEnsure();
  if (!s) return [];
  const snap = await itemsCol(s.orgId)
    .where("facets", "array-contains", facet)
    .limit(limit || 50).get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

async function itemsRecent(limit){
  const s = await orgEnsure();
  if (!s) return [];
  const snap = await itemsCol(s.orgId).orderBy("updatedAt", "desc").limit(limit || 50).get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}
