# functions/ — the server side of EZ Clock In

Cloud Functions for Firebase, **2nd gen**, plain CommonJS JavaScript on the
**Node 20** runtime. No TypeScript, no bundler, no build step — the same
edit-and-deploy principle as the rest of the repo. `index.js` is the whole
surface; split into `lib/` only if it grows past ~100 lines.

## What's here (Phase 0, session 2 — dispatch decision, stubbed sends)

| Function | Trigger | Does |
|---|---|---|
| `onNodeRunWritten` | Firestore `onDocumentWritten("nodeRuns/{nodeRunId}")`, `retry: true` | On a nodeRun CREATE: resolves the effects that create implies (role → role-activated, action, vault — config read from the run's frozen `blueprintSnapshot`, one `runs/{id}` read, never the live blueprint), claims each in the `dispatchLog` ledger, runs a handler, stamps `dispatch.<type>` back onto the nodeRun. Entirely behind the `serverDispatch` flag — OFF means it logs and returns. |
| `nightlySweep` | Cloud Scheduler, `0 3 * * *` (03:00 daily, America/Denver) | Logs `sweep: no-op`. Phase 1 fills it. |

**Handlers:** notifications (role-activated fan-out, `notify` actions) and
the vault stamp are real — they're Firestore writes, and stubbing them
would mean flipping the flag silently stops workers hearing about stops.
**Email and webhook are stubs**: they log the exact payload they would
send (`email stub — would send` / `webhook stub — would POST`) and return
success. Sessions 3–4 make them real. Run-level effects (`run-completed`
/ `run-failed` admin pings) stay client-side until a `runs` trigger
exists — they carry no nodeRunId, so this trigger cannot see them.

## The dispatch ledger (`dispatchLog`)

Doc id = `<nodeRunId>__<sha256(effect definition)[:16]>`. Claimed with a
read-then-create in a transaction, because triggers are at-least-once and
every invocation must assume it is a duplicate. States: `claimed`
(in-flight or awaiting retry — `lastError` says which), `succeeded`,
`failed` (permanent). Retryable failures **throw** so Functions redelivers;
after `MAX_ATTEMPTS` (5) executions the effect is marked failed
permanently and stops. Config holes (no recipient, no URL) fail
permanently on the first attempt — retrying can't invent a recipient. A
fresh error-free claim younger than 60s belongs to a concurrent
invocation and is skipped; older than that is treated as a crashed
attempt and retried.

## The flag — the single switch

`blueprints/config` document, field `serverDispatch`. It lives in
`blueprints` because that collection is already team-readable under the
frozen rules and the UI's list query filters on `orgId`, so a config doc
without one never appears anywhere. **Absent or anything but `true` =
OFF** (client keeps dispatching exactly as before; the trigger logs
`dispatch: flag off` and returns).

Flip ON: Firebase console → Firestore → `blueprints` → add/edit doc id
`config` → field `serverDispatch` (boolean) = `true`. The client checks
per dispatch call, so open tabs honor it within one advance.
Flip back: set it to `false` (or delete the doc). Never let both paths
run at once — the flag is what prevents double-sends.

## Decisions and why

- **Region `us-central1`, pinned in `index.js` via `setGlobalOptions`.** The
  Firestore database lives in the `nam5` multi-region; a 2nd-gen Firestore
  trigger must be deployed where the database is (nam5 → us-central1), and
  the scheduler follows it so everything stays in one place. If you add a
  function, do not pick another region.
- **`maxInstances: 10` on every function** — a runaway trigger loop (a
  function writing `nodeRuns` and waking itself) hits a 10-instance ceiling
  instead of a four-digit bill. Raise it deliberately, per function, never
  globally on a whim.
- **`firebase-functions/logger` with structured fields, never `console.log`**
  — Phase 1 gets debugged by filtering these fields in Logs Explorer.
- **No `hosting` block in `firebase.json`** — the app is served by GitHub
  Pages from `main`. Firebase Hosting config would be misleading.
- **Never commit a service account key.** `.gitignore` blocks
  `*serviceAccount*` and `functions/.env*`; deploys use your `firebase login`
  identity, and the runtime uses its own service account automatically.

## Deploy

```
firebase deploy --only functions
```

(Project comes from `.firebaserc` → `ez-agency-timeclock`. Needs the Blaze
plan; first deploy may take several minutes while it enables Cloud Run /
Eventarc / Scheduler APIs.)

Deploy a single function while iterating:

```
firebase deploy --only functions:onNodeRunWritten
```

## Tail logs

```
firebase functions:log                          # everything, newest last
firebase functions:log --only nightlySweep      # one function
```

Or in the console: Firebase → Functions → ⋮ on the function → View logs
(opens Cloud Logging with the filter pre-set).

## Emulator

```
cd functions && npm install     # once
firebase emulators:start --only functions,firestore
```

The Functions emulator picks up `onNodeRunWritten` against the Firestore
emulator on 127.0.0.1:8080 — create any doc under `nodeRuns/` in the
emulator UI and watch the log line appear in the terminal. Scheduled
functions do not fire on a clock in the emulator; trigger `nightlySweep`
manually from the emulator UI's Functions tab if you need to see it run.

Note: the rules test suite (`tests/firestore-rules.test.mjs`) uses project id
`demo-ez` and is unaffected by any of this.
