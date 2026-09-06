/* ============================================================
   AUTOMATIONS — trigger, condition, action.

   Pure: events and rows in, a PLAN out. It decides what should
   happen and never makes it happen, which is the same split
   item-engine.js already uses and for the same reason - a
   decision that writes nothing can be tested exhaustively, and
   the glue that carries it out stays dumb enough to move to a
   server later without moving a rule.

   WHY THE EVENT LOG IS THE TRIGGER SURFACE. Every change already
   appends an event describing exactly what happened and what it
   changed from. Automations read those rather than watching
   documents, so a rule fires on the CHANGE - "when this moved to
   Review" - rather than on a state it might have been sitting in
   all week.

   ONE CONDITION LANGUAGE. Conditions are evaluated by
   wfEvalCondition() from js/workflow-engine.js - the same
   grammar the workflow gates use. A second expression evaluator
   would be a second set of bugs, a second thing to document, and
   two subtly different answers to "is this field empty".

   TERMINATION, TWICE OVER. An automation's action produces
   events, which can trigger more automations. Two things stop
   that running away, and the first is the good one:

   1. A no-op writes nothing. Setting a field to the value it
      already holds returns zero events from itemCommit, so the
      commonest loop - two rules that keep answering each other -
      dies on its second lap without anyone noticing.
   2. causationDepth is the guard of last resort, capped like the
      workflow engine's hop count. Past it the chain stops and
      says so rather than quietly continuing.
   ============================================================ */

const AUTO_MAX_DEPTH = 10;
const AUTO_ACTION_KINDS = ["set_status", "set_field", "assign", "notify"];

/* A rule fires on one verb, optionally narrowed to one kind of work.
   Both halves are cheap and neither reads the database. */
function autoTriggerMatches(automation, event, item){
  const t = automation && automation.trigger;
  if (!t || !t.verb) return false;
  if (t.verb !== event.verb) return false;
  if (t.typeId && (!item || item.typeId !== t.typeId)) return false;
  return true;
}

/* The Item is handed to the shared grammar as the run's `task`, so
   source:"task" reads its own properties (status, title) and
   source:"field" reads its values - exactly as a workflow gate would
   read them. Nothing new to learn, and nothing new to get wrong. */
const autoContext = item => ({ task: item, nodeRuns: [] });

function autoConditionsPass(automation, item){
  const conds = (automation && automation.conditions) || [];
  if (!conds.length) return true;                 // no conditions is "always"
  const ctx = autoContext(item);
  return conds.every(c => wfEvalCondition(c, ctx));
}

/* One action becomes either an intent for itemCommit or a notification
   for the glue to deliver. Anything unrecognised is skipped and named,
   never guessed at - a rule doing something almost-right is worse than
   a rule visibly doing nothing. */
function autoActionToStep(action, item){
  if (!action || AUTO_ACTION_KINDS.indexOf(action.kind) < 0) return null;
  if (action.kind === "set_status")
    return { kind: "intent", intent: { kind: "set_status", status: action.status } };
  if (action.kind === "set_field")
    return { kind: "intent", intent: { kind: "update", fields: { [action.key]: action.value } } };
  if (action.kind === "assign") {
    // "add" leaves who is already there alone, which is what a rule that
    // brings a reviewer in almost always means; "set" replaces outright
    const now = (item && item.assigneeIds) || [];
    const ids = action.assigneeIds || [];
    const next = action.mode === "set" ? ids : [...new Set([...now, ...ids])];
    return { kind: "intent", intent: { kind: "assign", assigneeIds: next } };
  }
  if (action.kind === "notify")
    return { kind: "notify", toUids: action.toUids || [], toRole: action.toRole || null,
             message: action.message || "" };
  return null;
}

/* THE PLAN. Every rule that matches this one event, in the order they
   were defined, with what each would do.

   args = { automations, event, item, depth }
   Returns { steps, fired, skipped, stopped } - `stopped` set when the
   chain hit its depth cap, so the caller can say so rather than leaving
   a rule looking like it silently declined to run. */
function autoPlan(args){
  const { automations, event, item } = args;
  const depth = args.depth || 0;
  if (depth >= AUTO_MAX_DEPTH)
    return { steps: [], fired: [], skipped: [], stopped: "max-depth" };

  const steps = [], fired = [], skipped = [];
  (automations || []).forEach(a => {
    if (a.enabled === false) return;
    if (!autoTriggerMatches(a, event, item)) return;
    if (!autoConditionsPass(a, item)) { skipped.push({ id: a.id, why: "conditions" }); return; }
    let any = false;
    (a.actions || []).forEach(action => {
      const step = autoActionToStep(action, item);
      if (!step) { skipped.push({ id: a.id, why: "unknown-action:" + (action && action.kind) }); return; }
      steps.push(Object.assign({ automationId: a.id, depth: depth + 1 }, step));
      any = true;
    });
    if (any) fired.push(a.id);
  });
  return { steps, fired, skipped, stopped: null };
}

/* Node test hook — the browser never defines `module`, so this block is
   invisible there; tests/automation.test.mjs requires this file. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { AUTO_MAX_DEPTH, AUTO_ACTION_KINDS, autoTriggerMatches,
    autoConditionsPass, autoActionToStep, autoPlan };
}
