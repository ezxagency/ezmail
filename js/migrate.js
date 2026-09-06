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
    { key: "from",    label: "Asked by",  type: "text",     required: false, options: [] }
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
      from: row.fromName || ""
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
