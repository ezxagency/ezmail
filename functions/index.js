/* ============================================================
   SERVER-SIDE COMMIT — phase 3 of docs/platform-spec.md.

   This is the whole point of the chokepoint. js/items.js has been
   calling itemCommit() in the browser since phase 2; the decision
   never lived in the UI, so moving it here changes ONE function's
   middle and nothing else. The engine below is the same file the
   browser runs, byte for byte (tests/repo-guards.test.mjs fails
   the build if the copies drift), which is why "the same rules
   apply on the server" is a fact rather than a hope.

   WHAT THIS ENDS. Until now firestore.rules let any org member
   write any item, because a rule cannot run the engine - one
   return statement, ten document reads. The comment above that
   rule said so and called it time-boxed. This is the box closing:
   once this is deployed and the rules are narrowed to reject
   client writes, opening devtools buys nothing. The engine
   decides, and the engine runs where the caller cannot reach it.

   TWO THINGS THE CLIENT DOES NOT GET TO SAY, no matter what it
   sends in the payload:

   1. WHO IT IS. The uid comes from the verified auth context.
   2. WHICH ORG IT IS IN. That comes from reading the membership
      document, never from the request. A client that names
      another org gets its own membership looked up and fails,
      because tenancy is not a field a caller may assert.
   ============================================================ */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { itemCommit } = require("./shared/item-engine.js");
const { permCan } = require("./shared/permissions.js");

admin.initializeApp();
const db = admin.firestore();

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* The engine's refusals, mapped to something a caller can act on.
   "invalid" keeps its details so the form can show every problem at
   once, exactly as it does today when the engine runs in the browser. */
function refuse(decision){
  const map = {
    denied: "permission-denied", "wrong-tenant": "permission-denied",
    "no-actor": "unauthenticated", "unknown-intent": "invalid-argument",
    "unknown-status": "invalid-argument", "no-type": "not-found", invalid: "invalid-argument"
  };
  throw new HttpsError(map[decision.error] || "internal", decision.error, decision.details || null);
}

exports.commitItem = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

  const { orgId, typeId, itemId, intent } = req.data || {};
  if (!orgId || !typeId || !intent) throw new HttpsError("invalid-argument", "orgId, typeId and intent are required.");

  const orgRef = db.collection("orgs").doc(orgId);

  // Membership is proof, and it is read rather than believed. A caller
  // who is not seated in this org never gets past here, whatever their
  // payload claimed.
  const member = await orgRef.collection("members").doc(uid).get();
  if (!member.exists) throw new HttpsError("permission-denied", "You are not a member of that organization.");

  const roleId = member.data().roleId;
  const roleDoc = roleId ? await orgRef.collection("roles").doc(roleId).get() : null;
  const permissions = roleDoc && roleDoc.exists ? (roleDoc.data().permissions || []) : [];

  const typeDoc = await orgRef.collection("itemTypes").doc(typeId).get();
  if (!typeDoc.exists) throw new HttpsError("not-found", "That work type no longer exists.");
  const type = Object.assign({ id: typeDoc.id }, typeDoc.data());

  const actor = { uid, orgId };
  const allow = (resource, action, ctx) => permCan(permissions, resource, action, ctx);
  const id = itemId || newId();
  const itemRef = orgRef.collection("items").doc(id);

  // The decision is re-made INSIDE the transaction against the item as it
  // is right now. Two people finishing the same item at once cannot both
  // win: the second attempt re-reads, re-decides, and either agrees or
  // refuses on current state rather than on what the client last saw.
  return db.runTransaction(async (tx) => {
    let item = null;
    if (itemId) {
      const snap = await tx.get(itemRef);
      if (!snap.exists) throw new HttpsError("not-found", "That work no longer exists.");
      item = Object.assign({ id: snap.id }, snap.data());
    }

    const decision = itemCommit({ type, item, intent, actor, allow, now: Date.now(), id });
    if (!decision.ok) refuse(decision);
    if (!decision.events.length && decision.item === item) return { ok: true, item, events: [] };

    if (decision.item === null) tx.delete(itemRef);
    else tx.set(itemRef, Object.assign({}, decision.item, { id }));

    // The log is written by the same transaction as the change it
    // describes: an event for something that did not happen is worse
    // than no log, and a change with no event is exactly the silence
    // the audit trail exists to prevent.
    decision.events.forEach(ev => tx.set(orgRef.collection("events").doc(), ev));

    return { ok: true, item: decision.item, events: decision.events };
  });
});
