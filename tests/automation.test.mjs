/* Unit tests for ../js/automation.js - pure, so no emulator, no DOM, no
   Firebase: plain node.
     node tests/automation.test.mjs

   automation.js calls wfEvalCondition(), which in the browser is a global
   from js/workflow-engine.js loaded before it. Putting it on globalThis
   here reproduces that shared scope exactly rather than pretending the
   file has imports it does not have. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { wfEvalCondition } = require("../js/workflow-engine.js");
globalThis.wfEvalCondition = wfEvalCondition;
const A = require("../js/automation.js");
const { itemCommit } = require("../js/item-engine.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};

const ITEM = { id: "i1", orgId: "orgA", typeId: "shiftswap", title: "Friday",
  status: "open", assigneeIds: ["u1"], fields: { priority: "high", urgent: true, hours: 4 } };
const EV = (verb, data) => ({ orgId: "orgA", actorId: "u1", at: 1, verb,
  subject: { kind: "item", id: "i1" }, data: data || {} });
const RULE = over => Object.assign({
  id: "a1", name: "R", enabled: true,
  trigger: { verb: "item.created" }, conditions: [],
  actions: [{ kind: "notify", toRole: "manager", message: "New one" }]
}, over);

/* ---------- triggers ---------- */
T("a rule fires on its own verb", () => {
  assert.ok(A.autoTriggerMatches(RULE(), EV("item.created"), ITEM));
});
T("and on nothing else", () => {
  assert.ok(!A.autoTriggerMatches(RULE(), EV("item.status_changed"), ITEM));
});
T("a rule can be narrowed to one kind of work", () => {
  const r = RULE({ trigger: { verb: "item.created", typeId: "shiftswap" } });
  assert.ok(A.autoTriggerMatches(r, EV("item.created"), ITEM));
  assert.ok(!A.autoTriggerMatches(r, EV("item.created"), { typeId: "task" }));
});
T("a rule with no verb never fires", () => {
  assert.ok(!A.autoTriggerMatches(RULE({ trigger: {} }), EV("item.created"), ITEM));
});
T("a disabled rule is not planned", () => {
  const p = A.autoPlan({ automations: [RULE({ enabled: false })], event: EV("item.created"), item: ITEM });
  assert.deepEqual(p.fired, []);
});

/* ---------- conditions, in the workflow engine's own grammar ---------- */
T("no conditions means always", () => {
  assert.ok(A.autoConditionsPass(RULE(), ITEM));
});
T("a condition reads the Item's fields", () => {
  const r = RULE({ conditions: [{ source: "field", path: "priority", op: "==", value: "high" }] });
  assert.ok(A.autoConditionsPass(r, ITEM));
  assert.ok(!A.autoConditionsPass(r, Object.assign({}, ITEM, { fields: { priority: "low" } })));
});
T("a condition reads the Item's own properties", () => {
  const r = RULE({ conditions: [{ source: "task", path: "status", op: "==", value: "open" }] });
  assert.ok(A.autoConditionsPass(r, ITEM));
});
T("conditions are AND - every one has to hold", () => {
  const r = RULE({ conditions: [
    { source: "field", path: "priority", op: "==", value: "high" },
    { source: "field", path: "hours", op: ">", value: 10 }
  ]});
  assert.ok(!A.autoConditionsPass(r, ITEM));
});
T("a value that was never recorded satisfies nothing, as everywhere else", () => {
  const r = RULE({ conditions: [{ source: "field", path: "ghost", op: "!=", value: "x" }] });
  assert.ok(!A.autoConditionsPass(r, ITEM), "missing must read as false, not as 'not equal'");
});

/* ---------- actions ---------- */
T("set_status becomes a status intent", () => {
  const s = A.autoActionToStep({ kind: "set_status", status: "review" }, ITEM);
  assert.deepEqual(s.intent, { kind: "set_status", status: "review" });
});
T("set_field becomes an update intent", () => {
  const s = A.autoActionToStep({ kind: "set_field", key: "priority", value: "low" }, ITEM);
  assert.deepEqual(s.intent, { kind: "update", fields: { priority: "low" } });
});
T("assign ADDS by default, keeping whoever is already on it", () => {
  const s = A.autoActionToStep({ kind: "assign", assigneeIds: ["u2"] }, ITEM);
  assert.deepEqual(s.intent.assigneeIds.sort(), ["u1", "u2"]);
});
T("assign can replace outright when asked to", () => {
  const s = A.autoActionToStep({ kind: "assign", assigneeIds: ["u2"], mode: "set" }, ITEM);
  assert.deepEqual(s.intent.assigneeIds, ["u2"]);
});
T("assign adding somebody already there changes nothing", () => {
  const s = A.autoActionToStep({ kind: "assign", assigneeIds: ["u1"] }, ITEM);
  assert.deepEqual(s.intent.assigneeIds, ["u1"]);
});
T("notify is not an intent - nothing about the item changes", () => {
  const s = A.autoActionToStep({ kind: "notify", toRole: "manager", message: "hi" }, ITEM);
  assert.equal(s.kind, "notify");
  assert.equal(s.intent, undefined);
});
T("an action nobody implemented is skipped, and named", () => {
  assert.equal(A.autoActionToStep({ kind: "launch_rocket" }, ITEM), null);
  const p = A.autoPlan({ automations: [RULE({ actions: [{ kind: "launch_rocket" }] })],
    event: EV("item.created"), item: ITEM });
  assert.deepEqual(p.fired, []);
  assert.ok(p.skipped[0].why.startsWith("unknown-action"), JSON.stringify(p.skipped));
});

/* ---------- the plan ---------- */
T("several rules fire in the order they were defined", () => {
  const p = A.autoPlan({ automations: [
    RULE({ id: "a1", actions: [{ kind: "set_status", status: "review" }] }),
    RULE({ id: "a2", actions: [{ kind: "assign", assigneeIds: ["u2"] }] })
  ], event: EV("item.created"), item: ITEM });
  assert.deepEqual(p.fired, ["a1", "a2"]);
  assert.deepEqual(p.steps.map(s => s.automationId), ["a1", "a2"]);
});
T("a rule whose conditions fail is recorded as skipped, not silently dropped", () => {
  const p = A.autoPlan({ automations: [RULE({ conditions: [{ source: "field", path: "priority", op: "==", value: "low" }] })],
    event: EV("item.created"), item: ITEM });
  assert.deepEqual(p.fired, []);
  assert.equal(p.skipped[0].why, "conditions");
});
T("every step carries the depth it would run at", () => {
  const p = A.autoPlan({ automations: [RULE({ actions: [{ kind: "set_status", status: "review" }] })],
    event: EV("item.created"), item: ITEM, depth: 3 });
  assert.equal(p.steps[0].depth, 4);
});

/* ---------- termination ---------- */
T("the depth cap stops a chain and says why", () => {
  const p = A.autoPlan({ automations: [RULE()], event: EV("item.created"), item: ITEM,
    depth: A.AUTO_MAX_DEPTH });
  assert.deepEqual(p.steps, []);
  assert.equal(p.stopped, "max-depth");
});

/* The better guard, and the one that actually stops the common case: a
   rule that writes what is already there produces no event, so the chain
   ends on its second lap rather than at the cap. */
T("a rule writing a value that is already set produces NO event, so nothing re-triggers", () => {
  const type = { id: "shiftswap", fields: [{ key: "priority", type: "select", options: ["high", "low"] }],
    statuses: [{ key: "open" }, { key: "review" }] };
  const step = A.autoActionToStep({ kind: "set_field", key: "priority", value: "high" }, ITEM);
  const r = itemCommit({ type, item: ITEM, intent: step.intent, actor: { uid: "u1", orgId: "orgA" },
    allow: () => true, now: 5 });
  assert.ok(r.ok);
  assert.equal(r.events.length, 0, "a no-op wrote an event, and the loop guard is now the only thing stopping it");
});

T("a rule writing a genuinely new value DOES produce an event", () => {
  const type = { id: "shiftswap", fields: [{ key: "priority", type: "select", options: ["high", "low"] }],
    statuses: [{ key: "open" }, { key: "review" }] };
  const step = A.autoActionToStep({ kind: "set_field", key: "priority", value: "low" }, ITEM);
  const r = itemCommit({ type, item: ITEM, intent: step.intent, actor: { uid: "u1", orgId: "orgA" },
    allow: () => true, now: 5 });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].verb, "item.updated");
});

/* ---------- who a notify actually reaches ----------
   The bell queries toUid and firestore.rules only lets the addressee
   read it, so a notification addressed to a ROLE is one nobody can see.
   Resolving the role to people is what makes every pack's notify rule
   real rather than decorative. */
const MEM = [{ uid: "u1", roleId: "manager" }, { uid: "u2", roleId: "lead" },
             { uid: "u3", roleId: "lead" }, { uid: "u4", roleId: "staff" }];

T("a role becomes the people holding it", () => {
  assert.deepEqual(A.autoNotifyTargets({ toRole: "lead" }, MEM, "zz"), ["u2", "u3"]);
});
T("a role nobody holds reaches nobody, rather than erroring", () => {
  assert.deepEqual(A.autoNotifyTargets({ toRole: "cfo" }, MEM, "zz"), []);
});
T("the person who caused it is never told about it", () => {
  // the commonest way a useful rule becomes a muted one
  assert.deepEqual(A.autoNotifyTargets({ toRole: "lead" }, MEM, "u2"), ["u3"]);
});
T("explicit uids and a role merge without duplicates", () => {
  assert.deepEqual(A.autoNotifyTargets({ toRole: "lead", toUids: ["u1", "u2"] }, MEM, "zz"),
    ["u1", "u2", "u3"]);
});
T("no members, no targets - and no crash", () => {
  assert.deepEqual(A.autoNotifyTargets({ toRole: "lead" }, null, "zz"), []);
  assert.deepEqual(A.autoNotifyTargets({}, MEM, "zz"), []);
});
T("every pack notify role is one a pack member could actually hold", () => {
  // the end-to-end property: a pack's rules name roles the same pack creates,
  // so applying a pack gives every rule in it somebody to reach
  const P = require("../js/packs.js");
  P.PACKS.forEach(pack => (pack.automations || []).forEach(a =>
    (a.actions || []).filter(x => x.kind === "notify" && x.toRole).forEach(x => {
      const seated = pack.roles.map(r => ({ uid: "x" + r.id, roleId: r.id }));
      assert.ok(A.autoNotifyTargets({ toRole: x.toRole }, seated, "zz").length,
        pack.key + ': "' + a.name + '" notifies ' + x.toRole + ", which nobody in the pack holds");
    })));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
