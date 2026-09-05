/* Unit tests for ../js/permissions.js - pure grammar, so no emulator,
   no DOM, no Firebase: plain node.
     node tests/permissions.test.mjs
   Same runner shape as the other suites: PASS/FAIL lines, exit 1 on any
   failure. */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PERM_SCOPES, permParse, permGrantScope, permDistance, permCan } = require("../js/permissions.js");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 160)); }
};

const A = orgId => ({ uid: "u1", orgId: "orgA", doc: { orgId: orgId || "orgA" } });
const docIn = (o) => ({ uid: "u1", orgId: "orgA", doc: Object.assign({ orgId: "orgA" }, o) });

/* ---------- the ladder ---------- */
T("scopes are ordered weakest to strongest", () => {
  assert.deepEqual(PERM_SCOPES, ["none", "own", "assigned", "org"]);
});

/* ---------- parsing ---------- */
T("parses a well-formed permission", () => {
  assert.deepEqual(permParse("item:update:assigned"), { resource: "item", action: "update", scope: "assigned" });
});
T("tolerates surrounding whitespace", () => {
  assert.deepEqual(permParse(" item : update : org "), { resource: "item", action: "update", scope: "org" });
});
T("rejects a two-part permission", () => assert.equal(permParse("item:update"), null));
T("rejects an unknown scope", () => assert.equal(permParse("item:update:everything"), null));
T("rejects an empty resource", () => assert.equal(permParse(":update:org"), null));
T("rejects a non-string", () => assert.equal(permParse(null), null));

/* ---------- grants ---------- */
T("the widest grant wins, not the last one listed", () => {
  assert.equal(permGrantScope(["item:update:org", "item:update:own"], "item", "update"), "org");
  assert.equal(permGrantScope(["item:update:own", "item:update:org"], "item", "update"), "org");
});
T("an unrelated resource grants nothing", () => {
  assert.equal(permGrantScope(["workflow:publish:org"], "item", "update"), "none");
});
T("an unrelated action grants nothing", () => {
  assert.equal(permGrantScope(["item:delete:org"], "item", "update"), "none");
});
T("a wildcard resource matches", () => {
  assert.equal(permGrantScope(["*:update:assigned"], "item", "update"), "assigned");
});
T("a wildcard action matches", () => {
  assert.equal(permGrantScope(["item:*:org"], "item", "delete"), "org");
});
T("a malformed row costs only itself", () => {
  assert.equal(permGrantScope(["garbage", "item:update:org", ""], "item", "update"), "org");
});
T("an empty or missing list grants nothing", () => {
  assert.equal(permGrantScope([], "item", "update"), "none");
  assert.equal(permGrantScope(undefined, "item", "update"), "none");
});

/* ---------- distance ---------- */
T("a document I created is 'own' even when also assigned to me", () => {
  assert.equal(permDistance(docIn({ createdBy: "u1", assigneeIds: ["u1"] })), "own");
});
T("a document assigned to me but authored elsewhere is 'assigned'", () => {
  assert.equal(permDistance(docIn({ createdBy: "u2", assigneeIds: ["u1"] })), "assigned");
});
T("a colleague's untouched document is 'org'", () => {
  assert.equal(permDistance(docIn({ createdBy: "u2", assigneeIds: ["u3"] })), "org");
});
T("no document means the org-wide act itself", () => {
  assert.equal(permDistance({ uid: "u1", orgId: "orgA" }), "org");
});
T("another tenant's document is unreachable at every rung", () => {
  assert.equal(permDistance(A("orgB")), null);
});

/* ---------- the ladder, end to end ---------- */
T("'assigned' carries 'own' beneath it", () => {
  assert.ok(permCan(["item:update:assigned"], "item", "update", docIn({ createdBy: "u1" })));
});
T("'own' does NOT reach work merely assigned to me", () => {
  assert.ok(!permCan(["item:update:own"], "item", "update", docIn({ createdBy: "u2", assigneeIds: ["u1"] })));
});
T("'own' does NOT reach a colleague's work", () => {
  assert.ok(!permCan(["item:update:own"], "item", "update", docIn({ createdBy: "u2" })));
});
T("'org' reaches everything inside the org", () => {
  assert.ok(permCan(["item:update:org"], "item", "update", docIn({ createdBy: "u2" })));
});
T("'none' reaches nothing, including my own work", () => {
  assert.ok(!permCan(["item:update:none"], "item", "update", docIn({ createdBy: "u1" })));
});

/* ---------- the rule that must hold even if every other line is wrong ---------- */
T("an owner's *:*:org stops dead at the tenant boundary", () => {
  assert.ok(permCan(["*:*:org"], "item", "delete", docIn({ createdBy: "u2" })));
  assert.ok(!permCan(["*:*:org"], "item", "read", A("orgB")));
});
T("a caller with no org reaches nothing", () => {
  assert.ok(!permCan(["*:*:org"], "item", "read", { uid: "u1", doc: { orgId: "orgA" } }));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
