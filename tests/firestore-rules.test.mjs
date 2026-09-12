/* Emulator test matrix for ../firestore.rules - 259 allow/deny assertions
   across five actors: admin, assigner (worker role + special email),
   worker, pending stranger, an unverified fresh signup, and the
   unauthenticated client-link holder.

   Run (needs Java on PATH and firebase-tools):
     cd tests && npm i @firebase/rules-unit-testing firebase
     firebase emulators:exec --only firestore --project demo-ez "node firestore-rules.test.mjs"
   Change the rules path below if you run it from elsewhere. */
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, addDoc } from "firebase/firestore";

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
  await setDoc(doc(db, "invites/inv1"), { createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null });
  await setDoc(doc(db, "invites/inv2"), { createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: "worker1", usedAt: 2 });
  await setDoc(doc(db, "invites/inv4"), { createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null });
  await setDoc(doc(db, "invites/inv5"), { createdBy: "admin1", createdAt: 1, expiresAt: 2, usedBy: null, usedAt: null });
  // inv1/inv2/inv4/inv5 deliberately carry NO kind: they are the shape
  // every invite had before founder links existed, and they must keep
  // working as team invites
  await setDoc(doc(db, "invites/invF"), { kind: "founder", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null });
  await setDoc(doc(db, "invites/invF2"), { kind: "founder", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null });
  await setDoc(doc(db, "invites/invTeam"), { kind: "team", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null });
  // somebody already through the founder door, running their own org
  await setDoc(doc(db, "users/member1"), { email: "founder@other.com", role: "member", emailVerified: true });
  // the directory, mid-migration: one entry stamped to Ez Agency's org,
  // one still carrying no orgId at all (every entry looked like this
  // before the directory was tenant-scoped)
  await setDoc(doc(db, "directory/worker1"), { name: "W1", email: "w1@x.com", orgId: "orgA" });
  await setDoc(doc(db, "directory/worker2"), { name: "W2", email: "w2@x.com" });
  await setDoc(doc(db, "directory/member1"), { name: "Founder", email: "founder@other.com" });
  // an org member1 already owns, with somebody else genuinely in it - the
  // only setup where the "orgId and nothing else" constraint is what
  // decides, rather than the target simply being a stranger
  await setDoc(doc(db, "orgs/orgN"), { name: "N Co", ownerUid: "member1", createdAt: 1 });
  await setDoc(doc(db, "orgs/orgN/members/member1"), { uid: "member1", roleId: "owner", joinedAt: 1 });
  await setDoc(doc(db, "orgs/orgN/members/worker2"), { uid: "worker2", roleId: "staff", joinedAt: 1 });
  // a second customer in orgN, with the pointer that makes them reachable.
  // member1's own pointer moves to orgM during the founder-door tests, so
  // this is the actor the same-org cases run as.
  await setDoc(doc(db, "users/member2"), { email: "colleague@other.com", role: "member", emailVerified: true });
  await setDoc(doc(db, "orgs/orgN/members/member2"), { uid: "member2", roleId: "staff", joinedAt: 1 });
  await setDoc(doc(db, "memberOf/member2"), { orgId: "orgN", at: 1 });
  // ...and somebody whose pointer LIES: says orgA, is seated nowhere
  await setDoc(doc(db, "users/liar1"), { email: "liar@evil.com", role: "member", emailVerified: true });
  await setDoc(doc(db, "memberOf/liar1"), { orgId: "orgA", at: 1 });
  // a third tenant's person, in orgB and nowhere else - the only clean
  // "somebody in another org" in this fixture, since worker2 turns out to
  // sit in orgA, orgB and orgN at once
  await setDoc(doc(db, "users/outsider1"), { email: "out@third.com", role: "member", emailVerified: true });
  await setDoc(doc(db, "orgs/orgB/members/outsider1"), { uid: "outsider1", roleId: "staff", joinedAt: 1 });
  // ---- tenancy (phase 1): two orgs that must never see each other, plus
  // two founded-but-unseated orgs for the founding-seat case ----
  await setDoc(doc(db, "orgs/orgA"), { name: "Org A", ownerUid: "admin1", createdAt: 1 });
  await setDoc(doc(db, "orgs/orgA/members/admin1"), { uid: "admin1", roleId: "owner", joinedAt: 1 });
  await setDoc(doc(db, "orgs/orgA/members/worker1"), { uid: "worker1", roleId: "staff", joinedAt: 1 });
  await setDoc(doc(db, "orgs/orgA/roles/owner"), { name: "Owner", permissions: ["*:*:org"] });
  await setDoc(doc(db, "orgs/orgA/roles/staff"), { name: "Staff", permissions: ["item:update:assigned"] });
  // a role that is NOT the owner and is trusted with exactly one field of
  // a seat - the scheduled shift length. Everything below tests that the
  // "one field" half is real and not just intended.
  await setDoc(doc(db, "orgs/orgA/roles/manager"),
    { name: "Manager", permissions: ["item:read:org", "member:read:org", "member:hours:org", "review:decide:org"] });
  await setDoc(doc(db, "users/mgr1"), { email: "mgr@x.com", role: "worker" });
  await setDoc(doc(db, "orgs/orgA/members/mgr1"), { uid: "mgr1", roleId: "manager", joinedAt: 1 });
  // a plain staff member of orgA who reviews nothing - the actor for "a
  // member is not a reviewer", and the teammate an owner can name as one
  await setDoc(doc(db, "users/staff9"), { email: "s9@x.com", role: "worker" });
  await setDoc(doc(db, "orgs/orgA/members/staff9"), { uid: "staff9", roleId: "staff", joinedAt: 1 });
  await setDoc(doc(db, "orgs/orgB"), { name: "Org B", ownerUid: "worker2", createdAt: 1 });
  await setDoc(doc(db, "orgs/orgB/members/worker2"), { uid: "worker2", roleId: "owner", joinedAt: 1 });
  await setDoc(doc(db, "orgs/orgB/roles/owner"), { name: "Owner", permissions: ["*:*:org"] });
  await setDoc(doc(db, "orgs/orgC"), { name: "Org C", ownerUid: "newbie1", createdAt: 1 });
  await setDoc(doc(db, "orgs/orgF"), { name: "Org F", ownerUid: "newbie2", createdAt: 1 });
  const LIVE = 9999999999999;
  await setDoc(doc(db, "orgs/orgA/invites/oinv1"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: LIVE, usedBy: null, usedAt: null });
  await setDoc(doc(db, "orgs/orgA/invites/oinvUsed"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: LIVE, usedBy: "worker2", usedAt: 2 });
  await setDoc(doc(db, "orgs/orgA/invites/oinvOld"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: 2, usedBy: null, usedAt: null });
  await setDoc(doc(db, "orgs/orgB/invites/oinvB"), { roleId: "staff", createdBy: "worker2", createdAt: 1, expiresAt: LIVE, usedBy: null, usedAt: null });
  await setDoc(doc(db, "orgs/orgA/invites/oinvBurn"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: LIVE, usedBy: null, usedAt: null });
  // ---- the work model (phase 2) ----
  await setDoc(doc(db, "orgs/orgA/itemTypes/task"), { name: "Task", fields: [], statuses: [{ key: "open" }] });
  await setDoc(doc(db, "orgs/orgA/items/it1"), { id: "it1", orgId: "orgA", typeId: "task", title: "A", status: "open", fields: {}, facets: ["type:task", "status:open"], assigneeIds: [], createdBy: "worker1", createdAt: 1, updatedAt: 1 });
  await setDoc(doc(db, "orgs/orgA/events/ev1"), { orgId: "orgA", actorId: "worker1", at: 1, verb: "item.created", subject: { kind: "item", id: "it1" }, data: {} });
  await setDoc(doc(db, "orgs/orgB/items/it2"), { id: "it2", orgId: "orgB", typeId: "task", title: "B", status: "open", fields: {}, facets: [], assigneeIds: [], createdBy: "worker2", createdAt: 1, updatedAt: 1 });
});

const admin = env.authenticatedContext("admin1", { email: "ezagency2nd@gmail.com" }).firestore();
const newbie = env.authenticatedContext("newbie1", { email: "nb@x.com" }).firestore();
const newbie2 = env.authenticatedContext("newbie2", { email: "nb2@x.com" }).firestore();
const assigner = env.authenticatedContext("assigner1", { email: "prashuchiha34@gmail.com" }).firestore();
const worker = env.authenticatedContext("worker1", { email: "w1@x.com" }).firestore();
const manager = env.authenticatedContext("mgr1", { email: "mgr@x.com" }).firestore();
const staff9 = env.authenticatedContext("staff9", { email: "s9@x.com" }).firestore();
const anon = env.unauthenticatedContext().firestore();
const stranger = env.authenticatedContext("stranger1", { email: "stranger@evil.com" }).firestore();
const unverified = env.authenticatedContext("unverified1", { email: "new@x.com" }).firestore();
const newbie3 = env.authenticatedContext("newbie3", { email: "nb3@x.com" }).firestore();
const newbie4 = env.authenticatedContext("newbie4", { email: "nb4@x.com" }).firestore();
// a customer: their own organization, and nothing of Ez Agency's
const member = env.authenticatedContext("member1", { email: "founder@other.com" }).firestore();
const member2 = env.authenticatedContext("member2", { email: "colleague@other.com" }).firestore();
const liar = env.authenticatedContext("liar1", { email: "liar@evil.com" }).firestore();

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

// ================= INVITE-ONLY SIGNUP =================
await T("anon: GET an invite by token (the link is the capability)", assertSucceeds(getDoc(doc(anon, "invites/inv1"))));
await T("anon: LIST invites DENIED (no token harvesting)", assertFails(getDocs(collection(anon, "invites"))));
await T("stranger(pending): LIST invites DENIED", assertFails(getDocs(collection(stranger, "invites"))));
await T("worker: create an invite DENIED (admin hands out the keys)", assertFails(setDoc(doc(worker, "invites/evil"), { createdBy: "worker1", createdAt: 9, usedBy: null, usedAt: null })));
await T("admin: create + list-unused + delete invites", assertSucceeds((async () => {
  await setDoc(doc(admin, "invites/inv3"), { createdBy: "admin1", createdAt: 9, usedBy: null, usedAt: null });
  await getDocs(query(collection(admin, "invites"), where("usedBy", "==", null)));
  await deleteDoc(doc(admin, "invites/inv3"));
})()));
await T("new account WITH a live invite: users doc created", assertSucceeds(setDoc(doc(newbie, "users/newbie1"), { email: "nb@x.com", role: "pending", createdAt: 9, emailVerified: false, verifyCode: "111111", verifyCodeAt: 9, invite: "inv1", name: "NB", phone: "980" })));
await T("new account burns its invite (usedBy = itself, once)", assertSucceeds(updateDoc(doc(newbie, "invites/inv1"), { usedBy: "newbie1", usedAt: 9, usedEmail: "nb@x.com", usedName: "NB" })));
await T("signup with a BURNED invite DENIED", assertFails(setDoc(doc(newbie2, "users/newbie2"), { email: "nb2@x.com", role: "pending", createdAt: 9, emailVerified: false, invite: "inv1", name: "NB2", phone: "" })));
await T("signup with NO invite DENIED (the door is closed)", assertFails(setDoc(doc(newbie2, "users/newbie2"), { email: "nb2@x.com", role: "pending", createdAt: 9, emailVerified: false, name: "NB2", phone: "" })));
await T("signup with someone else's spent invite DENIED", assertFails(setDoc(doc(newbie2, "users/newbie2"), { email: "nb2@x.com", role: "pending", createdAt: 9, emailVerified: false, invite: "inv2", name: "NB2", phone: "" })));
await T("signup with an EXPIRED invite DENIED (links last 24h)", assertFails(setDoc(doc(newbie2, "users/newbie2"), { email: "nb2@x.com", role: "pending", createdAt: 9, emailVerified: false, invite: "inv5", name: "NB2", phone: "" })));
await T("signup straight to role worker DENIED even with an invite", assertFails(setDoc(doc(newbie2, "users/newbie2"), { email: "nb2@x.com", role: "worker", createdAt: 9, emailVerified: true, invite: "inv4", name: "NB2", phone: "" })));
await T("burning an invite in someone ELSE's name DENIED", assertFails(updateDoc(doc(newbie2, "invites/inv4"), { usedBy: "worker1", usedAt: 9 })));

// ================= THE FOUNDER DOOR =================
// A founder link makes a member: somebody running their OWN organization,
// who waits on nobody's approval. The link's KIND is what decides, so the
// two doors cannot be walked through in each other's place.
await T("founder link: creates a MEMBER account", assertSucceeds(setDoc(doc(newbie3, "users/newbie3"), { email: "nb3@x.com", role: "member", createdAt: 9, emailVerified: false, verifyCode: "111111", verifyCodeAt: 9, invite: "invF", name: "NB3", phone: "" })));
await T("founder link cannot make a PENDING account (wrong door)", assertFails(setDoc(doc(newbie4, "users/newbie4"), { email: "nb4@x.com", role: "pending", createdAt: 9, emailVerified: false, invite: "invF2", name: "NB4", phone: "" })));
await T("team link cannot make a MEMBER account (wrong door)", assertFails(setDoc(doc(newbie4, "users/newbie4"), { email: "nb4@x.com", role: "member", createdAt: 9, emailVerified: false, invite: "invTeam", name: "NB4", phone: "" })));
await T("a kindless invite cannot make a MEMBER either", assertFails(setDoc(doc(newbie4, "users/newbie4"), { email: "nb4@x.com", role: "member", createdAt: 9, emailVerified: false, invite: "inv4", name: "NB4", phone: "" })));
await T("member signup with NO invite DENIED", assertFails(setDoc(doc(newbie4, "users/newbie4"), { email: "nb4@x.com", role: "member", createdAt: 9, emailVerified: false, name: "NB4", phone: "" })));
// the backward-compatibility guarantee: every link minted before founder
// links existed carries no kind, and still opens the door it always did
await T("a kindless invite still makes a pending hire (nothing was broken)", assertSucceeds(setDoc(doc(newbie4, "users/newbie4"), { email: "nb4@x.com", role: "pending", createdAt: 9, emailVerified: false, invite: "inv4", name: "NB4", phone: "" })));

// A member is NOT team. isTeam() guards Ez Agency's own pre-tenancy data,
// none of which is org-scoped - so this is the boundary that stops a
// customer reading another company's work, and the whole reason a founder
// is not simply handed the "worker" role.
await T("member: read Ez Agency blueprints DENIED", assertFails(getDoc(doc(member, "blueprints/bp1"))));
await T("member: read Ez Agency runs DENIED", assertFails(getDoc(doc(member, "runs/r1"))));
await T("member: read Ez Agency nodeRuns DENIED", assertFails(getDoc(doc(member, "nodeRuns/nr1"))));
await T("member: list Ez Agency clientReviews DENIED", assertFails(getDocs(collection(member, "clientReviews"))));
await T("member: read an org they do not belong to DENIED", assertFails(getDoc(doc(member, "orgs/orgA"))));

// ...but their own tenant is entirely theirs.
await T("member: creates their own org and seats themselves as owner", assertSucceeds((async () => {
  await setDoc(doc(member, "orgs/orgM"), { name: "Their Co", ownerUid: "member1", createdAt: 9 });
  await setDoc(doc(member, "orgs/orgM/members/member1"), { uid: "member1", roleId: "owner", joinedAt: 9 });
  await setDoc(doc(member, "memberOf/member1"), { orgId: "orgM", at: 9 });
})()));
await T("member: designs a work type in their own org", assertSucceeds(setDoc(doc(member, "orgs/orgM/itemTypes/task"), { name: "Task", fields: [], statuses: [] })));

// ================= HANDOFF: BLUEPRINTS AND RUNS =================
// A customer's pipeline cannot live in the top-level collections isTeam()
// guards, so it hangs under the org like everything else they own.
await T("owner: draws a blueprint in their own org", assertSucceeds(setDoc(doc(admin, "orgs/orgA/blueprints/bp1"), { name: "Brief handoff", nodes: [], edges: [], status: "published" })));
await T("member of the org: reads the blueprint", assertSucceeds(getDoc(doc(worker, "orgs/orgA/blueprints/bp1"))));
await T("non-owner: draws a blueprint DENIED (a pipeline is a shape the owner sets)", assertFails(setDoc(doc(worker, "orgs/orgA/blueprints/evil"), { name: "E", nodes: [], edges: [] })));
await T("another org cannot read this org's blueprint", assertFails(getDoc(doc(member, "orgs/orgA/blueprints/bp1"))));

// a run carries its stops inside it, which is what lets advancing be one
// transaction over one document
await T("member: starts a run, stops and all (advancing is a member action)", assertSucceeds(
  setDoc(doc(worker, "orgs/orgA/runs/run1"), { id: "run1", taskId: "it1", status: "running", orgId: "orgA", startedAt: 1,
    nodeRuns: [{ id: "run1:s0:1", runId: "run1", nodeId: "s0", nodeType: "role", status: "in_progress", arrivedAt: 1 }] })));
await T("member: reads the run they are travelling, and its stops with it", assertSucceeds(getDoc(doc(worker, "orgs/orgA/runs/run1"))));
await T("another org cannot read this org's run, nor therefore its stops", assertFails(getDoc(doc(member, "orgs/orgA/runs/run1"))));
await T("non-owner: delete a run DENIED (history is not a member's to erase)", assertFails(deleteDoc(doc(worker, "orgs/orgA/runs/run1"))));
await T("a stranger reaches none of it", assertFails(getDoc(doc(stranger, "orgs/orgA/runs/run1"))));
await T("Ez Agency's admin cannot read the member's org", assertFails(getDoc(doc(admin, "orgs/orgM"))));

// ================= REVIEWS: submit, decide, resubmit - one document per contribution =================
// The document as js/reviews.js writes it. setDoc replaces the whole
// document, which is what a transaction's update amounts to from the
// rules' side: request.resource.data is always the full next document.
const NULLS = { weightedTenths: null, score: null, scores: null, byUid: null, at: null, month: null, firstPass: null, revisions: null, onTime: null };
const sub = (about, extra) => Object.assign({ orgId: "orgA", itemId: "it1", runId: null, nodeId: null, typeId: "task", title: "A", store: "", stepLabel: "", brief: "the brief",
  aboutUid: about, aboutRoleId: "staff", reviewerUid: null, status: "submitted", round: 1,
  submission: { link: "https://docs.example.com/a", note: "here it is", at: 5, byUid: about, iteration: null, dueAt: null, onTime: null },
  decision: null, history: [], createdAt: 5, updatedAt: 5, version: 1 }, NULLS, extra || {});
const S = { quality: 4, brief: 5, handoff: 4 };   // 43 tenths
const approve = (prev, by, scores, extra) => Object.assign({}, prev, {
  status: "approved", decision: { kind: "approved", feedback: "Restock first, files named.", scores, byUid: by, at: 9 },
  weightedTenths: scores.quality * 5 + scores.brief * 3 + scores.handoff * 2, score: (scores.quality * 5 + scores.brief * 3 + scores.handoff * 2) / 10,
  scores, byUid: by, at: 9, month: "2026-09", firstPass: prev.round === 1, revisions: prev.round - 1, onTime: prev.submission.onTime,
  updatedAt: 9, version: prev.version + 1 }, extra || {});
const changes = (prev, by, extra) => Object.assign({}, prev, {
  status: "changes", decision: { kind: "changes", feedback: "Lead with the restock.", scores: null, byUid: by, at: 9 },
  updatedAt: 9, version: prev.version + 1 }, NULLS, extra || {});
const resubmit = (prev, extra) => Object.assign({}, prev, {
  status: "submitted", round: prev.round + 1, decision: null,
  submission: { link: "https://docs.example.com/a2", note: "round two", at: 12, byUid: prev.aboutUid, iteration: null, dueAt: null, onTime: null },
  history: prev.history.concat([{ round: prev.round, submission: prev.submission, decision: prev.decision }]),
  updatedAt: 12, version: prev.version + 1 }, NULLS, extra || {});
const R1 = "orgs/orgA/reviews/it1:work:worker1";

// --- submitting ---
await T("member: submits their own work for review", assertSucceeds(setDoc(doc(worker, R1), sub("worker1"))));
await T("member: a submission in somebody else's name DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/reviews/it1:work:staff9"), sub("staff9"))));
await T("member: picking their own reviewer on the way in DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/reviews/it2:work:worker1"), sub("worker1", { itemId: "it2", reviewerUid: "staff9" }))));
await T("member: a submission with a javascript: link DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/reviews/it2:work:worker1"), sub("worker1", { itemId: "it2", submission: { link: "javascript:alert(1)", note: "", at: 5, byUid: "worker1" } }))));
await T("member: a submission that arrives already scored DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/reviews/it2:work:worker1"), approve(sub("worker1", { itemId: "it2" }), "admin1", S, { version: 1 }))));
await T("member: rating their OWN work DENIED, even as a decision in their own name", assertFails(setDoc(doc(worker, R1), approve(sub("worker1"), "worker1", S))));
await T("another org's owner reaches no review here", assertFails(getDoc(doc(member, R1))));
await T("a stranger reaches no review", assertFails(getDoc(doc(stranger, R1))));
await T("member: reads the org's reviews (their own feedback, the board)", assertSucceeds(getDoc(doc(worker, R1))));
await T("member: lists the org's reviews", assertSucceeds(getDocs(collection(worker, "orgs/orgA/reviews"))));

// --- deciding ---
await T("plain member (no review:decide): deciding DENIED", assertFails(setDoc(doc(staff9, R1), approve(sub("worker1"), "staff9", S))));
await T("owner: an approval without feedback DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", S, { decision: { kind: "approved", feedback: "", scores: S, byUid: "admin1", at: 9 } }))));
await T("owner: an approval with a score out of range DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", { quality: 6, brief: 5, handoff: 4 }))));
await T("owner: an approval with a fractional score DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", { quality: 4.5, brief: 5, handoff: 4 }))));
await T("owner: an approval whose tenths do not match the scores DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", S, { weightedTenths: 50 }))));
await T("owner: a decision in somebody else's name DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "mgr1", S))));
await T("owner: a decision that does not bump the version DENIED (two decisions cannot both land)", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", S, { version: 1 }))));
await T("owner: a decision that rewrites what was submitted DENIED", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", S, { submission: Object.assign({}, sub("worker1").submission, { note: "edited" }) }))));
await T("owner: requests changes with feedback", assertSucceeds(setDoc(doc(admin, R1), changes(sub("worker1"), "admin1"))));
await T("owner: a second decision on a decided round DENIED (version has moved on)", assertFails(setDoc(doc(admin, R1), approve(sub("worker1"), "admin1", S))));
await T("member: cannot edit the decision on their own review", assertFails(setDoc(doc(worker, R1), changes(sub("worker1"), "admin1", { decision: { kind: "changes", feedback: "fine actually", scores: null, byUid: "admin1", at: 9 }, version: 3 }))));

// --- resubmitting ---
const afterChanges = changes(sub("worker1"), "admin1");
await T("member: a resubmission that drops the closed round from history DENIED", assertFails(setDoc(doc(worker, R1), resubmit(afterChanges, { history: [] }))));
await T("member: a resubmission that rewrites history DENIED", assertFails(setDoc(doc(worker, R1), resubmit(afterChanges, { history: [{ round: 1, submission: afterChanges.submission, decision: { kind: "approved", feedback: "was fine", scores: S, byUid: "admin1", at: 9 } }] }))));
await T("member: a resubmission that names a reviewer DENIED", assertFails(setDoc(doc(worker, R1), resubmit(afterChanges, { reviewerUid: "staff9" }))));
await T("member: a resubmission that keeps a score DENIED", assertFails(setDoc(doc(worker, R1), resubmit(afterChanges, { score: 4.3, weightedTenths: 43, scores: S }))));
await T("somebody else resubmitting a person's work DENIED", assertFails(setDoc(doc(staff9, R1), resubmit(afterChanges))));
await T("member: resubmits after changes - the round closes into history", assertSucceeds(setDoc(doc(worker, R1), resubmit(afterChanges))));
const round2 = resubmit(afterChanges);
await T("manager (review:decide): approves round two with the exact tenths", assertSucceeds(setDoc(doc(manager, R1), approve(round2, "mgr1", S))));
await T("member: reopening an approved review with the history intact (a loop sent it round again)", assertSucceeds(setDoc(doc(worker, R1), resubmit(approve(round2, "mgr1", S)))));
await T("owner: tampering with a closed round in history DENIED", assertFails(setDoc(doc(admin, R1), Object.assign(resubmit(approve(round2, "mgr1", S)), {
  history: [{ round: 1, submission: afterChanges.submission, decision: { kind: "changes", feedback: "REWRITTEN", scores: null, byUid: "admin1", at: 9 } }, resubmit(approve(round2, "mgr1", S)).history[1]],
  version: resubmit(approve(round2, "mgr1", S)).version + 1 }))));

// --- naming a reviewer ---
const R3 = "orgs/orgA/reviews/it3:work:worker1";
await setDoc(doc(worker, R3), sub("worker1", { itemId: "it3" }));
await T("member: naming their own reviewer DENIED", assertFails(updateDoc(doc(worker, R3), { reviewerUid: "staff9", updatedAt: 7, version: 2 })));
await T("owner: naming the person as their own reviewer DENIED", assertFails(updateDoc(doc(admin, R3), { reviewerUid: "worker1", updatedAt: 7, version: 2 })));
await T("owner: naming a reviewer and a score in one write DENIED (one field, pinned)", assertFails(updateDoc(doc(admin, R3), { reviewerUid: "staff9", score: 5, updatedAt: 7, version: 2 })));
await T("owner: names an independent teammate as reviewer", assertSucceeds(updateDoc(doc(admin, R3), { reviewerUid: "staff9", updatedAt: 7, version: 2 })));
await T("named reviewer: decides the review they were given", assertSucceeds(setDoc(doc(staff9, R3), approve(sub("worker1", { itemId: "it3", reviewerUid: "staff9", version: 2 }), "staff9", S))));
await T("owner: naming a reviewer on an approved review DENIED", assertFails(updateDoc(doc(admin, R3), { reviewerUid: "mgr1", updatedAt: 8, version: 4 })));
await T("named reviewer: deciding a review they were NOT given DENIED", assertFails(setDoc(doc(staff9, "orgs/orgA/reviews/it4:work:worker1"), approve(sub("worker1", { itemId: "it4" }), "staff9", S, { version: 1 }))));

// --- a step that rates: the reviewer opens and closes the round in one write ---
const stepSub = about => ({ link: null, note: "the finish note", at: 5, byUid: about, iteration: 1, dueAt: null, onTime: null });
const R5 = "orgs/orgA/reviews/it5:s0:worker1";
await T("manager: records a step's rating with the step's own finish as the submission", assertSucceeds(setDoc(doc(manager, R5), approve(sub("worker1", { itemId: "it5", nodeId: "s0", submission: stepSub("worker1") }), "mgr1", S, { version: 1 }))));
await T("plain member: recording a step's rating DENIED", assertFails(setDoc(doc(staff9, "orgs/orgA/reviews/it6:s0:worker1"), approve(sub("worker1", { itemId: "it6", nodeId: "s0", submission: stepSub("worker1") }), "staff9", S, { version: 1 }))));
const stepDone = approve(sub("worker1", { itemId: "it5", nodeId: "s0", submission: stepSub("worker1") }), "mgr1", S, { version: 1 });
// one write opens round two AND decides it, so the version steps once
const stepRound2 = approve(Object.assign(resubmit(stepDone), { submission: Object.assign(stepSub("worker1"), { iteration: 2 }) }), "mgr1", S, { version: 2 });
await T("manager: the step reached again opens round two and decides it, keeping round one", assertSucceeds(setDoc(doc(manager, R5), stepRound2)));
await T("manager: the same again, with round one dropped from history DENIED", assertFails(setDoc(doc(manager, R5), approve(Object.assign(resubmit(stepRound2), { history: [] }), "mgr1", S, { version: 3 }))));
await T("manager: the same again, with round two's decision rewritten in history DENIED", assertFails(setDoc(doc(manager, R5), approve(Object.assign(resubmit(stepRound2), { history: [stepRound2.history[0], { round: 2, submission: stepRound2.submission, decision: Object.assign({}, stepRound2.decision, { feedback: "REWRITTEN" }) }] }), "mgr1", S, { version: 3 }))));

// --- deleting ---
await T("non-owner: delete a review DENIED (a deleted review is a changed score)", assertFails(deleteDoc(doc(worker, R1))));
await T("manager: delete a review DENIED", assertFails(deleteDoc(doc(manager, R1))));
await T("owner: deletes a review", assertSucceeds(deleteDoc(doc(admin, R1))));

// ================= THE DIRECTORY IS TENANT-SCOPED =================
// It holds names and emails. "Every signed-in account may read it" was
// true enough while everyone with an account worked here; the founder
// door ended that, and this is the boundary that replaces it.
await T("member: read another org's directory entry DENIED", assertFails(getDoc(doc(member, "directory/worker1"))));
await T("member: read a LEGACY unstamped entry DENIED (they are not team)", assertFails(getDoc(doc(member, "directory/worker2"))));
await T("member: read their OWN entry", assertSucceeds(getDoc(doc(member, "directory/member1"))));
await T("member: sweep the whole directory DENIED", assertFails(getDocs(collection(member, "directory"))));
await T("worker: read a teammate stamped to their own org", assertSucceeds(getDoc(doc(worker, "directory/worker1"))));
await T("worker: read a legacy unstamped entry (the migration ramp)", assertSucceeds(getDoc(doc(worker, "directory/worker2"))));
await T("worker: scoped query over their own org", assertSucceeds(getDocs(query(collection(worker, "directory"), where("orgId", "==", "orgA")))));

// An owner stamps their own people, and may change nothing else about them
await T("admin(owner of orgA): stamps a member's entry with orgId", assertSucceeds(setDoc(doc(admin, "directory/worker2"), { orgId: "orgA" }, { merge: true })));
await T("owner: stamping somebody who is NOT in their org DENIED", assertFails(setDoc(doc(member, "directory/worker1"), { orgId: "orgN" }, { merge: true })));
// worker2 IS in orgN, so these two turn on the constraint itself rather
// than on the target being a stranger
await T("owner: stamps orgId onto their own member", assertSucceeds(setDoc(doc(member, "directory/worker2"), { orgId: "orgN" }, { merge: true })));
await T("owner: stamping orgId AND a name DENIED (a roster is not a rename)", assertFails(setDoc(doc(member, "directory/worker2"), { orgId: "orgN", name: "Hacked" }, { merge: true })));
await T("owner: renaming their own member DENIED", assertFails(setDoc(doc(member, "directory/worker2"), { name: "Hacked" }, { merge: true })));

// ================= WHO MAY RING WHOSE BELL =================
// "Anyone signed in may notify anyone" was a statement about who could
// hold an account. Once a customer can, it is a way to put text in this
// team's bell - no leak, but a phishing surface.
const NOTE = t => ({ kind: "automation", read: false, createdAt: 9, text: t, store: "", task: "" });
await T("member: notify an Ez Agency worker DENIED", assertFails(setDoc(doc(member2, "notifications/x1"), { ...NOTE("click here"), toUid: "worker1" })));
await T("member: ring the admin bell with arbitrary text DENIED", assertFails(setDoc(doc(member2, "notifications/x2"), { ...NOTE("reset your password"), toRole: "admin" })));
await T("member: notify somebody in their OWN org", assertSucceeds(setDoc(doc(member2, "notifications/x3"), { ...NOTE("a swap needs covering"), toUid: "member1" })));
await T("member: notify somebody in ANOTHER org DENIED", assertFails(setDoc(doc(member2, "notifications/x4"), { ...NOTE("hello"), toUid: "outsider1" })));
await T("a LYING memberOf pointer buys nothing", assertFails(setDoc(doc(liar, "notifications/x5"), { ...NOTE("trust me"), toUid: "worker1" })));
await T("worker(team): still notifies anyone, as the legacy paths need", assertSucceeds(setDoc(doc(worker, "notifications/x6"), { ...NOTE("@mention"), toUid: "worker2" })));
await T("a fresh signup may still ring the approval bell", assertSucceeds(setDoc(doc(newbie3, "notifications/x7"), { toRole: "admin", kind: "signup", read: false, createdAt: 9, msg: "NB3 verified their email" })));
await T("...but only in that exact shape", assertFails(setDoc(doc(newbie3, "notifications/x8"), { toRole: "admin", kind: "automation", read: false, createdAt: 9, text: "anything else" })));

await T("member: writing into Ez Agency's assignments DENIED", assertFails(setDoc(doc(member2, "assignments/a9"), { toUid: "member2", store: "s", task: "t", createdAt: 9 })));

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

// ================= TENANCY (phase 1) =================
// The one property the whole product rests on: an org is a wall, and no
// role - not even an owner holding *:*:org - reaches through it.
await T("member: read own org", assertSucceeds(getDoc(doc(worker, "orgs/orgA"))));
await T("member: read ANOTHER org DENIED", assertFails(getDoc(doc(worker, "orgs/orgB"))));
await T("member: read another org's roster DENIED", assertFails(getDoc(doc(worker, "orgs/orgB/members/worker2"))));
await T("member: read another org's roles DENIED", assertFails(getDoc(doc(worker, "orgs/orgB/roles/owner"))));
await T("owner of A: read org B DENIED", assertFails(getDoc(doc(admin, "orgs/orgB"))));
await T("owner of A: write into org B DENIED", assertFails(setDoc(doc(admin, "orgs/orgB/roles/evil"), { name: "E", permissions: ["*:*:org"] })));
await T("stranger to the org: read it DENIED", assertFails(getDoc(doc(stranger, "orgs/orgA"))));
await T("orgs are never enumerable", assertFails(getDocs(collection(admin, "orgs"))));

await T("member: read own org's roles", assertSucceeds(getDoc(doc(worker, "orgs/orgA/roles/staff"))));
await T("member: read own org's roster", assertSucceeds(getDoc(doc(worker, "orgs/orgA/members/admin1"))));
await T("owner: shape a role", assertSucceeds(setDoc(doc(admin, "orgs/orgA/roles/editor"), { name: "Editor", permissions: ["item:update:org"] })));
await T("non-owner member: shape a role DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/roles/evil"), { name: "Evil", permissions: ["*:*:org"] })));
await T("non-owner member: seat someone DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/members/stranger1"), { roleId: "staff", joinedAt: 9 })));
await T("non-owner member: promote SELF to owner DENIED", assertFails(updateDoc(doc(worker, "orgs/orgA/members/worker1"), { roleId: "owner" })));
await T("owner: seat a member", assertSucceeds(setDoc(doc(admin, "orgs/orgA/members/worker2"), { roleId: "staff", joinedAt: 9 })));

/* ---- scheduled hours: one delegated field on a seat ----
   The grant is member:hours at org scope. What makes delegating it safe is
   not the grant but the FIELD PIN beside it: without that, the update that
   sets somebody's hours is the same update that could set their roleId,
   and "can set hours" would quietly mean "can promote themselves". */
await T("owner: set someone's shift hours",
  assertSucceeds(updateDoc(doc(admin, "orgs/orgA/members/worker1"), { shiftMinutes: 360 })));
await T("manager with member:hours: set someone's shift hours",
  assertSucceeds(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { shiftMinutes: 420 })));
await T("manager: clear the hours back to unset",
  assertSucceeds(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { shiftMinutes: 0 })));
await T("manager: ride the same write into a role change DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { shiftMinutes: 360, roleId: "owner" })));
await T("manager: change a role on its own DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { roleId: "owner" })));
await T("manager: promote SELF DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgA/members/mgr1"), { roleId: "owner" })));
await T("staff without the grant: set their own hours DENIED",
  assertFails(updateDoc(doc(worker, "orgs/orgA/members/worker1"), { shiftMinutes: 60 })));
await T("owner: a day longer than a day DENIED",
  assertFails(updateDoc(doc(admin, "orgs/orgA/members/worker1"), { shiftMinutes: 2000 })));
await T("manager: hours that are not a whole number of minutes DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { shiftMinutes: 90.5 })));
await T("manager: negative hours DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgA/members/worker1"), { shiftMinutes: -60 })));
await T("manager of one org: set hours in ANOTHER org DENIED",
  assertFails(updateDoc(doc(manager, "orgs/orgB/members/worker2"), { shiftMinutes: 360 })));
await T("owner: move ownerUid DENIED", assertFails(updateDoc(doc(admin, "orgs/orgA"), { ownerUid: "worker1" })));
await T("owner: rename the org", assertSucceeds(updateDoc(doc(admin, "orgs/orgA"), { name: "Org A renamed" })));
await T("owner: delete the org DENIED", assertFails(deleteDoc(doc(admin, "orgs/orgA"))));

await T("founder: seat SELF as owner (the founding seat)", assertSucceeds(setDoc(doc(newbie, "orgs/orgC/members/newbie1"), { roleId: "owner", joinedAt: 9 })));
await T("founder: seat self at a LESSER role DENIED", assertFails(setDoc(doc(newbie2, "orgs/orgF/members/newbie2"), { roleId: "staff", joinedAt: 9 })));
await T("founder: seat SOMEONE ELSE DENIED", assertFails(setDoc(doc(newbie2, "orgs/orgF/members/worker1"), { roleId: "owner", joinedAt: 9 })));
await T("non-founder: seat self into an unseated org DENIED", assertFails(setDoc(doc(newbie2, "orgs/orgC/members/newbie2"), { roleId: "owner", joinedAt: 9 })));
await T("create an org naming SOMEONE ELSE as owner DENIED", assertFails(setDoc(doc(newbie, "orgs/orgD"), { name: "D", ownerUid: "admin1", createdAt: 1 })));
await T("create an org naming self", assertSucceeds(setDoc(doc(newbie, "orgs/orgE"), { name: "E", ownerUid: "newbie1", createdAt: 1 })));
await T("create an org with no createdAt DENIED", assertFails(setDoc(doc(newbie, "orgs/orgG"), { name: "G", ownerUid: "newbie1" })));
await T("anonymous: read an org DENIED", assertFails(getDoc(doc(anon, "orgs/orgA"))));

// memberOf is the pointer a client reads to FIND its tenant, since orgs
// are not enumerable. It authorizes nothing - but it is still nobody
// else's business which org a colleague belongs to.
await T("memberOf: write my own pointer", assertSucceeds(setDoc(doc(worker, "memberOf/worker1"), { orgId: "orgA", at: 1 })));
await T("memberOf: read my own pointer", assertSucceeds(getDoc(doc(worker, "memberOf/worker1"))));
await T("memberOf: read SOMEONE ELSE's pointer DENIED", assertFails(getDoc(doc(worker, "memberOf/worker2"))));
await T("memberOf: write SOMEONE ELSE's pointer DENIED", assertFails(setDoc(doc(worker, "memberOf/worker2"), { orgId: "orgA", at: 1 })));
await T("memberOf: anonymous read DENIED", assertFails(getDoc(doc(anon, "memberOf/worker1"))));
// pointing at an org you do not belong to buys nothing - the org refuses you
// ---- finding your own membership when nobody handed you a pointer ----
// An owner can seat an existing team, but memberOf is a document only its
// owner may write - so the seated person has to be able to FIND the seat.
await T("a person finds their own membership across orgs", assertSucceeds(
  getDocs(query(collectionGroup(worker, "members"), where("uid", "==", "worker1")))));
await T("that lookup cannot be pointed at anyone else", assertFails(
  getDocs(query(collectionGroup(worker, "members"), where("uid", "==", "admin1")))));
await T("an unfiltered sweep of every membership everywhere DENIED", assertFails(
  getDocs(collectionGroup(worker, "members"))));
await T("anonymous cannot run that lookup at all", assertFails(
  getDocs(query(collectionGroup(anon, "members"), where("uid", "==", "worker1")))));

// ---- org invites: the token is the capability, and the seat names it ----
const seat = (roleId, invite) => ({ roleId, invite, joinedAt: 9 });

await T("invite: any signed-in holder may read what it offers", assertSucceeds(getDoc(doc(stranger, "orgs/orgA/invites/oinv1"))));
await T("invite: a non-owner lists them DENIED", assertFails(getDocs(collection(stranger, "orgs/orgA/invites"))));
await T("invite: an owner lists them (one membership check, any count)", assertSucceeds(getDocs(collection(admin, "orgs/orgA/invites"))));
await T("invite: a non-owner mints one DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/invites/evil1"), { roleId: "staff", createdBy: "worker1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null })));
await T("invite: an owner of A mints into B DENIED", assertFails(setDoc(doc(admin, "orgs/orgB/invites/evil2"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null })));
await T("invite: an owner mints one", assertSucceeds(setDoc(doc(admin, "orgs/orgA/invites/oinvNew"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: null, usedAt: null })));
await T("invite: minting one already marked used DENIED", assertFails(setDoc(doc(admin, "orgs/orgA/invites/evil3"), { roleId: "staff", createdBy: "admin1", createdAt: 1, expiresAt: 9999999999999, usedBy: "admin1", usedAt: 1 })));

// every way of NOT getting a seat, before the one way that works
await T("seat: with no invite named DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), { roleId: "staff", joinedAt: 9 })));
await T("seat: naming a USED invite DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("staff", "oinvUsed"))));
await T("seat: naming an EXPIRED invite DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("staff", "oinvOld"))));
await T("seat: another org token DENIED (wrong path, no such doc)", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("staff", "oinvB"))));
await T("seat: naming an invite that does not exist DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("staff", "nope"))));
await T("seat: claiming a HIGHER role than the invite grants DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("owner", "oinv1"))));
await T("seat: using a live invite to seat SOMEONE ELSE DENIED", assertFails(setDoc(doc(stranger, "orgs/orgA/members/unverified1"), seat("staff", "oinv1"))));

// burning: the holder stamps themselves on it, once, and nothing else
await T("burn: stamp SOMEONE ELSE onto an invite DENIED", assertFails(updateDoc(doc(stranger, "orgs/orgA/invites/oinvBurn"), { usedBy: "worker1", usedAt: 9 })));
await T("burn: move the org while burning DENIED", assertFails(updateDoc(doc(stranger, "orgs/orgA/invites/oinvBurn"), { usedBy: "stranger1", usedAt: 9, orgId: "orgB" })));
await T("burn: raise the role while burning DENIED", assertFails(updateDoc(doc(stranger, "orgs/orgA/invites/oinvBurn"), { usedBy: "stranger1", usedAt: 9, roleId: "owner" })));
await T("burn: an already-burned invite DENIED", assertFails(updateDoc(doc(stranger, "orgs/orgA/invites/oinvUsed"), { usedBy: "stranger1", usedAt: 9 })));

// and now the one path that works, end to end
await T("seat: a live invite seats the holder at the role it grants", assertSucceeds(setDoc(doc(stranger, "orgs/orgA/members/stranger1"), seat("staff", "oinv1"))));
await T("burn: the holder stamps themselves on it", assertSucceeds(updateDoc(doc(stranger, "orgs/orgA/invites/oinv1"), { usedBy: "stranger1", usedAt: 9 })));
await T("seated member: now reads the org", assertSucceeds(getDoc(doc(stranger, "orgs/orgA"))));
await T("seated member: still cannot shape roles", assertFails(setDoc(doc(stranger, "orgs/orgA/roles/evil"), { name: "Evil", permissions: ["*:*:org"] })));
await T("seated member: still cannot read org B", assertFails(getDoc(doc(stranger, "orgs/orgB"))));
await T("invite: an owner revokes one", assertSucceeds(deleteDoc(doc(admin, "orgs/orgA/invites/oinvNew"))));
await T("invite: a member revokes one DENIED", assertFails(deleteDoc(doc(worker, "orgs/orgA/invites/oinvBurn"))));

// ---- the work model: tenancy is the path, and the log is append-only ----
const newItem = over => Object.assign({ id: "x", orgId: "orgA", typeId: "task", title: "T", status: "open", fields: {}, facets: ["type:task"], assigneeIds: [], createdBy: "worker1", createdAt: 1, updatedAt: 1 }, over);
const newEvent = over => Object.assign({ orgId: "orgA", actorId: "worker1", at: 1, verb: "item.updated", subject: { kind: "item", id: "it1" }, data: {} }, over);

await T("items: a member reads one", assertSucceeds(getDoc(doc(worker, "orgs/orgA/items/it1"))));
await T("items: a member lists them (one membership check, any count)", assertSucceeds(getDocs(collection(worker, "orgs/orgA/items"))));
await T("items: a member writes one", assertSucceeds(setDoc(doc(worker, "orgs/orgA/items/it9"), newItem({ id: "it9" }))));
await T("items: a NON-member reads one DENIED", assertFails(getDoc(doc(unverified, "orgs/orgA/items/it1"))));
await T("items: a member of A reads B DENIED", assertFails(getDoc(doc(worker, "orgs/orgB/items/it2"))));
await T("items: a member of A lists B DENIED", assertFails(getDocs(collection(worker, "orgs/orgB/items"))));
await T("items: a member of A writes into B DENIED", assertFails(setDoc(doc(worker, "orgs/orgB/items/evil"), newItem({ orgId: "orgB" }))));
await T("items: anonymous reads one DENIED", assertFails(getDoc(doc(anon, "orgs/orgA/items/it1"))));

await T("itemTypes: a member reads the schema", assertSucceeds(getDoc(doc(worker, "orgs/orgA/itemTypes/task"))));
await T("itemTypes: a non-owner designs one DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/itemTypes/evil"), { name: "E", fields: [], statuses: [] })));
await T("itemTypes: an owner designs one", assertSucceeds(setDoc(doc(admin, "orgs/orgA/itemTypes/brief"), { name: "Brief", fields: [], statuses: [{ key: "open" }] })));

await T("events: a member appends one in their own name", assertSucceeds(addDoc(collection(worker, "orgs/orgA/events"), newEvent())));
await T("events: appending in SOMEONE ELSE's name DENIED", assertFails(addDoc(collection(worker, "orgs/orgA/events"), newEvent({ actorId: "admin1" }))));
await T("events: an event with no verb DENIED", assertFails(addDoc(collection(worker, "orgs/orgA/events"), { orgId: "orgA", actorId: "worker1", at: 1 })));
await T("events: a member reads the log", assertSucceeds(getDocs(collection(worker, "orgs/orgA/events"))));
await T("events: a NON-member reads the log DENIED", assertFails(getDocs(collection(unverified, "orgs/orgA/events"))));
// the property the audit trail rests on: history is not editable by anyone
await T("events: a member rewrites history DENIED", assertFails(updateDoc(doc(worker, "orgs/orgA/events/ev1"), { verb: "item.deleted" })));
await T("events: an OWNER rewrites history DENIED", assertFails(updateDoc(doc(admin, "orgs/orgA/events/ev1"), { verb: "item.deleted" })));
await T("events: an OWNER deletes history DENIED", assertFails(deleteDoc(doc(admin, "orgs/orgA/events/ev1"))));

await T("automations: a member reads the rules that act on their work", assertSucceeds(getDocs(collection(worker, "orgs/orgA/automations"))));
await T("automations: a non-owner writes one DENIED", assertFails(setDoc(doc(worker, "orgs/orgA/automations/evil"), { name: "E", enabled: true, trigger: { verb: "item.created" }, actions: [] })));
await T("automations: an owner writes one", assertSucceeds(setDoc(doc(admin, "orgs/orgA/automations/a1"), { name: "Notify leads", enabled: true, trigger: { verb: "item.created" }, conditions: [], actions: [{ kind: "notify", toRole: "manager", message: "New" }] })));
await T("automations: a NON-member reads them DENIED", assertFails(getDocs(collection(unverified, "orgs/orgA/automations"))));
await T("automations: a member of A reads B DENIED", assertFails(getDocs(collection(worker, "orgs/orgB/automations"))));

await T("memberOf: a forged pointer still cannot open the org", assertFails((async () => {
  await setDoc(doc(worker, "memberOf/worker1"), { orgId: "orgB", at: 1 });
  return getDoc(doc(worker, "orgs/orgB"));
})()));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
