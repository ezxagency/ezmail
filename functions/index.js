/* ============================================================
   PHASE 0 — the server exists, and does nothing.
   Two no-op functions whose only job is to prove the deploy
   target, the Firestore trigger plumbing, and the scheduler all
   work before any real logic rides them. Phase 1 (dueAfter
   enforcement, effect dispatch) builds on exactly these two
   entry points — debug from their structured logs, not prints.

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

const REGION = "us-central1";          // Firestore is nam5 — triggers must live with the data
const SWEEP_TZ = "America/Denver";     // the org's clock, not the server's

setGlobalOptions({ region: REGION, maxInstances: 10 });

/* Fires on every create/update/delete of a nodeRun. Deliberately blind:
   it reads nothing and writes nothing — the event payload alone tells us
   the id and what kind of write happened. Phase 1 turns this into the
   server-side effect dispatcher. */
exports.onNodeRunWritten = onDocumentWritten(
  { document: "nodeRuns/{nodeRunId}", maxInstances: 10 },
  (event) => {
    const before = event.data && event.data.before && event.data.before.exists;
    const after = event.data && event.data.after && event.data.after.exists;
    const changeType = !before ? "create" : !after ? "delete" : "update";
    logger.info("nodeRun written", {
      nodeRunId: event.params.nodeRunId,
      changeType,
    });
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
