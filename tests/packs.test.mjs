/* Unit tests for ../js/packs.js — pure, so plain node:
     node tests/packs.test.mjs

   packs.js reads ITEM_FIELD_TYPES, permParse, PERM_CATALOG,
   ITEM_EVENT_VERBS and AUTO_ACTION_KINDS from the shared global scope,
   exactly as the browser gives it them via the <script> order. Putting
   them on globalThis here reproduces that rather than pretending the
   file has imports it does not have.

   THE POINT OF THIS SUITE. docs/platform-spec.md claims a new industry
   ships with no code change. That is only true if a pack that cannot
   work cannot ship — so the first block below validates EVERY pack in
   the repo, and the second block proves the validator actually says no,
   because a validator that always returns ok would pass the first block
   and mean nothing. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const IE = require("../js/item-engine.js");
const PM = require("../js/permissions.js");
const { wfEvalCondition } = require("../js/workflow-engine.js");
globalThis.wfEvalCondition = wfEvalCondition;
const AU = require("../js/automation.js");
globalThis.ITEM_FIELD_TYPES = IE.ITEM_FIELD_TYPES;
globalThis.ITEM_EVENT_VERBS = IE.ITEM_EVENT_VERBS;
globalThis.permParse = PM.permParse;
globalThis.PERM_CATALOG = PM.PERM_CATALOG;
globalThis.AUTO_ACTION_KINDS = AU.AUTO_ACTION_KINDS;
const P = require("../js/packs.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 175)); }
};
const clone = v => JSON.parse(JSON.stringify(v));

/* ---------- every shipped pack is usable ---------- */
T("there are packs to choose between", () => {
  assert.ok(P.PACKS.length >= 6, "a chooser with three options is not a platform");
});
P.PACKS.forEach(pack => {
  T('pack "' + pack.key + '" validates against the real engines', () => {
    const r = P.packValidate(pack);
    assert.ok(r.ok, r.errors.join(" | "));
  });
});
T("pack keys are unique", () => {
  const keys = P.PACKS.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
});
T("packByKey finds one and refuses to invent one", () => {
  assert.equal(P.packByKey("restaurant").name, "Restaurant");
  assert.equal(P.packByKey("nope"), null);
});
T("no pack ships an owner role", () => {
  // whoever created the org already holds it; a pack redefining who owns
  // the place would be the worst possible surprise
  P.PACKS.forEach(p => p.roles.forEach(r => {
    assert.ok(!/owner/i.test(r.id), p.key + " defines " + r.id);
    assert.ok(r.permissions.indexOf("*:*:org") < 0, p.key + "/" + r.id + " is an owner in disguise");
  }));
});
T("every pack's fields survive the item engine's own validator", () => {
  // packValidate checks the field TYPES; this checks that a real item of
  // each type actually commits, which is the thing a user will do first
  P.PACKS.forEach(pack => pack.itemTypes.forEach(t => {
    const type = { id: t.id, name: t.name, fields: t.fields, statuses: t.statuses };
    const intent = { kind: "create", title: "First one", status: t.statuses[0].key, fields: {} };
    t.fields.filter(f => f.required).forEach(f => {
      intent.fields[f.key] = f.type === "date" ? "2026-01-01"
        : f.type === "number" ? 1
        : f.type === "select" ? f.options[0] : "x";
    });
    const r = IE.itemCommit({ type, item: null, intent,
      actor: { uid: "u1", orgId: "o1" }, allow: () => true, now: 1, id: "i1" });
    assert.ok(r.ok, pack.key + "/" + t.id + ": " + JSON.stringify(r.error || r.details));
  }));
});
T("the automation builder offers exactly the verbs that exist", () => {
  // ORG_TRIGGERS is a UI list in another file; if it drifts from what the
  // engine emits, the builder offers a trigger that can never fire
  const src = require("node:fs").readFileSync(new URL("../js/org.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const ORG_TRIGGERS"), src.indexOf("];", src.indexOf("const ORG_TRIGGERS")));
  const offered = [...block.matchAll(/verb: *"([a-z._]+)"/g)].map(m => m[1]);
  assert.ok(offered.length, "could not read ORG_TRIGGERS");
  offered.forEach(v => assert.ok(IE.ITEM_EVENT_VERBS.includes(v), v + " is offered but never emitted"));
});
T("every pack automation plans into real steps", () => {
  P.PACKS.forEach(pack => (pack.automations || []).forEach((a, i) => {
    const t = pack.itemTypes.find(x => x.id === a.trigger.typeId) || pack.itemTypes[0];
    // build an item that SATISFIES the rule's conditions, so we are testing
    // the plan and not just the skip path
    const item = { id: "i1", orgId: "o1", typeId: t.id, title: "x",
      status: t.statuses[0].key, assigneeIds: [], fields: {} };
    (a.conditions || []).forEach(c => {
      if (c.source === "task") item[c.path] = c.value; else item.fields[c.path] = c.value;
    });
    const plan = P.packPlan(pack, {}).automations[i];
    const out = AU.autoPlan({ automations: [Object.assign({ id: "a" + i }, plan.doc)],
      event: { orgId: "o1", actorId: "u1", at: 1, verb: a.trigger.verb,
               subject: { kind: "item", id: "i1" }, data: {} },
      item, depth: 0 });
    assert.equal(out.fired.length, 1, pack.key + '/"' + a.name + '" did not fire on its own trigger');
    assert.ok(out.steps.length, pack.key + '/"' + a.name + '" fired and did nothing');
  }));
});

/* ---------- the validator says no ---------- */
const REST = () => clone(P.packByKey("restaurant"));
const rejects = (mutate, needle) => {
  const p = REST(); mutate(p);
  const r = P.packValidate(p);
  assert.ok(!r.ok, "accepted a pack it should refuse");
  assert.ok(r.errors.join(" | ").includes(needle), "wrong complaint: " + r.errors.join(" | "));
};
T("refuses a field type the item engine does not have", () => {
  rejects(p => { p.itemTypes[0].fields[0].type = "rating"; }, 'unknown type "rating"');
});
T("refuses a choice field with nothing to choose", () => {
  rejects(p => { p.itemTypes[0].fields[1].options = []; }, "nothing to choose");
});
T("refuses a type with one status", () => {
  rejects(p => { p.itemTypes[0].statuses = [{ key: "open", label: "Open" }]; }, "at least two statuses");
});
T("refuses a malformed permission", () => {
  rejects(p => { p.roles[0].permissions = ["item:update"]; }, "not resource:action:scope");
});
T("refuses a permission naming a resource that does not exist", () => {
  rejects(p => { p.roles[0].permissions = ["invoice:read:org"]; }, "no known resource");
});
T("refuses a permission naming an action that resource does not have", () => {
  rejects(p => { p.roles[0].permissions = ["report:delete:org"]; }, "no known action");
});
T("refuses a trigger verb nothing emits", () => {
  rejects(p => { p.automations[0].trigger.verb = "item.approved"; }, "is not a verb anything emits");
});
T("refuses a trigger on a type the pack does not define", () => {
  rejects(p => { p.automations[0].trigger.typeId = "invoice"; }, "which the pack does not define");
});
T("refuses an action kind the planner cannot run", () => {
  rejects(p => { p.automations[0].actions = [{ kind: "send_sms" }]; }, "not a kind the planner runs");
});
T("refuses notifying a role the pack never creates", () => {
  rejects(p => { p.automations[0].actions[0].toRole = "cfo"; }, 'role "cfo" which the pack does not define');
});
T("refuses a rule that waits for a status its type never reaches", () => {
  // the silent failure: well-formed, type-correct, and it can never fire
  rejects(p => {
    p.automations[0].conditions = [{ source: "task", path: "status", op: "==", value: "escalated" }];
  }, "never reaches");
});
T("refuses setting a status the type does not have", () => {
  rejects(p => { p.automations[0].actions = [{ kind: "set_status", status: "archived" }]; },
    'sets status "archived"');
});
T("refuses a rule that does nothing", () => {
  rejects(p => { p.automations[0].actions = []; }, "does nothing");
});
T("refuses duplicate ids", () => {
  rejects(p => { p.itemTypes.push(clone(p.itemTypes[0])); }, "duplicate id");
});
T("reports every problem, not just the first", () => {
  const p = REST();
  p.itemTypes[0].fields[0].type = "rating";
  p.roles[0].permissions = ["nope"];
  assert.ok(P.packValidate(p).errors.length >= 2);
});

/* ---------- the plan ---------- */
T("a plan on an empty org creates everything", () => {
  const pack = P.packByKey("restaurant");
  const plan = P.packPlan(pack, {});
  assert.equal(plan.roles.length, 3);
  assert.equal(plan.itemTypes.length, 2);
  assert.equal(plan.automations.length, 2);
  assert.equal(plan.skipped.length, 0);
});
T("applying the same pack twice is a no-op", () => {
  const pack = P.packByKey("restaurant");
  const first = P.packPlan(pack, {});
  const after = {
    roleIds: first.roles.map(r => r.id),
    typeIds: first.itemTypes.map(t => t.id),
    automationIds: first.automations.map(a => a.id)
  };
  const second = P.packPlan(pack, after);
  assert.equal(second.roles.length, 0);
  assert.equal(second.itemTypes.length, 0);
  assert.equal(second.automations.length, 0);
  assert.equal(second.skipped.length, 7);
});
T("an existing role keeps its own permissions", () => {
  // an org that already has "manager" has its OWN manager; a pack must not
  // quietly hand it a different set of powers
  const plan = P.packPlan(P.packByKey("restaurant"), { roleIds: ["manager"] });
  assert.ok(!plan.roles.some(r => r.id === "manager"));
  assert.deepEqual(plan.skipped.filter(s => s.kind === "role"), [{ kind: "role", id: "manager" }]);
});
T("a pack half-applied fills in only the missing half", () => {
  const plan = P.packPlan(P.packByKey("restaurant"), { typeIds: ["shiftswap"] });
  assert.deepEqual(plan.itemTypes.map(t => t.id), ["maintenance"]);
  assert.equal(plan.roles.length, 3);
});
T("the plan hands over deep copies, not the pack itself", () => {
  const pack = P.packByKey("restaurant");
  const plan = P.packPlan(pack, {});
  plan.itemTypes[0].doc.fields[0].label = "MUTATED";
  plan.roles[0].doc.permissions.push("*:*:org");
  assert.notEqual(pack.itemTypes[0].fields[0].label, "MUTATED");
  assert.equal(pack.roles[0].permissions.indexOf("*:*:org"), -1);
});
T("automation ids are derived, so they are stable across runs", () => {
  const a = P.packPlan(P.packByKey("restaurant"), {}).automations.map(x => x.id);
  const b = P.packPlan(P.packByKey("restaurant"), {}).automations.map(x => x.id);
  assert.deepEqual(a, b);
  assert.equal(a[0], "pk_restaurant_auto_0");
});
T("two packs cannot collide on an automation id", () => {
  const all = P.PACKS.flatMap(p => P.packPlan(p, {}).automations.map(a => a.id));
  assert.equal(new Set(all).size, all.length);
});
T("new item types arrive with no workflow attached", () => {
  // packs ship statuses, not workflow graphs — an org draws its own
  P.packPlan(P.packByKey("agency"), {}).itemTypes.forEach(t =>
    assert.equal(t.doc.workflowId, null));
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
