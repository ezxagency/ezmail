/* ============================================================
   WORKFLOW ENGINE — pure blueprint/run logic. No DOM, no
   Firestore, no globals from the rest of the app: everything in
   here takes plain objects in and returns plain objects out, so
   the same file runs unchanged in the browser (classic script,
   loaded before js/workflow.js) and under Node for unit tests.
   BLUEPRINT vs RUN is the load-bearing split (see
   docs/workflow-builder-spec.md): a blueprint is the drawing an
   admin edits; a run executes its own frozen blueprintSnapshot
   and must never feel a later edit to the blueprint it came from.
   ============================================================ */

/* ---------- shapes (JSDoc only — nothing here executes) ---------- */

/**
 * One block on the canvas. `type` decides what `config` holds:
 *  - "trigger": { label? }                       exactly one per blueprint, no incoming edges
 *  - "role":    { role?, assigneeId?, label?, outputs? }  a human acts; the task waits until
 *               they complete. `outputs` DECLARES the named values this stop must record,
 *               [{ key, type:"boolean"|"number"|"text", label? }] — e.g. an approve/reject
 *               role declares { key:"approved", type:"boolean" } and the completion UI
 *               collects it, so a downstream LOGIC/route condition always finds it
 *  - "split":   { mode:"route"|"parallel", branches:[{ id, label, condition?, isElse? }] }
 *               route mode: exactly one branch has isElse:true; edges name their branch via fromHandle
 *  - "logic":   { condition }                    edges carry fromHandle "true" | "false"
 *  - "vault":   { label? }                       save the deliverable, stamp it, KEEP MOVING
 *  - "action":  { actionType:"notify"|"complete"|"email"|"webhook", params? }
 * `waitFor` only matters when 2+ edges point at this node — that IS the
 * merge (there is no merge block): "all" (default) = every LIVE incoming
 * path must arrive; "any" = first arrival wins. Skip tokens from dead
 * route branches count as arrivals (engine rule 1).
 * @typedef {Object} Node
 * @property {string} id
 * @property {"trigger"|"role"|"split"|"logic"|"vault"|"action"} type
 * @property {{x:number, y:number}} position  canvas coordinates — drawing only, the engine ignores them
 * @property {Object} config                  per-type payload, see above
 * @property {"all"|"any"} [waitFor]          merge policy; default "all"
 */

/**
 * A line between two blocks, always output → input (drawn top → bottom;
 * downward = forward). `fromHandle` names WHICH output on a multi-output
 * block: a split branch id, or "true"/"false" on a logic gate.
 * Single-output blocks omit it.
 * @typedef {Object} Edge
 * @property {string} id
 * @property {string} from         source node id
 * @property {string} [fromHandle] branch id | "true" | "false"
 * @property {string} to           target node id
 */

/**
 * A rule a route-split branch or logic gate evaluates. Reads either a
 * field on the task or an earlier nodeRun's output in the same run
 * (engine rule 2) — e.g. approved == true, wordCount > 500.
 * @typedef {Object} Condition
 * @property {"task"|"nodeOutput"} source
 * @property {string} [nodeId]  which node's output, when source is "nodeOutput"
 * @property {string} path      key inside the task / the nodeRun's output
 * @property {"=="|"!="|">"|">="|"<"|"<="|"contains"} op
 * @property {string|number|boolean} value
 */

/**
 * The drawing/template an admin edits. Publishing bumps `version` and
 * flips `status`. Editing a blueprint must NEVER change runs already in
 * flight — every run carries its own frozen copy.
 * @typedef {Object} Blueprint
 * @property {string} id
 * @property {string} orgId    "ez-agency" today; here so multi-org stays possible later
 * @property {string} ownerId  uid of the admin who created it
 * @property {string} name
 * @property {number} version
 * @property {"draft"|"published"} status
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {number} createdAt  Date.now() ms
 * @property {number} updatedAt
 */

/**
 * One real task travelling through a FROZEN copy of a blueprint.
 * @typedef {Object} Run
 * @property {string} id
 * @property {string} blueprintId  provenance only — the engine never reads the live blueprint
 * @property {Blueprint} blueprintSnapshot  the frozen copy this run executes
 * @property {string} taskId
 * @property {string} orgId
 * @property {"running"|"completed"|"failed"|"cancelled"} status
 * @property {string[]} activeNodeIds  where the task is right now
 * @property {number} hops        transitions taken so far; the engine fails the run
 *                                past the hop cap (default 100) so loops can't spin forever
 * @property {number} startedAt
 * @property {number|null} completedAt
 */

/**
 * One node's story inside one run. `output` is what downstream conditions
 * read (engine rule 2): an OPEN key/value map, not a fixed shape. The
 * actor's declared outputs land as named keys (approved:true,
 * wordCount:812), the engine adds its own stamps (a logic gate's boolean
 * `result`, a route split's `pickedBranch`), and the conventional keys
 * `files` (string[]) and `note` (string) ride along with everything else —
 * persist enough here that a later condition never re-derives anything.
 * "skipped" is the dead-path token (engine rule 1): a route split emits
 * it down every un-picked branch and it propagates, so a later
 * waitFor:"all" merge counts that path as arrived instead of
 * deadlocking on a branch that never ran.
 * @typedef {Object} NodeRun
 * @property {string} id
 * @property {string} runId
 * @property {string} nodeId
 * @property {"trigger"|"role"|"split"|"logic"|"vault"|"action"} nodeType
 * @property {"pending"|"waiting"|"in_progress"|"completed"|"skipped"|"failed"} status
 * @property {string} [assigneeId]
 * @property {number} arrivedAt
 * @property {number|null} completedAt
 * @property {Object<string, *>} output  open map: declared outputs + engine stamps
 *                                       + conventional files:string[] / note:string
 */
