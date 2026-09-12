/* ============================================================
   PERMISSIONS — pure grammar. No DOM, no Firestore, no globals
   from the rest of the app: plain values in, a boolean out, so
   the same file runs unchanged in the browser (classic script)
   and under Node for unit tests (tests/permissions.test.mjs).
   Same discipline as js/workflow-engine.js, and for the same
   reason: the moment authorization needs the DOM to answer a
   question, it stops being testable and starts being trusted.

   A permission is three parts — resource:action:scope. The first
   two name WHAT; the third names HOW FAR, and that is the part
   worth reading twice:

     none      cannot, at all
     own       documents this person created
     assigned  documents assigned to them, or that they created
     org       anything the organization owns

   Those four are a LADDER, not four unrelated buckets: a grant
   at one rung carries every rung beneath it, so "assigned"
   quietly includes "own" and nobody has to be granted both.
   That is the whole reason `assigned` is defined as "mine either
   way" rather than the narrower "in assigneeIds" — the narrow
   reading would break the ladder and force admins to reason
   about overlapping sets, which is exactly the complexity this
   grammar exists to refuse. Three meaningful scopes is the
   ceiling: past that, the roles screen stops being something a
   non-technical admin can hold in their head, and a permission
   model nobody understands is one nobody configures correctly.

   `*` is allowed for resource and action, never for scope — an
   owner is ["*:*:org"], and there is deliberately no way to
   write a wildcard that means "everywhere at every distance"
   without also saying how far it reaches.
   ============================================================ */

/* The ladder, weakest first. Index IS the rank - permRank() leans
   on that, so never reorder this array. */
const PERM_SCOPES = ["none", "own", "assigned", "org"];

const permRank = scope => {
  const i = PERM_SCOPES.indexOf(scope);
  return i < 0 ? -1 : i;   // -1 = not a scope at all, which never matches
};

/* "item:update:assigned" -> { resource, action, scope }, or null for
   anything malformed. Returning null rather than throwing is the safe
   default here: a garbled row in a role document should cost that one
   row, not every check that role is asked to answer. */
function permParse(str){
  if (typeof str !== "string") return null;
  const p = str.split(":");
  if (p.length !== 3) return null;
  const [resource, action, scope] = p.map(s => s.trim());
  if (!resource || !action || permRank(scope) < 0) return null;
  return { resource, action, scope };
}

/* The widest scope a permission list grants for one resource:action.
   Wildcards count, and the WIDEST grant wins - listing both
   "item:update:own" and "item:update:org" is not a contradiction to
   resolve, it is just a redundant row. */
function permGrantScope(permissions, resource, action){
  let best = "none";
  (permissions || []).forEach(row => {
    const p = permParse(row);
    if (!p) return;
    if (p.resource !== resource && p.resource !== "*") return;
    if (p.action !== action && p.action !== "*") return;
    if (permRank(p.scope) > permRank(best)) best = p.scope;
  });
  return best;
}

/* How far this person actually stands from one document:
   the NARROWEST scope that still reaches it. A grant satisfies the
   check when it ranks at or above this. Cross-tenant is not a scope
   and never will be - a document from another org is unreachable at
   every rung, which is the one rule that must hold even if every
   other line here is misconfigured. */
function permDistance(ctx){
  const { uid, orgId, doc } = ctx || {};
  if (!doc) return "org";                       // no document = the org-wide act itself
  if (!orgId || doc.orgId !== orgId) return null;   // another tenant: unreachable
  // NARROWEST first, and that ordering is the ladder working: a document
  // someone both created AND is assigned to must answer "own", or a role
  // granted only "own" would be locked out of its author's own work the
  // moment anybody assigned it to them.
  if (doc.createdBy === uid) return "own";
  if (Array.isArray(doc.assigneeIds) && doc.assigneeIds.indexOf(uid) >= 0) return "assigned";
  return "org";
}

/* The one call the app makes.
   ctx = { uid, orgId, doc?: { orgId, createdBy, assigneeIds } } */
function permCan(permissions, resource, action, ctx){
  const need = permDistance(ctx);
  if (need === null) return false;              // wrong tenant, full stop
  const granted = permGrantScope(permissions, resource, action);
  if (granted === "none") return false;
  return permRank(granted) >= permRank(need);
}

/* ============================================================
   THE CATALOG — every (resource, action) an org can grant, in the
   words an admin uses rather than the words the database uses. It
   lives here, beside the grammar, because a roles screen offering a
   pair the grammar never checks is a switch wired to nothing: the
   test suite asserts the two agree, so that stays impossible.
   ============================================================ */
const PERM_CATALOG = [
  { resource: "item", label: "Work", actions: [
    { action: "create", label: "Create work" },
    { action: "read",   label: "See work" },
    { action: "update", label: "Change work" },
    { action: "delete", label: "Delete work" }
  ]},
  { resource: "itemType", label: "Work types", actions: [
    { action: "read",   label: "See types" },
    { action: "update", label: "Design types" }
  ]},
  { resource: "workflow", label: "Workflows", actions: [
    { action: "read",    label: "See workflows" },
    { action: "update",  label: "Draw workflows" },
    { action: "publish", label: "Publish workflows" }
  ]},
  { resource: "review", label: "Reviews", actions: [
    { action: "decide", label: "Review and rate submitted work" }
  ]},
  { resource: "automation", label: "Automations", actions: [
    { action: "read",   label: "See automations" },
    { action: "update", label: "Build automations" }
  ]},
  { resource: "member", label: "People", actions: [
    { action: "read",   label: "See the roster" },
    { action: "invite", label: "Invite people" },
    /* Narrow on purpose. It authorizes ONE field on a seat - the
       scheduled length of that person's shift - and firestore.rules
       pins the write to that field, so it can never be ridden into a
       role change. A broader "member:update" would have been the same
       switch wired to the whole seat. */
    { action: "hours",  label: "Set working hours" }
  ]},
  { resource: "role", label: "Roles", actions: [
    { action: "read",   label: "See roles" },
    { action: "update", label: "Change roles" }
  ]},
  { resource: "report", label: "Reports", actions: [
    { action: "read", label: "See reports" }
  ]}
];

/* Node test hook — the browser never defines `module`, so this block is
   invisible there; tests/permissions.test.mjs requires this file. */
if (typeof module !== "undefined" && module.exports){
  module.exports = { PERM_SCOPES, PERM_CATALOG, permParse, permGrantScope, permDistance, permCan };
}
