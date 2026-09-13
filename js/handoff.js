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

/* ---------- the shape of a stop ----------
   { id, label, roleId, assignees, status, dueAfter,
     choices:  ["Approve", "Send back"]         what the person picks when they finish (optional)
     routes:   [{ when, to }]                   where the work goes next, first match wins;
                                                 when = { kind:"choice", value } or
                                                        { kind:"field", key, op, value }
                                                 to   = another stop's id, or "done"
     together: true }                           runs AT THE SAME TIME as the stop before it

   Without routes the work goes to the next stop in the list - the list
   order is the "otherwise". Consecutive stops marked `together` form a
   group that starts at once and is waited for as one: the stop after
   the group begins only when every member has finished. */

/* Every stop gets an id that survives reordering, because a route names
   the stop it goes to and "step 3" stops being step 3 the moment
   somebody drags a card. Tracks saved before routes existed carry none;
   they are given one here, from their position, and keep it from then
   on because the editors save what this returns. */
function hoStopIds(track){
  return (track || []).filter(Boolean).map((s, i) => Object.assign({}, s, { id: s.id || ("st" + i) }));
}

/* Consecutive stops that run together, as [{ from, to }] index ranges.
   A stop on its own is a group of one. The first stop cannot join
   anything, so `together` on it is ignored here and refused below. */
function hoGroups(stops){
  const out = [];
  (stops || []).forEach((s, i) => {
    if (i > 0 && s && s.together) out[out.length - 1].to = i;
    else out.push({ from: i, to: i });
  });
  return out;
}

const HO_FIELD_OPS = ["==", "!=", "contains", ">", "<"];

/* Everything wrong with a track, all at once - never the first error,
   for the same reason itemValidate() works that way: a form that
   reveals one problem per save is a form people abandon.
   `fieldKeys` is the kind's fields, for rules that read one; pass
   nothing and field rules are not checked against a list. */
function hoTrackErrors(track, roleIds, statusKeys, members, fieldKeys){
  const out = [];
  const stops = hoStopIds(track);
  const roles = new Set(roleIds || []);
  const statuses = new Set(statusKeys || []);
  const ids = new Set(stops.map(s => s.id));
  const groups = hoGroups(stops);
  const groupStart = new Set(groups.map(g => g.from));
  const inGroup = i => { const g = groups.find(x => i >= x.from && i <= x.to); return g && g.from !== g.to; };
  if (!stops.length) return [{ at: -1, message: "Add at least one step." }];
  if (stops.length > HO_MAX_STOPS)
    out.push({ at: -1, message: "That is more than " + HO_MAX_STOPS + " steps. Keep it shorter." });
  stops.forEach((s, i) => {
    if (!s || !(s.label || "").trim()) out.push({ at: i, message: "Every step needs a name." });
    if (!s || !s.roleId) out.push({ at: i, message: "Who does this step?" });
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
      out.push({ at: i, message: "Days to finish has to be a number above zero." });
    // narrowing to nobody who is actually in the role is a stop that can
    // never be held - the same silent stall as an empty role, arrived at
    // from the other direction
    if (s && (s.assignees || []).length && members) {
      const inRole = (members || []).filter(m =>
        s.roleId === HO_ANY || !s.roleId || m.roleId === s.roleId).map(m => m.uid);
      if (!s.assignees.some(u => inRole.indexOf(u) >= 0))
        out.push({ at: i, message: "Nobody you ticked is in that role any more." });
    }
    if (!s) return;
    const choices = (s.choices || []).map(c => String(c || "").trim());
    if (choices.some(c => !c)) out.push({ at: i, message: "A choice needs a name." });
    if (new Set(choices).size !== choices.length) out.push({ at: i, message: "Two choices have the same name." });
    if (i === 0 && s.together) out.push({ at: i, message: "The first step has nothing to run alongside." });
    const routes = (s.routes || []).filter(Boolean);
    if (routes.length && s.together)
      out.push({ at: i, message: "A step that runs alongside others cannot branch. Put the branch on the step after them." });
    routes.forEach(r => {
      const w = r.when || {};
      if (w.kind === "choice") {
        if (!choices.length) out.push({ at: i, message: "This step has no choices, so a rule cannot read one." });
        else if (choices.indexOf(String(w.value || "").trim()) < 0)
          out.push({ at: i, message: '"' + (w.value || "") + '" is not one of this step\'s choices.' });
      } else if (w.kind === "field") {
        if (!w.key) out.push({ at: i, message: "Which field should the rule look at?" });
        else if (fieldKeys && fieldKeys.indexOf(w.key) < 0)
          out.push({ at: i, message: '"' + w.key + '" is not a field this kind of work has.' });
        if (HO_FIELD_OPS.indexOf(w.op || "==") < 0) out.push({ at: i, message: "That comparison is not one the rules know." });
        if (w.value === undefined || w.value === null || w.value === "")
          out.push({ at: i, message: "What should the field be compared with?" });
      } else out.push({ at: i, message: "A rule has to look at a choice or a field." });
      if (!r.to) out.push({ at: i, message: "Where should the work go? Pick a step or Done." });
      else if (r.to !== "done") {
        const j = stops.findIndex(x => x.id === r.to);
        if (j < 0) out.push({ at: i, message: "A rule points at a step that is no longer there." });
        else if (inGroup(j) && !groupStart.has(j))
          out.push({ at: i, message: "Work cannot jump into the middle of steps that run together." });
      }
    });
  });
  return out;
}

/* A track becomes a real blueprint: trigger -> role -> role -> ... ->
   done, and where a stop branches, the engine's own SPLIT blocks -
   `route` for if/otherwise, `parallel` for stops that run together -
   with the stop after a parallel group as the MERGE (a node with two or
   more incoming lines is the merge; it waits for all of them). The one
   generator of a pipeline. (A second one, from campaign chains, wrote
   to a collection nothing listed and was cut with the page.)

   A stop with choices DECLARES an output, `choice`, so the engine
   refuses to complete it without one and every rule that reads it is
   reading a value that was really recorded (the engine's declaration
   invariant). The choices ride on the role node as `choices` too, so
   the finish sheet can draw them from the run's frozen snapshot. */
function hoBuildBlueprint(type, track, opts){
  const o = opts || {};
  const stops = hoStopIds(track);
  if (!stops.length) return null;
  const groups = hoGroups(stops);

  const nodes = [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 },
                   config: { label: "New " + ((type && type.name) || "work") } }];
  const edges = [];
  let en = 0;
  const edge = (from, to, handle) => {
    const e = { id: "e" + (en++), from, to };
    if (handle) e.fromHandle = handle;
    edges.push(e);
  };
  const entryOf = g => g.from === g.to ? "s" + g.from : "p" + g.from;
  // where a route may send the work: a stop on its own, the FIRST stop
  // of a group (which enters the whole group), or the end
  const targetOf = to => {
    if (to === "done") return "done";
    const i = stops.findIndex(x => x.id === to);
    if (i < 0) return null;
    const g = groups.find(x => i >= x.from && i <= x.to);
    return g && g.from === i ? entryOf(g) : null;
  };
  const condOf = (when, i) => when.kind === "choice"
    ? { source: "nodeOutput", nodeId: "s" + i, path: "choice", op: "==", value: String(when.value || "").trim() }
    : { source: "field", path: when.key, op: when.op || "==", value: when.value };

  stops.forEach((s, i) => {
    const config = { label: s.label || ("Step " + (i + 1)) };
    // the role is the whole point: who holds it is derived from this at
    // read time, so the stop stays true as people join and leave
    config.role = s.roleId;
    // the engine reads cfg.assignees as "who may act"; the role stays
    // beside it so hoHolders can keep intersecting the two
    if ((s.assignees || []).length) config.assignees = s.assignees.slice();
    // extra keys the engine ignores and this file reads. wfValidate
    // checks the config it knows about and permits the rest, which is
    // what lets a stop say what it MEANS in the type's own vocabulary
    // without teaching the engine about statuses.
    if (s.status) config.status = s.status;
    if (s.dueAfter) config.dueAfter = s.dueAfter;
    // the person at this stop rates the work the previous stop handed
    // them; another key the engine ignores and the finish sheets read
    if (s.rates) config.rates = true;
    const choices = (s.choices || []).map(c => String(c || "").trim()).filter(Boolean);
    if (choices.length) {
      config.choices = choices;
      config.outputs = [{ key: "choice", type: "text", label: "Decision" }];
    }
    nodes.push({ id: "s" + i, type: "role", position: { x: 0, y: (i + 1) * 160 }, config });
  });

  // `prev` is every line waiting to be joined to the next thing: one for
  // a plain stop, one per member after a group (their lines meet at the
  // next entry, which is what makes it the merge), and a route's
  // "otherwise" side after a stop that branches
  let prev = [{ node: "trigger" }];
  groups.forEach((g, gi) => {
    const entry = entryOf(g);
    prev.forEach(p => edge(p.node, entry, p.handle));
    if (g.from === g.to) {
      const i = g.from, s = stops[i];
      const routes = (s.routes || []).filter(r => r && r.when && r.to);
      if (!routes.length) { prev = [{ node: "s" + i }]; return; }
      const branches = routes.map((r, k) => ({ id: "b" + k,
        label: r.when.kind === "choice" ? String(r.when.value) : (r.when.key + " " + (r.when.op || "==") + " " + r.when.value),
        condition: condOf(r.when, i) }));
      branches.push({ id: "else", label: "Otherwise", isElse: true });
      nodes.push({ id: "r" + i, type: "split", position: { x: 0, y: (i + 1) * 160 + 80 },
        config: { mode: "route", label: "After " + (s.label || ("step " + (i + 1))), branches } });
      edge("s" + i, "r" + i);
      routes.forEach((r, k) => { const t = targetOf(r.to); if (t) edge("r" + i, t, "b" + k); });
      prev = [{ node: "r" + i, handle: "else" }];
    } else {
      const members = [];
      for (let i = g.from; i <= g.to; i++) members.push(i);
      nodes.push({ id: "p" + g.from, type: "split", position: { x: 0, y: (g.from + 1) * 160 - 80 },
        config: { mode: "parallel", label: "At the same time",
                  branches: members.map(i => ({ id: "b" + i, label: stops[i].label || ("Step " + (i + 1)) })) } });
      members.forEach(i => edge("p" + g.from, "s" + i, "b" + i));
      prev = members.map(i => ({ node: "s" + i }));
    }
  });

  // every path must reach an end or the blueprint will not validate. The
  // node is an action only because that is the end-shape the validator
  // accepts: the org glue (js/items.js) applies the engine's run and stops
  // and discards its effects, so this notify never sends. The people on
  // the last stop are told by item.assigned when it reaches them.
  nodes.push({ id: "done", type: "action", position: { x: 0, y: (stops.length + 1) * 160 },
    config: { actionType: "notify", label: "Finished",
              params: { message: ((type && type.name) || "Work") + " finished its handoff." } } });
  prev.forEach(p => edge(p.node, "done", p.handle));

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

/* The role stops the work reaches after a node, following the graph the
   way the engine will: through a route's "otherwise" (or a named branch
   when `handle` is given), through every branch of a parallel split, to
   the end. Returns { stops: [role nodes], done: bool }. */
function hoAfter(blueprint, nodeId, handle){
  const nodes = (blueprint && blueprint.nodes) || [], edges = (blueprint && blueprint.edges) || [];
  const byId = id => nodes.find(n => n.id === id) || null;
  const out = { stops: [], done: false };
  const seen = new Set();
  const walk = (id, h) => {
    edges.filter(e => e.from === id && (h ? e.fromHandle === h : true)).forEach(e => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      const n = byId(e.to);
      if (!n) return;
      if (n.type === "role") { if (!out.stops.some(x => x.id === n.id)) out.stops.push(n); }
      else if (n.type === "split") {
        const cfg = n.config || {};
        if ((cfg.mode || "route") === "route") walk(n.id, "else");
        else (cfg.branches || []).forEach(b => walk(n.id, b.id));
      }
      else if (n.type === "action" || n.type === "vault") { if (!edges.some(x => x.from === n.id)) out.done = true; else walk(n.id); }
      else walk(n.id);
    });
  };
  walk(nodeId, handle || null);
  return out;
}

/* Where a piece of work is on its handoff, in the words a card needs:
   which stop (n of N), who passed it here and what they wrote, who is
   next, and - when the stop asks for a decision - the choices and where
   each one sends the work. Copied onto the Item by the run sync so the
   deck reads it without reading the run. `nameOf(uid)` turns a seat
   into a name; the holders of the NEXT stop are resolved from the
   roster the same way hoHolders resolves the current one - the role,
   narrowed to the named. */
function hoSummary(blueprint, nodeRuns, members, nameOf, run){
  const name = uid => (nameOf && nameOf(uid)) || "";
  const stops = ((blueprint && blueprint.nodes) || []).filter(n => n.type === "role");
  const active = hoActiveStops(nodeRuns)[0] || null;
  const legs = hoTrail(blueprint, nodeRuns).filter(t => t.status === "completed");
  const last = legs.length ? legs[legs.length - 1] : null;
  const from = last ? {
    uid: last.by || null, name: last.by ? name(last.by) : "",
    label: last.label, nodeId: last.nodeId, note: (last.output && last.output.comment) || "", at: last.completedAt || null,
    choice: (last.output && last.output.choice) || null
  } : null;
  if (!active) return { stop: null, from, next: null, done: !!(run && run.status === "completed") || legs.length > 0 };
  const holdersOf = node => {
    const cfg = node.config || {}, roster = members || [];
    const inRole = cfg.role === HO_ANY ? roster.map(m => m.uid)
      : cfg.role ? roster.filter(m => m.roleId === cfg.role).map(m => m.uid)
      : roster.map(m => m.uid);
    const named = cfg.assignees || [];
    return (named.length ? inRole.filter(u => named.indexOf(u) >= 0) : inRole).map(u => ({ uid: u, name: name(u) }));
  };
  const nextOf = (after) => {
    const first = after.stops[0] || null;
    if (!first) return null;
    const n = { label: (first.config && first.config.label) || first.id,
      role: (first.config && first.config.role) || null, holders: holdersOf(first) };
    if (after.stops.length > 1) n.also = after.stops.slice(1).map(x => (x.config && x.config.label) || x.id);
    return n;
  };
  /* One record per RUNNING step. Steps that run together are all
     running at once, held by different people, and the item is one
     document shared by all of them - so the summary carries every one,
     and each screen picks the step ITS reader holds (hoMyStop). Before
     this the summary named only the first, and the person holding the
     second was offered a submission, a decision and a Done for a step
     that was never theirs. */
  const stopOf = nr => {
    const idx = stops.findIndex(n => n.id === nr.nodeId);
    const cur = idx >= 0 ? stops[idx] : null;
    const cfg = (cur && cur.config) || {};
    const after = hoAfter(blueprint, nr.nodeId);
    // where each choice sends the work: the branch whose rule names it,
    // else the "otherwise" path - said in the target's own words, so the
    // sheet can offer "Send back -> Write the draft" rather than a bare word
    const choices = (cfg.choices || []).map(v => {
      const split = ((blueprint && blueprint.nodes) || []).find(n => n.type === "split" &&
        ((blueprint.edges || []).some(e => e.from === nr.nodeId && e.to === n.id)));
      const br = split ? ((split.config || {}).branches || []).find(b => b.condition && b.condition.path === "choice" && b.condition.value === v) : null;
      const to = br ? hoAfter(blueprint, split.id, br.id) : after;
      const first = to.stops[0];
      return { value: v, to: first ? ((first.config && first.config.label) || first.id) : (to.done ? "Done" : ""), back: !!(first && stops.indexOf(first) < idx) };
    });
    // the step's id and which pass of it this is ride along, because a
    // review (js/reviews.js) is keyed by the step and refuses to reuse an
    // approval given to an earlier pass of the same step; and who holds
    // it, so the people on one step can see each other
    return Object.assign({ label: (cur && cur.config && cur.config.label) || nr.nodeId, index: idx + 1, count: stops.length,
        nodeId: nr.nodeId, iteration: (nodeRuns || []).filter(x => x && x.nodeId === nr.nodeId).length,
        holders: cur ? holdersOf(cur) : [] },
      choices.length ? { choices } : {}, cfg.rates ? { rates: true } : {}, { after });
  };
  const running = hoActiveStops(nodeRuns).map(stopOf);
  // what comes next is the same for every member of a group - they all
  // meet at the step after it - so one `next` serves every running step
  const next = nextOf(running[0].after);
  running.forEach(x => { delete x.after; });
  return {
    stop: running[0],
    // every running step, in the run's order; one entry when nothing runs together
    stops: running.map(x => Object.assign({}, x)),
    from,
    next,
    done: false
  };
}

/* The running step THIS person holds, from a summary the run wrote onto
   the work. Steps that run together give one piece of work several
   running steps at once; `handoff.stop` is the first, and a person
   holding the second must be shown, and offered, their own. Falls back
   to the first for a summary written before `stops` existed, and for a
   reader on no step (an owner overriding), who gets the first as before. */
function hoMyStop(handoff, uid){
  if (!handoff || handoff.done) return null;
  const all = Array.isArray(handoff.stops) && handoff.stops.length ? handoff.stops : (handoff.stop ? [handoff.stop] : []);
  if (!all.length) return null;
  return all.find(x => uid && (x.holders || []).some(h => h && h.uid === uid)) || all[0];
}

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

/* The track as one sentence, in the words the editor previews it in:
   "Write the draft (Staff) → Check it (Manager) → done". This exists
   because the editor's controls describe ONE step each, and the thing
   an owner is actually deciding is the whole line - reading it back as
   a sentence is what turns four dropdowns into a decision they can
   check. A step with no name yet is "Step n", and one with nobody
   chosen says so rather than vanishing, so the preview is honest about
   an unfinished track instead of tidy about it. Steps that run together
   are bracketed, and a step that branches says where each way goes.
   `roleNameOf(id)` turns a role id into its name; HO_ANY reads "anyone". */
function hoDescribe(track, roleNameOf){
  const stops = hoStopIds(track);
  if (!stops.length) return "";
  const nameOf = id => id === HO_ANY ? "anyone" : ((roleNameOf && roleNameOf(id)) || id);
  const labelOf = s => (s.label || "").trim() || ("Step " + (stops.indexOf(s) + 1));
  const leg = s => {
    const who = s.roleId ? nameOf(s.roleId) : "nobody chosen yet";
    const only = (s.assignees || []).length ? ", " + s.assignees.length + " named" : "";
    const routes = (s.routes || []).filter(r => r && r.when && r.to).map(r => {
      const w = r.when;
      const test = w.kind === "choice" ? String(w.value) : (w.key + " " + ({ "==": "is", "!=": "is not", contains: "contains", ">": "over", "<": "under" }[w.op || "=="] || w.op) + " " + w.value);
      const t = r.to === "done" ? "done" : (stops.find(x => x.id === r.to) || null);
      const dest = t === "done" ? "done" : t ? ((stops.indexOf(t) < stops.indexOf(s) ? "back to " : "") + labelOf(t)) : "?";
      return "if " + test + " → " + dest;
    });
    return labelOf(s) + " (" + who + only + ")" + (routes.length ? " [" + routes.join("; ") + "]" : "");
  };
  const legs = hoGroups(stops).map(g => g.from === g.to ? leg(stops[g.from])
    : "{ " + stops.slice(g.from, g.to + 1).map(leg).join(" + ") + " together }");
  return legs.join(" → ") + " → done";
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
        dueAt: nr.dueAt || null,
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
  module.exports = { hoSummary, hoDescribe, hoStopIds, hoGroups, hoAfter, HO_FIELD_OPS, HO_MAX_STOPS, HO_ANY, HO_DAY, HO_NUDGE_EVERY,
    hoLate, hoDue, hoNeedsNudge, hoTrackErrors, hoTrackGaps, hoBuildBlueprint,
    hoActiveStops, hoHolders, hoStatus, hoMayAdvance, hoStalled, hoTrail, hoMyStop };
}
