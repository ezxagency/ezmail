/* ============================================================
   SERVER-SIDE EFFECT DISPATCH — the decision, not yet the send.

   The engine never persists effects: wfResolve computes them
   in-memory and the browser used to consume them right after
   the transaction committed — which is exactly the hole this
   closes (tab gone = effect gone, no record). But every effect
   maps 1:1 to the CREATE of a nodeRun in a known shape, because
   non-role nodes resolve inside the reconcile and Firestore
   only ever sees their final state:

     role   + in_progress  → role-activated
     action + completed    → action (actionType/params in config)
     vault  + completed    → vault

   Everything a dispatch needs lives on the nodeRun doc plus the
   run's FROZEN blueprintSnapshot — one read, never the live
   blueprint. run-completed / run-failed are run-level (no
   nodeRunId, no stamp) and stay client-side until a runs
   trigger exists.

   Triggers are at-least-once, so every invocation is treated as
   a possible duplicate. The dispatchLog ledger is the truth:
   doc id = nodeRunId + a stable hash of the effect definition,
   claimed with a read-then-create inside a transaction. A fresh
   claim someone else holds is skipped (they're working); a
   claim that recorded an error, or went stale past the lease,
   is a retry and bumps the attempt count; succeeded and failed
   are terminal. Handlers signal "retrying might help" by
   THROWING (the caller rethrows so Functions redelivers, until
   the attempt cap turns it into a permanent failure) and
   "retrying can never help" by returning state "failed" (a
   config hole like a missing recipient — no throw, no retry).

   Email and webhook handlers are Phase-0 STUBS: they log the
   exact payload they would send and return success. Sessions 3
   and 4 make them real. Internal effects (notifications, the
   vault stamp) are real already — they are Firestore writes,
   and stubbing them would mean flipping the flag silently stops
   workers hearing about their stops.
   ============================================================ */

const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const MAX_ATTEMPTS = 5;        // handler executions per effect, ever
const CLAIM_LEASE_MS = 60000;  // a fresh error-free claim younger than this is "someone's on it"

/* ---------- identity: one ledger row per (nodeRun, effect) ---------- */

// JSON with sorted keys at every level, so the same effect always hashes
// the same no matter what order the snapshot happened to store fields in
function stableStringify(v){
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

const effectHash = ef => crypto.createHash("sha256").update(stableStringify(ef)).digest("hex").slice(0, 16);

// nodeRun ids are runId:nodeId:attemptN — colons are legal in doc ids
const ledgerId = ef => ef.nodeRunId + "__" + effectHash(ef);

/* ---------- the flag: blueprints/config, the single switch ----------
   Lives in blueprints because firestore.rules is frozen this session and
   that collection is already team-readable client-side, while the UI's
   list query filters on orgId so a config doc without one stays
   invisible. Absent doc or anything but literal true = OFF. */
async function readDispatchFlag(db){
  const snap = await db.collection("blueprints").doc("config").get();
  return !!(snap.exists && snap.data().serverDispatch === true);
}

/* ---------- effect resolution: the engine's emissions, reconstructed ---------- */

// Mirrors what wfResolve pushes (js/workflow-engine.js:417-449). Config
// comes from the run's frozen snapshot — same source the engine used.
function resolveEffects(nodeRun, snapshotNode){
  const cfg = (snapshotNode && snapshotNode.config) || {};
  if (nodeRun.nodeType === "role" && nodeRun.status === "in_progress"){
    return [{ type: "role-activated", nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id,
      role: cfg.role || null, assigneeId: cfg.assigneeId || null }];
  }
  if (nodeRun.nodeType === "action" && nodeRun.status === "completed"){
    return [{ type: "action", nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id,
      actionType: cfg.actionType || null, params: cfg.params || {} }];
  }
  if (nodeRun.nodeType === "vault" && nodeRun.status === "completed"){
    return [{ type: "vault", nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id }];
  }
  return [];
}

// which nodeType/status creates can carry effects at all — checked before
// any read so trigger/logic/split creates cost nothing extra
const mayHaveEffects = nr =>
  (nr.nodeType === "role" && nr.status === "in_progress") ||
  (nr.nodeType === "action" && nr.status === "completed") ||
  (nr.nodeType === "vault" && nr.status === "completed");

/* ---------- handlers ---------- */

const slice140 = s => String(s || "").slice(0, 140);

async function handleRoleActivated(db, ef, ctx){
  const { run, now } = ctx;
  const node = ((run.blueprintSnapshot || {}).nodes || []).find(n => n.id === ef.nodeId);
  const cfg = node ? node.config || {} : {};
  const taskTitle = (run.task && run.task.title) || "a workflow run";

  // same resolution the client did: a named person, else everyone in the
  // directory holding the craft, else — never silently nobody — the admins
  let recipients = [];
  if (ef.assigneeId){
    recipients = [ef.assigneeId];
  } else if (ef.role){
    const want = String(ef.role).trim().toLowerCase();
    const dir = await db.collection("directory").get();
    const uids = [];
    dir.forEach(d => {
      const craft = (d.data().craft || "").trim().toLowerCase();
      if (craft === want) uids.push(d.id);
    });
    recipients = [...new Set(uids)];
  }

  const base = {
    kind: "wf-stop", status: "pending",
    runId: run.id, nodeRunId: ef.nodeRunId,
    stop: cfg.label || "A stop", taskTitle,
    fromName: (run.blueprintSnapshot || {}).name || "Workflow",
    text: cfg.instructions || "",
    read: false, createdAt: now
  };
  if (recipients.length){
    const batch = db.batch();
    recipients.forEach(uid => batch.set(db.collection("notifications").doc(), Object.assign({ toUid: uid }, base)));
    await batch.commit();
    return { state: "dispatched", reason: ef.assigneeId ? "notified the assignee"
      : "notified " + recipients.length + " " + ef.role + (recipients.length === 1 ? "" : "s") };
  }
  await db.collection("notifications").add({
    toRole: "admin", kind: "workflow", read: false, createdAt: now,
    text: "No one holds the role “" + (ef.role || "?") + "” — the stop “" + (cfg.label || ef.nodeId) + "” on “" + taskTitle + "” is waiting unclaimed in Workflows."
  });
  return { state: "dispatched", reason: "no one holds the role “" + (ef.role || "?") + "” — admins alerted" };
}

async function handleVault(){
  return { state: "dispatched", reason: "stamped into the run record" };
}

async function handleAction(db, ef, ctx){
  const { run, now } = ctx;
  const p = ef.params || {};
  const taskTitle = (run.task && run.task.title) || "a workflow run";

  if (ef.actionType === "notify"){
    await db.collection("notifications").add({
      toRole: "admin", kind: "workflow", read: false, createdAt: now,
      text: p.message || ("A workflow action fired on: " + taskTitle)
    });
    return { state: "dispatched" };
  }
  if (ef.actionType === "complete"){
    // runs still carry taskId: null — same honest skip the client stamps
    return { state: "skipped", reason: "no linked task to mark complete" };
  }
  if (ef.actionType === "email"){
    // config holes fail permanently — a retry can't invent a recipient
    if (!p.to) return { state: "failed", reason: "no recipient configured on this Action" };
    logger.info("email stub — would send", {
      handler: "email", nodeRunId: ef.nodeRunId, runId: run.id,
      to: p.to, subject: p.subject || ("Workflow update — " + taskTitle)
    });
    return { state: "dispatched", reason: "stub: payload logged, no mail sent" };
  }
  if (ef.actionType === "webhook"){
    if (!p.enabled) return { state: "skipped", reason: "webhook is disabled — switch it on in the Action block" };
    if (!p.url) return { state: "failed", reason: "no URL configured on this Action" };
    logger.info("webhook stub — would POST", {
      handler: "webhook", nodeRunId: ef.nodeRunId, runId: run.id, url: p.url,
      payload: {
        event: "workflow-action",
        runId: run.id, taskId: run.taskId || null, task: run.task || {},
        blueprint: { name: (run.blueprintSnapshot || {}).name || "", version: (run.blueprintSnapshot || {}).version || 0 },
        nodeId: ef.nodeId, nodeRunId: ef.nodeRunId, firedAt: now
      }
    });
    return { state: "dispatched", reason: "stub: payload logged, no request sent" };
  }
  return { state: "failed", reason: "unknown action type: " + (ef.actionType || "(none)") };
}

const DEFAULT_HANDLERS = {
  "role-activated": handleRoleActivated,
  "vault": handleVault,
  "action": handleAction
};

/* ---------- the ledger claim ---------- */

// One transaction decides what this invocation may do with this effect.
// Returns { decision: "run" | "skip" | "cap", attempts, why }.
async function claimEffect(db, ef, meta, now){
  const ref = db.collection("dispatchLog").doc(ledgerId(ef));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists){
      tx.create(ref, {
        status: "claimed", attempts: 1,
        firstAttemptAt: now, lastAttemptAt: now, lastError: null,
        nodeRunId: ef.nodeRunId, runId: meta.runId, effectType: ef.type, effect: ef
      });
      return { decision: "run", attempts: 1 };
    }
    const d = snap.data();
    if (d.status === "succeeded") return { decision: "skip", attempts: d.attempts, why: "already succeeded" };
    if (d.status === "failed") return { decision: "skip", attempts: d.attempts, why: "already failed permanently" };
    // status "claimed": an error on record or a stale lease means the last
    // attempt is over and this is a retry; a fresh error-free claim means
    // another invocation is mid-flight right now — leave it alone
    if (d.lastError == null && now - (d.lastAttemptAt || 0) < CLAIM_LEASE_MS)
      return { decision: "skip", attempts: d.attempts, why: "another invocation holds a live claim" };
    if (d.attempts >= MAX_ATTEMPTS){
      tx.update(ref, { status: "failed", lastError: slice140("gave up after " + d.attempts + " attempts: " + (d.lastError || "crash before outcome")) });
      return { decision: "cap", attempts: d.attempts };
    }
    tx.update(ref, { attempts: d.attempts + 1, lastAttemptAt: now });
    return { decision: "run", attempts: d.attempts + 1 };
  });
}

/* ---------- stamping the nodeRun (the shape the client writes today) ---------- */

async function stampNodeRun(db, ef, stamp){
  try {
    await db.collection("nodeRuns").doc(ef.nodeRunId).update({ ["dispatch." + ef.type]: stamp });
  } catch (e) {
    // the stamp is bookkeeping for the timeline; the ledger stays the truth
    logger.error("couldn't stamp nodeRun", { nodeRunId: ef.nodeRunId, effectType: ef.type, error: String(e && e.message || e) });
  }
}

/* ---------- the core: dispatch everything one created nodeRun implies ----------
   `nodeRun` is the created doc's data. `opts.handlers` overrides the
   handler map (how the tests inject failures); `opts.now` pins time.
   Throws ONLY when at least one effect failed retryably — so the trigger
   can rethrow and let Functions redeliver, while capped/permanent
   failures are swallowed on purpose. */
async function dispatchForCreate(db, nodeRun, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const handlers = Object.assign({}, DEFAULT_HANDLERS, opts.handlers || {});

  if (!mayHaveEffects(nodeRun)) return { effects: 0 };

  const runSnap = await db.collection("runs").doc(nodeRun.runId).get();
  if (!runSnap.exists){
    // no run, no snapshot, no way to resolve config — permanent, not retryable
    logger.error("dispatch: run doc missing", { nodeRunId: nodeRun.id, runId: nodeRun.runId });
    return { effects: 0, why: "run missing" };
  }
  const run = runSnap.data();
  const node = ((run.blueprintSnapshot || {}).nodes || []).find(n => n.id === nodeRun.nodeId);
  const effects = resolveEffects(nodeRun, node);

  let retryable = 0;
  for (const ef of effects){
    const claim = await claimEffect(db, ef, { runId: nodeRun.runId }, now);
    const ref = db.collection("dispatchLog").doc(ledgerId(ef));
    logger.info("dispatch claim", { nodeRunId: ef.nodeRunId, effectType: ef.type,
      decision: claim.decision, attempts: claim.attempts, why: claim.why || null });

    if (claim.decision === "cap"){
      await stampNodeRun(db, ef, { at: now, state: "failed", via: "server",
        reason: slice140("gave up after " + claim.attempts + " attempts") });
      continue;
    }
    if (claim.decision !== "run") continue;

    await stampNodeRun(db, ef, { at: now, state: "pending", via: "server",
      reason: "attempt " + claim.attempts });
    try {
      const outcome = await handlers[ef.type](db, ef, { run, nodeRun, now }) || { state: "dispatched" };
      const terminal = outcome.state === "failed" ? "failed" : "succeeded";
      await ref.update({ status: terminal, lastError: outcome.state === "failed" ? slice140(outcome.reason) : null, outcome });
      const stamp = { at: now, state: outcome.state, via: "server" };
      if (outcome.reason) stamp.reason = slice140(outcome.reason);
      await stampNodeRun(db, ef, stamp);
      logger.info("dispatch done", { nodeRunId: ef.nodeRunId, effectType: ef.type,
        state: outcome.state, attempts: claim.attempts });
    } catch (e) {
      const msg = slice140(e && e.message || e);
      if (claim.attempts >= MAX_ATTEMPTS){
        await ref.update({ status: "failed", lastError: slice140("gave up after " + claim.attempts + " attempts: " + msg) });
        await stampNodeRun(db, ef, { at: now, state: "failed", via: "server",
          reason: slice140("gave up after " + claim.attempts + " attempts: " + msg) });
        logger.error("dispatch failed permanently", { nodeRunId: ef.nodeRunId, effectType: ef.type,
          attempts: claim.attempts, error: msg });
      } else {
        await ref.update({ lastError: msg, lastAttemptAt: now });
        await stampNodeRun(db, ef, { at: now, state: "pending", via: "server",
          reason: slice140("attempt " + claim.attempts + " failed — will retry: " + msg) });
        logger.warn("dispatch attempt failed — will retry", { nodeRunId: ef.nodeRunId, effectType: ef.type,
          attempts: claim.attempts, error: msg });
        retryable++;
      }
    }
  }
  if (retryable) throw new Error(retryable + " effect(s) failed retryably on " + nodeRun.id);
  return { effects: effects.length };
}

module.exports = {
  MAX_ATTEMPTS, CLAIM_LEASE_MS,
  stableStringify, effectHash, ledgerId,
  readDispatchFlag, resolveEffects, mayHaveEffects,
  dispatchForCreate, DEFAULT_HANDLERS
};
