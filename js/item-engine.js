/* ============================================================
   ITEM ENGINE — the universal work object: what a type declares, what a
   value may be, which facets a document carries, and the one place
   a change is decided. Pure: plain objects in, plain objects out,
   no DOM and no Firestore, so the same file runs in the browser
   (classic script) and under Node for tests. Third file to earn
   that discipline, after workflow-engine.js and permissions.js.

   THE ONE OBJECT. Every unit of work is an Item; its ItemType says
   which fields and statuses it has, and optionally which blueprint
   it rides. A restaurant's shift swap and an agency's campaign are
   the same row with different types - which is the whole reason a
   second work object must never be added (docs/platform-spec.md,
   ground rule 2): automations, permissions, search and the activity
   feed all fork the day it is.

   THE CHOKEPOINT. itemCommit() is the only function that turns an
   intent into a new Item, and it returns the events that change
   produced rather than writing anything. That split is deliberate:
   the decision is pure and testable here, and the glue that talks
   to Firestore stays dumb enough to be swapped for a server call
   without moving a single rule (spec, ground rule 3).

   AUTHORIZATION arrives as a callback, never as a global. items.js
   knows a change must be ALLOWED; permissions.js knows what that
   means. Passing `allow` keeps this file standalone in Node while
   the browser hands it a closure over the signed-in role.

   FACETS are the answer to a constraint, not a preference: a
   customer filtering on fields we have never seen cannot be served
   by Firestore composite indexes, which cap at 200 (1000 billed)
   and must be declared in advance. One array-contains index over
   "key:value" strings serves every equality filter anyone invents.
   Only the types that can be equal to something produce them -
   ranges stay real fields and spend the indexes we can afford.
   ============================================================ */

/* ---------- the eleven, and nothing else ----------
   Each descriptor answers four questions: how a raw input becomes a
   stored value, whether that value is acceptable, whether it can be
   filtered by equality, and how it reads as a facet. Adding a
   twelfth type means answering all four AND building six UI
   surfaces for it (spec, ground rule 5) - the list is closed. */

// facet values are lowercased and slugged so "Store Alpha" and
// "store alpha" land on one row - EXCEPT identifiers, where case is
// meaning: a uid is not a label and slugging one corrupts it
const itemSlug = v => String(v).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const ITEM_FIELD_TYPES = {
  text:        { coerce: v => (v == null ? "" : String(v)),
                 valid: v => v.length <= 500 },
  longtext:    { coerce: v => (v == null ? "" : String(v)),
                 valid: v => v.length <= 20000 },
  number:      { coerce: v => (v === "" || v == null ? null : Number(v)),
                 valid: v => v === null || Number.isFinite(v) },
  money:       { coerce: v => (v === "" || v == null ? null : Math.round(Number(v) * 100) / 100),
                 valid: v => v === null || Number.isFinite(v) },
  // a plain YYYY-MM-DD string, never a timestamp: every "is it today"
  // check in this app is an exact string compare, and a datetime would
  // silently break all of them
  date:        { coerce: v => (v == null || v === "" ? null : String(v).slice(0, 10)),
                 valid: v => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v) },
  select:      { coerce: v => (v == null || v === "" ? null : String(v)),
                 valid: (v, f) => v === null || (f.options || []).indexOf(v) >= 0,
                 facet: v => (v === null ? null : itemSlug(v)) },
  multiselect: { coerce: v => (Array.isArray(v) ? v.map(String) : []),
                 valid: (v, f) => v.every(x => (f.options || []).indexOf(x) >= 0),
                 facet: v => v.map(itemSlug), multi: true },
  // a uid, so it is an identifier and never slugged
  user:        { coerce: v => (v == null || v === "" ? null : String(v)),
                 valid: v => v === null || v.length <= 128,
                 facet: v => v },
  checkbox:    { coerce: v => v === true || v === "true",
                 valid: () => true,
                 facet: v => (v ? "true" : "false") },
  url:         { coerce: v => (v == null ? "" : String(v).trim()),
                 valid: v => v === "" || /^https?:\/\/\S+$/i.test(v) },
  file:        { coerce: v => (v == null || v === "" ? null : String(v)),
                 valid: v => v === null || v.length <= 2000 }
};

const ITEM_TYPE_KEYS = Object.keys(ITEM_FIELD_TYPES);

/* ---------- values ---------- */

const itemFieldDef = (type, key) => (type.fields || []).find(f => f.key === key) || null;

function itemCoerce(field, raw){
  const t = ITEM_FIELD_TYPES[field.type];
  return t ? t.coerce(raw) : null;
}

// "empty" has to mean the same thing for every type or `required` lies:
// 0 and false are values a person chose, "" and null and [] are not
const itemIsEmpty = v => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0);

/* Everything wrong with a draft, all at once - never the first error.
   A form that reveals one problem per save is a form people abandon. */
function itemValidate(type, draft){
  const out = [];
  const title = (draft.title == null ? "" : String(draft.title)).trim();
  if (!title) out.push({ key: "title", message: "Give it a title." });
  else if (title.length > 200) out.push({ key: "title", message: "Title is too long." });

  const statuses = (type.statuses || []).map(s => s.key);
  if (draft.status != null && statuses.indexOf(draft.status) < 0)
    out.push({ key: "status", message: "That is not a status this type has." });

  (type.fields || []).forEach(f => {
    const t = ITEM_FIELD_TYPES[f.type];
    if (!t) { out.push({ key: f.key, message: "Unknown field type." }); return; }
    const v = (draft.fields || {})[f.key];
    if (itemIsEmpty(v)) {
      if (f.required) out.push({ key: f.key, message: (f.label || f.key) + " is required." });
      return;                       // an absent optional value is never invalid
    }
    if (!t.valid(v, f)) out.push({ key: f.key, message: (f.label || f.key) + " is not valid." });
  });
  return out;
}

/* ---------- facets ---------- */

/* The denormalized filter keys, derived - never hand-written, and never
   read back as truth. `fields` is the record; facets are an index that
   happens to live on the row, so anything that edits a value must let
   this recompute rather than patching a string. */
function itemFacets(type, item){
  const out = ["type:" + itemSlug(type.id || item.typeId || "")];
  if (item.status) out.push("status:" + itemSlug(item.status));
  (item.assigneeIds || []).forEach(uid => out.push("assignee:" + uid));

  (type.fields || []).forEach(f => {
    const t = ITEM_FIELD_TYPES[f.type];
    if (!t || !t.facet) return;               // ranges and free text do not facet
    const v = (item.fields || {})[f.key];
    if (itemIsEmpty(v) && f.type !== "checkbox") return;
    const made = t.facet(v);
    (Array.isArray(made) ? made : [made]).forEach(x => {
      if (x !== null && x !== "") out.push(f.key + ":" + x);
    });
  });
  // sorted and deduped so two items with the same values produce byte-identical
  // arrays - which makes a no-op write actually look like one
  return [...new Set(out)].sort();
}

/* ---------- the chokepoint ---------- */

const ITEM_INTENTS = ["create", "update", "set_status", "assign", "delete"];

const itemEvent = (verb, item, actor, now, data) => ({
  orgId: item.orgId, actorId: actor.uid, at: now, verb,
  subject: { kind: "item", id: item.id }, data: data || {}
});

/* The ONE place an Item changes.

   args = { type, item, intent, actor, allow, now, id }
     type   the ItemType this Item belongs to
     item   the current Item, or null when creating
     intent { kind, ...payload }
     actor  { uid, orgId }
     allow  (resource, action, ctx) => boolean   - permissions.js, injected
     now    ms timestamp, so tests are not clocks

   Returns { ok: true, item, events } or { ok: false, error, details }.
   It never writes. The caller persists what comes back, which is what
   lets the same decision run client-side today and server-side later. */
function itemCommit(args){
  const { type, item, intent, actor, now } = args;
  const allow = args.allow || (() => true);
  const at = now || 0;
  const fail = (error, details) => ({ ok: false, error, details: details || null });

  if (!intent || ITEM_INTENTS.indexOf(intent.kind) < 0) return fail("unknown-intent");
  if (!actor || !actor.uid || !actor.orgId) return fail("no-actor");
  if (!type) return fail("no-type");

  // tenancy is checked here as well as in the rules, and deliberately so:
  // this file is what a server will run, and a check that exists only in
  // the client is a check that does not exist
  if (intent.kind !== "create" && (!item || item.orgId !== actor.orgId)) return fail("wrong-tenant");

  const ctx = { uid: actor.uid, orgId: actor.orgId, doc: item || undefined };

  if (intent.kind === "delete") {
    if (!allow("item", "delete", ctx)) return fail("denied");
    return { ok: true, item: null, events: [itemEvent("item.deleted", item, actor, at)] };
  }

  if (intent.kind === "create") {
    if (!allow("item", "create", { uid: actor.uid, orgId: actor.orgId })) return fail("denied");
    const first = (type.statuses || [])[0];
    const draft = {
      id: args.id || null,
      orgId: actor.orgId,
      typeId: type.id,
      title: (intent.title == null ? "" : String(intent.title)).trim(),
      status: intent.status || (first ? first.key : null),
      fields: {},
      assigneeIds: (intent.assigneeIds || []).slice(),
      parentId: intent.parentId || null,
      workflowRunId: null,
      dueAt: intent.dueAt || null,
      createdAt: at, updatedAt: at, createdBy: actor.uid
    };
    (type.fields || []).forEach(f => {
      const raw = (intent.fields || {})[f.key];
      draft.fields[f.key] = raw === undefined
        ? (f.default !== undefined ? itemCoerce(f, f.default) : itemCoerce(f, null))
        : itemCoerce(f, raw);
    });
    const errs = itemValidate(type, draft);
    if (errs.length) return fail("invalid", errs);
    draft.facets = itemFacets(type, draft);
    return { ok: true, item: draft, events: [itemEvent("item.created", draft, actor, at, { title: draft.title })] };
  }

  // everything below edits an existing Item
  const next = Object.assign({}, item, { fields: Object.assign({}, item.fields) });
  const events = [];

  if (intent.kind === "update") {
    if (!allow("item", "update", ctx)) return fail("denied");
    const changed = {};
    if (intent.title !== undefined) {
      next.title = String(intent.title).trim();
      if (next.title !== item.title) changed.title = { from: item.title, to: next.title };
    }
    if (intent.dueAt !== undefined) next.dueAt = intent.dueAt;
    Object.keys(intent.fields || {}).forEach(key => {
      const f = itemFieldDef(type, key);
      if (!f) return;                 // a value for a field the type dropped is ignored, not an error
      const v = itemCoerce(f, intent.fields[key]);
      if (JSON.stringify(v) !== JSON.stringify(item.fields ? item.fields[key] : undefined))
        changed[key] = { from: item.fields ? item.fields[key] : null, to: v };
      next.fields[key] = v;
    });
    const errs = itemValidate(type, next);
    if (errs.length) return fail("invalid", errs);
    if (!Object.keys(changed).length) return { ok: true, item, events: [] };   // a true no-op writes nothing
    events.push(itemEvent("item.updated", next, actor, at, { changed }));
  }

  if (intent.kind === "set_status") {
    if (!allow("item", "update", ctx)) return fail("denied");
    const statuses = (type.statuses || []).map(s => s.key);
    if (statuses.indexOf(intent.status) < 0) return fail("unknown-status");
    if (intent.status === item.status) return { ok: true, item, events: [] };
    next.status = intent.status;
    events.push(itemEvent("item.status_changed", next, actor, at, { from: item.status, to: intent.status }));
  }

  if (intent.kind === "assign") {
    if (!allow("item", "update", ctx)) return fail("denied");
    const ids = [...new Set((intent.assigneeIds || []).map(String))].sort();
    const was = [...(item.assigneeIds || [])].sort();
    if (JSON.stringify(ids) === JSON.stringify(was)) return { ok: true, item, events: [] };
    next.assigneeIds = ids;
    events.push(itemEvent("item.assigned", next, actor, at, { from: was, to: ids }));
  }

  next.updatedAt = at;
  next.facets = itemFacets(type, next);
  return { ok: true, item: next, events };
}

/* Node test hook — the browser never defines `module`, so this block is
   invisible there; tests/item-engine.test.mjs requires this file. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { ITEM_FIELD_TYPES, ITEM_TYPE_KEYS, ITEM_INTENTS,
    itemSlug, itemFieldDef, itemCoerce, itemIsEmpty, itemValidate, itemFacets, itemCommit };
}
