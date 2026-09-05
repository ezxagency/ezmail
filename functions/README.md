# functions/ — the server side of EZ Clock In

Cloud Functions for Firebase, **2nd gen**, plain CommonJS JavaScript on the
**Node 20** runtime. No TypeScript, no bundler, no build step — the same
edit-and-deploy principle as the rest of the repo. `index.js` is the whole
surface; split into `lib/` only if it grows past ~100 lines.

## What's here (Phase 0 — deliberate no-ops)

| Function | Trigger | Does |
|---|---|---|
| `onNodeRunWritten` | Firestore `onDocumentWritten("nodeRuns/{nodeRunId}")` | Logs the doc id + create/update/delete. Reads and writes nothing. |
| `nightlySweep` | Cloud Scheduler, `0 3 * * *` (03:00 daily, America/Denver) | Logs `sweep: no-op`. |

They exist to prove the deploy target, the Firestore trigger plumbing, and
the scheduler before any real logic (Phase 1: server-side effect dispatch,
`dueAfter` escalation) rides them.

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
