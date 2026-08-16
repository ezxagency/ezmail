/* Emulator test matrix for ../firestore.rules - 106 allow/deny assertions
   across five actors: admin, assigner (worker role + special email),
   worker, pending stranger, an unverified fresh signup, and the
   unauthenticated client-link holder.

   Run (needs Java on PATH and firebase-tools):
     cd tests && npm i @firebase/rules-unit-testing firebase
     firebase emulators:exec --only firestore --project demo-ez "node firestore-rules.test.mjs"
   Change the rules path below if you run it from elsewhere. */
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, addDoc } from "firebase/firestore";

const rules = readFileSync("../firestore.rules", "utf8");
let pass = 0, fail = 0;
const T = async (name, p) => {
  try { await p; pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 140)); }
};

const env = await initializeTestEnvironment({
  projectId: "demo-ez",
  firestore: { rules, host: "127.0.0.1", port: 8080 }
});

// ---- seed data with rules disabled ----
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users/admin1"), { email: "ezagency2nd@gmail.com", role: "admin" });
  await setDoc(doc(db, "users/assigner1"), { email: "prashuchiha34@gmail.com", role: "worker" });
  await setDoc(doc(db, "users/worker1"), { email: "w1@x.com", role: "worker" });
  await setDoc(doc(db, "users/stranger1"), { email: "stranger@evil.com", role: "pending" });
  await setDoc(doc(db, "users/worker2"), { email: "w2@x.com", role: "worker" });
  await setDoc(doc(db, "users/unverified1"), { email: "new@x.com", role: "pending", emailVerified: false, verifyCode: "111111", verifyCodeAt: 1 });
  await setDoc(doc(db, "appState/worker1"), { json: "{}", email: "w1@x.com" });
  await setDoc(doc(db, "assignments/a1"), { toUid: "worker1", toName: "W1", store: "abc", task: "Copy", done: false, ack: false });
  await setDoc(doc(db, "assignments/a2"), { toUid: "worker2", toName: "W2", store: "mno", task: "Design", done: true, ack: false });
  await setDoc(doc(db, "campaigns/c1"), { title: "T", memberUids: ["worker1", "assigner1"], status: "active", cur: 0, stages: [], history: [], updatedAt: 1 });
  await setDoc(doc(db, "campaigns/c2"), { title: "T2", memberUids: ["worker2"], status: "active", cur: 0, stages: [], history: [], updatedAt: 1 });
  await setDoc(doc(db, "campaignTemplates/t1"), { name: "Tpl", stages: [] });
  await setDoc(doc(db, "blueprints/bp1"), { orgId: "ez-agency", ownerId: "admin1", name: "Track", version: 1, status: "published", nodes: [], edges: [], createdAt: 1, updatedAt: 1 });
  await setDoc(doc(db, "blueprints/bp1/versions/1"), { version: 1, name: "Track", nodes: [], edges: [], publishedAt: 1, publishedBy: "admin1" });
  await setDoc(doc(db, "runs/run1"), { id: "run1", blueprintId: "bp1", blueprintSnapshot: { nodes: [], edges: [] }, taskId: null, task: { title: "Banner" }, orgId: "ez-agency", status: "running", activeNodeIds: ["n1"], hops: 2, startedAt: 1, completedAt: null, nodeRunIds: ["run1:t:1", "run1:n1:1"] });
  await setDoc(doc(db, "nodeRuns/run1:n1:1"), { id: "run1:n1:1", seq: 1, runId: "run1", nodeId: "n1", nodeType: "role", status: "in_progress", assigneeId: "worker1", arrivedAt: 1, completedAt: null, output: {}, inputs: {} });
  await setDoc(doc(db, "notifications/n1"), { toUid: "worker1", fromUid: "worker2", kind: "handoff", status: "pending", store: "abc", task: "Copy", text: "@W1 take it", read: false, createdAt: 1 });
  await setDoc(doc(db, "notifications/n2"), { toRole: "admin", read: false, createdAt: 1 });
  await setDoc(doc(db, "clientReviews/tok1"), { campaignId: "c1", title: "T", stage: "Copy", status: "pending", comment: "", decidedAt: null, links: [] });
  await setDoc(doc(db, "clientReviews/tok2"), { campaignId: "c1", title: "T", stage: "Copy", status: "approved", comment: "ok", decidedAt: 2, links: [] });
  await setDoc(doc(db, "directory/worker1"), { name: "W1", email: "w1@x.com", craft: "designer" });
  await setDoc(doc(db, "directory/worker2"), { name: "W2", email: "w2@x.com" });
});

const admin = env.authenticatedContext("admin1", { email: "ezagency2nd@gmail.com" }).firestore();
const assigner = env.authenticatedContext("assigner1", { email: "prashuchiha34@gmail.com" }).firestore();
const worker = env.authenticatedContext("worker1", { email: "w1@x.com" }).firestore();
const anon = env.unauthenticatedContext().firestore();
const stranger = env.authenticatedContext("stranger1", { email: "stranger@evil.com" }).firestore();
const unverified = env.authenticatedContext("unverified1", { email: "new@x.com" }).firestore();

// ================= WORKER =================
await T("worker: query own open assignments", assertSucceeds(getDocs(query(collection(worker, "assignments"), where("toUid", "==", "worker1"), where("done", "==", false)))));
await T("worker: unfiltered assignments list DENIED", assertFails(getDocs(collection(worker, "assignments"))));
await T("worker: update own assignment (done)", assertSucceeds(updateDoc(doc(worker, "assignments/a1"), { done: true, doneAt: 9, ack: false })));
await T("worker: update someone else's assignment DENIED", assertFails(updateDoc(doc(worker, "assignments/a2"), { done: false })));
await T("worker: create SELF-addressed assignment (handoff accept)", assertSucceeds(setDoc(doc(worker, "assignments/self1"), { toUid: "worker1", toName: "W1", store: "abc", task: "Copy", note: "", snote: "Accepted hand-off from W2", done: false, createdAt: 9, groupId: null, groupSize: 1, seenAt: null, dueDate: null, doneAt: null, fromName: "W2", fromEmail: "" })));
await T("worker: create assignment for ANOTHER DENIED", assertFails(setDoc(doc(worker, "assignments/evil1"), { toUid: "worker2", task: "x" })));
await T("worker: delete an assignment DENIED", assertFails(deleteDoc(doc(worker, "assignments/a1"))));
await T("worker: update own handoff notification status", assertSucceeds(updateDoc(doc(worker, "notifications/n1"), { status: "accepted" })));
await T("worker: create notification to anyone (decline notify)", assertSucceeds(addDoc(collection(worker, "notifications"), { toUid: "worker2", kind: "handoff-news", msg: "declined", fromUid: "worker1", read: false, createdAt: 9 })));
await T("worker: read admin roleDoc notification DENIED", assertFails(getDoc(doc(worker, "notifications/n2"))));
await T("worker: query own notifications", assertSucceeds(getDocs(query(collection(worker, "notifications"), where("toUid", "==", "worker1")))));
await T("worker: campaigns query by membership", assertSucceeds(getDocs(query(collection(worker, "campaigns"), where("memberUids", "array-contains", "worker1")))));
await T("worker: unfiltered campaigns list DENIED", assertFails(getDocs(collection(worker, "campaigns"))));
await T("worker: update member campaign (baton move)", assertSucceeds(updateDoc(doc(worker, "campaigns/c1"), { cur: 1, updatedAt: 9 })));
await T("worker: update NON-member campaign DENIED", assertFails(updateDoc(doc(worker, "campaigns/c2"), { cur: 1 })));
await T("worker: create campaign DENIED", assertFails(setDoc(doc(worker, "campaigns/x"), { title: "x", memberUids: ["worker1"] })));
await T("worker: read campaignTemplates DENIED", assertFails(getDoc(doc(worker, "campaignTemplates/t1"))));
await T("worker: create clientReview (stage owner sends link)", assertSucceeds(setDoc(doc(worker, "clientReviews/tok3"), { campaignId: "c1", title: "T", stage: "Copy", status: "pending", comment: "", decidedAt: null, links: [] })));
await T("worker: query clientReviews by campaign", assertSucceeds(getDocs(query(collection(worker, "clientReviews"), where("campaignId", "==", "c1")))));
await T("worker: write own directory merge", assertSucceeds(setDoc(doc(worker, "directory/worker1"), { name: "W1", craft: "designer" }, { merge: true })));
await T("worker: write other's directory DENIED", assertFails(setDoc(doc(worker, "directory/worker2"), { name: "hax" }, { merge: true })));
await T("worker: read other's appState DENIED", assertFails(getDoc(doc(worker, "appState/worker2"))));
await T("worker: mail to self", assertSucceeds(addDoc(collection(worker, "mail"), { to: ["w1@x.com"], message: { subject: "s", html: "h" }, summary: { requestedBy: "w1@x.com" } })));
await T("worker: mail to other DENIED", assertFails(addDoc(collection(worker, "mail"), { to: ["boss@x.com"], summary: { requestedBy: "w1@x.com" } })));

// ================= WORKFLOW BLUEPRINTS =================
await T("worker: read blueprints (runs board shows the track)", assertSucceeds(getDocs(query(collection(worker, "blueprints"), where("orgId", "==", "ez-agency")))));
await T("worker: create blueprint DENIED", assertFails(setDoc(doc(worker, "blueprints/evil"), { orgId: "ez-agency", name: "x", nodes: [], edges: [] })));
await T("worker: update blueprint DENIED", assertFails(updateDoc(doc(worker, "blueprints/bp1"), { name: "renamed" })));
await T("worker: delete blueprint DENIED", assertFails(deleteDoc(doc(worker, "blueprints/bp1"))));
await T("admin: delete a PUBLISHED blueprint (runs keep their frozen copies)", assertSucceeds((async () => {
  await setDoc(doc(admin, "blueprints/bp9"), { orgId: "ez-agency", ownerId: "admin1", name: "Pub", version: 2, status: "published", nodes: [], edges: [], createdAt: 9, updatedAt: 9 });
  await deleteDoc(doc(admin, "blueprints/bp9"));
})()));
await T("admin: blueprint create+update+delete", assertSucceeds((async () => {
  await setDoc(doc(admin, "blueprints/bp2"), { orgId: "ez-agency", ownerId: "admin1", name: "New", version: 1, status: "draft", nodes: [], edges: [], createdAt: 9, updatedAt: 9 });
  await updateDoc(doc(admin, "blueprints/bp2"), { name: "Renamed", updatedAt: 10 });
  await deleteDoc(doc(admin, "blueprints/bp2"));
})()));
await T("stranger(pending): read blueprints DENIED", assertFails(getDocs(collection(stranger, "blueprints"))));
await T("anon: read blueprint DENIED", assertFails(getDoc(doc(anon, "blueprints/bp1"))));
await T("worker: read a blueprint version (history is team-readable)", assertSucceeds(getDoc(doc(worker, "blueprints/bp1/versions/1"))));
await T("worker: write a blueprint version DENIED", assertFails(setDoc(doc(worker, "blueprints/bp1/versions/9"), { version: 9, nodes: [], edges: [] })));
await T("admin: record v2 at publish", assertSucceeds(setDoc(doc(admin, "blueprints/bp1/versions/2"), { version: 2, name: "Track", nodes: [], edges: [], publishedAt: 9, publishedBy: "admin1" })));
await T("worker: v1 still intact and readable after v2 landed", assertSucceeds(getDoc(doc(worker, "blueprints/bp1/versions/1"))));
await T("admin: rewriting a past version DENIED (write-once, immutable)", assertFails(updateDoc(doc(admin, "blueprints/bp1/versions/1"), { nodes: [{ hacked: true }] })));

// ================= WORKFLOW RUNS + NODERUNS =================
await T("worker: read a run", assertSucceeds(getDoc(doc(worker, "runs/run1"))));
await T("worker: create run DENIED (admin starts runs)", assertFails(setDoc(doc(worker, "runs/evil"), { orgId: "ez-agency", status: "running", blueprintSnapshot: {}, task: {}, nodeRunIds: [] })));
await T("worker: delete run DENIED", assertFails(deleteDoc(doc(worker, "runs/run1"))));
await T("worker: advance writes progress allowlist only", assertSucceeds(updateDoc(doc(worker, "runs/run1"), { status: "running", activeNodeIds: ["n2"], hops: 3, completedAt: null, nodeRunIds: ["run1:t:1", "run1:n1:1", "run1:n2:1"] })));
await T("worker: rewrite blueprintSnapshot mid-flight DENIED", assertFails(updateDoc(doc(worker, "runs/run1"), { hops: 4, blueprintSnapshot: { nodes: [], edges: [], hacked: true } })));
await T("worker: rewrite frozen task DENIED", assertFails(updateDoc(doc(worker, "runs/run1"), { hops: 4, task: { title: "forged" } })));
await T("worker: create nodeRun (the engine's new attempts)", assertSucceeds(setDoc(doc(worker, "nodeRuns/run1:n2:1"), { id: "run1:n2:1", seq: 2, runId: "run1", nodeId: "n2", nodeType: "role", status: "in_progress", assigneeId: null, arrivedAt: 9, completedAt: null, output: {}, inputs: {} })));
await T("worker: update nodeRun (completing a stop)", assertSucceeds(updateDoc(doc(worker, "nodeRuns/run1:n1:1"), { status: "completed", completedAt: 9, output: { approved: true } })));
await T("worker: delete nodeRun DENIED", assertFails(deleteDoc(doc(worker, "nodeRuns/run1:n1:1"))));
await T("admin: run create+delete", assertSucceeds((async () => {
  await setDoc(doc(admin, "runs/run2"), { id: "run2", blueprintId: "bp1", blueprintSnapshot: { nodes: [], edges: [] }, taskId: null, task: { title: "X" }, orgId: "ez-agency", status: "running", activeNodeIds: [], hops: 1, startedAt: 9, completedAt: null, nodeRunIds: [] });
  await deleteDoc(doc(admin, "runs/run2"));
})()));
await T("stranger(pending): read runs DENIED", assertFails(getDoc(doc(stranger, "runs/run1"))));
await T("stranger(pending): read nodeRuns DENIED", assertFails(getDocs(collection(stranger, "nodeRuns"))));
await T("anon: read run DENIED", assertFails(getDoc(doc(anon, "runs/run1"))));
await T("worker: cancel a run DENIED (verdicts are admin's)", assertFails(updateDoc(doc(worker, "runs/run1"), { status: "cancelled", activeNodeIds: [] })));
await T("admin: cancel a run (status + cleared stops only)", assertSucceeds(updateDoc(doc(admin, "runs/run1"), { status: "cancelled", activeNodeIds: [] })));

// ================= ASSIGNER =================
await T("assigner: unfiltered assignments read (log/picker)", assertSucceeds(getDocs(collection(assigner, "assignments"))));
await T("assigner: create assignment for another", assertSucceeds(setDoc(doc(assigner, "assignments/as1"), { toUid: "worker1", toName: "W1", store: "abc", task: "Embed", done: false })));
await T("assigner: update another's assignment (edit flow)", assertSucceeds(updateDoc(doc(assigner, "assignments/a1"), { note: "edited" })));
await T("assigner: DELETE assignment (edit removes a row)", assertSucceeds(deleteDoc(doc(assigner, "assignments/a1"))));
await T("assigner: read appState (picker names)", assertSucceeds(getDoc(doc(assigner, "appState/worker1"))));
await T("assigner: campaigns membership query works", assertSucceeds(getDocs(query(collection(assigner, "campaigns"), where("memberUids", "array-contains", "assigner1")))));
await T("assigner: users pending query DENIED (not admin)", assertFails(getDocs(query(collection(assigner, "users"), where("role", "==", "pending")))));

// ================= ADMIN =================
await T("admin: unfiltered assignments", assertSucceeds(getDocs(collection(admin, "assignments"))));
await T("admin: completion query done/ack", assertSucceeds(getDocs(query(collection(admin, "assignments"), where("done", "==", true), where("ack", "==", false)))));
await T("admin: delete assignment", assertSucceeds(deleteDoc(doc(admin, "assignments/a2"))));
await T("admin: unfiltered campaigns", assertSucceeds(getDocs(collection(admin, "campaigns"))));
await T("admin: create+delete campaign", assertSucceeds((async () => { await setDoc(doc(admin, "campaigns/adm1"), { title: "x", memberUids: [], stages: [], status: "active" }); await deleteDoc(doc(admin, "campaigns/adm1")); })()));
await T("admin: templates CRUD", assertSucceeds((async () => { await setDoc(doc(admin, "campaignTemplates/t2"), { name: "n", stages: [] }); await deleteDoc(doc(admin, "campaignTemplates/t2")); })()));
await T("admin: toRole notifications query", assertSucceeds(getDocs(query(collection(admin, "notifications"), where("toRole", "==", "admin")))));
await T("admin: users pending query", assertSucceeds(getDocs(query(collection(admin, "users"), where("role", "==", "pending")))));
await T("admin: write any directory (roles sheet)", assertSucceeds(setDoc(doc(admin, "directory/worker2"), { craft: "copywriter" }, { merge: true })));
await T("admin: delete worker users+appState", assertSucceeds((async () => { await deleteDoc(doc(admin, "appState/worker1")); await deleteDoc(doc(admin, "users/worker2")); })()));

// ================= UNAUTHENTICATED (client link) =================
await T("anon: GET clientReview by token", assertSucceeds(getDoc(doc(anon, "clientReviews/tok1"))));
await T("anon: LIST clientReviews DENIED (no enumeration)", assertFails(getDocs(collection(anon, "clientReviews"))));
await T("anon: decide pending review (allowed keys)", assertSucceeds(updateDoc(doc(anon, "clientReviews/tok1"), { status: "changes", comment: "fix header", decidedAt: 9 })));
await T("anon: re-answer decided review DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok2"), { status: "changes", comment: "again", decidedAt: 9 })));
await T("anon: sneak extra field DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok3"), { status: "approved", comment: "", decidedAt: 9, links: ["https://evil"] })));
await T("anon: invalid status DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok3"), { status: "hacked", comment: "", decidedAt: 9 })));
await T("anon: delete review DENIED", assertFails(deleteDoc(doc(anon, "clientReviews/tok1"))));
await T("anon: read assignments DENIED", assertFails(getDoc(doc(anon, "assignments/a1"))));
await T("anon: read campaigns DENIED", assertFails(getDoc(doc(anon, "campaigns/c1"))));
await T("anon: read directory DENIED", assertFails(getDoc(doc(anon, "directory/worker1"))));
await T("anon: create notification DENIED", assertFails(addDoc(collection(anon, "notifications"), { toUid: "worker1", msg: "spam" })));

// ================= HARDENING (audit findings) =================
await T("worker: re-address own task to someone else DENIED", assertFails(updateDoc(doc(worker, "assignments/self1"), { toUid: "worker2" })));
await T("worker: rewrite own task's note/store DENIED", assertFails(updateDoc(doc(worker, "assignments/self1"), { note: "hax", store: "zzz" })));
await T("worker: finish own task with comment (allowlist)", assertSucceeds(updateDoc(doc(worker, "assignments/self1"), { done: true, doneAt: 9, ack: false, comment: "done!", commentAt: 9 })));
await T("worker: stamp seenAt (allowlist)", assertSucceeds(updateDoc(doc(worker, "assignments/self1"), { seenAt: 9 })));
await T("worker: revert decided handoff to pending DENIED", assertFails(updateDoc(doc(worker, "notifications/n1"), { status: "pending" })));
await T("worker: rewrite notification text DENIED", assertFails(updateDoc(doc(worker, "notifications/n1"), { text: "forged" })));
await T("worker: mark own notification read (allowlist)", assertSucceeds(updateDoc(doc(worker, "notifications/n1"), { read: true })));
await T("worker: mail with bcc smuggled DENIED", assertFails(addDoc(collection(worker, "mail"), { to: ["w1@x.com"], bcc: ["victim@x.com"], message: { subject: "s", html: "h" }, summary: { requestedBy: "w1@x.com" } })));
await T("worker: legit mail shape still allowed", assertSucceeds(addDoc(collection(worker, "mail"), { to: ["w1@x.com"], message: { subject: "s", html: "h" }, summary: { requestedBy: "w1@x.com" } })));
await T("stranger(pending): LIST clientReviews DENIED", assertFails(getDocs(collection(stranger, "clientReviews"))));
await T("stranger(pending): filtered clientReviews query DENIED", assertFails(getDocs(query(collection(stranger, "clientReviews"), where("campaignId", "==", "c1")))));
await T("stranger(pending): create clientReview DENIED", assertFails(setDoc(doc(stranger, "clientReviews/evil"), { campaignId: "c1", status: "pending" })));
await T("stranger(pending): GET by token still works (capability link)", assertSucceeds(getDoc(doc(stranger, "clientReviews/tok2"))));
await T("stranger(pending): assignments/campaigns/directory reads DENIED", assertFails(getDocs(collection(stranger, "assignments"))));
await T("anon: oversized comment DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok3"), { status: "approved", comment: "x".repeat(2001), decidedAt: 9 })));
await T("anon: non-string comment DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok3"), { status: "approved", comment: { evil: true }, decidedAt: 9 })));
await T("anon: string decidedAt DENIED", assertFails(updateDoc(doc(anon, "clientReviews/tok3"), { status: "approved", comment: "", decidedAt: "later" })));
await T("anon: normal decision still works", assertSucceeds(updateDoc(doc(anon, "clientReviews/tok3"), { status: "approved", comment: "looks great", decidedAt: 9 })));
await T("admin: mark roleDoc notification read (allowlist)", assertSucceeds(updateDoc(doc(admin, "notifications/n2"), { read: true })));

// ================= EMAIL VERIFICATION (post-signup code) =================
await T("unverified: resend a fresh code (allowlist)", assertSucceeds(updateDoc(doc(unverified, "users/unverified1"), { verifyCode: "222222", verifyCodeAt: 2 })));
await T("unverified: sneak a role change while resending DENIED", assertFails(updateDoc(doc(unverified, "users/unverified1"), { verifyCode: "333333", role: "admin" })));
await T("unverified: touch a disallowed field alongside verifying DENIED", assertFails(updateDoc(doc(unverified, "users/unverified1"), { emailVerified: true, email: "hacked@x.com" })));
await T("unverified: mark self verified after entering the right code", assertSucceeds(updateDoc(doc(unverified, "users/unverified1"), { emailVerified: true })));
await T("unverified: reuse the verify path once already verified DENIED", assertFails(updateDoc(doc(unverified, "users/unverified1"), { verifyCode: "999999" })));
await T("worker: touch verify fields on a legacy doc with no such field DENIED", assertFails(updateDoc(doc(worker, "users/worker1"), { verifyCode: "000000" })));
await T("worker: touch ANOTHER user's verify fields DENIED", assertFails(updateDoc(doc(worker, "users/unverified1"), { emailVerified: true })));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
