/* ============================================================
   REVIEWS — submit work for review, decide on it, resubmit.

   js/rating.js decides (what a review is, what a submission or a
   decision needs, who may decide, the math). This file does the
   WRITING and the DRAWING: the transactions, the notifications,
   the three sheets, the Reviews & Feedback page, and the live
   watch that keeps the deck's cards and the page current.

   THE DOCUMENT: orgs/{orgId}/reviews/{rvKey(item, step, person)}
     status      submitted | changes | approved
     round       1, 2, 3 ... one per submission
     submission  { link, note, at, byUid, iteration, dueAt, onTime }
     decision    null | { kind, feedback, scores|null, byUid, at }
     history     the closed rounds, in order, never rewritten
     reviewerUid null (the owner and anyone holding review:decide) or
                 the teammate an owner named
     version     bumped on every write; the rules refuse a stale one
   plus the rating fields the board reads once it is approved
   (weightedTenths, score, scores, byUid, at, month, firstPass,
   revisions, onTime) - null until then, so nothing pending can be
   mistaken for a zero.

   EVERY WRITE IS A TRANSACTION that reads the document first and
   checks it is still in the state the screen showed: two reviewers
   deciding the same submission, or a person resubmitting while their
   reviewer is typing, is refused with "changed" rather than one of
   them silently overwriting the other. firestore.rules holds the same
   line from the other side (the version, the history prefix, who may
   move what to what), because a screen is not a gate.

   PROTECTED versus ENFORCED-IN-THE-BROWSER, said plainly: the rating
   data here - who decided, the scores, the history - is checked by
   the rules on the server. Which STEP a piece of work is on, and
   whether a person may finish it, is still the item engine running
   in the browser under the knowingly-permissive items/runs rules the
   platform spec documents. A review therefore records a judgement
   the server protects, about work whose movement it does not yet.

   `rv` prefix: one shared global scope.
   ============================================================ */

const rvCol = orgId => db.collection("orgs").doc(orgId).collection("reviews");
let rvMine = null;      // my own review documents; null = not loaded, false = could not reach
let rvQueue = null;     // what waits on me as a reviewer; same three states
let rvUnsubs = [];
let rvPageOpen = false;

const rvUid = () => (typeof auth !== "undefined" && auth && auth.currentUser) ? auth.currentUser.uid : null;
const rvNameOf = uid => (typeof orgPersonName === "function" && uid) ? orgPersonName(uid) : (uid || "someone");
const rvWhen = at => at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + clock(at) : "";
const rvStatusWord = { submitted: "In review", changes: "Changes requested", approved: "Approved", stale: "Approved earlier", none: "Not reviewed" };

/* My standing in the org, as the rules see it: my role and its rows. */
function rvMe(){
  const s = typeof orgS !== "undefined" ? orgS : null;
  const uid = rvUid();
  if (!s || !uid) return { uid, roleId: null, perms: [], s: null };
  const role = (s.roles || []).find(r => r.id === s.myRoleId);
  const perms = s.myRoleId === "owner" ? ["*:*:org"] : (role ? role.permissions || [] : []);
  return { uid, roleId: s.myRoleId || null, perms, s };
}
/* Do I review for this org at all - an owner, or a role that decides? */
function rvIsReviewer(){
  const me = rvMe();
  if (!me.s) return false;
  return me.roleId === "owner" || (typeof permGrantScope === "function" && permGrantScope(me.perms, "review", "decide") === "org");
}
/* Who a submission goes to: the named reviewer, else everyone who may
   decide - the owner and any role granted review:decide. */
function rvReviewersFor(review){
  const s = typeof orgS !== "undefined" ? orgS : null;
  if (!s) return [];
  if (review && review.reviewerUid) return [review.reviewerUid];
  const roleMay = {};
  (s.roles || []).forEach(r => { roleMay[r.id] = r.id === "owner" || (typeof permGrantScope === "function" && permGrantScope(r.permissions || [], "review", "decide") === "org"); });
  return (s.members || []).filter(m => m.roleId === "owner" || roleMay[m.roleId]).map(m => m.uid);
}

/* ---------- reading ---------- */

/* The document for one of my rows on the deck, and the state it puts
   the card in. A row on a track is reviewed per STEP - the summary the
   run writes onto the item carries the step's id and iteration. */
/* The running step of this row that I hold. Steps that run together
   give one row several running steps, held by different people; the
   summary's first is somebody else's when mine is the second, and a
   review keyed by it would be about their work, not mine. */
function rvStopOf(row){
  const h = row && row.handoff && !row.handoff.done ? row.handoff : null;
  if (!h) return null;
  return typeof hoMyStop === "function" ? hoMyStop(h, rvUid()) : (h.stop || null);
}
function rvForRow(row){
  const uid = rvUid();
  if (!row || !uid || !Array.isArray(rvMine)) return null;
  const itemId = row.itemId || row.id;
  const st = rvStopOf(row);
  const nodeId = st ? (st.nodeId || null) : null;
  const key = rvKey(itemId, nodeId, uid);
  return rvMine.find(r => r.id === key) || null;
}
function rvRowState(row){
  const st = rvStopOf(row);
  const iteration = st && st.iteration != null ? st.iteration : null;
  return rvState(rvForRow(row), iteration);
}
/* Whether a row can be submitted at all: it is a piece of org work I
   hold, with a kind of work still there. Work from the assignments-only
   path (no organization) has nowhere for a review to live. */
function rvRowOffers(row){
  return !!(row && rvUid() && typeof orgS !== "undefined" && orgS && (row.itemId || row.id) && !row.orphanType);
}

/* Everything a submission needs about the work, read fresh: the item
   (its brief, deadline, kind), and if it is on a track, the step I
   hold and which iteration of it this is. Refuses when the step is not
   with me any more - a submission for a step somebody else holds would
   be reviewed about the wrong work. */
async function rvCtxLoad(itemId, wantNodeId){
  const s = await orgEnsure();
  const uid = rvUid();
  if (!s || !uid) return { ok: false, error: "no-org" };
  let item;
  try {
    const d = await db.collection("orgs").doc(s.orgId).collection("items").doc(itemId).get();
    if (!d.exists) return { ok: false, error: "gone" };
    item = Object.assign({ id: d.id }, d.data());
  } catch (e) { console.error(e); return { ok: false, error: "read-failed" }; }
  const type = (s.types || []).find(t => t.id === item.typeId) || null;
  const f = item.fields || {};
  const ctx = {
    itemId: item.id, typeId: item.typeId || null, typeName: type ? type.name : "",
    title: f.task || item.title || "Work", store: f.store || item.store || "",
    brief: f.note || item.brief || "", runId: item.workflowRunId || null,
    nodeId: null, stepLabel: "", iteration: null,
    dueAt: rvDueAt({ dueAt: item.dueAt, dueDate: f.dueDate, dueTime: f.dueTime }),
    assigned: (item.assigneeIds || []).indexOf(uid) >= 0
  };
  if (item.workflowRunId && typeof itemsHandoffLoad === "function") {
    const h = await itemsHandoffLoad(item);
    if (!h) return { ok: false, error: "no-run" };
    const stops = hoActiveStops(h.nodeRuns);
    const held = stops.filter(nr => hoMayAdvance(h.blueprint, nr, uid, h.members, false).ok);
    // the step the card named, if it is mine; otherwise whichever running
    // step is - the card's summary may predate `stops`, and name the step
    // that runs alongside mine. Refused only when I hold none of them.
    const mine = held.find(nr => nr.nodeId === wantNodeId) || held[0] || null;
    if (!mine) return { ok: false, error: "not-your-step" };
    const node = ((h.blueprint && h.blueprint.nodes) || []).find(n => n.id === mine.nodeId);
    ctx.nodeId = mine.nodeId;
    ctx.stepLabel = (node && node.config && node.config.label) || mine.nodeId;
    ctx.iteration = (h.nodeRuns || []).filter(nr => nr.nodeId === mine.nodeId).length;
    if (mine.dueAt) ctx.dueAt = mine.dueAt;
  } else if (!ctx.assigned && (item.createdBy || null) !== uid) {
    return { ok: false, error: "not-yours" };
  }
  return { ok: true, ctx, item };
}

/* ---------- writing ---------- */

const rvRatingNulls = () => ({ weightedTenths: null, score: null, scores: null, byUid: null, at: null, month: null,
  firstPass: null, revisions: null, onTime: null });

/* Submit, or resubmit. One transaction: a document that is already in
   review, or approved for THIS iteration, is refused rather than
   quietly rewritten; a resubmission closes the round into history. */
async function rvSubmit(ctx, link, note){
  const s = await orgEnsure();
  const uid = rvUid();
  if (!s || !uid) return { ok: false, error: "no-org" };
  const ok = rvSubmissionOk(link, note);
  if (!ok.ok) return { ok: false, error: ok.reason };
  const now = Date.now();
  const ref = rvCol(s.orgId).doc(rvKey(ctx.itemId, ctx.nodeId, uid));
  const submission = { link: (link || "").trim() || null, note: (note || "").trim(), at: now, byUid: uid,
    iteration: ctx.iteration == null ? null : ctx.iteration, dueAt: ctx.dueAt == null ? null : ctx.dueAt,
    onTime: rvOnTime(now, ctx.dueAt) };
  let out = null;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        out = Object.assign({
          orgId: s.orgId, itemId: ctx.itemId, runId: ctx.runId || null, nodeId: ctx.nodeId || null, typeId: ctx.typeId || null,
          title: ctx.title || "", store: ctx.store || "", stepLabel: ctx.stepLabel || "", brief: ctx.brief || "",
          aboutUid: uid, aboutRoleId: s.myRoleId || null, reviewerUid: null,
          status: "submitted", round: 1, submission, decision: null, history: [],
          createdAt: now, updatedAt: now, version: 1
        }, rvRatingNulls());
        tx.set(ref, out);
        return;
      }
      const p = snap.data();
      if (p.aboutUid !== uid) throw new Error("not-yours");
      if (p.status === "submitted") throw new Error("already-submitted");
      if (p.status === "approved" && !(ctx.iteration != null && p.submission && p.submission.iteration != null && p.submission.iteration < ctx.iteration))
        throw new Error("already-approved");
      const patch = Object.assign({
        status: "submitted", round: (p.round || 1) + 1, submission, decision: null,
        history: (p.history || []).concat([{ round: p.round || 1, submission: p.submission || null, decision: p.decision || null }]),
        title: ctx.title || p.title || "", brief: ctx.brief || p.brief || "",
        updatedAt: now, version: (p.version || 0) + 1
      }, rvRatingNulls());
      tx.update(ref, patch);
      out = Object.assign({}, p, patch);
    });
  } catch (e) {
    const code = String(e && e.message || e);
    if (["not-yours", "already-submitted", "already-approved"].indexOf(code) >= 0) return { ok: false, error: code };
    console.error("Could not submit for review:", e);
    return { ok: false, error: "write-failed" };
  }
  out.id = ref.id;
  rvNotify(rvReviewersFor(out).filter(u => u !== uid), {
    kind: "review-submitted", msg: rvNameOf(uid) + " submitted " + (out.title || "work") + " for review" + (out.round > 1 ? " (round " + out.round + ")" : "") + ".",
    text: submission.note || submission.link || "", store: out.store || "", task: out.title || "" });
  return { ok: true, review: out };
}

/* Decide. `expectVersion` is the version the sheet was drawn from: if
   the document moved on (somebody else decided, or the person
   resubmitted), the write is refused and the sheet says so. */
async function rvDecide(reviewId, kind, scores, feedback, expectVersion){
  const s = await orgEnsure();
  const me = rvMe();
  if (!s || !me.uid) return { ok: false, error: "no-org" };
  const ok = rvDecisionOk(kind, scores, feedback);
  if (!ok.ok) return { ok: false, error: ok.reason };
  const ref = rvCol(s.orgId).doc(reviewId);
  const now = Date.now();
  let out = null;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("gone");
      const p = snap.data();
      if (p.status !== "submitted" || (expectVersion != null && p.version !== expectVersion)) throw new Error("changed");
      if (!rvMayDecide(p, me.uid, me.roleId, me.perms)) throw new Error("not-allowed");
      const decision = { kind, feedback: feedback.trim(), scores: kind === "approved" ? { quality: scores.quality, brief: scores.brief, handoff: scores.handoff } : null, byUid: me.uid, at: now };
      const patch = Object.assign({ status: kind, decision, updatedAt: now, version: (p.version || 0) + 1 }, rvRatingNulls());
      if (kind === "approved") {
        const tenths = rtTenths(decision.scores);
        Object.assign(patch, { weightedTenths: tenths, score: tenths / 10, scores: decision.scores, byUid: me.uid, at: now,
          month: rtMonth(now), firstPass: (p.round || 1) === 1, revisions: Math.max(0, (p.round || 1) - 1),
          onTime: p.submission && typeof p.submission.onTime === "boolean" ? p.submission.onTime : null });
      }
      tx.update(ref, patch);
      out = Object.assign({ id: reviewId }, p, patch);
    });
  } catch (e) {
    const code = String(e && e.message || e);
    if (["gone", "changed", "not-allowed"].indexOf(code) >= 0) return { ok: false, error: code };
    console.error("Could not record the decision:", e);
    return { ok: false, error: "write-failed" };
  }
  rvNotify([out.aboutUid], {
    kind: "review-decided",
    msg: (kind === "approved" ? "Approved · " + rtFmt(out.score) + " / 5 — " : "Changes requested on ") + (out.title || "your work") + (kind === "approved" ? "." : "."),
    text: out.decision.feedback, store: out.store || "", task: out.title || "" });
  return { ok: true, review: out };
}

/* Name a reviewer (or clear one). The rules pin this write to that one
   field, so a role that may pick a reviewer cannot ride it to change a
   score. Never the person whose work it is. */
async function rvDelegate(reviewId, reviewerUid){
  const s = await orgEnsure();
  const me = rvMe();
  if (!s || !me.uid) return { ok: false, error: "no-org" };
  const ref = rvCol(s.orgId).doc(reviewId);
  const now = Date.now();
  let out = null;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("gone");
      const p = snap.data();
      if (p.status === "approved") throw new Error("decided");
      if (!rvMayDelegate(p, me.uid, me.roleId, me.perms)) throw new Error("not-allowed");
      if (reviewerUid && reviewerUid === p.aboutUid) throw new Error("self");
      const patch = { reviewerUid: reviewerUid || null, updatedAt: now, version: (p.version || 0) + 1 };
      tx.update(ref, patch);
      out = Object.assign({ id: reviewId }, p, patch);
    });
  } catch (e) {
    const code = String(e && e.message || e);
    if (["gone", "decided", "not-allowed", "self"].indexOf(code) >= 0) return { ok: false, error: code };
    console.error("Could not set the reviewer:", e);
    return { ok: false, error: "write-failed" };
  }
  if (reviewerUid && reviewerUid !== me.uid && out.status === "submitted")
    rvNotify([reviewerUid], { kind: "review-assigned", msg: rvNameOf(me.uid) + " asked you to review " + (out.title || "some work") + ".",
      text: (out.submission && (out.submission.note || out.submission.link)) || "", store: out.store || "", task: out.title || "" });
  return { ok: true, review: out };
}

/* A step that RATES the work it receives (the builder's switch) is a
   review too: the checker's finish IS the decision, and the finish note
   is the feedback. It lands in the same document the person's own
   submission would, so the board never holds two ratings for one
   contribution whichever way the review arrived. If the person had
   submitted, this decides that submission; if not, the checker's
   decision opens and closes the round in one write, with the step's
   own finish as the submission. Refuses without feedback: a rating
   with no words is the thing the rubric exists to prevent. */
async function rvRecordFromStep(item, type, h, reviewerStop, output, uid){
  try {
    const rv = output.review || {};
    const feedback = (output.comment || "").trim();
    const kind = rv.sentBack ? "changes" : "approved";
    const ok = rvDecisionOk(kind, rv.scores, feedback);
    if (!ok.ok) { console.warn("A step rating was not recorded: " + ok.reason); return null; }
    const legs = hoTrail(h.blueprint, h.nodeRuns).filter(t => t.status === "completed");
    const last = legs.length ? legs[legs.length - 1] : null;
    if (!last || !last.by || last.by === uid) return null;   // nothing received, or their own work
    const iteration = (h.nodeRuns || []).filter(nr => nr.nodeId === last.nodeId && nr.status === "completed").length;
    const s = await orgEnsure();
    const me = rvMe();
    const ref = rvCol(s.orgId).doc(rvKey(item.id, last.nodeId, last.by));
    const now = Date.now();
    let out = null;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const p = snap.exists ? snap.data() : null;
      if (p && !rvMayDecide(p, me.uid, me.roleId, me.perms)) throw new Error("not-allowed");
      const decision = { kind, feedback, scores: kind === "approved" ? { quality: rv.scores.quality, brief: rv.scores.brief, handoff: rv.scores.handoff } : null, byUid: uid, at: now };
      const rating = kind === "approved" ? (round => ({ weightedTenths: rtTenths(decision.scores), score: rtTenths(decision.scores) / 10, scores: decision.scores,
        byUid: uid, at: now, month: rtMonth(now), firstPass: round === 1, revisions: round - 1 })) : () => ({});
      if (p && p.status === "submitted") {
        const patch = Object.assign({ status: kind, decision, updatedAt: now, version: (p.version || 0) + 1 }, rvRatingNulls(), rating(p.round || 1),
          kind === "approved" ? { onTime: p.submission && typeof p.submission.onTime === "boolean" ? p.submission.onTime : null } : {});
        tx.update(ref, patch); out = Object.assign({ id: ref.id }, p, patch); return;
      }
      // the step's own finish stands as the submission
      const submission = { link: null, note: (last.output && last.output.comment) || "", at: last.completedAt || now, byUid: last.by,
        iteration, dueAt: last.dueAt || null, onTime: rvOnTime(last.completedAt || now, last.dueAt || null) };
      const round = p ? (p.round || 1) + 1 : 1;
      const base = Object.assign({ status: kind, round, submission, decision, updatedAt: now, version: p ? (p.version || 0) + 1 : 1 },
        rvRatingNulls(), rating(round), kind === "approved" ? { onTime: submission.onTime } : {});
      if (p) {
        tx.update(ref, Object.assign(base, { history: (p.history || []).concat([{ round: p.round || 1, submission: p.submission || null, decision: p.decision || null }]) }));
        out = Object.assign({ id: ref.id }, p, base);
      } else {
        out = Object.assign({
          orgId: s.orgId, itemId: item.id, runId: h.run.id, nodeId: last.nodeId, typeId: type.id,
          title: item.title || "", store: (item.fields || {}).store || "", stepLabel: last.label || last.nodeId, brief: item.brief || (item.fields || {}).note || "",
          aboutUid: last.by, aboutRoleId: ((s.members || []).find(m => m.uid === last.by) || {}).roleId || null, reviewerUid: null,
          history: [], createdAt: now
        }, base);
        tx.set(ref, out);
      }
    });
    if (out) rvNotify([out.aboutUid], { kind: "review-decided",
      msg: (kind === "approved" ? "Approved · " + rtFmt(out.score) + " / 5 — " : "Changes requested on ") + (out.title || "your work") + ".",
      text: feedback, store: out.store || "", task: out.title || "" });
    return out;
  } catch (e) { console.error("Could not record the step's review:", e); return null; }
}

/* The bell. Fire-and-forget: a submission that landed is a submission,
   whether or not the reviewer's bell rang. */
async function rvNotify(uids, n){
  const from = rvUid();
  const to = (uids || []).filter(u => u && u !== from);
  if (!to.length) return;
  try {
    const batch = db.batch();
    to.forEach(uid => batch.set(db.collection("notifications").doc(),
      Object.assign({ toUid: uid, fromUid: from, read: false, createdAt: Date.now() }, n)));
    await batch.commit();
  } catch (e) { console.warn("Could not ring the bell for a review:", e); }
}

/* The org's reviews, every status, for the admin home. */
async function rvLoadAll(orgId, limit){
  const snap = await rvCol(orgId).orderBy("updatedAt", "desc").limit(limit || 500).get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

/* ---------- the live watch ---------- */

/* Started once the org is known. My own documents, and - if I review -
   what waits on me. Each snapshot redraws whatever is showing: the
   deck's cards read the state, the page lists it. A failed read is
   recorded as such, never as "nothing". */
function rvWatch(){
  rvStop();
  const uid = rvUid();
  if (!uid) return;
  orgEnsure().then(s => {
    if (!s || rvUid() !== uid) { rvMine = []; rvQueue = []; rvPaint(); return; }
    const col = rvCol(s.orgId);
    rvUnsubs.push(col.where("aboutUid", "==", uid).onSnapshot(snap => {
      rvMine = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      rvPaint();
    }, e => { console.error(e); rvMine = false; rvPaint(); }));
    const q = rvIsReviewer() ? col.where("status", "==", "submitted") : col.where("reviewerUid", "==", uid);
    rvUnsubs.push(q.onSnapshot(snap => {
      rvQueue = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(r => r.status === "submitted" && r.aboutUid !== uid);
      rvPaint();
    }, e => { console.error(e); rvQueue = false; rvPaint(); }));
    const item = $("drawerReviews");
    if (item) { item.classList.remove("hidden"); if (typeof rlSync === "function") rlSync(); }
  }).catch(e => { console.error(e); rvMine = false; rvQueue = false; rvPaint(); });
  if (typeof onSessionEnd === "function") onSessionEnd(rvStop);
}
function rvStop(){
  rvUnsubs.forEach(u => { try { u(); } catch (e) {} });
  rvUnsubs = []; rvMine = null; rvQueue = null;
  rvPeersStop();
  const item = $("drawerReviews");
  if (item) item.classList.add("hidden");
}
/* ---------- the people on my step ----------
   A step that runs together, or one held by several people, is one step
   on several decks - and each person could only see their own review.
   Every co-holder's document is watched by its exact id (rvKey of the
   same work, the same step, their uid), so the card can say where each
   of them stands. Missing means not sent yet; `false` means the read
   failed, which is said as such and never as "not sent". */
let rvPeers = {};          // key -> document | null (none yet) | false (could not reach)
let rvPeerUnsubs = {};     // key -> unsubscribe
/* The keys the deck's rows need: for each row on a track, my step's other holders. */
function rvPeerKeys(rows, uid){
  const out = [];
  (rows || []).forEach(row => {
    if (!row || row.orphanType) return;
    const itemId = row.itemId || row.id;
    const h = row.handoff && !row.handoff.done ? row.handoff : null;
    const st = h ? (typeof hoMyStop === "function" ? hoMyStop(h, uid) : h.stop) : null;
    if (!st || !itemId) return;
    (st.holders || []).forEach(p => { if (p && p.uid && p.uid !== uid) out.push(rvKey(itemId, st.nodeId || null, p.uid)); });
  });
  return [...new Set(out)];
}
function rvPeersWatch(rows){
  const uid = rvUid();
  const s = typeof orgS !== "undefined" ? orgS : null;
  if (!uid || !s || !s.orgId) { rvPeersStop(); return; }
  const want = rvPeerKeys(rows, uid);
  const wantSet = new Set(want);
  Object.keys(rvPeerUnsubs).forEach(k => {
    if (wantSet.has(k)) return;
    try { rvPeerUnsubs[k](); } catch (e) {}
    delete rvPeerUnsubs[k]; delete rvPeers[k];
  });
  want.forEach(k => {
    if (rvPeerUnsubs[k]) return;
    // nothing in the slot until the database answers: the card says
    // "loading", never "not sent" about a question it has not asked
    try {
      rvPeerUnsubs[k] = rvCol(s.orgId).doc(k).onSnapshot(d => {
        const next = d.exists ? Object.assign({ id: d.id }, d.data()) : null;
        // the first answer is the one the card was drawn without; a later
        // one is a teammate moving, and the card says so
        const changed = !(k in rvPeers) || JSON.stringify(rvPeers[k]) !== JSON.stringify(next);
        rvPeers[k] = next;
        if (changed) rvPaint();
      }, e => { console.error(e); rvPeers[k] = false; rvPaint(); });
    } catch (e) { console.error(e); rvPeerUnsubs[k] = () => {}; rvPeers[k] = false; }
  });
}
function rvPeersStop(){
  Object.keys(rvPeerUnsubs).forEach(k => { try { rvPeerUnsubs[k](); } catch (e) {} });
  rvPeerUnsubs = {}; rvPeers = {};
}
/* The lines the card draws under its step: one per other person on it,
   with where their submission stands. Nothing when I am alone on it. */
function rvPeerLines(row){
  const uid = rvUid();
  const st = rvStopOf(row);
  if (!st || !uid) return "";
  const itemId = row.itemId || row.id;
  const others = (st.holders || []).filter(p => p && p.uid && p.uid !== uid);
  if (!others.length) return "";
  const line = p => {
    const key = rvKey(itemId, st.nodeId || null, p.uid);
    const r = rvPeers[key];
    const name = p.name || rvNameOf(p.uid);
    let word, cls;
    if (!(key in rvPeers)) { word = "loading\u2026"; cls = "is-dim"; }
    else if (r === false) { word = "could not reach their review"; cls = "is-err"; }
    else if (!r) { word = "not sent for review yet"; cls = "is-none"; }
    else {
      const state = rvState(r, st.iteration != null ? st.iteration : null);
      cls = "is-" + state;
      word = state === "submitted" ? "in review" + (r.round > 1 ? " · round " + r.round : "") + (r.submission && r.submission.at ? " · sent " + rvWhen(r.submission.at) : "")
        : state === "changes" ? "changes requested"
        : state === "approved" ? "approved"
        : state === "stale" ? "approved on an earlier pass"
        : "not sent for review yet";
    }
    return '<li class="dk-with-p ' + cls + '"><b>' + esc(name) + '</b> · ' + esc(word) + '</li>';
  };
  return '<p class="dk-hand-with"><b>With you on this step</b></p><ul class="dk-with">' + others.map(line).join("") + '</ul>';
}

function rvPaint(){
  if (typeof dkRefresh === "function") dkRefresh();
  if (rvPageOpen) rvRenderPage();
  rvBadge();
}
/* The drawer item says how much is waiting: changes to answer, and if I
   review, submissions to look at. */
function rvBadge(){
  const el = $("drawerReviews");
  if (!el) return;
  const n = (Array.isArray(rvQueue) ? rvQueue.length : 0) + (Array.isArray(rvMine) ? rvMine.filter(r => r.status === "changes").length : 0);
  let b = el.querySelector(".drawer-badge");
  if (!b) { b = document.createElement("span"); b.className = "drawer-badge"; el.appendChild(b); }
  b.textContent = n ? String(n) : "";
  b.hidden = !n;
}

/* ---------- the pieces other screens draw ---------- */

/* The block on a deck card: where this piece of work stands with its
   reviewer, and the one thing to do about it. Nothing when the row
   cannot be reviewed here. */
function rvCardBlock(row){
  if (!rvRowOffers(row)) return "";
  if (rvMine === null) return '<div class="dk-blk dk-rv"><p class="dk-blk-h">Review</p><p class="dk-rv-t is-dim">Loading your reviews…</p></div>';
  if (rvMine === false) return '<div class="dk-blk dk-rv"><p class="dk-blk-h">Review</p><p class="dk-rv-t is-err">Could not reach your reviews.</p></div>';
  const r = rvForRow(row), st = rvRowState(row);
  const by = r && r.decision ? rvNameOf(r.decision.byUid) : "";
  let body = "", act = "";
  if (st === "submitted") {
    body = '<p class="dk-rv-t"><span class="dk-rv-pill is-wait">In review</span> with ' + esc(r.reviewerUid ? rvNameOf(r.reviewerUid) : "the owner") + (r.round > 1 ? ' · round ' + r.round : '') + ' · sent ' + esc(rvWhen(r.submission && r.submission.at)) + '</p>';
    act = '<button type="button" class="dk-rv-bt dk-rv-open" data-rv="' + esc(r.id) + '">View</button>';
  } else if (st === "changes") {
    body = '<p class="dk-rv-t"><span class="dk-rv-pill is-back">Changes requested</span> by ' + esc(by) + '</p>'
      + '<p class="dk-rv-q">“' + esc(rvShort(r.decision.feedback, 140)) + '”</p>';
    act = '<button type="button" class="dk-rv-bt dk-rv-open" data-rv="' + esc(r.id) + '">Read</button>'
      + '<button type="button" class="dk-rv-bt is-go dk-rv-submit" data-rv="' + esc(r.id) + '">Submit revision</button>';
  } else if (st === "approved") {
    body = '<p class="dk-rv-t"><span class="dk-rv-pill is-ok">Approved · ' + rtFmt(r.score) + ' / 5</span> by ' + esc(by) + '</p>'
      + '<p class="dk-rv-q">“' + esc(rvShort(r.decision.feedback, 140)) + '”</p>'
      + '<p class="dk-rv-next">Next: press <b>' + esc(rvDoneLabel(row)) + '</b> below to complete it.</p>';
    act = '<button type="button" class="dk-rv-bt dk-rv-open" data-rv="' + esc(r.id) + '">Details</button>';
  } else {
    body = '<p class="dk-rv-t is-dim">' + (st === "stale" ? 'Approved on an earlier pass - this round needs its own review.' : 'Not sent for review yet. Submit a link or a note when it is ready.') + '</p>';
    act = '<button type="button" class="dk-rv-bt is-go dk-rv-submit">Submit for review</button>';
  }
  return '<div class="dk-blk dk-rv"><p class="dk-blk-h">Review</p>' + body + '<div class="dk-rv-acts">' + act + '</div></div>';
}
/* What the right-hand button on a card will say - the label the block
   above names, so the two agree. */
function rvDoneLabel(row){
  const h = row && row.handoff && !row.handoff.done ? row.handoff : null;
  const st = rvStopOf(row);
  return h ? (st && st.choices && st.choices.length ? "Decide" : h.next ? "Pass on" : "Finish") : "Done";
}
const rvShort = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/* A card's Review buttons, routed from the deck's click handler. */
function rvCardClick(el, row){
  if (!el || !row) return false;
  if (el.classList.contains("dk-rv-submit")) { const st = rvStopOf(row); rvSubmitSheet(row.itemId || row.id, st ? st.nodeId : null); return true; }
  if (el.classList.contains("dk-rv-open")) { const r = rvForRow(row); if (r) rvResultSheet(r); return true; }
  return false;
}

/* The line on the finish sheet: what the reviewer said, if anything. */
function rvFinishLine(row){
  if (!rvRowOffers(row) || !Array.isArray(rvMine)) return "";
  const r = rvForRow(row), st = rvRowState(row);
  if (st === "approved") return '<p class="rv-fin is-ok">Approved by ' + esc(rvNameOf(r.decision.byUid)) + ' · ' + rtFmt(r.score) + ' / 5. Completing it now is the next step.</p>';
  if (st === "submitted") return '<p class="rv-fin is-wait">Still in review with ' + esc(r.reviewerUid ? rvNameOf(r.reviewerUid) : "the owner") + '. You can complete it anyway; the review stays open.</p>';
  if (st === "changes") return '<p class="rv-fin is-back">' + esc(rvNameOf(r.decision.byUid)) + ' asked for changes. Completing it without a revision leaves that unanswered.</p>';
  return "";
}

/* ---------- the sheets ---------- */

/* Submit, or resubmit. Reads the work first so the sheet shows the
   brief and the deadline it will be judged against. */
async function rvSubmitSheet(itemId, nodeId){
  openSheet('<h2>Submit for review</h2><p class="hint">Loading the work…</p>');
  const r = await rvCtxLoad(itemId, nodeId);
  if (!$("sheet").classList.contains("on")) return;
  if (!r.ok) {
    openSheet('<h2>Submit for review</h2><p class="hint">' + esc(
      r.error === "not-your-step" ? "This step is not with you right now, so there is nothing of yours to submit."
      : r.error === "not-yours" ? "This work is not assigned to you."
      : r.error === "gone" ? "That work is no longer there."
      : r.error === "no-org" ? "Reviews live inside an organization, and you are not seated in one."
      : "Could not load the work — check your connection.") + '</p><button class="btn btn-ghost btn-sm" id="rvClose">Close</button>', () => { $("rvClose").onclick = closeSheet; });
    return;
  }
  const ctx = r.ctx;
  const uid = rvUid();
  const prev = Array.isArray(rvMine) ? rvMine.find(x => x.id === rvKey(ctx.itemId, ctx.nodeId, uid)) : null;
  const prevState = rvState(prev, ctx.iteration);
  const to = rvReviewersFor(prev).filter(u => u !== uid).map(rvNameOf);
  const due = ctx.dueAt ? new Date(ctx.dueAt) : null;
  openSheet(
    '<h2>' + (prevState === "changes" ? "Submit a revision" : "Submit for review") + '</h2>' +
    '<p class="hint"><b>' + esc(ctx.title) + '</b>' + (ctx.store ? ' · ' + esc(ctx.store) : '') + (ctx.stepLabel ? ' · ' + esc(ctx.stepLabel) : '') +
      (prev && prevState !== "none" ? ' · round ' + ((prev.round || 1) + (prevState === "submitted" ? 0 : 1)) : '') + '</p>' +
    (ctx.brief ? '<div class="rv-brief"><p class="rv-k">The brief</p><p>' + esc(ctx.brief) + '</p></div>' : '') +
    (prevState === "changes" && prev.decision ? '<div class="rv-back"><p class="rv-k">' + esc(rvNameOf(prev.decision.byUid)) + ' asked for changes</p><p>' + esc(prev.decision.feedback) + '</p></div>' : '') +
    (prevState === "stale" ? '<p class="rv-note">The earlier approval was for a previous pass of this step; this round is reviewed on its own.</p>' : '') +
    '<label class="fld"><span>Link to the work</span><input type="url" id="rvLink" placeholder="https://…" maxlength="' + RT_LINK_MAX + '" inputmode="url"></label>' +
    '<label class="fld"><span>Handoff note</span><textarea id="rvNote" rows="4" maxlength="' + RT_NOTE_MAX + '" placeholder="What you delivered, where the files are, anything the reviewer should know…"></textarea></label>' +
    '<p class="rv-note" id="rvHint">A link or a note - at least one.' + (due ? ' Due ' + esc(due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) + (ctx.dueAt % 86400000 ? ' ' + esc(clock(ctx.dueAt)) : '') + ' on your clock; submitting after that counts as late.' : ' No deadline on this work, so it is neither on time nor late.') + '</p>' +
    '<p class="rv-note">Goes to ' + esc(to.length ? to.join(", ") : "the owner") + '.</p>' +
    '<button class="btn btn-go" id="rvSend" disabled>Submit for review</button>' +
    '<button class="btn btn-ghost btn-sm" id="rvCancel">Cancel</button>',
    () => {
      $("rvCancel").onclick = closeSheet;
      const link = $("rvLink"), note = $("rvNote"), send = $("rvSend"), hint = $("rvHint");
      const check = () => {
        const ok = rvSubmissionOk(link.value, note.value);
        send.disabled = !ok.ok;
        hint.classList.toggle("is-err", ok.reason === "bad-link");
        if (ok.reason === "bad-link") hint.textContent = "The link has to start with http:// or https://.";
      };
      link.oninput = check; note.oninput = check;
      send.onclick = async () => {
        send.disabled = true; send.textContent = "Submitting…";
        const res = await rvSubmit(ctx, link.value, note.value);
        if (!res.ok) {
          send.disabled = false; send.textContent = "Submit for review";
          toast(res.error === "already-submitted" ? "It is already in review."
            : res.error === "already-approved" ? "This was already approved - complete it from the card."
            : res.error === "bad-link" ? "That link is not a web address."
            : res.error === "empty" ? "Add a link or a note first."
            : "Could not submit — check your connection.");
          return;
        }
        closeSheet();
        toast(res.review.round > 1 ? "Revision submitted — your reviewer has been told." : "Submitted for review.");
      };
      note.focus();
    });
}

/* The reviewer's sheet: the brief, the submission, the person and the
   task together; earlier rounds beneath; a reviewer to name if allowed;
   then the decision. Read-only for anyone who may not decide. */
function rvReviewSheet(review){
  const me = rvMe();
  const r = review;
  const may = rvMayDecide(r, me.uid, me.roleId, me.perms) && r.status === "submitted";
  const mayName = rvMayDelegate(r, me.uid, me.roleId, me.perms) && r.status !== "approved";
  const members = ((me.s && me.s.members) || []).filter(m => m.uid !== r.aboutUid);
  const sub = r.submission || {};
  const roleName = id => { const x = ((me.s && me.s.roles) || []).find(y => y.id === id); return x ? x.name : ""; };
  const history = (r.history || []).slice().reverse().map(h => rvRoundHTML(h, roleName)).join("");
  openSheet(
    '<h2>' + esc(r.status === "submitted" ? "Review" : rvStatusWord[r.status] || "Review") + '</h2>' +
    '<div class="rv-head"><b>' + esc(r.title || "Work") + '</b><span>' + esc([r.store, r.stepLabel].filter(Boolean).join(" · ")) + '</span>' +
      '<span>By <b>' + esc(rvNameOf(r.aboutUid)) + '</b>' + (roleName(r.aboutRoleId) ? ' · ' + esc(roleName(r.aboutRoleId)) : '') + ' · round ' + (r.round || 1) + ' · submitted ' + esc(rvWhen(sub.at)) +
      (sub.onTime === true ? ' · <i class="is-good">on time</i>' : sub.onTime === false ? ' · <i class="is-late">late</i>' : ' · no deadline') + '</span></div>' +
    (r.brief ? '<div class="rv-brief"><p class="rv-k">The brief</p><p>' + esc(r.brief) + '</p></div>' : '<p class="rv-note">No brief was written for this work.</p>') +
    '<div class="rv-sub"><p class="rv-k">Submitted work</p>' + rvSubmissionHTML(sub) + '</div>' +
    (history ? '<details class="rv-hist"><summary>Earlier rounds (' + r.history.length + ')</summary>' + history + '</details>' : '') +
    (r.status !== "submitted" && r.decision ? '<div class="rv-dec is-' + esc(r.status) + '"><p class="rv-k">' + esc(rvStatusWord[r.status]) + ' by ' + esc(rvNameOf(r.decision.byUid)) + ' · ' + esc(rvWhen(r.decision.at)) + '</p>' + rvScoresHTML(r.decision.scores) + '<p class="rv-fb">' + esc(r.decision.feedback) + '</p></div>' : '') +
    (mayName ? '<label class="fld rv-who"><span>Reviewer</span><select id="rvWho"><option value="">The owner (default)</option>' +
        members.map(m => '<option value="' + esc(m.uid) + '"' + (r.reviewerUid === m.uid ? ' selected' : '') + '>' + esc(rvNameOf(m.uid)) + (roleName(m.roleId) ? ' · ' + esc(roleName(m.roleId)) : '') + '</option>').join("") + '</select></label>'
      : r.reviewerUid ? '<p class="rv-note">Reviewer: ' + esc(rvNameOf(r.reviewerUid)) + '</p>' : '') +
    (may
      ? '<div class="rv-kind" role="radiogroup" aria-label="Decision">' +
          '<button type="button" class="rv-kind-bt" role="radio" aria-checked="false" data-kind="changes">Request changes</button>' +
          '<button type="button" class="rv-kind-bt" role="radio" aria-checked="false" data-kind="approved">Approve &amp; rate</button></div>' +
        '<div id="rvForm" hidden>' + rtFormHTML(rvNameOf(r.aboutUid)) + '</div>' +
        '<label class="fld"><span id="rvFbLabel">Feedback (required)</span><textarea id="rvFeedback" rows="4" maxlength="' + RT_FEEDBACK_MAX + '" placeholder="Say what decided it - and if it is a 5, why it earned one."></textarea></label>' +
        '<button class="btn btn-go" id="rvDecideBt" disabled>Pick a decision</button>'
      : r.status === "submitted" ? '<p class="rv-note">' + (r.aboutUid === me.uid ? "This is your own work; somebody else decides." : "You are not this work's reviewer.") + '</p>' : '') +
    '<button class="btn btn-ghost btn-sm" id="rvClose">Close</button>',
    () => {
      $("rvClose").onclick = closeSheet;
      if (mayName) $("rvWho").onchange = async e => {
        const sel = e.target; sel.disabled = true;
        const res = await rvDelegate(r.id, sel.value || null);
        sel.disabled = false;
        if (!res.ok) { toast(res.error === "decided" ? "Already decided." : res.error === "not-allowed" ? "Your role cannot name a reviewer." : "Could not set the reviewer."); return; }
        r.version = res.review.version; r.reviewerUid = res.review.reviewerUid;
        toast(sel.value ? "Reviewer set." : "Back to the owner.");
      };
      if (!may) return;
      let kind = null, scores = null;
      const bt = $("rvDecideBt"), fb = $("rvFeedback"), form = $("rvForm");
      const ready = () => {
        const ok = kind ? rvDecisionOk(kind, scores, fb.value) : { ok: false, reason: "kind" };
        bt.disabled = !ok.ok;
        bt.textContent = !kind ? "Pick a decision"
          : ok.reason === "feedback" ? "Write the feedback first"
          : ok.reason === "scores" ? "Score all three first"
          : kind === "approved" ? "Approve · " + rtFmt(rtScore(scores)) + " / 5" : "Send changes back";
      };
      document.querySelectorAll(".rv-kind-bt").forEach(b => b.onclick = () => {
        kind = b.dataset.kind;
        document.querySelectorAll(".rv-kind-bt").forEach(x => { const on = x === b; x.classList.toggle("is-on", on); x.setAttribute("aria-checked", String(on)); });
        form.hidden = kind !== "approved";
        $("rvFbLabel").textContent = kind === "approved" ? "Feedback (required) — what made it this good?" : "What needs to change (required)";
        ready();
      });
      rtFormBind(form.querySelector(".rt-form"), sc => { scores = sc; ready(); });
      fb.oninput = ready;
      bt.onclick = async () => {
        bt.disabled = true; bt.textContent = "Saving…";
        const res = await rvDecide(r.id, kind, scores, fb.value, r.version);
        if (!res.ok) {
          ready();
          toast(res.error === "changed" ? "This review changed while you had it open — reopen it to see the latest."
            : res.error === "not-allowed" ? "Your role cannot decide this one."
            : res.error === "gone" ? "That review is no longer there."
            : "Could not save the decision — check your connection.");
          return;
        }
        closeSheet();
        toast(kind === "approved" ? "Approved · " + rtFmt(res.review.score) + " / 5. " + rvNameOf(r.aboutUid) + " has been told." : "Sent back with your feedback.");
        if (typeof amRefresh === "function" && typeof amOn === "function" && amOn()) amRefresh();
      };
    });
}

/* The person's own sheet: the decision and why, the scores with what
   each one means, earlier rounds, and the way forward. */
function rvResultSheet(review){
  const r = review;
  const me = rvMe();
  const st = r.status;
  const sub = r.submission || {};
  const roleName = id => { const x = ((me.s && me.s.roles) || []).find(y => y.id === id); return x ? x.name : ""; };
  const history = (r.history || []).slice().reverse().map(h => rvRoundHTML(h, roleName)).join("");
  const canResubmit = r.aboutUid === me.uid && st === "changes";
  openSheet(
    '<h2>' + esc(rvStatusWord[st] || "Review") + '</h2>' +
    '<div class="rv-head"><b>' + esc(r.title || "Work") + '</b><span>' + esc([r.store, r.stepLabel].filter(Boolean).join(" · ")) + ' · round ' + (r.round || 1) + '</span>' +
      '<span>Submitted ' + esc(rvWhen(sub.at)) + (sub.onTime === true ? ' · <i class="is-good">on time</i>' : sub.onTime === false ? ' · <i class="is-late">late</i>' : '') + '</span></div>' +
    (st === "submitted"
      ? '<p class="rv-note">Waiting on ' + esc(r.reviewerUid ? rvNameOf(r.reviewerUid) : "the owner") + '. You will be told when it is decided.</p>'
      : r.decision ? '<div class="rv-dec is-' + esc(st) + '"><p class="rv-k">' + (st === "approved" ? 'Approved · <b>' + rtFmt(r.score) + ' / 5</b>' : 'Changes requested') + ' · by ' + esc(rvNameOf(r.decision.byUid)) + ' · ' + esc(rvWhen(r.decision.at)) + '</p>' +
          rvScoresHTML(r.decision.scores) + '<p class="rv-fb">' + esc(r.decision.feedback) + '</p></div>' : '') +
    '<div class="rv-sub"><p class="rv-k">What you submitted</p>' + rvSubmissionHTML(sub) + '</div>' +
    (history ? '<details class="rv-hist"><summary>Earlier rounds (' + r.history.length + ')</summary>' + history + '</details>' : '') +
    (st === "approved" ? '<p class="rv-next">Next: on your card, press <b>Pass on</b>, <b>Finish</b> or <b>Done</b> to complete the work. The approval stays with this record.</p>' : '') +
    (canResubmit ? '<button class="btn btn-go" id="rvAgain">Submit a revision</button>' : '') +
    '<button class="btn btn-ghost btn-sm" id="rvClose">Close</button>',
    () => {
      $("rvClose").onclick = closeSheet;
      if (canResubmit) $("rvAgain").onclick = () => rvSubmitSheet(r.itemId, r.nodeId || null);
    });
}

function rvSubmissionHTML(sub){
  const link = sub && sub.link && rvLinkOk(sub.link) ? sub.link : null;
  return (link ? '<p class="rv-link"><a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(rvShort(link, 80)) + '</a></p>' : '') +
    (sub && sub.note ? '<p class="rv-fb">' + esc(sub.note) + '</p>' : '') +
    (!link && !(sub && sub.note) ? '<p class="rv-note">Nothing attached.</p>' : '');
}
function rvScoresHTML(scores){
  if (!rtValidScores(scores)) return "";
  return '<ul class="rv-scores">' + RT_KEYS.map(k => '<li><b>' + scores[k] + '</b><span>' + esc(RT_LABELS[k]) + ' · ' + esc(RT_SCALE[scores[k] - 1]) + '</span><small>' + esc(RT_EXAMPLES[k][scores[k] - 1]) + '</small></li>').join("") + '</ul>';
}
function rvRoundHTML(h, roleName){
  const s = h.submission || {}, d = h.decision;
  return '<div class="rv-round"><p class="rv-k">Round ' + (h.round || "?") + ' · submitted ' + esc(rvWhen(s.at)) + '</p>' + rvSubmissionHTML(s) +
    (d ? '<div class="rv-dec is-' + esc(d.kind) + '"><p class="rv-k">' + esc(rvStatusWord[d.kind] || d.kind) + (d.scores ? ' · ' + rtFmt(rtScore(d.scores)) + ' / 5' : '') + ' · ' + esc(rvNameOf(d.byUid)) + ' · ' + esc(rvWhen(d.at)) + '</p><p class="rv-fb">' + esc(d.feedback) + '</p></div>' : '') + '</div>';
}

/* ---------- the page: Reviews & Feedback ---------- */

function enterReviewsPage(){
  rvPageOpen = true;
  rvRenderPage();
}
function leaveReviewsPage(){ rvPageOpen = false; }

function rvRenderPage(){
  const host = $("reviewsBody");
  if (!host) return;
  const me = rvMe();
  if (!me.s) {
    host.innerHTML = '<p class="rv-empty">' + (typeof orgWhyNone !== "undefined" && orgWhyNone === "error"
      ? "Could not reach your organization — check your connection."
      : "Reviews live inside an organization, and this account is not seated in one.") + '</p>';
    return;
  }
  const mine = rvMine, queue = rvQueue;
  const row = (r, act) => {
    const st = r.status;
    return '<li class="rv-row" data-rv="' + esc(r.id) + '" data-act="' + act + '">' +
      '<i class="am-dot ' + (st === "submitted" ? "is-blue" : st === "changes" ? "is-orange" : "is-green") + '"></i>' +
      '<div class="rv-row-t"><b>' + esc(r.title || "Work") + '</b><span>' + esc([r.store, r.stepLabel].filter(Boolean).join(" · ")) +
        (act === "review" ? ' · by ' + esc(rvNameOf(r.aboutUid)) : '') + ' · round ' + (r.round || 1) + ' · ' + esc(rvWhen((r.decision && r.decision.at) || (r.submission && r.submission.at))) + '</span></div>' +
      '<span class="rv-pill is-' + esc(st) + '">' + esc(st === "approved" ? "Approved · " + rtFmt(r.score) : rvStatusWord[st]) + '</span>' +
      '<button type="button" class="am-go">' + (act === "review" ? "Review" : st === "changes" ? "Revise" : "Open") + '</button></li>';
  };
  const list = (rows, empty) => rows.length ? '<ul class="am-list rv-list">' + rows.join("") + '</ul>' : '<p class="am-empty">' + empty + '</p>';
  const reviewer = rvIsReviewer() || (Array.isArray(queue) && queue.length > 0);
  let queueHtml = "";
  if (reviewer) {
    queueHtml = '<section class="am-panel rv-panel"><div class="am-panel-h"><h2>Needs your review</h2>' + (Array.isArray(queue) && queue.length ? '<em>' + queue.length + '</em>' : '') + '</div>' +
      (queue === null ? '<p class="am-loading">Loading…</p>' : queue === false ? '<p class="am-err">Could not reach the review queue — check your connection.</p>'
        : list(queue.slice().sort((a, b) => ((a.submission && a.submission.at) || 0) - ((b.submission && b.submission.at) || 0)).map(r => row(r, "review")), "Nothing is waiting for you.")) + '</section>';
  }
  let mineHtml;
  if (mine === null) mineHtml = '<p class="am-loading">Loading your reviews…</p>';
  else if (mine === false) mineHtml = '<p class="am-err">Could not reach your reviews — check your connection.</p>';
  else {
    const sorted = mine.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const pending = sorted.filter(r => r.status === "submitted"), back = sorted.filter(r => r.status === "changes"), ok = sorted.filter(r => r.status === "approved");
    const rated = ok.map(rvRating).filter(Boolean);
    const avg = rtMeanTenths(rated.map(x => x.tenths));
    mineHtml =
      '<div class="am-tiles rv-tiles">' +
        '<div class="am-tile"><b>' + pending.length + '</b><span>In review</span></div>' +
        '<div class="am-tile' + (back.length ? ' is-orange' : '') + '"><b>' + back.length + '</b><span>Changes to make</span></div>' +
        '<div class="am-tile is-blue"><b>' + (avg == null ? "—" : rtFmt(avg)) + '</b><span>Your rating · ' + rated.length + ' approved</span></div>' +
      '</div>' +
      (back.length ? '<section class="am-panel rv-panel"><div class="am-panel-h"><h2>Changes requested</h2><em>' + back.length + '</em></div>' + list(back.map(r => row(r, "mine")), "") + '</section>' : '') +
      '<section class="am-panel rv-panel"><div class="am-panel-h"><h2>Your submissions</h2><em>' + sorted.length + '</em></div>' +
        list(sorted.filter(r => r.status !== "changes").map(r => row(r, "mine")), "Nothing submitted yet. Press Submit for review on a card when work is ready.") +
        '<p class="am-foot">A rating is quality × 50% + brief accuracy × 30% + handoff readiness × 20%, out of 5, given with written feedback by the person who reviewed it. Revisions update a rating rather than adding one.</p></section>';
  }
  host.innerHTML = queueHtml + mineHtml;
  if (!host.dataset.rvBound) {
    host.dataset.rvBound = "1";
    host.addEventListener("click", e => {
      const li = e.target.closest(".rv-row");
      if (!li) return;
      const id = li.dataset.rv;
      if (li.dataset.act === "review") { const r = (Array.isArray(rvQueue) ? rvQueue : []).find(x => x.id === id); if (r) rvReviewSheet(r); return; }
      const r = (Array.isArray(rvMine) ? rvMine : []).find(x => x.id === id);
      if (!r) return;
      if (r.status === "changes" && e.target.closest(".am-go")) rvSubmitSheet(r.itemId, r.nodeId || null); else rvResultSheet(r);
    });
  }
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { rvForRow, rvRowState, rvCardBlock, rvFinishLine };
}
