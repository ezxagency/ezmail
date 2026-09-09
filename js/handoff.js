/* ============================================================
   HANDOFF — work that moves person to person.

   docs/handoff-spec.md is the design. This file is the pure half:
   it turns a linear TRACK into a real blueprint the existing engine
   runs, and it answers the four questions the screens ask about a
   running one — who holds it, what status that means, who may move
   it on, and where it has been.

   IT BUILDS A REAL BLUEPRINT, not a second workflow model. Every
   track is validated by wfValidate() and executed by wfStartRun()
   and wfAdvance(), the same functions the Workflows page uses. A
   second engine would be a second set of bugs and two different
   answers to "where is this work".

   WHY A LINEAR TRACK. The open canvas comes later, deliberately: a
   nicer way to draw a thing that already runs is worth building, a
   nicer way to draw one that does not is not. A straight line -
   these stages, in this order, each held by this role - is what a
   baton actually needs, and it is expressible in the engine's own
   node format with nothing added.

   HOLDERS ARE DERIVED, NEVER FROZEN. A stop names a ROLE; who holds
   it is whoever is in that role right now. Freezing the people at
   activation would mean somebody who joined this morning cannot act,
   and somebody who left last week still can.
   ============================================================ */

const HO_MAX_STOPS = 12;          // a straight line longer than this is a diagram
const HO_ANY = "__any__";         // a stop open to everyone in the org
const HO_DAY = 86400000;
// how often a late piece of work may be chased. Being nagged about the
// same thing every time somebody opens the app is how a chase becomes
// something people learn to ignore.
const HO_NUDGE_EVERY = HO_DAY;

/* ---------- building a track ---------- */

/* Everything wrong with a track, all at once - never the first error,
   for the same reason itemValidate() works that way: a form that
   reveals one problem per save is a form people abandon. */
function hoTrackErrors(track, roleIds, statusKeys, members){
  const out = [];
  const stops = track || [];
  const roles = new Set(roleIds || []);
  const statuses = new Set(statusKeys || []);
  if (!stops.length) return [{ at: -1, message: "A handoff needs at least one stop." }];
  if (stops.length > HO_MAX_STOPS)
    out.push({ at: -1, message: "That is more stops than a straight line should carry." });
  stops.forEach((s, i) => {
    if (!s || !(s.label || "").trim()) out.push({ at: i, message: "Every stop needs a name." });
    if (!s || !s.roleId) out.push({ at: i, message: "Who holds this stop?" });
    else if (s.roleId !== HO_ANY && !roles.has(s.roleId))
      out.push({ at: i, message: '"' + s.roleId + '" is not a role in this organization.' });
    // a stop may leave the status alone, but it may not name one that
    // does not exist - that is a stop which silently changes nothing
    if (s && s.status && !statuses.has(s.status))
      out.push({ at: i, message: '"' + s.status + '" is not a status this kind of work has.' });
    // a budget of zero or nonsense would make work late the instant it
    // arrived, which reads as a bug rather than as a deadline
    if (s && s.dueAfter !== undefined && s.dueAfter !== null && s.dueAfter !== "" &&
        (typeof s.dueAfter !== "number" || !(s.dueAfter > 0)))
      out.push({ at: i, message: "A time budget has to be a number of days above zero." });
    // narrowing to nobody who is actually in the role is a stop that can
    // never be held - the same silent stall as an empty role, arrived at
    // from the other direction
    if (s && (s.assignees || []).length && members) {
      const inRole = (members || []).filter(m =>
        s.roleId === HO_ANY || !s.roleId || m.roleId === s.roleId).map(m => m.uid);
      if (!s.assignees.some(u => inRole.indexOf(u) >= 0))
        out.push({ at: i, message: "Nobody you picked is in that role any more." });
    }
  });
  return out;
}

/* A track becomes trigger -> role -> role -> ... -> done: the one
   generator of a linear pipeline. (A second one, from campaign chains,
   wrote to a collection nothing listed and was cut with the page.) */
function hoBuildBlueprint(type, track, opts){
  const o = opts || {};
  const stops = (track || []).filter(Boolean);
  if (!stops.length) return null;

  const nodes = [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 },
                   config: { label: "New " + ((type && type.name) || "work") } }];
  const edges = [];
  let prev = "trigger";

  stops.forEach((s, i) => {
    const id = "s" + i;
    const config = { label: s.label || ("Stop " + (i + 1)) };
    // the role is the whole point: who holds it is derived from this at
    // read time, so the stop stays true as people join and leave
    config.role = s.roleId;
    // the engine reads cfg.assignees as "who may act"; the role stays
    // beside it so hoHolders can keep intersecting the two
    if ((s.assignees || []).length) config.assignees = s.assignees.slice();
    // an extra key the engine ignores and this file reads. wfValidate
    // checks the config it knows about and permits the rest, which is
    // what lets a stop say what it MEANS in the type's own vocabulary
    // without teaching the engine about statuses.
    if (s.status) config.status = s.status;
    if (s.dueAfter) config.dueAfter = s.dueAfter;
    nodes.push({ id, type: "role", position: { x: 0, y: (i + 1) * 160 }, config });
    edges.push({ id: "e" + i, from: prev, to: id });
    prev = id;
  });

  // every path must reach an end or the blueprint will not validate. The
  // node is an action only because that is the end-shape the validator
  // accepts: the org glue (js/items.js) applies the engine's run and stops
  // and discards its effects, so this notify never sends. The people on
  // the last stop are told by item.assigned when it reaches them.
  nodes.push({ id: "done", type: "action", position: { x: 0, y: (stops.length + 1) * 160 },
    config: { actionType: "notify", label: "Finished",
              params: { message: ((type && type.name) || "Work") + " finished its handoff." } } });
  edges.push({ id: "e_done", from: prev, to: "done" });

  return {
    id: o.id || null,
    orgId: o.orgId || null,
    ownerId: o.ownerId || null,
    name: ((type && type.name) || "Work") + " handoff",
    version: o.version || 1,
    status: "published",
    typeId: (type && type.id) || null,
    track: JSON.parse(JSON.stringify(stops)),   // kept so the editor can show it back
    nodes, edges,
    createdAt: o.now || 0, updatedAt: o.now || 0
  };
}

/* Stops nobody can act on, found from the TRACK rather than from any
   running work.

   hoStalled() below answers "this job is stuck" once a job already is.
   This answers "this track will stick" before anything has been created,
   costs no reads at all, and covers work that does not exist yet - because
   in a straight line there is exactly one way to stall, and it is a stop
   whose role has nobody in it.

   Finding the cause beats finding each casualty. */
function hoTrackGaps(track, members){
  const roster = members || [];
  const out = [];
  (track || []).forEach((s, i) => {
    if (!s || !s.roleId) return;
    const inRole = s.roleId === HO_ANY
      ? roster.map(m => m.uid)
      : roster.filter(m => m && m.roleId === s.roleId).map(m => m.uid);
    const held = (s.assignees || []).length
      ? inRole.filter(u => s.assignees.indexOf(u) >= 0)
      : inRole;
    if (!held.length) out.push({ at: i, label: s.label, roleId: s.roleId });
  });
  return out;
}

/* ---------- late ----------
   Two different things wear the name "time-based", and only one of them
   needs a server.

   Firing while nobody is there - "at 3am, chase anything untouched for
   three days" - needs something awake to check, and a browser is not.

   KNOWING SOMETHING IS LATE is arithmetic against a deadline the engine
   already records, done whenever anyone looks. That needs nothing. The
   engine has been computing nr.dueAt from a stop's budget since the
   handoff engine was written and showing it to nobody. */

function hoLate(dueAt, now){
  if (!dueAt) return { due: false, late: false, msLate: 0 };
  const by = (now || 0) - dueAt;
  return { due: true, late: by > 0, msLate: by > 0 ? by : 0, msLeft: by > 0 ? 0 : -by };
}

/* When the work travelling this run is next due. Several stops can be
   active at once, and the EARLIEST wins: work is late the moment its
   soonest obligation passes, not its most forgiving one. */
function hoDue(blueprint, nodeRuns, now){
  let dueAt = null;
  hoActiveStops(nodeRuns).forEach(nr => {
    if (nr.dueAt && (dueAt === null || nr.dueAt < dueAt)) dueAt = nr.dueAt;
  });
  return Object.assign({ dueAt }, hoLate(dueAt, now));
}

/* Should this late work be chased right now?

   Idempotence is the whole point. Anyone opening the app runs this, so
   without a stamp the same overdue job would be chased once per person
   per page load - which is not a chase, it is noise, and noise is how a
   chase becomes something people mute. */
function hoNeedsNudge(item, now, everyMs){
  if (!item || !item.dueAt) return false;
  if (!hoLate(item.dueAt, now).late) return false;
  const gap = everyMs || HO_NUDGE_EVERY;
  return !item.nudgedAt || (now - item.nudgedAt) >= gap;
}

/* ---------- reading a running one ---------- */

/* The stops a run is actually waiting at. Everything else in nodeRuns is
   history or machinery. */
function hoActiveStops(nodeRuns){
  return (nodeRuns || []).filter(nr => nr && nr.nodeType === "role" && nr.status === "in_progress");
}

const hoNodeById = (blueprint, id) =>
  ((blueprint && blueprint.nodes) || []).find(n => n.id === id) || null;

/* Who holds this work right now: the people in the roles its active
   stops name. Derived from CURRENT membership on every read, which is
   the difference between a stop that belongs to a role and one that
   belongs to whoever happened to be in it when the work arrived.

   members: [{ uid, roleId }] - the org roster, as orgLoad already has it. */
function hoHolders(blueprint, nodeRuns, members){
  const roster = members || [];
  const out = [];
  hoActiveStops(nodeRuns).forEach(nr => {
    const node = hoNodeById(blueprint, nr.nodeId);
    const cfg = (node && node.config) || {};
    /* A stop belongs to a ROLE, and may be narrowed to some of the people
       in it. "The managers" or "these two managers" - never a bare list of
       names divorced from a role.

       That is what keeps holders derived rather than frozen: narrowing
       says WHICH managers, so somebody who stops being a manager stops
       holding the stop, without anybody editing the track. A flat list of
       names would have kept them on it forever. */
    const inRole = cfg.role === HO_ANY
      ? roster.map(m => m.uid)
      : cfg.role
        ? roster.filter(m => m.roleId === cfg.role).map(m => m.uid)
        : roster.map(m => m.uid);
    const named = (nr.assignees && nr.assignees.length) ? nr.assignees
      : (nr.assigneeId ? [nr.assigneeId] : []);
    const holders = named.length ? inRole.filter(u => named.indexOf(u) >= 0) : inRole;
    holders.forEach(u => out.push(u));
  });
  return [...new Set(out)].filter(Boolean);
}

/* The status the active stop declares, or null to leave it alone.
   Several active stops is possible in the full engine; the first one
   that names a status wins, because a status is a single word and
   inventing a merge rule for it would be inventing a wrong answer. */
function hoStatus(blueprint, nodeRuns){
  const stops = hoActiveStops(nodeRuns);
  for (const nr of stops){
    const node = hoNodeById(blueprint, nr.nodeId);
    const st = node && node.config && node.config.status;
    if (st) return st;
  }
  return null;
}

/* May this person move this stop on?

   Whoever holds it, and an owner always - work gets stuck for reasons no
   model predicts and somebody has to be able to unstick it. The owner
   case is returned as its own answer rather than folded in, so the glue
   can record an override as an override instead of disguising it as the
   holder having acted. */
function hoMayAdvance(blueprint, nodeRun, uid, members, isOwner){
  if (!nodeRun || nodeRun.status !== "in_progress") return { ok: false, reason: "not-active" };
  if (!uid) return { ok: false, reason: "not-signed-in" };
  const holders = hoHolders(blueprint, [nodeRun], members);
  if (holders.indexOf(uid) >= 0) return { ok: true, as: "holder" };
  if (isOwner) return { ok: true, as: "override" };
  return { ok: false, reason: "not-yours" };
}

/* A stop nobody can act on. This is the silent failure the spec is most
   worried about: the run does not error, it simply stops, and looks
   exactly like work in progress until somebody asks why nothing has
   happened for a week. */
function hoStalled(blueprint, nodeRuns, members){
  const stops = hoActiveStops(nodeRuns);
  if (!stops.length) return null;
  if (hoHolders(blueprint, nodeRuns, members).length) return null;
  const node = hoNodeById(blueprint, stops[0].nodeId);
  const cfg = (node && node.config) || {};
  return { nodeId: stops[0].nodeId, label: cfg.label || stops[0].nodeId, role: cfg.role || null };
}

/* Where the work has been, oldest first. nodeRuns already records all of
   this and it has never been shown to anybody. */
function hoTrail(blueprint, nodeRuns){
  return (nodeRuns || [])
    .filter(nr => nr && nr.nodeType === "role")
    .slice()
    .sort((a, b) => (a.arrivedAt || 0) - (b.arrivedAt || 0) || (a.seq || 0) - (b.seq || 0))
    .map(nr => {
      const node = hoNodeById(blueprint, nr.nodeId);
      const cfg = (node && node.config) || {};
      return {
        nodeId: nr.nodeId, nodeRunId: nr.id,
        label: cfg.label || nr.nodeId,
        role: cfg.role || null,
        status: nr.status,
        by: nr.completedBy || null,
        // recorded separately from `by` on purpose: an owner unsticking
        // somebody else's stop is a different fact from that person
        // having done it, and a trail that blurred the two would be worth
        // less than no trail
        as: nr.completedAs || null,
        arrivedAt: nr.arrivedAt || null,
        completedAt: nr.completedAt || null,
        output: nr.output || {}
      };
    });
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { HO_MAX_STOPS, HO_ANY, HO_DAY, HO_NUDGE_EVERY,
    hoLate, hoDue, hoNeedsNudge, hoTrackErrors, hoTrackGaps, hoBuildBlueprint,
    hoActiveStops, hoHolders, hoStatus, hoMayAdvance, hoStalled, hoTrail };
}
