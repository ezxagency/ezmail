/* ============================================================
   TEMPLATE PACKS — an industry as a JSON file.

   The test of ground rule 1 (docs/platform-spec.md) is whether
   supporting a new kind of business touches any application
   code. It does not: a pack is types, roles, rules and tracks,
   and everything below is data the same engines already consume.
   If a pack could ship broken, that claim would be hollow - so
   tests/packs.test.mjs validates every pack in here against the
   real item engine, the real permission grammar and the real
   workflow validator. A pack that cannot be used fails the build.

   PACKS ARE A STARTING POINT, NOT A CAGE. Everything a pack
   creates is an ordinary type, role or rule afterwards: rename
   it, delete it, add fields. Nothing knows it came from a pack
   except the derived id, which is only there so applying the
   same pack twice does not make a second copy of everything.

   WHAT A PACK DELIBERATELY DOES NOT INCLUDE: an owner role.
   Whoever created the org already holds it, and a pack quietly
   redefining who owns the place would be the worst kind of
   surprise.
   ============================================================ */

/* Permission bundles, so a pack says "staff" instead of restating
   the grammar eight times and getting one of them subtly wrong. */
const PACK_PERMS = {
  // managers and leads review the work they receive (js/rating.js);
  // the rules read the same row before they accept a decision
  manager: ["item:create:org", "item:read:org", "item:update:org", "item:delete:org",
            "member:read:org", "member:invite:org", "workflow:read:org", "report:read:org", "review:decide:org"],
  lead:    ["item:create:org", "item:read:org", "item:update:org",
            "member:read:org", "workflow:read:org", "review:decide:org"],
  staff:   ["item:create:org", "item:read:org", "item:update:assigned", "workflow:read:org"],
  viewer:  ["item:read:org"]
};

/* Shorthands, so a pack reads as content rather than as boilerplate.
   Named pkRole/pkStatus/pkField and not R/S/F because these files share
   ONE global scope: `S` is already the live shift state in config.js,
   and a one-letter helper here would silently redefine it. */
const pkRole = (id, name, bundle) => ({ id, name, permissions: PACK_PERMS[bundle] });
const pkStatus = (...names) => names.map(n => ({ key: n.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: n }));
/* A stop on a handoff track: what happens, who holds it, and the status
   it means. Not every kind of work is a pipeline - a supply request is
   one person's job - so only the packs where a baton is genuinely the
   point carry one. */
const pkStop = (label, roleId, status) => ({ label, roleId, status });
const pkField = (key, label, type, opts) => Object.assign({ key, label, type, required: false, options: [] }, opts || {});

const PACKS = [
  {
    key: "restaurant", name: "Restaurant", version: 1,
    blurb: "Shift cover, maintenance and prep, for a floor that changes every day.",
    roles: [pkRole("manager", "Manager", "manager"), pkRole("lead", "Shift lead", "lead"), pkRole("staff", "Staff", "staff")],
    itemTypes: [
      { id: "shiftswap", name: "Shift swap", statuses: pkStatus("Open", "Claimed", "Approved", "Denied"),
        track: [pkStop("Somebody takes it", "staff", "claimed"),
                pkStop("Manager approves", "manager", "approved")],
        fields: [pkField("shiftDate", "Shift date", "date", { required: true }),
                 pkField("shift", "Which shift", "select", { options: ["Morning", "Evening", "Late"] }),
                 pkField("coveredBy", "Covered by", "user"),
                 pkField("reason", "Reason", "longtext")] },
      { id: "maintenance", name: "Maintenance issue", statuses: pkStatus("Reported", "In hand", "Fixed"),
        fields: [pkField("area", "Area", "select", { options: ["Kitchen", "Front of house", "Bathrooms", "Outside"], required: true }),
                 pkField("urgent", "Stops service", "checkbox"),
                 pkField("detail", "What is wrong", "longtext")] }
    ],
    automations: [
      { name: "Tell the leads about new swaps", trigger: { verb: "item.created", typeId: "shiftswap" },
        conditions: [], actions: [{ kind: "notify", toRole: "lead", message: "A shift needs covering." }] },
      { name: "Urgent maintenance goes to the manager", trigger: { verb: "item.created", typeId: "maintenance" },
        conditions: [{ source: "field", path: "urgent", op: "==", value: true }],
        actions: [{ kind: "notify", toRole: "manager", message: "Something is stopping service." }] }
    ]
  },
  {
    key: "agency", name: "Agency or studio", version: 1,
    blurb: "Client briefs through the people who make them, with the client's answer on the record.",
    roles: [pkRole("manager", "Account lead", "manager"), pkRole("lead", "Senior", "lead"), pkRole("staff", "Maker", "staff")],
    itemTypes: [
      { id: "brief", name: "Brief", statuses: pkStatus("New", "In progress", "Internal review", "With client", "Done"),
        track: [pkStop("Do the work", "staff", "in-progress"),
                pkStop("Senior reviews it", "lead", "internal-review"),
                pkStop("Send it to the client", "manager", "with-client")],
        fields: [pkField("client", "Client", "text", { required: true }),
                 pkField("service", "Work", "select", { options: ["Copy", "Design", "Build", "Ads", "Email"] }),
                 pkField("due", "Due", "date"),
                 pkField("brief", "The ask", "longtext"),
                 pkField("link", "Working file", "url")] }
    ],
    automations: [
      { name: "Senior reviews before the client sees it", trigger: { verb: "item.status_changed", typeId: "brief" },
        conditions: [{ source: "task", path: "status", op: "==", value: "internal-review" }],
        actions: [{ kind: "notify", toRole: "lead", message: "Something is ready for internal review." }] }
    ]
  },
  {
    key: "clinic", name: "Clinic or practice", version: 1,
    blurb: "Follow-ups and supplies. Deliberately holds no clinical detail.",
    roles: [pkRole("manager", "Practice manager", "manager"), pkRole("lead", "Clinician", "lead"), pkRole("staff", "Reception", "staff")],
    itemTypes: [
      { id: "followup", name: "Follow-up", statuses: pkStatus("Due", "Attempted", "Reached", "Closed"),
        fields: [pkField("reference", "Reference", "text", { required: true }),
                 pkField("dueBy", "Due by", "date", { required: true }),
                 pkField("channel", "How", "select", { options: ["Phone", "Email", "Letter"] }),
                 pkField("note", "Note", "longtext")] },
      { id: "supply", name: "Supply request", statuses: pkStatus("Requested", "Ordered", "Arrived"),
        fields: [pkField("item", "What", "text", { required: true }), pkField("quantity", "How many", "number"),
                 pkField("urgent", "Urgent", "checkbox")] }
    ],
    automations: [
      { name: "Urgent supplies reach the manager", trigger: { verb: "item.created", typeId: "supply" },
        conditions: [{ source: "field", path: "urgent", op: "==", value: true }],
        actions: [{ kind: "notify", toRole: "manager", message: "An urgent supply request came in." }] }
    ]
  },
  {
    key: "construction", name: "Construction or trades", version: 1,
    blurb: "Site work and snags, with the photo and the sign-off attached to the job.",
    roles: [pkRole("manager", "Site manager", "manager"), pkRole("lead", "Foreman", "lead"), pkRole("staff", "Trade", "staff")],
    itemTypes: [
      { id: "sitetask", name: "Site task", statuses: pkStatus("Scheduled", "On site", "Done", "Blocked"),
        fields: [pkField("site", "Site", "text", { required: true }),
                 pkField("trade", "Trade", "select", { options: ["Electrical", "Plumbing", "Carpentry", "Groundworks", "Finishing"] }),
                 pkField("scheduled", "Scheduled", "date"), pkField("detail", "Scope", "longtext")] },
      { id: "snag", name: "Snag", statuses: pkStatus("Raised", "Fixed", "Signed off"),
        track: [pkStop("Fix it", "staff", "fixed"),
                pkStop("Foreman signs it off", "lead", "signed-off")],
        fields: [pkField("site", "Site", "text", { required: true }), pkField("photo", "Photo", "file"),
                 pkField("detail", "What is wrong", "longtext")] }
    ],
    automations: [
      { name: "A blocked job reaches the site manager", trigger: { verb: "item.status_changed", typeId: "sitetask" },
        conditions: [{ source: "task", path: "status", op: "==", value: "blocked" }],
        actions: [{ kind: "notify", toRole: "manager", message: "A job on site is blocked." }] }
    ]
  },
  {
    key: "retail", name: "Retail", version: 1,
    blurb: "Store jobs and stock problems across more than one place.",
    roles: [pkRole("manager", "Area manager", "manager"), pkRole("lead", "Store manager", "lead"), pkRole("staff", "Team", "staff")],
    itemTypes: [
      { id: "storetask", name: "Store task", statuses: pkStatus("To do", "Doing", "Done"),
        fields: [pkField("store", "Store", "text", { required: true }),
                 pkField("kind", "Kind", "select", { options: ["Merchandising", "Cleaning", "Admin", "Training"] }),
                 pkField("due", "Due", "date"), pkField("detail", "Detail", "longtext")] },
      { id: "stock", name: "Stock issue", statuses: pkStatus("Reported", "Counted", "Resolved"),
        fields: [pkField("store", "Store", "text", { required: true }), pkField("sku", "Item or SKU", "text"),
                 pkField("shortBy", "Short by", "number")] }
    ],
    automations: [
      { name: "Stock problems reach the area manager", trigger: { verb: "item.created", typeId: "stock" },
        conditions: [], actions: [{ kind: "notify", toRole: "manager", message: "A stock issue was reported." }] }
    ]
  },
  {
    key: "content", name: "Content or channel", version: 1,
    blurb: "Videos from idea to published, and the sponsorships that pay for them.",
    roles: [pkRole("manager", "Producer", "manager"), pkRole("lead", "Editor", "lead"), pkRole("staff", "Contributor", "staff")],
    itemTypes: [
      { id: "video", name: "Video", statuses: pkStatus("Idea", "Scripting", "Filming", "Editing", "Scheduled", "Published"),
        track: [pkStop("Write the script", "staff", "scripting"),
                pkStop("Film it", "staff", "filming"),
                pkStop("Edit it", "lead", "editing"),
                pkStop("Schedule it", "manager", "scheduled")],
        fields: [pkField("hook", "Hook", "text"), pkField("publishOn", "Publish on", "date"),
                 pkField("thumbnail", "Thumbnail", "file"), pkField("script", "Script", "longtext"),
                 pkField("link", "Working file", "url")] },
      { id: "sponsor", name: "Sponsorship", statuses: pkStatus("Talking", "Agreed", "Delivered", "Paid"),
        track: [pkStop("Agree the terms", "manager", "agreed"),
                pkStop("Deliver it", "lead", "delivered"),
                pkStop("Chase the payment", "manager", "paid")],
        fields: [pkField("brand", "Brand", "text", { required: true }), pkField("fee", "Fee", "money"),
                 pkField("deliverBy", "Deliver by", "date")] }
    ],
    automations: [
      { name: "The editor hears when filming is done", trigger: { verb: "item.status_changed", typeId: "video" },
        conditions: [{ source: "task", path: "status", op: "==", value: "editing" }],
        actions: [{ kind: "notify", toRole: "lead", message: "Something is ready to edit." }] },
      { name: "Chase a sponsorship that is delivered but unpaid", trigger: { verb: "item.status_changed", typeId: "sponsor" },
        conditions: [{ source: "task", path: "status", op: "==", value: "delivered" }],
        actions: [{ kind: "notify", toRole: "manager", message: "A sponsorship is delivered and awaiting payment." }] }
    ]
  },
  {
    key: "property", name: "Property or facilities", version: 1,
    blurb: "Work orders across buildings, with the tenant kept in the loop.",
    roles: [pkRole("manager", "Property manager", "manager"), pkRole("lead", "Coordinator", "lead"), pkRole("staff", "Contractor", "staff")],
    itemTypes: [
      { id: "workorder", name: "Work order", statuses: pkStatus("Raised", "Assigned", "Scheduled", "Complete"),
        track: [pkStop("Schedule it", "lead", "scheduled"),
                pkStop("Do the work", "staff", "complete")],
        fields: [pkField("building", "Building", "text", { required: true }), pkField("unit", "Unit", "text"),
                 pkField("trade", "Trade", "select", { options: ["Plumbing", "Electrical", "Heating", "General", "Grounds"] }),
                 pkField("emergency", "Emergency", "checkbox"), pkField("detail", "Detail", "longtext")] }
    ],
    automations: [
      { name: "Emergencies reach the manager immediately", trigger: { verb: "item.created", typeId: "workorder" },
        conditions: [{ source: "field", path: "emergency", op: "==", value: true }],
        actions: [{ kind: "notify", toRole: "manager", message: "An emergency work order came in." }] }
    ]
  },
  {
    key: "simple", name: "Just tasks", version: 1,
    blurb: "One kind of work and three stages. Start here and add what you find you need.",
    roles: [pkRole("manager", "Manager", "manager"), pkRole("staff", "Team", "staff")],
    itemTypes: [
      // NOT "task": that id belongs to MIGRATE_TASK_TYPE, the type the
      // Assign composer mirrors into. Sharing it made the mirror read this
      // type's statuses, fail validation on "open", and drop every
      // assignment silently in an org that had applied this pack.
      { id: "simpletask", name: "Task", statuses: pkStatus("To do", "Doing", "Done"),
        fields: [pkField("due", "Due", "date"), pkField("detail", "Detail", "longtext"),
                 pkField("priority", "Priority", "select", { options: ["High", "Normal", "Low"] })] }
    ],
    automations: []
  }
];

const packByKey = key => PACKS.find(p => p.key === key) || null;

/* Which pack a kind of work came from, inferred from its id rather than
   recorded on the document.

   That is deliberate. A stored packKey would have to survive every edit
   path - and itemTypeSave() replaces the document, so the first rename
   would silently drop it and the grouping would rot without anyone
   noticing. Inference cannot rot: no two packs define the same type id
   (tests/packs.test.mjs holds that), and a hand-made type is named
   "t<random>", which no pack can ever collide with. It also means an org
   that applied a pack before this existed groups correctly today, with
   no migration and no backfill. */
function packForType(type){
  if (!type || !type.id) return null;
  return PACKS.find(p => (p.itemTypes || []).some(t => t.id === type.id)) || null;
}

/* ------------------------------------------------------------------
   VALIDATION. A pack is only a real answer to "a new industry ships
   with no code change" if a broken one cannot ship. This runs against
   the REAL engines - the same ITEM_FIELD_TYPES the item engine
   enforces, the same grammar permParse reads, the same action kinds
   the automation planner understands - so a pack cannot be valid here
   and rejected there.

   It also catches the failure a type checker never would: a rule that
   is well-formed and can never fire, because it waits on a status its
   kind of work does not have. Silence is the worst bug an automation
   can have, so it is worth a rule of its own.

   Returns { ok, errors } - a list, not the first problem, because
   somebody fixing a pack wants all of them.
   ------------------------------------------------------------------ */
function packValidate(pack){
  const errors = [];
  const bad = (where, msg) => errors.push(where + ": " + msg);
  if (!pack || typeof pack !== "object") return { ok: false, errors: ["pack: not an object"] };
  if (!pack.key || !/^[a-z][a-z0-9-]*$/.test(pack.key)) bad("pack", "key must be lowercase slug");
  if (!pack.name) bad("pack", "needs a name");
  if (!pack.blurb) bad("pack", "needs a blurb - it is the only thing shown at the choice");
  if (typeof pack.version !== "number") bad("pack", "needs a numeric version");

  const roleIds = new Set();
  (pack.roles || []).forEach(r => {
    const w = "role " + (r && r.id);
    if (!r || !r.id) return bad("role", "needs an id");
    if (roleIds.has(r.id)) bad(w, "duplicate id");
    roleIds.add(r.id);
    if (!r.name) bad(w, "needs a name");
    if (!Array.isArray(r.permissions) || !r.permissions.length) return bad(w, "needs permissions");
    r.permissions.forEach(row => {
      const parsed = permParse(row);
      if (!parsed) return bad(w, 'permission "' + row + '" is not resource:action:scope');
      if (parsed.resource === "*" || parsed.action === "*") return;   // wildcards are legal
      const entry = PERM_CATALOG.find(c => c.resource === parsed.resource);
      if (!entry) return bad(w, 'permission "' + row + '" names no known resource');
      if (!entry.actions.some(a => a.action === parsed.action))
        bad(w, 'permission "' + row + '" names no known action on ' + parsed.resource);
    });
  });
  if (!roleIds.size) bad("pack", "needs at least one role");

  const statusesByType = {};
  const typeIds = new Set();
  (pack.itemTypes || []).forEach(t => {
    const w = "type " + (t && t.id);
    if (!t || !t.id) return bad("itemType", "needs an id");
    if (typeIds.has(t.id)) bad(w, "duplicate id");
    typeIds.add(t.id);
    if (!t.name) bad(w, "needs a name");
    const st = t.statuses || [];
    if (st.length < 2) bad(w, "needs at least two statuses - one stage is not a workflow");
    const seenStatus = new Set();
    st.forEach(s => {
      if (!s || !s.key || !s.label) return bad(w, "a status is missing key or label");
      if (seenStatus.has(s.key)) bad(w, 'duplicate status "' + s.key + '"');
      seenStatus.add(s.key);
    });
    statusesByType[t.id] = seenStatus;
    /* A track is validated against the SAME pack that ships it: a stop
       naming a role the pack does not create, or a status the type does
       not have, is a pipeline that stalls or silently does nothing on the
       first day somebody uses it. Both are exactly the class of failure
       packValidate exists to make impossible. */
    (t.track || []).forEach((st, i) => {
      const w2 = w + " track stop " + (i + 1);
      if (!st || !(st.label || "").trim()) bad(w2, "needs a name");
      if (!st || !st.roleId) bad(w2, "has nobody holding it");
      else if (!roleIds.has(st.roleId)) bad(w2, 'is held by "' + st.roleId + '", which the pack does not create');
      if (st && st.status && !seenStatus.has(st.status))
        bad(w2, 'sets status "' + st.status + '", which ' + t.id + " does not have");
    });
    const seenField = new Set();
    (t.fields || []).forEach(f => {
      if (!f || !f.key) return bad(w, "a field is missing its key");
      if (seenField.has(f.key)) bad(w, 'duplicate field "' + f.key + '"');
      seenField.add(f.key);
      if (!f.label) bad(w, 'field "' + f.key + '" needs a label');
      if (!ITEM_FIELD_TYPES[f.type]) bad(w, 'field "' + f.key + '" has unknown type "' + f.type + '"');
      if ((f.type === "select" || f.type === "multiselect") && !(f.options || []).length)
        bad(w, 'field "' + f.key + '" is a choice with nothing to choose');
    });
  });
  if (!typeIds.size) bad("pack", "needs at least one kind of work");

  (pack.automations || []).forEach(a => {
    const w = "rule " + ((a && a.name) || "?");
    if (!a || !a.name) return bad("automation", "needs a name");
    const t = a.trigger || {};
    if (!ITEM_EVENT_VERBS.includes(t.verb)) bad(w, 'trigger "' + t.verb + '" is not a verb anything emits');
    if (t.typeId && !typeIds.has(t.typeId)) bad(w, 'triggers on type "' + t.typeId + '" which the pack does not define');
    const known = t.typeId ? statusesByType[t.typeId] : null;

    (a.conditions || []).forEach(c => {
      if (!c || !c.path || !c.op) return bad(w, "a condition is incomplete");
      if (c.source !== "task" && c.source !== "field") bad(w, 'condition source "' + c.source + '" is neither task nor field');
      // the silent-rule check: waiting on a status this type never reaches
      if (known && c.source === "task" && c.path === "status" && c.op === "==" && !known.has(c.value))
        bad(w, 'waits for status "' + c.value + '" which ' + t.typeId + " never reaches");
    });

    if (!(a.actions || []).length) bad(w, "does nothing");
    (a.actions || []).forEach(act => {
      if (!act || AUTO_ACTION_KINDS.indexOf(act.kind) < 0)
        return bad(w, 'action "' + (act && act.kind) + '" is not a kind the planner runs');
      if (act.kind === "notify" && act.toRole && !roleIds.has(act.toRole))
        bad(w, 'notifies role "' + act.toRole + '" which the pack does not define');
      if (act.kind === "set_status"){
        if (!act.status) bad(w, "set_status with no status");
        else if (known && !known.has(act.status))
          bad(w, 'sets status "' + act.status + '" which ' + t.typeId + " does not have");
      }
      if (act.kind === "set_field" && !act.key) bad(w, "set_field with no field");
    });
  });

  return { ok: !errors.length, errors };
}


/* Ids are derived from the pack and the thing inside it, which is what
   makes applying one twice safe: the second run finds what it would
   have made already there and leaves it alone. It leaves an EDITED one
   alone too - a pack is a starting point, and quietly restoring what
   somebody deliberately changed would be worse than doing nothing. */
const packDocId = (packKey, kind, localId) => "pk_" + packKey + "_" + kind + "_" + localId;

/* What applying this pack WOULD do, given what the org already has.
   Returns lists rather than performing anything, so the screen can say
   "3 types, 3 roles, 2 rules" before somebody commits to it, and so
   this whole decision is testable without a database.

   existing = { roleIds, typeIds, automationIds } */
function packPlan(pack, existing){
  const have = k => new Set((existing && existing[k]) || []);
  const haveRoles = have("roleIds"), haveTypes = have("typeIds"), haveAutos = have("automationIds");
  const plan = { roles: [], itemTypes: [], automations: [], skipped: [] };

  (pack.roles || []).forEach(r => {
    // a role id collides on purpose: an org already having "manager"
    // should keep ITS manager, permissions and all
    if (haveRoles.has(r.id)) { plan.skipped.push({ kind: "role", id: r.id }); return; }
    plan.roles.push({ id: r.id, doc: { name: r.name, permissions: r.permissions.slice() } });
  });

  (pack.itemTypes || []).forEach(t => {
    if (haveTypes.has(t.id)) { plan.skipped.push({ kind: "itemType", id: t.id }); return; }
    plan.itemTypes.push({ id: t.id, doc: {
      name: t.name, icon: null, color: null,
      fields: JSON.parse(JSON.stringify(t.fields || [])),
      statuses: JSON.parse(JSON.stringify(t.statuses || [])),
      // the track is the source; the blueprint compiled from it is written
      // beside the type and named here, so the work starts travelling the
      // moment somebody creates any
      track: t.track ? JSON.parse(JSON.stringify(t.track)) : null,
      workflowId: t.track ? packDocId(pack.key, "bp", t.id) : null
    }});
  });

  (pack.automations || []).forEach((a, i) => {
    const id = packDocId(pack.key, "auto", String(i));
    if (haveAutos.has(id)) { plan.skipped.push({ kind: "automation", id }); return; }
    plan.automations.push({ id, doc: {
      name: a.name, enabled: true,
      trigger: Object.assign({}, a.trigger),
      conditions: JSON.parse(JSON.stringify(a.conditions || [])),
      actions: JSON.parse(JSON.stringify(a.actions || []))
    }});
  });

  // one blueprint per tracked type, compiled by the same function the
  // track editor uses - two generators would be two things to keep in step
  plan.blueprints = [];
  plan.itemTypes.forEach(t => {
    const src = (pack.itemTypes || []).find(x => x.id === t.id);
    if (!src || !src.track) return;
    const id = packDocId(pack.key, "bp", t.id);
    plan.blueprints.push({ id, doc: hoBuildBlueprint(src, src.track, { id, version: pack.version || 1 }) });
  });

  return plan;
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { PACKS, PACK_PERMS, packByKey, packForType, packDocId, packPlan, packValidate };
}
