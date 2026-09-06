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

/* ---------- building a track ---------- */

/* Everything wrong with a track, all at once - never the first error,
   for the same reason itemValidate() works that way: a form that
   reveals one problem per save is a form people abandon. */
function hoTrackErrors(track, roleIds, statusKeys){
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
  });
  return out;
}

/* A track becomes trigger -> role -> role -> ... -> done, which is the
   same shape migrateCampaignBlueprint() produces from a campaign chain.
   Same shape on purpose: two generators disagreeing about what a linear
   pipeline looks like would be two things to keep in step. */
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

  // every path must reach an end or the blueprint will not validate
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
    if (s.roleId === HO_ANY) { if (!roster.length) out.push({ at: i, label: s.label, roleId: s.roleId }); return; }
    if (!roster.some(m => m && m.roleId === s.roleId))
      out.push({ at: i, label: s.label, roleId: s.roleId });
  });
  return out;
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
    // an explicit person on the stop wins over its role: the full builder
    // can name one, and "Priya, specifically" must not be overruled by
    // everyone who happens to share her role
    const named = (nr.assignees && nr.assignees.length) ? nr.assignees
      : (nr.assigneeId ? [nr.assigneeId] : []);
    if (named.length) { named.forEach(u => out.push(u)); return; }
    if (!cfg.role) return;
    if (cfg.role === HO_ANY) { roster.forEach(m => out.push(m.uid)); return; }
    roster.forEach(m => { if (m.roleId === cfg.role) out.push(m.uid); });
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
        arrivedAt: nr.arrivedAt || null,
        completedAt: nr.completedAt || null,
        output: nr.output || {}
      };
    });
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { HO_MAX_STOPS, HO_ANY, hoTrackErrors, hoTrackGaps, hoBuildBlueprint,
    hoActiveStops, hoHolders, hoStatus, hoMayAdvance, hoStalled, hoTrail };
}
