/* The dispatch ledger's promises, held against a real Firestore emulator:
   a duplicate trigger invocation fires the handler exactly once, a
   handler failure is recorded and retried, retries stop dead at the cap,
   an already-succeeded effect is never re-run, a live concurrent claim
   is left alone, and the flag defaults OFF. Runs the REAL
   functions/lib/dispatch.js (admin SDK via functions/node_modules)
   against the emulator — handlers are injected per test, which is the
   module's own test seam, not a mock of it.

   Run (needs Java on PATH and firebase-tools):
     cd tests
     firebase emulators:exec --only firestore --project demo-ez "node functions-dispatch.test.mjs"
   Same runner shape as the rest: PASS/FAIL lines, exit 1 on failure. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// resolve firebase-admin (and the lib itself) out of functions/node_modules
const req = createRequire(join(here, "../functions/index.js"));
const { initializeApp } = req("firebase-admin/app");
const { getFirestore } = req("firebase-admin/firestore");
const dispatch = req(join(here, "../functions/lib/dispatch.js"));

if (!process.env.FIRESTORE_EMULATOR_HOST){
  console.error("FIRESTORE_EMULATOR_HOST is not set — run this under `firebase emulators:exec`.");
  process.exit(1);
}
initializeApp({ projectId: "demo-ez" });
const db = getFirestore();

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 160)); }
};

/* ---------- fixtures ---------- */
const RUN = {
  id: "r1", taskId: null, task: { title: "October banner" },
  blueprintSnapshot: { name: "Track", version: 2, nodes: [
    { id: "n1", type: "role", config: { label: "QA pass", role: "designer", instructions: "check it" } },
    { id: "a1", type: "action", config: { actionType: "email", params: { to: "c@x.com", subject: "Hi" } } },
    { id: "v1", type: "vault", config: {} }
  ] }
};
await db.doc("runs/r1").set(RUN);
await db.doc("directory/dA").set({ name: "Anshul", craft: "designer" });

// each test gets its own attempt number, so ledger ids never collide
const nrOf = (nodeId, nodeType, status, n) => {
  const id = `r1:${nodeId}:${n}`;
  return { id, runId: "r1", nodeId, nodeType, status, output: {}, inputs: {} };
};
const seedNr = async nr => { await db.doc("nodeRuns/" + nr.id).set(nr); return nr; };
const ledgerOf = async nr => {
  const q = await db.collection("dispatchLog").where("nodeRunId", "==", nr.id).get();
  assert.equal(q.size, 1, "expected exactly one ledger row for " + nr.id);
  return q.docs[0].data();
};
const stampOf = async (nr, type) => {
  const d = (await db.doc("nodeRuns/" + nr.id).get()).data();
  return (d.dispatch || {})[type];
};

/* ---------- the four required behaviours ---------- */

await T("duplicate trigger invocation fires the handler exactly once", async () => {
  const nr = await seedNr(nrOf("a1", "action", "completed", 1));
  let count = 0;
  const handlers = { action: async () => { count++; return { state: "dispatched", reason: "test" }; } };
  await dispatch.dispatchForCreate(db, nr, { handlers, now: 1000 });
  await dispatch.dispatchForCreate(db, nr, { handlers, now: 2000 });   // the redelivery
  assert.equal(count, 1);
  const led = await ledgerOf(nr);
  assert.equal(led.status, "succeeded");
  assert.equal(led.attempts, 1);
  assert.equal((await stampOf(nr, "action")).state, "dispatched");
});

await T("a handler failure is recorded on the ledger and retried", async () => {
  const nr = await seedNr(nrOf("a1", "action", "completed", 2));
  let count = 0;
  const handlers = { action: async () => { count++; throw new Error("SMTP down"); } };
  await assert.rejects(() => dispatch.dispatchForCreate(db, nr, { handlers, now: 1000 }), /retryably/);
  let led = await ledgerOf(nr);
  assert.equal(led.status, "claimed");
  assert.equal(led.attempts, 1);
  assert.match(led.lastError, /SMTP down/);
  assert.match((await stampOf(nr, "action")).reason, /will retry/);
  await assert.rejects(() => dispatch.dispatchForCreate(db, nr, { handlers, now: 2000 }), /retryably/);
  led = await ledgerOf(nr);
  assert.equal(led.attempts, 2);
  assert.equal(count, 2);
});

await T("retries stop at the cap — marked failed permanently, no more throws, no more runs", async () => {
  const nr = await seedNr(nrOf("a1", "action", "completed", 3));
  let count = 0;
  const handlers = { action: async () => { count++; throw new Error("always broken"); } };
  for (let i = 1; i < dispatch.MAX_ATTEMPTS; i++)
    await assert.rejects(() => dispatch.dispatchForCreate(db, nr, { handlers, now: i * 1000 }));
  // the capping attempt runs the handler one last time, then gives up WITHOUT throwing
  await dispatch.dispatchForCreate(db, nr, { handlers, now: 99000 });
  assert.equal(count, dispatch.MAX_ATTEMPTS);
  const led = await ledgerOf(nr);
  assert.equal(led.status, "failed");
  assert.match(led.lastError, /gave up after 5 attempts/);
  const s = await stampOf(nr, "action");
  assert.equal(s.state, "failed");
  assert.match(s.reason, /gave up/);
  // and one more redelivery after the cap touches nothing
  await dispatch.dispatchForCreate(db, nr, { handlers, now: 100000 });
  assert.equal(count, dispatch.MAX_ATTEMPTS);
});

await T("an already-succeeded effect is never re-run", async () => {
  const nr = await seedNr(nrOf("v1", "vault", "completed", 4));
  await dispatch.dispatchForCreate(db, nr, { now: 1000 });   // real vault handler, succeeds
  assert.equal((await ledgerOf(nr)).status, "succeeded");
  let count = 0;
  await dispatch.dispatchForCreate(db, nr, { handlers: { vault: async () => { count++; return { state: "dispatched" }; } }, now: 2000 });
  assert.equal(count, 0);
  assert.equal((await ledgerOf(nr)).attempts, 1);
});

/* ---------- the guards around them ---------- */

await T("a live error-free claim from a concurrent invocation is left alone", async () => {
  const nr = await seedNr(nrOf("a1", "action", "completed", 5));
  const ef = dispatch.resolveEffects(nr, RUN.blueprintSnapshot.nodes[1])[0];
  await db.doc("dispatchLog/" + dispatch.ledgerId(ef)).set({
    status: "claimed", attempts: 1, firstAttemptAt: 5000, lastAttemptAt: 5000,
    lastError: null, nodeRunId: nr.id, runId: "r1", effectType: "action", effect: ef
  });
  let count = 0;
  // "now" inside the lease window — the other invocation is presumed mid-flight
  await dispatch.dispatchForCreate(db, nr, { handlers: { action: async () => { count++; return { state: "dispatched" }; } }, now: 5000 + dispatch.CLAIM_LEASE_MS - 1 });
  assert.equal(count, 0);
  assert.equal((await ledgerOf(nr)).status, "claimed");
});

await T("a stale error-free claim (crash case) is retried after the lease expires", async () => {
  const nr = await seedNr(nrOf("a1", "action", "completed", 6));
  const ef = dispatch.resolveEffects(nr, RUN.blueprintSnapshot.nodes[1])[0];
  await db.doc("dispatchLog/" + dispatch.ledgerId(ef)).set({
    status: "claimed", attempts: 1, firstAttemptAt: 5000, lastAttemptAt: 5000,
    lastError: null, nodeRunId: nr.id, runId: "r1", effectType: "action", effect: ef
  });
  let count = 0;
  await dispatch.dispatchForCreate(db, nr, { handlers: { action: async () => { count++; return { state: "dispatched" }; } }, now: 5000 + dispatch.CLAIM_LEASE_MS + 1 });
  assert.equal(count, 1);
  const led = await ledgerOf(nr);
  assert.equal(led.status, "succeeded");
  assert.equal(led.attempts, 2);
});

await T("role activation resolves the pool from the directory and lands real notifications", async () => {
  const nr = await seedNr(nrOf("n1", "role", "in_progress", 7));
  await dispatch.dispatchForCreate(db, nr, { now: 1000 });
  const led = await ledgerOf(nr);
  assert.equal(led.status, "succeeded");
  assert.equal(led.effectType, "role-activated");
  const q = await db.collection("notifications").where("nodeRunId", "==", nr.id).get();
  assert.equal(q.size, 1);
  const n = q.docs[0].data();
  assert.equal(n.toUid, "dA");
  assert.equal(n.kind, "wf-stop");
  assert.equal(n.stop, "QA pass");
  assert.equal(n.taskTitle, "October banner");
  assert.equal((await stampOf(nr, "role-activated")).state, "dispatched");
});

await T("nodeRun creates that carry no effects touch nothing", async () => {
  const out = await dispatch.dispatchForCreate(db, nrOf("n1", "role", "completed", 8), { now: 1000 });
  assert.equal(out.effects, 0);
  const q = await db.collection("dispatchLog").where("nodeRunId", "==", "r1:n1:8").get();
  assert.equal(q.size, 0);
});

await T("the flag defaults OFF: absent doc and serverDispatch:false both read false", async () => {
  assert.equal(await dispatch.readDispatchFlag(db), false);
  await db.doc("blueprints/config").set({ serverDispatch: false });
  assert.equal(await dispatch.readDispatchFlag(db), false);
  await db.doc("blueprints/config").set({ serverDispatch: true });
  assert.equal(await dispatch.readDispatchFlag(db), true);
  await db.doc("blueprints/config").delete();
});

await T("effect identity is stable: same definition hashes the same regardless of key order", async () => {
  const a = { type: "action", nodeRunId: "x", nodeId: "a1", actionType: "email", params: { to: "c@x.com", subject: "Hi" } };
  const b = { params: { subject: "Hi", to: "c@x.com" }, actionType: "email", nodeId: "a1", nodeRunId: "x", type: "action" };
  assert.equal(dispatch.ledgerId(a), dispatch.ledgerId(b));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
