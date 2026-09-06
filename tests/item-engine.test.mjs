/* Unit tests for ../js/item-engine.js - pure, so no emulator, no DOM, no
   Firebase: plain node.
     node tests/item-engine.test.mjs
   Same runner shape as the other suites: PASS/FAIL lines, exit 1 on any
   failure. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ITEM_FIELD_TYPES, ITEM_TYPE_KEYS, itemSlug, itemCoerce, itemIsEmpty, itemNewAssignees,
        itemValidate, itemFacets, itemCommit } = require("../js/item-engine.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 170)); }
};

const TYPE = {
  id: "task",
  fields: [
    { key: "priority", type: "select", options: ["high", "low"], label: "Priority" },
    { key: "tags",     type: "multiselect", options: ["a", "b"] },
    { key: "owner",    type: "user" },
    { key: "urgent",   type: "checkbox" },
    { key: "budget",   type: "money" },
    { key: "due",      type: "date" },
    { key: "link",     type: "url" },
    { key: "notes",    type: "longtext" },
    { key: "client",   type: "text", required: true, label: "Client" }
  ],
  statuses: [{ key: "open" }, { key: "review" }, { key: "done" }]
};
const ACTOR = { uid: "u1", orgId: "orgA" };
const YES = () => true, NO = () => false;
const make = over => Object.assign({
  id: "i1", orgId: "orgA", typeId: "task", title: "T", status: "open",
  fields: { client: "Acme" }, assigneeIds: [], createdBy: "u1", createdAt: 1, updatedAt: 1
}, over);

/* ---------- the closed set ---------- */
T("exactly eleven field types exist", () => assert.equal(ITEM_TYPE_KEYS.length, 11));
T("every type can coerce and validate", () => {
  ITEM_TYPE_KEYS.forEach(k => {
    assert.equal(typeof ITEM_FIELD_TYPES[k].coerce, "function", k);
    assert.equal(typeof ITEM_FIELD_TYPES[k].valid, "function", k);
  });
});

/* ---------- coercion ---------- */
T("number coerces a numeric string, keeps null for empty", () => {
  assert.equal(itemCoerce({ type: "number" }, "42"), 42);
  assert.equal(itemCoerce({ type: "number" }, ""), null);
});
T("money rounds to cents", () => assert.equal(itemCoerce({ type: "money" }, "10.005"), 10.01));
T("date keeps YYYY-MM-DD and never becomes a timestamp", () => {
  assert.equal(itemCoerce({ type: "date" }, "2026-09-05T23:00:00Z"), "2026-09-05");
});
T("checkbox coerces the string 'true'", () => {
  assert.equal(itemCoerce({ type: "checkbox" }, "true"), true);
  assert.equal(itemCoerce({ type: "checkbox" }, null), false);
});
T("multiselect always coerces to an array", () => {
  assert.deepEqual(itemCoerce({ type: "multiselect" }, null), []);
});

/* ---------- emptiness, which is what `required` means ---------- */
T("zero and false are values a person chose, not emptiness", () => {
  assert.ok(!itemIsEmpty(0));
  assert.ok(!itemIsEmpty(false));
});
T("null, empty string and empty array are emptiness", () => {
  [null, undefined, "", []].forEach(v => assert.ok(itemIsEmpty(v), String(v)));
});

/* ---------- validation ---------- */
T("a required field that is empty fails", () => {
  const errs = itemValidate(TYPE, make({ fields: {} }));
  assert.ok(errs.some(e => e.key === "client"));
});
T("an absent OPTIONAL value is never invalid", () => {
  assert.equal(itemValidate(TYPE, make()).length, 0);
});
T("a select outside its options fails", () => {
  const errs = itemValidate(TYPE, make({ fields: { client: "A", priority: "urgent" } }));
  assert.ok(errs.some(e => e.key === "priority"));
});
T("a multiselect with one bad member fails", () => {
  const errs = itemValidate(TYPE, make({ fields: { client: "A", tags: ["a", "zzz"] } }));
  assert.ok(errs.some(e => e.key === "tags"));
});
T("a malformed url fails, an empty one does not", () => {
  assert.ok(itemValidate(TYPE, make({ fields: { client: "A", link: "not a url" } })).some(e => e.key === "link"));
  assert.equal(itemValidate(TYPE, make({ fields: { client: "A", link: "" } })).length, 0);
});
T("a status the type does not have fails", () => {
  assert.ok(itemValidate(TYPE, make({ status: "nope" })).some(e => e.key === "status"));
});
T("a missing title fails", () => {
  assert.ok(itemValidate(TYPE, make({ title: "   " })).some(e => e.key === "title"));
});
T("EVERY problem is reported, not just the first", () => {
  const errs = itemValidate(TYPE, make({ title: "", fields: { priority: "nope" } }));
  const keys = errs.map(e => e.key).sort();
  assert.deepEqual(keys, ["client", "priority", "title"]);
});

/* ---------- facets ---------- */
T("labels are slugged so casing and spacing collapse to one row", () => {
  assert.equal(itemSlug("Store Alpha"), "store-alpha");
  assert.equal(itemSlug("  STORE   alpha "), "store-alpha");
});
T("a uid is an identifier and keeps its case", () => {
  const f = itemFacets(TYPE, make({ fields: { client: "A", owner: "AbC_123" } }));
  assert.ok(f.includes("owner:AbC_123"));
});
T("type and status always facet", () => {
  const f = itemFacets(TYPE, make());
  assert.ok(f.includes("type:task") && f.includes("status:open"));
});
T("assignees facet, one row each", () => {
  const f = itemFacets(TYPE, make({ assigneeIds: ["u2", "u3"] }));
  assert.ok(f.includes("assignee:u2") && f.includes("assignee:u3"));
});
T("a multiselect facets once per member", () => {
  const f = itemFacets(TYPE, make({ fields: { client: "A", tags: ["a", "b"] } }));
  assert.ok(f.includes("tags:a") && f.includes("tags:b"));
});
T("checkbox facets even when false - false IS a filterable answer", () => {
  const f = itemFacets(TYPE, make({ fields: { client: "A", urgent: false } }));
  assert.ok(f.includes("urgent:false"));
});
T("ranges and free text never facet", () => {
  const f = itemFacets(TYPE, make({ fields: { client: "Acme", budget: 10, due: "2026-01-01", notes: "hi" } }));
  assert.ok(!f.some(x => x.startsWith("budget:") || x.startsWith("due:") || x.startsWith("notes:") || x.startsWith("client:")));
});
T("facets are sorted and deduped, so equal items produce equal arrays", () => {
  const a = itemFacets(TYPE, make({ fields: { client: "A", tags: ["b", "a"] } }));
  const b = itemFacets(TYPE, make({ fields: { client: "A", tags: ["a", "b"] } }));
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort());
});

/* ---------- commit: create ---------- */
T("create returns an item, an event, and computed facets", () => {
  const r = itemCommit({ type: TYPE, item: null, actor: ACTOR, allow: YES, now: 5, id: "i9",
    intent: { kind: "create", title: "Ship", fields: { client: "Acme", priority: "high" } } });
  assert.ok(r.ok);
  assert.equal(r.item.status, "open");             // first status is the default
  assert.equal(r.item.createdBy, "u1");
  assert.equal(r.events[0].verb, "item.created");
  assert.ok(r.item.facets.includes("priority:high"));
});
T("create refuses an invalid draft and names every problem", () => {
  const r = itemCommit({ type: TYPE, item: null, actor: ACTOR, allow: YES, now: 5,
    intent: { kind: "create", title: "", fields: {} } });
  assert.ok(!r.ok);
  assert.equal(r.error, "invalid");
  assert.ok(r.details.length >= 2);
});
T("create is refused without permission", () => {
  const r = itemCommit({ type: TYPE, item: null, actor: ACTOR, allow: NO, now: 5,
    intent: { kind: "create", title: "Ship", fields: { client: "A" } } });
  assert.equal(r.error, "denied");
});

/* ---------- commit: update ---------- */
T("update records what changed, and only what changed", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { client: "Beta" } } });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.events[0].data.changed), ["client"]);
  assert.equal(r.item.updatedAt, 9);
});
T("an update that changes nothing writes no event", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { client: "Acme" } } });
  assert.ok(r.ok);
  assert.equal(r.events.length, 0);
});
T("an update that would invalidate the item is refused", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { client: "" } } });
  assert.equal(r.error, "invalid");
});
T("a value for a field the type dropped is ignored, not an error", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { ghost: "x" } } });
  assert.ok(r.ok);
  assert.equal(r.item.fields.ghost, undefined);
});
T("facets are recomputed on update, never patched", () => {
  const r = itemCommit({ type: TYPE, item: make({ fields: { client: "A", priority: "high" },
    facets: ["priority:high", "stale:row"] }), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { priority: "low" } } });
  assert.ok(r.item.facets.includes("priority:low"));
  assert.ok(!r.item.facets.includes("priority:high"));
  assert.ok(!r.item.facets.includes("stale:row"));
});

/* ---------- commit: status, assign, delete ---------- */
T("set_status emits a from/to event", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "set_status", status: "done" } });
  assert.equal(r.events[0].verb, "item.status_changed");
  assert.deepEqual({ f: r.events[0].data.from, t: r.events[0].data.to }, { f: "open", t: "done" });
});
T("set_status to the status it already has is a no-op", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "set_status", status: "open" } });
  assert.equal(r.events.length, 0);
});
T("set_status to a status the type lacks is refused", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "set_status", status: "shipped" } });
  assert.equal(r.error, "unknown-status");
});
T("assign dedupes and sorts, so order is never a change", () => {
  const r = itemCommit({ type: TYPE, item: make({ assigneeIds: ["u3", "u2"] }), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "assign", assigneeIds: ["u2", "u3", "u2"] } });
  assert.equal(r.events.length, 0);
});
T("assign updates the assignee facets", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "assign", assigneeIds: ["u7"] } });
  assert.ok(r.item.facets.includes("assignee:u7"));
});
T("delete returns no item and one event", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "delete" } });
  assert.ok(r.ok);
  assert.equal(r.item, null);
  assert.equal(r.events[0].verb, "item.deleted");
});

/* ---------- the refusals that must hold wherever this runs ---------- */
T("another tenant's item is refused before anything else is considered", () => {
  const r = itemCommit({ type: TYPE, item: make({ orgId: "orgB" }), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "update", fields: { client: "X" } } });
  assert.equal(r.error, "wrong-tenant");
});
T("an unknown intent is refused", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "escalate" } });
  assert.equal(r.error, "unknown-intent");
});
T("an actor with no org is refused", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: { uid: "u1" }, allow: YES, now: 9,
    intent: { kind: "update", fields: {} } });
  assert.equal(r.error, "no-actor");
});
T("commit never writes: it returns events rather than emitting them", () => {
  const r = itemCommit({ type: TYPE, item: make(), actor: ACTOR, allow: YES, now: 9,
    intent: { kind: "set_status", status: "review" } });
  assert.ok(Array.isArray(r.events));
  assert.equal(typeof r.item, "object");
});

/* ---------- end to end: the spec's own worked example ----------
   docs/platform-spec.md ships a "restaurant" pack whose Shift Swap type
   is meant to prove the model fits an industry nobody wrote code for.
   This builds exactly that type - the shape the Organization page's
   builder produces - and runs one real request through its whole life.
   If this passes, "a custom type runs end to end" is true of the engine. */
const SHIFT_SWAP = {
  id: "shiftswap",
  name: "Shift Swap",
  fields: [
    { key: "requestedBy", label: "Requested by", type: "user",     required: true },
    { key: "shiftDate",   label: "Shift date",   type: "date",     required: true },
    { key: "coverBy",     label: "Covered by",   type: "user",     required: false },
    { key: "reason",      label: "Reason",       type: "longtext", required: false },
    { key: "urgent",      label: "Urgent",       type: "checkbox", required: false }
  ],
  statuses: [{ key: "open", label: "Open" }, { key: "claimed", label: "Claimed" },
             { key: "approved", label: "Approved" }, { key: "denied", label: "Denied" }]
};

T("e2e: a shift swap is requested, claimed, approved - and never needed code", () => {
  const lead = { uid: "lead1", orgId: "orgR" };
  const staff = { uid: "staff1", orgId: "orgR" };

  // 1. staff files the request. The first status is where new work starts.
  const made = itemCommit({ type: SHIFT_SWAP, item: null, actor: staff, allow: YES, now: 100, id: "sw1",
    intent: { kind: "create", title: "Friday night", fields: { requestedBy: "staff1", shiftDate: "2026-09-11", urgent: true } } });
  assert.ok(made.ok, JSON.stringify(made.details));
  assert.equal(made.item.status, "open");
  assert.equal(made.events[0].verb, "item.created");

  // the facets a manager would filter on exist without any index being
  // declared for a type that did not exist an hour ago
  assert.ok(made.item.facets.includes("type:shiftswap"));
  assert.ok(made.item.facets.includes("status:open"));
  assert.ok(made.item.facets.includes("urgent:true"));
  assert.ok(made.item.facets.includes("requestedBy:staff1"));
  // a date is a range, so it is a real field and never a facet row
  assert.ok(!made.item.facets.some(f => f.startsWith("shiftDate:")));

  // 2. a shift lead claims it
  const claimed = itemCommit({ type: SHIFT_SWAP, item: made.item, actor: lead, allow: YES, now: 200,
    intent: { kind: "update", fields: { coverBy: "lead1" } } });
  assert.ok(claimed.ok);
  assert.deepEqual(Object.keys(claimed.events[0].data.changed), ["coverBy"]);

  const moved = itemCommit({ type: SHIFT_SWAP, item: claimed.item, actor: lead, allow: YES, now: 300,
    intent: { kind: "set_status", status: "claimed" } });
  assert.ok(moved.item.facets.includes("status:claimed"));
  assert.ok(!moved.item.facets.includes("status:open"));

  // 3. it lands on the lead's queue, then a manager approves it
  const assigned = itemCommit({ type: SHIFT_SWAP, item: moved.item, actor: lead, allow: YES, now: 400,
    intent: { kind: "assign", assigneeIds: ["lead1"] } });
  assert.ok(assigned.item.facets.includes("assignee:lead1"));

  const done = itemCommit({ type: SHIFT_SWAP, item: assigned.item, actor: lead, allow: YES, now: 500,
    intent: { kind: "set_status", status: "approved" } });
  assert.equal(done.item.status, "approved");
  assert.equal(done.item.updatedAt, 500);

  // the whole story is readable from the events alone, which is what the
  // audit trail and every future automation actually read
  const story = [made, claimed, moved, assigned, done].flatMap(r => r.events).map(e => e.verb);
  assert.deepEqual(story, ["item.created", "item.updated", "item.status_changed", "item.assigned", "item.status_changed"]);
});

T("e2e: the same type refuses a request missing a required field", () => {
  const r = itemCommit({ type: SHIFT_SWAP, item: null, actor: { uid: "staff1", orgId: "orgR" }, allow: YES, now: 100,
    intent: { kind: "create", title: "Friday", fields: { requestedBy: "staff1" } } });
  assert.equal(r.error, "invalid");
  assert.ok(r.details.some(d => d.key === "shiftDate"));
});

T("e2e: a role that may only touch its own work cannot move a colleague's", () => {
  const mine = itemCommit({ type: SHIFT_SWAP, item: null, actor: { uid: "staff1", orgId: "orgR" }, allow: YES, now: 100, id: "sw2",
    intent: { kind: "create", title: "Mine", fields: { requestedBy: "staff1", shiftDate: "2026-09-11" } } }).item;
  // permissions.js decides this; the engine only asks. "own" reaches a
  // document you created and stops there.
  const ownOnly = (resource, action, ctx) =>
    !ctx.doc || ctx.doc.createdBy === "staff2";
  const r = itemCommit({ type: SHIFT_SWAP, item: mine, actor: { uid: "staff2", orgId: "orgR" }, allow: ownOnly, now: 200,
    intent: { kind: "set_status", status: "approved" } });
  assert.equal(r.error, "denied");
});

/* ---------- who was just handed this ----------
   Creating an item with people on it and assigning them later are two
   intents that mean the same thing to whoever receives the work. */
T("creating with people on it tells them", () => {
  assert.deepEqual(itemNewAssignees([{ verb: "item.created" }], { assigneeIds: ["u2", "u3"] }, "u1"),
    ["u2", "u3"]);
});
T("the person doing it is never told", () => {
  assert.deepEqual(itemNewAssignees([{ verb: "item.created" }], { assigneeIds: ["u1", "u2"] }, "u1"), ["u2"]);
});
T("assigning tells only the people who were not already on it", () => {
  // re-saving must not re-tell everybody who was already assigned
  assert.deepEqual(itemNewAssignees(
    [{ verb: "item.assigned", data: { from: ["u2"], to: ["u2", "u4"] } }], {}, "u1"), ["u4"]);
});
T("removing somebody tells nobody", () => {
  assert.deepEqual(itemNewAssignees(
    [{ verb: "item.assigned", data: { from: ["u2", "u4"], to: ["u2"] } }], {}, "u1"), []);
});
T("an edit that touches nobody notifies nobody", () => {
  assert.deepEqual(itemNewAssignees([{ verb: "item.updated" }], { assigneeIds: ["u2"] }, "u1"), []);
});
T("the same person twice is told once", () => {
  assert.deepEqual(itemNewAssignees(
    [{ verb: "item.created" }, { verb: "item.assigned", data: { from: [], to: ["u2"] } }],
    { assigneeIds: ["u2"] }, "u1"), ["u2"]);
});
T("no events, no telling - and no crash", () => {
  assert.deepEqual(itemNewAssignees(null, null, "u1"), []);
  assert.deepEqual(itemNewAssignees([{ verb: "item.assigned" }], {}, "u1"), []);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
