/* Unit tests for ../js/items.js - pure, so no emulator, no DOM, no
   Firebase: plain node.
     node tests/items.test.mjs
   Same runner shape as the other suites: PASS/FAIL lines, exit 1 on any
   failure. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ITEM_FIELD_TYPES, ITEM_TYPE_KEYS, itemSlug, itemCoerce, itemIsEmpty,
        itemValidate, itemFacets, itemCommit } = require("../js/items.js");

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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
