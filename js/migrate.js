/* ============================================================
   MIGRATION — the shapes today's collections take when they
   become Items. Pure: plain rows in, plain intents out, no DOM
   and no Firestore, so every decision about what a migration
   MEANS is testable before any data moves.

   The claim being tested here is the spec's central one: that
   assignments and campaigns are the same object as everything
   else, with different types. If either needed a field the model
   does not have, the model was wrong and this is where it shows.

   Migration is ADDITIVE and one-way here. Nothing reads from
   Items yet and nothing deletes from the old collections - the
   assign composer and the campaigns page keep working exactly as
   they do. That ordering is deliberate: data first, proven, and
   only then a UI cutover. Doing both at once means a bug in
   either one looks like a bug in both.

   IDs ARE DERIVED FROM THE SOURCE, which is what makes importing
   twice safe. Re-running finds the same id already present and
   skips it rather than making a second copy of somebody's work.
   ============================================================ */

/* ---------- the built-in types ----------
   Shipped rather than drawn, because these two already exist in
   the app and their shape is not a matter of opinion. `store` and
   `task` are CHOICE fields so they produce facet rows and a
   manager can filter by them - but their options are grown from
   the real data at import time, never guessed here. An import
   that rejected a row because a value was missing from a list
   would be a migration that lost work, which is no migration. */
const MIGRATE_TASK_TYPE = {
  id: "task",
  name: "Task",
  statuses: [{ key: "open", label: "Open" }, { key: "done", label: "Done" }],
  fields: [
    { key: "store",   label: "Store",     type: "select",   required: false, options: [] },
    { key: "task",    label: "Task",      type: "select",   required: false, options: [] },
    { key: "note",    label: "Brief",     type: "longtext", required: false, options: [] },
    { key: "dueDate", label: "Due",       type: "date",     required: false, options: [] },
    { key: "dueTime", label: "Due time",  type: "text",     required: false, options: [] },
    { key: "from",    label: "Asked by",  type: "text",     required: false, options: [] },
    // these three exist so the queue can be READ from an Item without
    // losing anything it shows today. They are unglamorous - a system
    // note, a contact, a count - but a field the UI reads and the model
    // does not carry is exactly how a cutover quietly degrades a screen
    // people rely on.
    { key: "snote",     label: "System note", type: "text",   required: false, options: [] },
    { key: "fromEmail", label: "Asked by (email)", type: "text", required: false, options: [] },
    { key: "groupSize", label: "Tasks in this send", type: "number", required: false, options: [] },
    // the receipt. It has to ride along or the queue, reading rows that
    // never look seen, re-stamps every one of them on every snapshot.
    { key: "seenAt",    label: "Seen at", type: "number", required: false, options: [] }
  ]
};

const MIGRATE_CAMPAIGN_TYPE = {
  id: "campaign",
  name: "Campaign",
  statuses: [{ key: "active", label: "Active" }, { key: "done", label: "Done" }],
  fields: [
    { key: "stage",  label: "Stage",  type: "select",   required: false, options: [] },
    { key: "owners", label: "Owners", type: "text",     required: false, options: [] },
    { key: "note",   label: "Note",   type: "longtext", required: false, options: [] }
  ]
};

/* A derived id, and the source it came from, so a row can always be
   traced back to the document it was made from - and so importing the
   same document twice cannot produce two Items. */
const migrateItemId = (kind, sourceId) => "im_" + kind + "_" + sourceId;
const migrateSource  = (kind, sourceId) => kind + ":" + sourceId;

/* An assignment has no title - the composer never asked for one, because
   store and task WERE the title. So one is built rather than invented:
   "STORE · Task", which is what the row already reads as on screen. */
function migrateAssignmentIntent(row){
  const store = (row.store || "").trim();
  const task = (row.task || "").trim();
  const title = [store, task].filter(Boolean).join(" · ") || "Task";
  return {
    kind: "create",
    title,
    status: row.done ? "done" : "open",
    assigneeIds: row.toUid ? [row.toUid] : [],
    fields: {
      store, task,
      note: row.note || "",
      dueDate: row.dueDate || null,
      dueTime: row.dueTime || "",
      from: row.fromName || "",
      snote: row.snote || "",
      fromEmail: row.fromEmail || "",
      groupSize: row.groupSize == null ? null : Number(row.groupSize),
      seenAt: row.seenAt == null ? null : Number(row.seenAt)
    },
    // one send became many rows sharing a groupId; that is a parent in the
    // new model, and the tree is what keeps them together
    parentId: row.groupId ? migrateItemId("group", row.groupId) : null,
    createdAt: row.createdAt || null
  };
}

/* A campaign carries its whole chain in one document. The stage it is AT
   becomes a value; the chain itself is a workflow, and that half waits
   for the engine additions the spec names (completionPolicy, dueAfter) -
   this preserves where the baton IS without pretending to move it. */
function migrateCampaignIntent(row){
  const stages = row.stages || [];
  const cur = stages[row.cur] || null;
  const owners = cur
    ? (cur.owners || (cur.uid ? [{ uid: cur.uid, uname: cur.uname }] : []))
    : [];
  return {
    kind: "create",
    title: row.title || "Campaign",
    status: row.status === "done" ? "done" : "active",
    assigneeIds: owners.map(o => o.uid).filter(Boolean),
    fields: {
      stage: cur ? (cur.name || cur.label || "") : "",
      owners: owners.map(o => o.uname).filter(Boolean).join(", "),
      note: ""
    },
    parentId: null,
    createdAt: row.createdAt || null
  };
}

/* Every distinct value a choice field will need, gathered from the rows
   themselves. Sorted so two imports of the same data produce the same
   type, and deduped case-insensitively-but-preserving: the first spelling
   seen wins, so "Store Alpha" and "store alpha" do not become two
   choices that mean one thing. */
function migrateOptionsFor(rows, key){
  const seen = new Map();
  rows.forEach(r => {
    const v = (r[key] == null ? "" : String(r[key])).trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, v);
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/* The type as it must exist BEFORE the rows are written: the shipped
   shape, with its choice fields grown to fit the data. */
function migrateTypeWithOptions(base, rows, keys){
  const type = JSON.parse(JSON.stringify(base));
  type.fields.forEach(f => {
    if (keys.indexOf(f.key) >= 0) f.options = migrateOptionsFor(rows, f.key);
  });
  return type;
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { MIGRATE_TASK_TYPE, MIGRATE_CAMPAIGN_TYPE, migrateItemId, migrateSource,
    migrateAssignmentIntent, migrateCampaignIntent, migrateOptionsFor, migrateTypeWithOptions };
}

/* ============================================================
   A CAMPAIGN CHAIN, AS A WORKFLOW.

   A campaign carries its stages in one document: an ordered list,
   each with owners and an optional time budget, and a pointer at
   whichever holds the baton. That is a straight line of ROLE stops
   with a deadline on each - which is exactly what the workflow
   engine already runs. This turns one into the other.

   WHAT THIS DELIBERATELY DOES NOT DO: fast-forward an in-flight
   campaign into a run that looks half-finished. Doing that means
   writing approvals nobody gave and completion times nobody
   worked to, into a log whose only value is that it never lies.
   So a chain becomes a publishable BLUEPRINT - the track, reusable
   for the next piece of work - while a campaign already in motion
   keeps the Item snapshot the import made of it, showing the stage
   it is genuinely on. New work rides the track properly from its
   first stop; old work is not retconned into having done so.
   ============================================================ */

const MIGRATE_DAY = 86400000, MIGRATE_HOUR = 3600000;

// the same arithmetic campaigns.js already does on a stage's budget
const migrateStageBudget = st => {
  const ms = (st.days || 0) * MIGRATE_DAY + (st.hours || 0) * MIGRATE_HOUR;
  return ms > 0 ? ms : null;
};
const migrateStageOwners = st =>
  (st.owners || (st.uid ? [{ uid: st.uid, uname: st.uname }] : []))
    .map(o => o.uid).filter(Boolean);

/* campaign -> Blueprint, in OUR schema (the shape the engine consumes
   and the builder saves), never the canvas vendor's. Returns null for a
   chain with no stages, which is not a workflow and should not pretend. */
function migrateCampaignBlueprint(campaign, opts){
  const stages = (campaign.stages || []).filter(Boolean);
  if (!stages.length) return null;
  const o = opts || {};

  const nodes = [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 },
                   config: { label: "New " + (campaign.title || "campaign") } }];
  const edges = [];
  let prev = "trigger";

  stages.forEach((st, i) => {
    const id = "s" + i;
    const people = migrateStageOwners(st);
    const budget = migrateStageBudget(st);
    const config = { label: st.name || ("Stage " + (i + 1)) };
    if (people.length) config.assignees = people;
    // several owners meant every one of them had to approve, and that is
    // the rule the engine now has a name for
    if (people.length > 1) config.completionPolicy = "all";
    // a stage with nobody on it still needs an answer to "who works
    // here", or the blueprint cannot be published
    if (!people.length) config.role = st.role || "anyone";
    if (budget) config.dueAfter = budget;

    nodes.push({ id, type: "role", position: { x: 0, y: (i + 1) * 160 }, config });
    edges.push({ id: "e" + i, from: prev, to: id });
    prev = id;
  });

  // every path has to reach an end, and a finished baton pass has always
  // ended by telling the people on it
  nodes.push({ id: "done", type: "action", position: { x: 0, y: (stages.length + 1) * 160 },
               config: { actionType: "notify", label: "Everyone: it is finished",
                         params: { message: (campaign.title || "Campaign") + " is complete." } } });
  edges.push({ id: "e_done", from: prev, to: "done" });

  return {
    id: o.id || null,
    orgId: o.orgId || null,
    ownerId: o.ownerId || null,
    name: (campaign.title || "Campaign") + " chain",
    version: 1,
    status: "draft",
    nodes, edges,
    createdAt: o.now || 0, updatedAt: o.now || 0
  };
}

/* ---------- and back again ----------
   The queue, the brief and the team log all render a row shape the
   assignments collection has always produced. Reading from Items means
   producing that same shape rather than rewriting four hundred lines of
   rendering against a new one - so the cutover is a change of SOURCE,
   not a change of screen.

   The id it returns is the ASSIGNMENT's id, recovered from importedFrom,
   because writes still go to that collection. A row that read from one
   place and wrote to another under the wrong id would finish the wrong
   task, which is the worst bug this cutover could have. */
function itemToQueueRow(item){
  const f = item.fields || {};
  const src = String(item.importedFrom || "");
  const sourceId = src.startsWith("assignment:") ? src.slice("assignment:".length) : null;
  return {
    id: sourceId || item.id,
    itemId: item.id,
    toUid: (item.assigneeIds || [])[0] || null,
    store: f.store || "",
    task: f.task || "",
    note: f.note || "",
    snote: f.snote || null,
    dueDate: f.dueDate || null,
    dueTime: f.dueTime || null,
    fromName: f.from || "",
    fromEmail: f.fromEmail || "",
    groupId: item.parentId ? String(item.parentId).replace(/^im_group_/, "") : null,
    groupSize: f.groupSize == null ? null : Number(f.groupSize),
    seenAt: f.seenAt == null ? null : Number(f.seenAt),
    done: item.status === "done",
    createdAt: item.createdAt || null
  };
}

if (typeof module !== "undefined" && module.exports){
  module.exports.itemToQueueRow = itemToQueueRow;
  module.exports.migrateCampaignBlueprint = migrateCampaignBlueprint;
  module.exports.migrateStageBudget = migrateStageBudget;
  module.exports.migrateStageOwners = migrateStageOwners;
}
