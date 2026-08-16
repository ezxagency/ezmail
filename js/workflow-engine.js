/* ============================================================
   WORKFLOW ENGINE — pure blueprint/run logic. No DOM, no
   Firestore, no globals from the rest of the app: everything in
   here takes plain objects in and returns plain objects out, so
   the same file runs unchanged in the browser (classic script,
   loaded before js/workflow.js) and under Node for unit tests
   (tests/workflow-engine.test.mjs).
   BLUEPRINT vs RUN is the load-bearing split (see
   docs/workflow-builder-spec.md): a blueprint is the drawing an
   admin edits; a run executes its own frozen blueprintSnapshot
   and must never feel a later edit to the blueprint it came from.

   HOW ADVANCEMENT WORKS (the reconcile, not deltas): a finished
   attempt (nodeRun) EMITS a token on each outgoing edge —
   "completed" down taken paths, "skip" down a route split's
   un-picked branches and everything below a skipped node. A
   LOGIC gate emits ONLY down its taken side: the other side gets
   nothing this pass — in a loop it may be taken next pass, and a
   skip there would masquerade as a dead path and echo around the
   loop (nested loops make that visible as phantom "skipped"
   attempts of live nodes). Each new attempt records exactly which
   emissions it consumed (inputs: edgeId → emitter nodeRun id).
   A pending arrival is an emission no attempt has consumed —
   derived from persisted state alone, never from memory, so
   wfAdvance(state, event) is deterministic and the glue can
   re-run it inside a Firestore transaction: two branches
   finishing at once cannot double-fire a join, because the
   second transaction sees the join's attempt already consuming
   its edge.

   A node with 2+ incoming edges IS the merge. It fires when
   every live incoming path has ARRIVED OR PROVABLY CAN'T:
   waitFor:"all" = each edge has a pending arrival or no token
   anywhere in flight can still reach it (reachability that
   never routes through the merge node itself — which is exactly
   what makes a loop-back re-entry its own fresh iteration
   instead of a deadlock waiting on edges spent last pass);
   waitFor:"any" = the first completed arrival wins. Skips count
   as arrivals; a merge whose arrivals are ALL skips skips
   itself and propagates. One guard keeps skips from echoing
   around loops forever: only COMPLETED work may start a node's
   next iteration — an all-skip arrival landing solely on edges
   the node's latest attempt already consumed is absorbed as
   bookkeeping (absorbed: edgeId → emitter ids), not re-fired.
   The hop cap (every created attempt is a hop) is the loop
   guard of last resort: past it the run status goes "failed".
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
 * field on the run's frozen task or an earlier nodeRun's output in the
 * same run (engine rule 2) — e.g. approved == true, wordCount > 500.
 * A missing referenced value makes the condition FALSE, never a throw:
 * a route falls through toward its else, a gate resolves to its false
 * side. Readable outputs: a role's declared keys, a logic gate's
 * `result`, a route split's `pickedBranch`.
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
 * After creation the engine only ever CHANGES status, activeNodeIds,
 * hops and completedAt — exactly the firestore.rules team-write
 * allowlist for run docs, so a worker-driven advance can always land.
 * @typedef {Object} Run
 * @property {string} id
 * @property {string} blueprintId  provenance only — the engine never reads the live blueprint
 * @property {Blueprint} blueprintSnapshot  the frozen copy this run executes
 * @property {string} taskId
 * @property {Object} task        task fields conditions read — frozen at start, like the snapshot
 * @property {string} orgId
 * @property {"running"|"completed"|"failed"|"cancelled"} status
 * @property {string[]} activeNodeIds  where the task is right now
 * @property {number} hops        attempts created so far; past the cap (default 100)
 *                                the run fails, so loops can't spin forever
 * @property {number} startedAt
 * @property {number|null} completedAt
 */

/**
 * One node's story inside one run. Loops revisit nodes, so one node can
 * have many attempts; `seq` is the total creation order (Firestore
 * returns docs unordered — the glue must sort by it before advancing).
 * `inputs`/`absorbed` are the engine's arrival bookkeeping described in
 * the header. `output` is what downstream conditions read (engine rule
 * 2): an OPEN key/value map, not a fixed shape. The actor's declared
 * outputs land as named keys (approved:true, wordCount:812), the engine
 * adds its own stamps (a logic gate's boolean `result`, a route split's
 * `pickedBranch`), and the conventional keys `files` (string[]) and
 * `note` (string) ride along with everything else — persist enough here
 * that a later condition never re-derives anything.
 * "skipped" is the dead-path token (engine rule 1): a route split emits
 * it down every un-picked branch and it propagates, so a later
 * waitFor:"all" merge counts that path as arrived instead of
 * deadlocking on a branch that never ran.
 * @typedef {Object} NodeRun
 * @property {string} id          runId:nodeId:attemptN — deterministic, no randomness
 * @property {number} seq         creation order across the whole run
 * @property {string} runId
 * @property {string} nodeId
 * @property {"trigger"|"role"|"split"|"logic"|"vault"|"action"} nodeType
 * @property {"pending"|"waiting"|"in_progress"|"completed"|"skipped"|"failed"} status
 * @property {string} [assigneeId]
 * @property {number} arrivedAt
 * @property {number|null} completedAt
 * @property {Object<string, *>} output  open map: declared outputs + engine stamps
 *                                       + conventional files:string[] / note:string
 * @property {Object<string, string>} inputs    edgeId → the emission (nodeRun id) this attempt consumed
 * @property {Object<string, string[]>} [absorbed]  edgeId → skip emissions swallowed as loop-echo bookkeeping
 */

const WF_MAX_HOPS = 100;

const wfClone = v => JSON.parse(JSON.stringify(v));

/* ============================================================
   CONDITIONS
   ============================================================ */
/** @param {Condition} cond  @param {{task:Object, nodeRuns:NodeRun[]}} ctx */
function wfEvalCondition(cond, ctx){
  let v;
  if (cond.source === "task"){
    v = ctx.task ? ctx.task[cond.path] : undefined;
  } else {
    // "earlier nodeRuns in the same run": on a loop the LATEST completed
    // attempt is the one whose answer matters (the rework, not the
    // rejected first pass). nodeRuns arrive here in creation order.
    const done = (ctx.nodeRuns || []).filter(nr => nr.nodeId === cond.nodeId && nr.status === "completed");
    const latest = done.length ? done[done.length - 1] : null;
    v = latest && latest.output ? latest.output[cond.path] : undefined;
  }
  // a value that was never recorded can't satisfy any rule - not even
  // "!=". Predictable beats clever: missing means false, full stop.
  if (v === undefined || v === null) return false;
  switch (cond.op){
    case "==": return v === cond.value;
    case "!=": return v !== cond.value;
    case ">": case ">=": case "<": case "<=": {
      const a = Number(v), b = Number(cond.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return cond.op === ">" ? a > b : cond.op === ">=" ? a >= b : cond.op === "<" ? a < b : a <= b;
    }
    case "contains":
      if (typeof v === "string") return v.includes(String(cond.value));
      if (Array.isArray(v)) return v.includes(cond.value);
      return false;
    default: return false;
  }
}

/* ============================================================
   VALIDATION — the publish checks. Friendly inline errors
   ({code, msg, nodeId?, edgeId?}), not a wall; [] means valid.
   Drafts may save broken - only publishing (and starting a run)
   goes through this.
   ============================================================ */
/** @param {Blueprint} bp  @returns {{code:string, msg:string, nodeId?:string, edgeId?:string}[]} */
function wfValidate(bp){
  const errs = [];
  const nodes = bp.nodes || [], edges = bp.edges || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const err = (code, msg, nodeId, edgeId) => {
    const e = { code, msg };
    if (nodeId) e.nodeId = nodeId;
    if (edgeId) e.edgeId = edgeId;
    errs.push(e);
  };

  edges.forEach(e => {
    if (!byId.has(e.from) || !byId.has(e.to))
      err("edge-endpoint", "This line is connected to a block that no longer exists.", null, e.id);
  });
  const okEdges = edges.filter(e => byId.has(e.from) && byId.has(e.to));
  const inTo = id => okEdges.filter(e => e.to === id);
  const outOf = id => okEdges.filter(e => e.from === id);

  const triggers = nodes.filter(n => n.type === "trigger");
  if (!triggers.length) err("no-trigger", "Add a Trigger block — every workflow starts with exactly one.");
  triggers.slice(1).forEach(n => err("many-triggers", "Only one Trigger per workflow — remove the extras.", n.id));
  triggers.forEach(n => {
    if (inTo(n.id).length) err("trigger-incoming", "The Trigger can't have incoming lines — it's where work enters.", n.id);
  });

  nodes.forEach(n => {
    if (n.type !== "trigger" && !inTo(n.id).length)
      err("floating", "No line reaches this block, so work never will either.", n.id);
  });

  // "no floats" also means no disconnected islands: a pair of blocks
  // feeding each other passes the incoming-line check while being
  // unreachable, so walk forward from the trigger too
  const unreachable = new Set();
  if (triggers.length === 1){
    const seen = new Set([triggers[0].id]);
    const q = [triggers[0].id];
    while (q.length) outOf(q.shift()).forEach(e => { if (!seen.has(e.to)){ seen.add(e.to); q.push(e.to); } });
    nodes.forEach(n => {
      if (!seen.has(n.id)){ unreachable.add(n.id); err("unreachable", "No path from the Trigger reaches this block.", n.id); }
    });
  }

  // an END is a block with no outgoing lines that is allowed to be one:
  // not the trigger (that's the start) and not a vault (spec: a vault
  // stamps and KEEPS MOVING - it is never an end)
  const vaultEnds = new Set();
  nodes.forEach(n => {
    if (n.type === "vault" && !outOf(n.id).length){
      vaultEnds.add(n.id);
      err("vault-end", "A Vault isn't an end — it stamps and keeps moving. Connect it onward.", n.id);
    }
  });
  const canEnd = new Set(nodes.filter(n => !outOf(n.id).length && n.type !== "trigger" && n.type !== "vault").map(n => n.id));
  let grew = true;
  while (grew){
    grew = false;
    okEdges.forEach(e => { if (canEnd.has(e.to) && !canEnd.has(e.from)){ canEnd.add(e.from); grew = true; } });
  }
  nodes.forEach(n => {
    if (!canEnd.has(n.id) && !vaultEnds.has(n.id) && !unreachable.has(n.id))
      err("dangling", "Work entering this block can never reach an end — connect the path onward.", n.id);
  });

  nodes.forEach(n => {
    const cfg = n.config || {};
    const out = outOf(n.id);
    if (n.type === "split"){
      if (out.length < 2) err("split-outgoing", "A Split needs at least two outgoing branches.", n.id);
      const branches = cfg.branches || [];
      const bIds = new Set(branches.map(b => b.id));
      out.forEach(e => {
        if (!e.fromHandle || !bIds.has(e.fromHandle))
          err("split-handle", "This line isn't attached to one of the Split's branches.", n.id, e.id);
      });
      if ((cfg.mode || "route") === "route"){
        if (branches.filter(b => b.isElse).length !== 1)
          err("route-else", "A routing Split needs exactly one “else” branch to catch everything unmatched.", n.id);
        branches.forEach(b => {
          if (!b.isElse && !b.condition)
            err("branch-condition", "Branch “" + (b.label || b.id) + "” needs a rule (or mark it as the else).", n.id);
        });
      }
    }
    if (n.type === "logic"){
      if (!cfg.condition) err("logic-condition", "This gate needs a yes/no rule.", n.id);
      const hs = new Set(out.map(e => e.fromHandle));
      if (!hs.has("true") || !hs.has("false"))
        err("logic-handles", "A gate needs both paths connected: one for yes, one for no.", n.id);
    }
    if (n.type === "role" && !cfg.role && !cfg.assigneeId)
      err("role-assignee", "Who works here? Pick a person or a role.", n.id);
    if (n.type === "action" && !cfg.actionType)
      err("action-type", "Pick what this Action does (notify, complete, email, webhook).", n.id);
  });

  // the declaration invariant: a rule may only read a value some block
  // actually records - a role's declared outputs, a gate's result, a
  // route's pickedBranch. Catching it at publish means a running task
  // can never hit a rule that dangles.
  const conds = [];
  nodes.forEach(n => {
    const cfg = n.config || {};
    if (n.type === "logic" && cfg.condition) conds.push({ cond: cfg.condition, nodeId: n.id });
    if (n.type === "split") (cfg.branches || []).forEach(b => { if (b.condition) conds.push({ cond: b.condition, nodeId: n.id }); });
  });
  conds.forEach(({ cond, nodeId }) => {
    if (cond.source !== "nodeOutput") return;
    const src = byId.get(cond.nodeId);
    if (!src){
      err("cond-output", "This rule reads from a block that no longer exists.", nodeId);
      return;
    }
    const declared = src.type === "role" ? ((src.config || {}).outputs || []).map(o => o.key)
      : src.type === "logic" ? ["result"]
      : src.type === "split" ? ["pickedBranch"] : [];
    if (!declared.includes(cond.path))
      err("cond-output", "This rule reads “" + cond.path + "” from a block that never records it.", nodeId);
  });

  return errs;
}

/* ============================================================
   ARRIVAL BOOKKEEPING (all derived, nothing cached)
   ============================================================ */
/* What tokens a finished attempt sends, per outgoing edge. A completed
   route split sends "completed" down the picked branch and "skip" down
   the rest (dead-path elimination, engine rule 1); a completed logic
   gate sends "completed" down its taken side and NOTHING down the other
   — not dead, just not this pass; a skipped anything sends "skip"
   everywhere below it. */
function wfEmissions(bp, nr){
  if (nr.status !== "completed" && nr.status !== "skipped") return [];
  const node = bp.nodes.find(n => n.id === nr.nodeId);
  if (!node) return [];
  const out = bp.edges.filter(e => e.from === nr.nodeId);
  if (nr.status === "skipped") return out.map(e => ({ edge: e, kind: "skip", emitter: nr.id }));
  if (node.type === "split" && ((node.config && node.config.mode) || "route") === "route"){
    const picked = nr.output ? nr.output.pickedBranch : null;
    return out.map(e => ({ edge: e, kind: e.fromHandle === picked ? "completed" : "skip", emitter: nr.id }));
  }
  if (node.type === "logic"){
    const took = String(!!(nr.output && nr.output.result));
    return out.filter(e => e.fromHandle === took).map(e => ({ edge: e, kind: "completed", emitter: nr.id }));
  }
  return out.map(e => ({ edge: e, kind: "completed", emitter: nr.id }));
}

/* Every emission not yet consumed (inputs) or swallowed (absorbed) by a
   downstream attempt - in creation order, so "oldest first" is stable. */
function wfPendingArrivals(bp, nodeRuns){
  const consumed = new Set();
  nodeRuns.forEach(nr => {
    Object.entries(nr.inputs || {}).forEach(([edgeId, emitter]) => consumed.add(edgeId + "|" + emitter));
    Object.entries(nr.absorbed || {}).forEach(([edgeId, emitters]) =>
      emitters.forEach(em => consumed.add(edgeId + "|" + em)));
  });
  const pend = [];
  nodeRuns.forEach(nr => wfEmissions(bp, nr).forEach(em => {
    if (!consumed.has(em.edge.id + "|" + em.emitter)) pend.push(em);
  }));
  return pend;
}

/* Which edges some token in flight could still reach - the "provably
   can't arrive" half of the merge rule. Flows never route THROUGH the
   merge node being asked about: its own firing can't be what feeds it.
   (Over-approximates for exotic nested-join loops - it may keep a merge
   waiting; the hop cap still bounds every run.) */
function wfFeedableEdges(bp, nodeRuns, pending, mergeNodeId){
  const feedable = new Set(), seen = new Set(), q = [];
  nodeRuns.forEach(nr => {
    if (nr.status === "in_progress" && nr.nodeId !== mergeNodeId) q.push(nr.nodeId);
  });
  pending.forEach(p => { if (p.edge.to !== mergeNodeId) q.push(p.edge.to); });
  while (q.length){
    const n = q.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    bp.edges.forEach(e => {
      if (e.from !== n) return;
      feedable.add(e.id);
      if (e.to !== mergeNodeId && !seen.has(e.to)) q.push(e.to);
    });
  }
  return feedable;
}

/* ============================================================
   ACTIVATION — what happens when a token actually lands on a
   block. Roles wait for a human; everything else resolves on
   the spot and the reconcile keeps rolling.
   ============================================================ */
function wfResolve(bp, state, node, nr, opts, effects){
  const now = opts.now || 0;
  const cfg = node.config || {};
  const ctx = { task: state.run.task, nodeRuns: state.nodeRuns };
  if (node.type === "role"){
    nr.status = "in_progress";
    nr.assigneeId = cfg.assigneeId || null;
    effects.push({ type: "role-activated", nodeId: node.id, nodeRunId: nr.id,
      role: cfg.role || null, assigneeId: cfg.assigneeId || null });
    return;
  }
  if (node.type === "split" && (cfg.mode || "route") === "route"){
    let picked = null;
    for (const b of (cfg.branches || [])){
      if (!b.isElse && b.condition && wfEvalCondition(b.condition, ctx)){ picked = b.id; break; }
    }
    if (picked === null){
      const els = (cfg.branches || []).find(b => b.isElse);
      picked = els ? els.id : null;
    }
    nr.output.pickedBranch = picked;
  } else if (node.type === "logic"){
    nr.output.result = cfg.condition ? wfEvalCondition(cfg.condition, ctx) : false;
  } else if (node.type === "vault"){
    nr.output.stampedAt = now;
    effects.push({ type: "vault", nodeId: node.id, nodeRunId: nr.id });
  } else if (node.type === "action"){
    effects.push({ type: "action", nodeId: node.id, nodeRunId: nr.id,
      actionType: cfg.actionType || null, params: cfg.params || {} });
  }
  nr.status = "completed";
  nr.completedAt = now;
}

/* ============================================================
   THE RECONCILE — recompute the run forward until nothing more
   can move without a human. Mutates `state` (its caller owns
   the clone) and appends to `effects`.
   ============================================================ */
function wfReconcile(bp, state, opts, effects){
  const maxHops = opts.maxHops || WF_MAX_HOPS;
  const now = opts.now || 0;

  while (state.run.status === "running"){
    const pending = wfPendingArrivals(bp, state.nodeRuns);
    if (!pending.length) break;
    let acted = false;

    for (const node of bp.nodes){
      const inc = bp.edges.filter(e => e.to === node.id);
      if (!inc.length) continue;

      // oldest unconsumed arrival per incoming edge
      const perEdge = new Map();
      pending.forEach(p => {
        if (p.edge.to === node.id && !perEdge.has(p.edge.id)) perEdge.set(p.edge.id, p);
      });
      if (!perEdge.size) continue;

      const anyCompleted = [...perEdge.values()].some(p => p.kind === "completed");
      let fire;
      if (inc.length === 1) fire = true;
      else {
        const feedable = wfFeedableEdges(bp, state.nodeRuns, pending, node.id);
        const settled = inc.every(e => perEdge.has(e.id) || !feedable.has(e.id));
        fire = (node.waitFor || "all") === "any" ? (anyCompleted || settled) : settled;
      }
      if (!fire) continue;

      const attempts = state.nodeRuns.filter(nr => nr.nodeId === node.id);
      const latest = attempts[attempts.length - 1] || null;

      // loop-echo guard: only completed work starts a new iteration. An
      // all-skip arrival landing solely on edges the latest attempt
      // already consumed is a dead path's echo coming around a loop -
      // swallow it as bookkeeping or it would re-skip this node forever.
      if (!anyCompleted && latest){
        const known = new Set([...Object.keys(latest.inputs || {}), ...Object.keys(latest.absorbed || {})]);
        if ([...perEdge.keys()].every(id => known.has(id))){
          latest.absorbed = latest.absorbed || {};
          perEdge.forEach((p, edgeId) => {
            (latest.absorbed[edgeId] = latest.absorbed[edgeId] || []).push(p.emitter);
          });
          acted = true;
          break;
        }
      }

      if (state.run.hops + 1 > maxHops){
        state.run.status = "failed";
        state.run.completedAt = now;
        state.nodeRuns.forEach(nr => { if (nr.status === "in_progress") nr.status = "failed"; });
        effects.push({ type: "run-failed", reason: "hop-cap", hops: state.run.hops });
        break;
      }
      state.run.hops++;

      const inputs = {};
      perEdge.forEach((p, edgeId) => { inputs[edgeId] = p.emitter; });
      const nr = {
        id: state.run.id + ":" + node.id + ":" + (attempts.length + 1),
        seq: state.nodeRuns.length,
        runId: state.run.id, nodeId: node.id, nodeType: node.type,
        status: "in_progress", assigneeId: null,
        arrivedAt: now, completedAt: null, output: {}, inputs
      };
      state.nodeRuns.push(nr);
      if (!anyCompleted){
        nr.status = "skipped";     // the merge itself dies: all live paths were dead
        nr.completedAt = now;      // ...and wfEmissions now propagates the skip below it
      } else {
        wfResolve(bp, state, node, nr, opts, effects);
      }
      acted = true;
      break;   // the pending list is stale now - recompute from the top
    }

    if (!acted) break;   // arrivals remain, but every merge is legitimately waiting
  }

  state.run.activeNodeIds = state.nodeRuns.filter(nr => nr.status === "in_progress").map(nr => nr.nodeId);
  if (state.run.status === "running" && !state.run.activeNodeIds.length
      && !wfPendingArrivals(bp, state.nodeRuns).length){
    state.run.status = "completed";
    state.run.completedAt = now;
    effects.push({ type: "run-completed" });
  }
  return state;
}

/* ============================================================
   PUBLIC API
   ============================================================ */
/**
 * Start a run: freeze the blueprint into the run, fire the trigger,
 * reconcile forward. Throws if the blueprint doesn't validate - a run
 * must never begin on a graph the publish checks would reject.
 * @param {{blueprint:Blueprint, runId:string, taskId?:string, task?:Object,
 *          orgId?:string, now?:number, maxHops?:number}} args
 * @returns {{run:Run, nodeRuns:NodeRun[], effects:Object[]}}
 */
function wfStartRun(args){
  const { blueprint, runId, taskId, task, orgId, now, maxHops } = args;
  const errs = wfValidate(blueprint);
  if (errs.length) throw new Error("Blueprint doesn't validate: " + errs[0].msg);
  const bp = wfClone(blueprint);
  const run = {
    id: runId, blueprintId: blueprint.id, blueprintSnapshot: bp,
    taskId: taskId || null, task: wfClone(task || {}),
    orgId: orgId || bp.orgId || "ez-agency",
    status: "running", activeNodeIds: [], hops: 1,
    startedAt: now || 0, completedAt: null
  };
  const trigger = bp.nodes.find(n => n.type === "trigger");
  const state = { run, nodeRuns: [{
    id: run.id + ":" + trigger.id + ":1", seq: 0, runId: run.id,
    nodeId: trigger.id, nodeType: "trigger", status: "completed",
    assigneeId: null, arrivedAt: now || 0, completedAt: now || 0, output: {}, inputs: {}
  }] };
  const effects = [];
  wfReconcile(bp, state, { now: now || 0, maxHops }, effects);
  return { run: state.run, nodeRuns: state.nodeRuns, effects };
}

/**
 * The reconcile entry point: apply one event to the persisted state and
 * recompute the next full state. Never mutates its input - returns fresh
 * objects, deterministic for the same (state, event, opts), so the glue
 * can run it inside a Firestore transaction and retry safely.
 * @param {{run:Run, nodeRuns:NodeRun[]}} prev  persisted state (nodeRuns in any order)
 * @param {{type:"complete", nodeRunId:string, output?:Object}} event
 * @param {{now?:number, maxHops?:number}} [opts]
 * @returns {{run:Run, nodeRuns:NodeRun[], effects:Object[]}}
 */
function wfAdvance(prev, event, opts){
  opts = opts || {};
  const state = { run: wfClone(prev.run), nodeRuns: wfClone(prev.nodeRuns) };
  state.nodeRuns.sort((a, b) => a.seq - b.seq);
  const bp = state.run.blueprintSnapshot;
  const effects = [];

  if (!event || event.type !== "complete") throw new Error("Unknown event: " + (event && event.type));
  if (state.run.status !== "running") throw new Error("Run is " + state.run.status + " — nothing can advance it.");
  const nr = state.nodeRuns.find(x => x.id === event.nodeRunId);
  if (!nr) throw new Error("No such stop: " + event.nodeRunId);
  if (nr.status !== "in_progress") throw new Error("This stop is " + nr.status + ", not awaiting work.");

  // the declaration contract, enforced at the door: a stop that promised
  // {approved} can't complete without it, or every downstream rule that
  // reads it would silently go false. requiresOutput:false opts a role
  // out - its declared values become best-effort, and rule 2's law
  // (missing reads as false) covers whatever goes unrecorded.
  const node = bp.nodes.find(n => n.id === nr.nodeId);
  const declared = node && node.type === "role" && (node.config || {}).requiresOutput !== false
    ? ((node.config || {}).outputs || []) : [];
  const output = Object.assign({}, event.output || {});
  const missing = declared.filter(d => output[d.key] === undefined).map(d => d.key);
  if (missing.length) throw new Error("This stop must record: " + missing.join(", "));

  nr.output = Object.assign({}, nr.output, output);
  nr.status = "completed";
  nr.completedAt = opts.now || 0;
  wfReconcile(bp, state, opts, effects);
  return { run: state.run, nodeRuns: state.nodeRuns, effects };
}

/* Node test hook — the browser never defines `module`, so this block is
   invisible there; tests/workflow-engine.test.mjs requires this file. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { WF_MAX_HOPS, wfValidate, wfEvalCondition, wfStartRun, wfAdvance };
}
