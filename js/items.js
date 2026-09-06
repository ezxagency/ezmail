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
async function itemSave(type, item, intent, opts){
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
    // Automations run AFTER the write, on the events it produced, and
    // never block the answer the person is waiting for. A rule that
    // fails is this feature's problem; the change they made already
    // landed and they have already been told so.
    itemsRunAutomations(decision.events, decision.item, (opts && opts.depth) || 0);
    // Being handed work is news in its own right. It should not depend on
    // somebody having written a rule about it - and it did not, on the
    // Assign composer, which has always told people. The Work page not
    // doing so made the same action mean two different things depending
    // on which screen you did it from.
    itemsNotifyAssigned(decision.events, decision.item);
    // a new piece of work whose kind has a track starts travelling it
    if (intent.kind === "create" && type && type.workflowId)
      itemsStartHandoff(decision.item, type);
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
    // the track is the SOURCE an owner edits; workflowId names the
    // blueprint generated from it. Both are carried, because a set()
    // replaces the document and dropping either would quietly unhook a
    // kind of work from the pipeline it is supposed to travel.
    track: type.track || null,
    workflowId: type.workflowId || null, updatedAt: Date.now()
  });
  return { ok: true, id };
}

/* "I have finished my part", from the assigned queue.

   The queue was built when every row was an assignment document with a
   done flag. An Item has no such flag - it has a STATUS, whose vocabulary
   the type owns, and possibly a handoff whose current stop is the real
   answer to what finishing means. So this routes rather than guesses:

     on a handoff you hold  -> advance the stop. Finishing your part IS
                               passing it on, and the run decides the rest.
     type has a "done"      -> set it. The migrated task type does.
     otherwise              -> its last status, and SAY SO in the toast,
                               because moving somebody's work to a stage
                               they did not name is worth admitting.

   Returns { ok, how, status } so the caller can word the toast honestly
   instead of claiming "done" for all three. */
async function itemsFinishFromQueue(itemId, comment){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  let item, type;
  try {
    const d = await itemsCol(s.orgId).doc(itemId).get();
    if (!d.exists) return { ok: false, error: "gone" };
    item = Object.assign({ id: d.id }, d.data());
    const t = await typesCol(s.orgId).doc(item.typeId).get();
    if (!t.exists) return { ok: false, error: "no-type" };
    type = Object.assign({ id: t.id }, t.data());
  } catch (e) {
    console.error("itemsFinishFromQueue could not read the work:", e);
    return { ok: false, error: "read-failed", detail: String((e && e.code) || (e && e.message) || e) };
  }

  /* Work created before its type had a track - or before the pointer to
     the run was persisted at all - is on a tracked type with no run. Left
     alone it would be finished by status, jumping straight to the end and
     skipping every stop. Start its run instead: the same self-healing the
     org pointer and the directory already do, rather than a migration
     nobody would remember to run. */
  if (type.workflowId && !item.workflowRunId) {
    const started = await itemsStartHandoff(item, type);
    if (started) {
      const d = await itemsCol(s.orgId).doc(itemId).get();
      if (d.exists) item = Object.assign({ id: d.id }, d.data());
    }
  }

  if (item.workflowRunId) {
    const h = await itemsHandoffLoad(item);
    const uid = auth.currentUser ? auth.currentUser.uid : null;
    const stops = h ? hoActiveStops(h.nodeRuns) : [];
    const mine = stops.find(nr => hoMayAdvance(h.blueprint, nr, uid, h.members, false).ok);
    if (mine) {
      const r = await itemsAdvanceHandoff(item, type, mine.id, comment ? { comment } : {});
      return r.ok ? { ok: true, how: "advanced" } : { ok: false, error: r.error };
    }
    // on a run but not their stop: finishing it from here would jump the
    // queue past whoever actually holds it
    return { ok: false, error: "not-your-stop" };
  }

  const done = itemDoneStatus(type);
  const statuses = (type.statuses || []).map(x => x.key);
  if (!done) return { ok: false, error: "no-status" };
  if (item.status === done) return { ok: true, how: "already", status: done };
  const r = await itemSave(type, item, { kind: "set_status", status: done });
  if (!r.ok) {
    console.error("itemsFinishFromQueue could not set the status:", r);
    return { ok: false, error: r.error || "save-failed", detail: JSON.stringify(r.details || "") };
  }
  const label = (type.statuses || []).find(x => x.key === done);
  return { ok: true, how: statuses.indexOf("done") >= 0 ? "done" : "moved",
           status: (label && label.label) || done };
}

/* Undo, for the rows where undo means anything. A handoff cannot be
   un-advanced from here - the baton is already with somebody else, and
   taking it back behind their screen would be worse than making them
   pass it on. */
async function itemsUndoFromQueue(itemId, toStatus){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  try {
    const d = await itemsCol(s.orgId).doc(itemId).get();
    if (!d.exists) return { ok: false, error: "gone" };
    const item = Object.assign({ id: d.id }, d.data());
    if (item.workflowRunId) return { ok: false, error: "on-a-handoff" };
    const t = await typesCol(s.orgId).doc(item.typeId).get();
    if (!t.exists) return { ok: false, error: "no-type" };
    const type = Object.assign({ id: t.id }, t.data());
    const back = toStatus || ((type.statuses || [])[0] || {}).key;
    if (!back) return { ok: false, error: "no-status" };
    const r = await itemSave(type, item, { kind: "set_status", status: back });
    return r.ok ? { ok: true } : { ok: false, error: r.error || "save-failed" };
  } catch (e) { console.error(e); return { ok: false, error: "failed" }; }
}

/* ---------- handoff: work that moves person to person ----------
   docs/handoff-spec.md. js/handoff.js decides; this writes.

   The two halves the model has always had and never used: an ItemType
   names a blueprint, and an Item points at the run it is travelling. */

const runsCol  = orgId => db.collection("orgs").doc(orgId).collection("runs");
const bpCol    = orgId => db.collection("orgs").doc(orgId).collection("blueprints");

async function itemsBlueprintFor(orgId, type){
  if (!type || !type.workflowId) return null;
  try {
    const d = await bpCol(orgId).doc(type.workflowId).get();
    return d.exists ? Object.assign({ id: d.id }, d.data()) : null;
  } catch (e) { console.error(e); return null; }
}

/* Start the run a new Item rides, if its kind of work has a track.
   Fire-and-forget from the caller's point of view: the Item is already
   committed and the person has already been told it saved, so a failure
   to start the run must not turn that into an error they see. It leaves
   the Item run-less, which is visible and recoverable, rather than
   leaving them believing the save failed. */
async function itemsStartHandoff(item, type){
  const s = await orgEnsure();
  if (!s || !item || !type || !type.workflowId) return null;
  const bp = await itemsBlueprintFor(s.orgId, type);
  if (!bp) { console.warn("Type " + type.id + " names a blueprint that is not there:", type.workflowId); return null; }

  let started;
  try {
    started = wfStartRun({ blueprint: bp, runId: "rn" + itemNewId(), taskId: item.id,
      task: item, orgId: s.orgId, now: Date.now() });
  } catch (e) { console.error("Blueprint would not start:", e); return null; }

  try {
    // the stops live ON the run. They are always read together, they
    // belong to it, and - the reason this is not merely tidier - it is
    // what lets the advance below be a real transaction: tx.get() takes a
    // document, never a query, so stops in their own collection could
    // only ever be read OUTSIDE the transaction protecting them.
    await runsCol(s.orgId).doc(started.run.id)
      .set(Object.assign({}, started.run, { nodeRuns: started.nodeRuns }));
  } catch (e) { console.error("Could not write the run:", e); return null; }

  await itemsSyncFromRun(item, type, bp, started.run, started.nodeRuns);
  return started;
}

/* Everything the screens read about a running handoff, in one place. */
async function itemsHandoffLoad(item){
  const s = await orgEnsure();
  if (!s || !item || !item.workflowRunId) return null;
  try {
    const runDoc = await runsCol(s.orgId).doc(item.workflowRunId).get();
    if (!runDoc.exists) return null;
    const run = Object.assign({ id: runDoc.id }, runDoc.data());
    // one read: the run carries its own stops, and its own frozen
    // blueprint, so a track edited since cannot change the shape of work
    // already travelling
    return { run, nodeRuns: run.nodeRuns || [], blueprint: run.blueprintSnapshot || null,
             members: s.members || [] };
  } catch (e) { console.error(e); return null; }
}

/* Move the baton on. The read-decide-write is one transaction because
   two people finishing the same stop at the same moment must not both
   win - the second must find it already completed and say so, rather
   than silently overwriting the first person's answer. */
async function itemsAdvanceHandoff(item, type, nodeRunId, output){
  const s = await orgEnsure();
  if (!s || !item || !item.workflowRunId) return { ok: false, error: "no-run" };
  const uid = auth.currentUser ? auth.currentUser.uid : null;
  const isOwner = (s.myRoleId === "owner");
  const runRef = runsCol(s.orgId).doc(item.workflowRunId);

  let after = null, as = null;
  try {
    await db.runTransaction(async tx => {
      const runDoc = await tx.get(runRef);
      if (!runDoc.exists) throw new Error("no-run");
      const run = Object.assign({ id: runDoc.id }, runDoc.data());
      const bp = run.blueprintSnapshot;
      // read inside the transaction, from the document the transaction
      // actually holds. A query here would have been an ordinary read -
      // outside the isolation, not re-run on retry - which is how two
      // people finishing the same stop could both have won.
      const nodeRuns = run.nodeRuns || [];

      const nr = nodeRuns.find(x => x.id === nodeRunId);
      if (!nr) throw new Error("no-stop");
      const may = hoMayAdvance(bp, nr, uid, s.members || [], isOwner);
      if (!may.ok) throw new Error(may.reason);
      as = may.as;

      const next = wfAdvance({ run, nodeRuns },
        { type: "complete", nodeRunId, output: output || {} }, { now: Date.now() });

      // who actually pressed it, which the engine does not record and the
      // trail is far less useful without
      const stamped = next.nodeRuns.map(x => x.id === nodeRunId
        ? Object.assign({}, x, { completedBy: uid, completedAs: as }) : x);
      tx.set(runRef, Object.assign({}, next.run, { nodeRuns: stamped }));
      after = { run: next.run, nodeRuns: stamped };
    });
  } catch (e) {
    const m = String((e && e.message) || "");
    if (m === "not-yours" || m === "not-active" || m === "no-stop" || m === "no-run") return { ok: false, error: m };
    console.error(e);
    return { ok: false, error: "failed" };
  }

  const bp = (after && after.run && after.run.blueprintSnapshot) || null;
  await itemsSyncFromRun(item, type, bp, after.run, after.nodeRuns);
  return { ok: true, as, run: after.run, nodeRuns: after.nodeRuns };
}

/* Make the Item tell the truth about where its work is.

   The run drives the status and the assignees, never the other way
   round - two ways to move the same work is two sources of truth, and
   they disagree eventually. This goes through itemSave() like every
   other change, which is deliberate: the baton arriving fires
   item.assigned, so the person it just reached is told by the same
   machinery that tells anyone handed work, and any rule watching the
   status fires as it would have anyway. */
async function itemsSyncFromRun(item, type, blueprint, run, nodeRuns){
  const s = await orgEnsure();
  if (!s || !item) return;
  const holders = hoHolders(blueprint, nodeRuns, s.members || []);
  const status = hoStatus(blueprint, nodeRuns);
  // the active stop's deadline is copied onto the Item, so a list of
  // fifty can show what is late without reading fifty runs
  const due = hoDue(blueprint, nodeRuns, Date.now()).dueAt;
  let cur = item;

  try {
    /* One commit for everything that is not the status or the assignees,
       and through itemSave like everything else. Writing any of it beside
       the chokepoint means the next commit rebuilds the document from an
       in-memory copy that predates the side write and quietly erases it -
       which is how an Item ended up travelling a run it had no record of,
       looking untracked to every screen that asked. */
    const patch = {};
    if (cur.workflowRunId !== run.id) patch.workflowRunId = run.id;
    // a new stop means a new clock: the chase stamp from the last one
    // must not silence the next
    if ((cur.dueAt || null) !== (due || null)) { patch.dueAt = due; patch.nudgedAt = null; }
    if (Object.keys(patch).length) {
      const r = await itemSave(type, cur, Object.assign({ kind: "update" }, patch));
      if (r.ok && r.item) cur = r.item;
    }
    if (status && cur.status !== status) {
      const r = await itemSave(type, cur, { kind: "set_status", status });
      if (r.ok && r.item) cur = r.item;
    }
    const now = (cur.assigneeIds || []).slice().sort().join(",");
    if (holders.slice().sort().join(",") !== now) {
      await itemSave(type, cur, { kind: "assign", assigneeIds: holders });
    }
  } catch (e) { console.warn("Could not sync the item to its run:", e); }
}

/* Chase what is late.

   This is automation without a server, and the trade is stated rather
   than hidden: it runs when somebody opens the app, not at 3am. For a
   team that opens it most days the difference is hours. What a scheduled
   server would buy is the unattended overnight run and nothing else.

   Only somebody who may update work across the org runs it, because
   stamping the chase onto a piece of work is a write - and a staff member
   who may only touch their own assigned work cannot stamp anybody
   else's. The permission grammar already answers that question, so it is
   asked rather than guessed at.

   Fire-and-forget: nothing about opening a page should fail because a
   chase could not be delivered. */
async function itemsChaseOverdue(){
  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  const role = (s.roles || []).find(r => r.id === s.myRoleId);
  if (!role || permGrantScope(role.permissions || [], "item", "update") !== "org")
    return { ok: false, error: "not-mine-to-chase" };

  const now = Date.now();
  let snap;
  try {
    snap = await itemsCol(s.orgId).where("dueAt", "<", now).get();
  } catch (e) { console.error(e); return { ok: false, error: "read-failed" }; }

  const late = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
    .filter(it => hoNeedsNudge(it, now));
  if (!late.length) return { ok: true, chased: 0 };

  const me = auth.currentUser ? auth.currentUser.uid : null;
  try {
    const batch = db.batch();
    late.forEach(it => {
      const days = Math.floor((now - it.dueAt) / HO_DAY);
      const text = (it.title || "Some work") + " is " +
        (days >= 1 ? days + (days === 1 ? " day" : " days") + " late" : "past its due time") + ".";
      // whoever holds it hears, and so does whoever is doing the chasing -
      // being late is a fact the person responsible for the pipeline needs
      // as much as the person holding the baton
      const targets = [...new Set((it.assigneeIds || []).concat(me ? [me] : []))];
      targets.forEach(uid => batch.set(db.collection("notifications").doc(), {
        toUid: uid, fromUid: me, kind: "overdue", read: false, createdAt: now,
        msg: text, text, store: "", task: it.title || ""
      }));
      batch.update(itemsCol(s.orgId).doc(it.id), { nudgedAt: now });
    });
    await batch.commit();
  } catch (e) { console.warn("Could not chase late work:", e); return { ok: false, error: "write-failed" }; }
  return { ok: true, chased: late.length };
}

/* ---------- template packs ---------- */

/* Apply a pack (js/packs.js) to the current org: the roles, kinds of work
   and rules an industry starts with, so nobody meets an empty screen and
   has to invent a data model before they can log anything.

   ADDITIVE AND IDEMPOTENT, and those two are the same property. The plan
   skips anything already there by id, so applying a pack twice creates
   nothing the second time, and a pack can be applied to an org that is
   already running without touching what it built. Existing documents are
   never overwritten - if an org already has a "manager", that is ITS
   manager, permissions and all.

   ONE BATCH, so a pack cannot half-land. Half a pack is worse than none:
   rules pointing at types that do not exist, notifying roles nobody holds.
   A pack is ~10 documents against a 500 limit, so this needs no chunking.

   The validation is not belt-and-braces theatre - tests/packs.test.mjs
   proves every pack in the repo is valid, but this file is also reachable
   from a console, and a broken pack should fail before it writes, not
   halfway through. */
async function itemsApplyPack(packKey){
  const pack = packByKey(packKey);
  if (!pack) return { ok: false, error: "no-pack" };
  const v = packValidate(pack);
  if (!v.ok) { console.error("pack " + packKey + " is invalid", v.errors); return { ok: false, error: "invalid", details: v.errors }; }

  const s = await orgEnsure();
  if (!s) return { ok: false, error: "no-org" };
  const org = db.collection("orgs").doc(s.orgId);

  let roleSnap, typeSnap, autoSnap;
  try {
    [roleSnap, typeSnap, autoSnap] = await Promise.all([
      org.collection("roles").get(), org.collection("itemTypes").get(), org.collection("automations").get()
    ]);
  } catch (e) { console.error(e); return { ok: false, error: "read-failed" }; }

  // read fresh rather than trusting the page cache: the decision to skip
  // something is only as good as the list it was made against
  const plan = packPlan(pack, {
    roleIds: roleSnap.docs.map(d => d.id),
    typeIds: typeSnap.docs.map(d => d.id),
    automationIds: autoSnap.docs.map(d => d.id)
  });

  const at = Date.now();
  const batch = db.batch();
  plan.roles.forEach(r => batch.set(org.collection("roles").doc(r.id), r.doc));
  plan.itemTypes.forEach(t => batch.set(org.collection("itemTypes").doc(t.id),
    Object.assign({}, t.doc, { updatedAt: at })));
  plan.automations.forEach(a => batch.set(org.collection("automations").doc(a.id),
    Object.assign({}, a.doc, { updatedAt: at })));
  // the compiled tracks. Derived from the types the plan is CREATING, so
  // a pack applied twice writes no second copy of them either.
  (plan.blueprints || []).forEach(b => batch.set(org.collection("blueprints").doc(b.id),
    Object.assign({}, b.doc, { orgId: s.orgId, updatedAt: at })));
  try { await batch.commit(); }
  catch (e) { console.error(e); return { ok: false, error: "write-failed" }; }

  // both caches now describe an org that no longer exists
  itemsAutomationsCache = null;
  orgInvalidate();
  return { ok: true, created: {
    roles: plan.roles.length, itemTypes: plan.itemTypes.length,
    automations: plan.automations.length, blueprints: (plan.blueprints || []).length
  }, skipped: plan.skipped.length };
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


/* ============================================================
   AUTOMATIONS — carrying out the plan.

   js/automation.js decides; this delivers. It reads the org's
   rules once per session, plans against each event a change
   produced, and applies what comes back through itemSave() -
   the same chokepoint everything else uses, so an automation is
   held to exactly the permissions and validation a person is.

   That last part matters: a rule cannot do what the person who
   triggered it could not. An automation that could move work its
   own author is not allowed to touch would be a way around the
   permission model rather than a feature of it.

   Depth rides along so a chain of rules answering each other
   stops. It rarely gets that far - a rule writing a value that
   is already set produces no event, so the common loop dies on
   its second lap - but the cap is there for the ones that do not.
   ============================================================ */

let itemsAutomationsCache = null;

async function itemsAutomationsLoad(orgId){
  if (itemsAutomationsCache) return itemsAutomationsCache;
  try {
    const snap = await db.collection("orgs").doc(orgId).collection("automations").get();
    itemsAutomationsCache = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  } catch (e) { console.error(e); itemsAutomationsCache = []; }
  return itemsAutomationsCache;
}

async function itemsRunAutomations(events, item, depth){
  if (!events || !events.length || !item) return;
  try {
    const s = await orgEnsure();
    if (!s) return;
    const rules = await itemsAutomationsLoad(s.orgId);
    if (!rules.length) return;

    const types = await itemTypesLoad();
    const type = types.find(t => t.id === item.typeId);
    if (!type) return;

    let current = item;
    for (const event of events) {
      const plan = autoPlan({ automations: rules, event, item: current, depth });
      if (plan.stopped) {
        console.warn("Automation chain stopped:", plan.stopped, "on", event.verb);
        continue;
      }
      for (const step of plan.steps) {
        if (step.kind === "notify") { await itemsDeliverNotify(step, current); continue; }
        // through itemSave, so the rule is checked exactly as a person is
        const r = await itemSave(type, current, step.intent, { depth: step.depth });
        if (!r.ok) { console.warn("Automation", step.automationId, "refused:", r.error); continue; }
        if (r.item) current = r.item;
      }
    }
  } catch (e) {
    console.warn("Could not run automations:", e);
  }
}

/* Notifications go to the collection the app already uses, so an
   automation's message arrives in the same bell as everything else
   rather than inventing a second place people have to remember. */
/* Tell whoever was just put on this piece of work. Fire-and-forget and
   caught: the commit has already succeeded and the person has already
   been told it worked, so a failure here must never turn that into an
   error they see. */
async function itemsNotifyAssigned(events, item){
  const me = auth.currentUser ? auth.currentUser.uid : null;
  const uids = itemNewAssignees(events, item, me);
  if (!uids.length) return;
  const at = Date.now();
  const title = (item && item.title) || "some work";
  try {
    const batch = db.batch();
    uids.forEach(uid => batch.set(db.collection("notifications").doc(), {
      toUid: uid, fromUid: me, kind: "assigned", read: false, createdAt: at,
      msg: title + " was assigned to you.",
      text: title + " was assigned to you.",
      store: (item && item.fields && item.fields.store) || "", task: title
    }));
    await batch.commit();
  } catch (e) { console.warn("Could not tell the new assignees:", e); }
}

async function itemsDeliverNotify(step, item){
  const from = auth.currentUser ? auth.currentUser.uid : null;
  const text = step.message || (item.title + " needs attention");
  const base = { fromUid: from, kind: "automation", read: false, createdAt: Date.now(),
    // `msg` is the headline the notification centre renders. Without it
    // every one of these read "Someone finished ..." - which is not what
    // happened, and was wrong for automations from the day they shipped.
    msg: text, text, store: (item.fields || {}).store || "", task: item.title || "" };

  // A role is resolved to PEOPLE before anything is written. The bell
  // queries toUid, and firestore.rules only lets the addressee read it -
  // so a doc addressed to "lead" would be written, permitted to nobody,
  // and read by no one. "admin" is the one exception: that is the legacy
  // email-list admin, not an org role, and its own toRole doc is what the
  // admin bell already watches.
  const s = await orgEnsure();
  const uids = autoNotifyTargets(step, s && s.members, from);
  const legacyAdmin = step.toRole === "admin";
  if (!uids.length && !legacyAdmin) {
    // worth saying out loud: a rule firing at an empty role is the kind of
    // nothing that looks exactly like working
    console.warn("Automation notified role '" + step.toRole + "', which nobody holds.");
    return;
  }
  try {
    const batch = db.batch();
    if (legacyAdmin) batch.set(db.collection("notifications").doc(),
      Object.assign({ toRole: "admin" }, base));
    uids.forEach(uid => batch.set(db.collection("notifications").doc(),
      Object.assign({ toUid: uid }, base)));
    await batch.commit();
  } catch (e) { console.warn("Could not deliver an automation notification:", e); }
}
