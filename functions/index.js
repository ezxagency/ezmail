/* ============================================================
   PHASE 0 — the server side, growing one honest step at a time.

   Session 1 proved the deploy target with two no-ops. Session 2
   (this one) moves the DISPATCH DECISION server-side: the
   onNodeRunWritten trigger now recognizes the effects a created
   nodeRun implies, claims each in the dispatchLog ledger, and
   runs a handler — email/webhook still stubs that log what they
   would send. The whole path sits behind the serverDispatch
   flag on blueprints/config, default OFF, so deploying this
   changes nothing until the flag flips. lib/dispatch.js holds
   the logic; this file only wires triggers.

   REGION is pinned to the Firestore database's own location: a
   2nd-gen Firestore trigger must live where the database lives,
   and everything else follows it so cross-region hops never
   become a latency or egress surprise. maxInstances is capped
   LOW on every function on purpose — a runaway trigger loop
   (function writes nodeRuns → wakes itself) hits a 10-instance
   ceiling instead of a four-digit bill.
   ============================================================ */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const dispatch = require("./lib/dispatch");

const REGION = "us-central1";          // Firestore is nam5 — triggers must live with the data
const SWEEP_TZ = "America/Denver";     // the org's clock, not the server's

setGlobalOptions({ region: REGION, maxInstances: 10 });
initializeApp();

/* Fires on every create/update/delete of a nodeRun. Only CREATES can
   carry effects (non-role nodes resolve inside the client's reconcile
   transaction, so their final state is born, not updated into) — updates
   include our own dispatch.* stamps, and acting on them would be the
   trigger feeding itself. retry:true because the ledger in lib/dispatch
   is what makes redelivery safe: a throw means "an effect failed and
   retrying might help", everything else is swallowed deliberately. */
exports.onNodeRunWritten = onDocumentWritten(
  { document: "nodeRuns/{nodeRunId}", maxInstances: 10, retry: true },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists;
    const after = event.data && event.data.after && event.data.after.exists;
    const changeType = !before ? "create" : !after ? "delete" : "update";
    logger.info("nodeRun written", {
      nodeRunId: event.params.nodeRunId,
      changeType,
    });
    if (changeType !== "create") return;

    const nodeRun = event.data.after.data();
    if (!dispatch.mayHaveEffects(nodeRun)) return;

    const db = getFirestore();
    if (!(await dispatch.readDispatchFlag(db))){
      logger.info("dispatch: flag off — client owns dispatch", { nodeRunId: nodeRun.id });
      return;
    }
    await dispatch.dispatchForCreate(db, nodeRun);
  }
);

/* The nightly sweep. Empty by design: Phase 1 fills it with overdue-stop
   reminders (dueAfter), Phase 2 with vault retention. It exists now so
   the Cloud Scheduler wiring is proven long before anything depends on
   it firing. */
exports.nightlySweep = onSchedule(
  { schedule: "0 3 * * *", timeZone: SWEEP_TZ, maxInstances: 10 },
  () => {
    logger.info("sweep: no-op", { job: "nightlySweep" });
  }
);
