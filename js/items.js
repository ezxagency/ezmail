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

/* ============================================================
   IMPORT — today's collections, brought across as Items.

   ADDITIVE AND ONE-WAY. Nothing is deleted, nothing is rewritten,
   and neither the assign composer nor the campaigns page changes
   behaviour: they keep reading their own collections exactly as
   before. That ordering is the whole safety story - the data
   moves first and gets proven, and only then does any UI switch
   over. Doing both at once means a bug in either looks like a bug
   in both, on a live team's working day.

   SAFE TO RUN TWICE. Item ids are derived from the source
   document (js/migrate.js), so a second run finds the same ids
   already present and skips them. It never makes a second copy of
   somebody's work, and it never overwrites edits made to an item
   after it was imported.
   ============================================================ */

const IMPORT_BATCH = 400;   // Firestore caps a batch at 500; leave room for the events

/* Which of these ids already exist, as one query rather than one read
   per row - a per-row existence check on a few hundred rows is a few
   hundred round trips and a bill to match. */
async function itemsExistingIds(orgId, typeId){
  const snap = await itemsCol(orgId).where("facets", "array-contains", "type:" + itemSlug(typeId)).limit(2000).get();
  return new Set(snap.docs.map(d => d.id));
}

/* kind: "assignment" | "campaign".
   Returns { created, skipped, refused, details } - refusals are counted
   and reported rather than thrown, because one malformed row from years
   ago must not stop the other three hundred from coming across. */
async function itemsImport(kind){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };

  const isTask = kind === "assignment";
  const baseType = isTask ? MIGRATE_TASK_TYPE : MIGRATE_CAMPAIGN_TYPE;
  const optionKeys = isTask ? ["store", "task"] : ["stage"];
  const toIntent = isTask ? migrateAssignmentIntent : migrateCampaignIntent;

  let rows;
  try {
    const snap = await db.collection(isTask ? "assignments" : "campaigns").get();
    rows = snap.docs.map(d => Object.assign({ __id: d.id }, d.data()));
  } catch (e) { console.error(e); return { ok: false, error: "read-failed" }; }
  if (!rows.length) return { ok: true, created: 0, skipped: 0, refused: 0, details: [] };

  // The choice fields have to fit the data BEFORE any row is written, or
  // the engine refuses every value it has never been told about. The
  // type is grown from the rows themselves and saved first.
  const optionRows = isTask ? rows : rows.map(c => ({ stage: ((c.stages || [])[c.cur] || {}).name || "" }));
  const type = migrateTypeWithOptions(baseType, optionRows, optionKeys);
  const saved = await itemTypeSave(type);
  if (!saved.ok) return { ok: false, error: "type-failed" };
  type.id = saved.id;

  const already = await itemsExistingIds(s.orgId, type.id);
  const actor = { uid: auth.currentUser.uid, orgId: s.orgId };
  const perms = await itemActorPermissions();
  const allow = (r, a, c) => permCan(perms, r, a, c);

  let created = 0, skipped = 0, refused = 0;
  const details = [];
  let batch = db.batch(), inBatch = 0;

  for (const row of rows) {
    const id = migrateItemId(kind, row.__id);
    if (already.has(id)) { skipped++; continue; }

    const intent = toIntent(row);
    const decision = itemCommit({ type, item: null, intent, actor, allow,
      now: intent.createdAt || Date.now(), id });
    if (!decision.ok) {
      refused++;
      if (details.length < 5) details.push(row.__id + ": " + decision.error);
      continue;
    }
    // the source is recorded ON the item, so a row can always be traced
    // back to the document it came from long after this run is forgotten
    const doc = Object.assign({}, decision.item, { id, importedFrom: migrateSource(kind, row.__id) });
    batch.set(itemsCol(s.orgId).doc(id), doc);
    decision.events.forEach(ev => batch.set(eventsCol(s.orgId).doc(), ev));
    created++;
    inBatch++;

    if (inBatch >= IMPORT_BATCH) {
      try { await batch.commit(); } catch (e) { console.error(e); return { ok: false, error: "write-failed", created, skipped, refused }; }
      batch = db.batch(); inBatch = 0;
    }
  }
  if (inBatch) {
    try { await batch.commit(); } catch (e) { console.error(e); return { ok: false, error: "write-failed", created, skipped, refused }; }
  }
  return { ok: true, created, skipped, refused, details };
}

/* Saved campaign chains, brought across as workflow blueprints.

   They arrive as DRAFTS on purpose. A chain that has been passing work
   between real people for months still deserves a look before anyone
   rides it as a workflow - and publishing is where the engine's own
   validation runs anyway. Same idempotency as the item import: the id
   is derived from the template, so a second run skips what it made. */
async function itemsImportChains(){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };

  let rows;
  try {
    const snap = await db.collection("campaignTemplates").get();
    rows = snap.docs.map(d => Object.assign({ __id: d.id }, d.data()));
  } catch (e) { console.error(e); return { ok: false, error: "read-failed" }; }
  if (!rows.length) return { ok: true, created: 0, skipped: 0, refused: 0, details: [] };

  const uid = auth.currentUser.uid;
  let created = 0, skipped = 0, refused = 0;
  const details = [];

  for (const row of rows) {
    const id = migrateItemId("chain", row.__id);
    const ref = db.collection("blueprints").doc(id);
    try {
      if ((await ref.get()).exists) { skipped++; continue; }
    } catch (e) { console.error(e); refused++; continue; }

    const bp = migrateCampaignBlueprint(
      { title: row.name, stages: row.stages },
      { id, orgId: s.orgId, ownerId: uid, now: Date.now() }
    );
    // a chain with no stages is not a workflow; saying so beats writing
    // an empty blueprint nobody can publish and nobody can explain
    if (!bp) { refused++; if (details.length < 5) details.push(row.__id + ": no stages"); continue; }

    try { await ref.set(bp); created++; }
    catch (e) { console.error(e); refused++; if (details.length < 5) details.push(row.__id + ": write failed"); }
  }
  return { ok: true, created, skipped, refused, details };
}

/* ============================================================
   MIRRORING — keeping the Item model current as work happens.

   The one-time import brings history across; without this, that
   history goes stale the moment somebody assigns anything new.
   So the composer writes its rows as it always has AND mirrors
   them here, using the same derived ids the import uses - which
   is what makes the two agree instead of racing.

   THE RULE THIS FILE OBEYS: mirroring must never break assigning.
   By the time any of it runs the assignment has already committed
   and the person has already been told it worked. A failure here
   is this feature's problem, not theirs, so everything is wrapped
   and nothing is re-thrown. A silently missing mirror row is
   recoverable - the import will pick it up. A composer that threw
   after successfully assigning work is not.

   Reads still come from the old collections. This keeps the new
   model TRUE so that switching reads over is later a decision
   about the UI rather than a scramble to backfill.
   ============================================================ */

let itemsTaskTypeCache = null;   // per session; option growth invalidates it

/* The task type, with its choice fields grown to fit whatever is being
   mirrored. Only writes the type when a genuinely new store or task
   appears, because the common case - work at a store seen a hundred
   times before - should cost nothing. */
async function itemsEnsureTaskType(orgId, rows){
  let type = itemsTaskTypeCache;
  if (!type) {
    const doc = await typesCol(orgId).doc(MIGRATE_TASK_TYPE.id).get();
    type = doc.exists ? Object.assign({ id: doc.id }, doc.data())
                      : migrateTypeWithOptions(MIGRATE_TASK_TYPE, rows, ["store", "task"]);
    if (!doc.exists) { await itemTypeSave(type); type.id = MIGRATE_TASK_TYPE.id; }
  }
  let grew = false;
  // a type saved before a field existed must gain it, or the adapter
  // reads a value the type never lets anyone write. Silent otherwise.
  (MIGRATE_TASK_TYPE.fields || []).forEach(def => {
    if (!(type.fields || []).some(f => f.key === def.key)) {
      type.fields = (type.fields || []).concat(Object.assign({}, def));
      grew = true;
    }
  });
  ["store", "task"].forEach(key => {
    const f = (type.fields || []).find(x => x.key === key);
    if (!f) return;
    rows.forEach(r => {
      const v = (r[key] || "").trim();
      if (v && !(f.options || []).some(o => o.toLowerCase() === v.toLowerCase())) {
        f.options = (f.options || []).concat(v).sort((a, b) => a.localeCompare(b));
        grew = true;
      }
    });
  });
  if (grew) await itemTypeSave(type);
  itemsTaskTypeCache = type;
  return type;
}

/* written: [{ id, row }] - the assignment ids just committed, with the
   documents that were written to them. */
async function itemsMirrorAssignments(written){
  if (!written || !written.length) return;
  try {
    const s = await orgEnsure();
    if (!s) return;                       // no org yet: nothing to mirror into
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return;

    const rows = written.map(w => w.row);
    const type = await itemsEnsureTaskType(s.orgId, rows);
    const perms = await itemActorPermissions();
    const allow = (r, a, c) => permCan(perms, r, a, c);
    const actor = { uid, orgId: s.orgId };

    const batch = db.batch();
    let n = 0;
    written.forEach(w => {
      const id = migrateItemId("assignment", w.id);
      const decision = itemCommit({ type, item: null, intent: migrateAssignmentIntent(w.row),
        actor, allow, now: w.row.createdAt || Date.now(), id });
      if (!decision.ok) { console.warn("mirror refused", w.id, decision.error, decision.details); return; }
      batch.set(itemsCol(s.orgId).doc(id), Object.assign({}, decision.item, { id, importedFrom: migrateSource("assignment", w.id) }));
      decision.events.forEach(ev => batch.set(eventsCol(s.orgId).doc(), ev));
      n++;
    });
    if (n) await batch.commit();
  } catch (e) {
    // deliberately swallowed - see the header
    console.warn("Could not mirror assignments into Items:", e);
  }
}

/* A row finishing (or being un-finished) moves its mirror's status, so
   the two do not drift apart the first time somebody ticks something
   off. Same swallow: the real row has already changed. */
async function itemsMirrorAssignmentStatus(assignmentId, done){
  try {
    const s = await orgEnsure();
    if (!s) return;
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return;
    const id = migrateItemId("assignment", assignmentId);
    const ref = itemsCol(s.orgId).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return;             // never mirrored; the import will catch it
    const item = Object.assign({ id: snap.id }, snap.data());
    const type = await itemsEnsureTaskType(s.orgId, []);
    const perms = await itemActorPermissions();
    const decision = itemCommit({ type, item, intent: { kind: "set_status", status: done ? "done" : "open" },
      actor: { uid, orgId: s.orgId }, allow: (r, a, c) => permCan(perms, r, a, c), now: Date.now() });
    if (!decision.ok || !decision.events.length) return;
    const batch = db.batch();
    batch.set(ref, Object.assign({}, decision.item, { id }));
    decision.events.forEach(ev => batch.set(eventsCol(s.orgId).doc(), ev));
    await batch.commit();
  } catch (e) {
    console.warn("Could not mirror a status change into Items:", e);
  }
}
