/* ============================================================
   WORKFLOW BUILDER — UI + Firestore glue.
   The routed #/workflow page: blueprints an admin draws, runs
   that ride them. Pure transition/validation logic lives in
   js/workflow-engine.js (loaded just before this file); this
   file owns the DOM and every Firestore read/write.

   The canvas is Drawflow (vendored via CDN), but Drawflow is
   ONLY the drawing surface: what we persist is OUR Blueprint
   schema (nodes/edges/config exactly as the engine consumes),
   never the vendor's export JSON. A sidecar map carries each
   node's type/config/waitFor keyed by our node id; Drawflow's
   numeric ids exist only inside one editing session, joined to
   ours through wfDf2Our/wfOur2Df.

   Pinned for the runs: a worker-driven advance may write ONLY
   ['status','activeNodeIds','hops','completedAt','nodeRunIds']
   on a run doc - the firestore.rules allowlist rejects anything
   else, so one stray field in that update would stall real runs
   mid-flight. The first four are the engine's own writes;
   nodeRunIds is glue bookkeeping (transactions cannot query, so
   the run doc carries refs to its nodeRuns and the advance
   appends the attempts it created). blueprintSnapshot and task
   are written once at run creation and never again - the
   allowlist is what makes that a guarantee instead of a habit.
   ============================================================ */

const WF_ORG = "ez-agency";

const WF_TYPES = {
  trigger: { name: "Trigger", pal: "Trigger" },
  role:    { name: "Role",    pal: "Role" },
  split:   { name: "Split",   pal: "Split" },
  logic:   { name: "Logic",   pal: "Logic" },
  vault:   { name: "Vault",   pal: "Vault" },
  action:  { name: "Action",  pal: "Action" }
};
const WF_ACTION_TYPES = [
  { v: "notify",   label: "Notify" },
  { v: "complete", label: "Mark complete" },
  { v: "email",    label: "Email" },
  { v: "webhook",  label: "Webhook" }
];
const WF_GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>';
const WF_X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ---------- module state (one editing session at a time) ---------- */
let wfView = "list";          // "list" | "builder"
let wfEditor = null;          // the Drawflow instance
let wfNodes = new Map();      // ourId -> { type, config, waitFor }
let wfDf2Our = new Map();     // String(drawflowId) -> ourId
let wfOur2Df = new Map();     // ourId -> drawflowId
let wfCurrent = null;         // { docId, name, version, status, createdAt }
let wfIsDirty = false;
let wfErrList = [];
let wfDirCache = null;        // directory people, for the assignee picker
let wfCleanupArmed = false;

const wfId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const wfClone2 = v => JSON.parse(JSON.stringify(v));

function wfResetAll(){
  if (wfEditor){ try { wfEditor.clear(); } catch (e) {} }
  wfEditor = null;
  wfNodes = new Map(); wfDf2Our = new Map(); wfOur2Df = new Map();
  wfCurrent = null; wfIsDirty = false; wfErrList = []; wfDirCache = null;
  wfView = "list";
  const box = $("workflowBody");
  if (box) box.innerHTML = "";
}

/* ============================================================
   TEMPLATES — starter blueprints, so a new admin never stares
   at a blank canvas. Each make() returns FRESH objects in OUR
   Blueprint schema (the exact shapes the builder saves and the
   engine consumes) - a template seeds a new draft, it never
   locks anything. Every one of these must pass wfValidate with
   zero errors; tests/workflow-templates.test.mjs holds them
   to it.
   ============================================================ */
function wfTplRole(id, label, role, x, y, extra){
  return { id, type: "role", position: { x, y }, config: Object.assign({
    label, role, assigneeId: null, assignmentType: "role",
    outputs: [], requiresOutput: true, instructions: "", dueAfter: null }, extra || {}) };
}
function wfTplEdge(from, to, fromHandle){
  const e = { id: from + "~" + (fromHandle || "out") + "~" + to, from, to };
  if (fromHandle) e.fromHandle = fromHandle;
  return e;
}

/* (a) the acceptance sketch - the spec's target flow, identical node/edge
   shapes to the handshake test: route into three lanes (or the else-arm),
   fan out in parallel, vault, merge on a final review, notify */
function wfTplAcceptance(){
  const lane = v => ({ source: "task", path: "lane", op: "==", value: v });
  return {
    nodes: [
      { id: "n_t", type: "trigger", position: { x: 340, y: 20 }, config: { label: "Start" } },
      { id: "n_s1", type: "split", position: { x: 340, y: 160 }, config: { mode: "route", branches: [
        { id: "bA", label: "Lane A", condition: lane("A") },
        { id: "bB", label: "Lane B", condition: lane("B") },
        { id: "bC", label: "Lane C", condition: lane("C") },
        { id: "bE", label: "Else", isElse: true, condition: null }
      ] } },
      wfTplRole("n_r1", "Draft the piece", "designer", 180, 320),
      { id: "n_s2", type: "split", position: { x: 180, y: 480 }, config: { mode: "parallel", branches: [
        { id: "p1", label: "Visual", condition: null },
        { id: "p2", label: "Copy", condition: null }
      ] } },
      wfTplRole("n_r2a", "Visual pass", "designer", 60, 640),
      wfTplRole("n_r2b", "Copy pass", "copywriter", 320, 640),
      { id: "n_v1", type: "vault", position: { x: 180, y: 800 }, config: { vaultName: "Lane assets", storeWhat: "the finished pieces", visibility: "team" } },
      wfTplRole("n_r3", "Generalist draft", "designer", 580, 320),
      wfTplRole("n_r4", "Generalist polish", "designer", 580, 480),
      { id: "n_v2", type: "vault", position: { x: 580, y: 640 }, config: { vaultName: "Else assets", storeWhat: "the fallback piece", visibility: "team" } },
      wfTplRole("n_rf", "Final review", "lead", 340, 960),
      { id: "n_a1", type: "action", position: { x: 340, y: 1110 }, config: { actionType: "notify", params: { message: "Track finished" } } }
    ],
    edges: [
      wfTplEdge("n_t", "n_s1"),
      wfTplEdge("n_s1", "n_r1", "bA"), wfTplEdge("n_s1", "n_r1", "bB"), wfTplEdge("n_s1", "n_r1", "bC"),
      wfTplEdge("n_s1", "n_r3", "bE"),
      wfTplEdge("n_r1", "n_s2"),
      wfTplEdge("n_s2", "n_r2a", "p1"), wfTplEdge("n_s2", "n_r2b", "p2"),
      wfTplEdge("n_r2a", "n_v1"), wfTplEdge("n_r2b", "n_v1"),
      wfTplEdge("n_v1", "n_rf"),
      wfTplEdge("n_r3", "n_r4"), wfTplEdge("n_r4", "n_v2"), wfTplEdge("n_v2", "n_rf"),
      wfTplEdge("n_rf", "n_a1")
    ]
  };
}

/* (b) the everyday one: a maker, a manager gate, and a reject that loops
   the work back for rework until it passes */
function wfTplApproval(){
  return {
    nodes: [
      { id: "t", type: "trigger", position: { x: 300, y: 20 }, config: { label: "Start" } },
      wfTplRole("r_draft", "Write the draft", "copywriter", 300, 170),
      wfTplRole("r_review", "Manager approval", "manager", 300, 340, {
        outputs: [{ key: "approved", type: "boolean", label: "Approve this?" }]
      }),
      { id: "g", type: "logic", position: { x: 300, y: 510 }, config: {
        condition: { source: "nodeOutput", nodeId: "r_review", path: "approved", op: "==", value: true }
      } },
      { id: "a_pub", type: "action", position: { x: 180, y: 670 }, config: { actionType: "notify", params: { message: "Approved — publish it" } } }
    ],
    edges: [
      wfTplEdge("t", "r_draft"),
      wfTplEdge("r_draft", "r_review"),
      wfTplEdge("r_review", "g"),
      wfTplEdge("g", "a_pub", "true"),
      wfTplEdge("g", "r_draft", "false")
    ]
  };
}

/* (c) a small studio staple: one brief fans into design + copy in
   parallel, both land in a vault (the two lines in ARE the merge),
   QA signs off, done */
function wfTplStudio(){
  return {
    nodes: [
      { id: "t", type: "trigger", position: { x: 300, y: 20 }, config: { label: "Start" } },
      wfTplRole("r_brief", "Shape the brief", "lead", 300, 170),
      { id: "sp", type: "split", position: { x: 300, y: 330 }, config: { mode: "parallel", branches: [
        { id: "d", label: "Design", condition: null },
        { id: "c", label: "Copy", condition: null }
      ] } },
      wfTplRole("r_design", "Design it", "designer", 160, 490),
      wfTplRole("r_copy", "Write it", "copywriter", 440, 490),
      { id: "v1", type: "vault", position: { x: 300, y: 650 }, config: { vaultName: "Deliverables", storeWhat: "the finished design and copy", visibility: "team" } },
      wfTplRole("r_qa", "QA sign-off", "lead", 300, 800),
      { id: "a1", type: "action", position: { x: 300, y: 950 }, config: { actionType: "notify", params: { message: "Ready for the client" } } }
    ],
    edges: [
      wfTplEdge("t", "r_brief"),
      wfTplEdge("r_brief", "sp"),
      wfTplEdge("sp", "r_design", "d"), wfTplEdge("sp", "r_copy", "c"),
      wfTplEdge("r_design", "v1"), wfTplEdge("r_copy", "v1"),
      wfTplEdge("v1", "r_qa"),
      wfTplEdge("r_qa", "a1")
    ]
  };
}

const WF_TEMPLATES = [
  { key: "acceptance", name: "Acceptance sketch",
    tagline: "Route into three lanes or an else-arm, fan out in parallel, vault the work, merge on a final review, notify",
    make: wfTplAcceptance },
  { key: "approval", name: "Draft → approval → publish",
    tagline: "One maker, one manager gate — a reject loops it back for rework until it passes",
    make: wfTplApproval },
  { key: "studio", name: "Brief → design + copy → QA",
    tagline: "A brief fans into parallel design and copy, both land in a vault, QA signs off",
    make: wfTplStudio }
];

function wfNewBlueprintSheet(){
  openSheet(`
    <h2>New blueprint</h2>
    <p class="hint">Start from a template — it seeds the canvas and stays fully editable — or draw from scratch.</p>
    <button type="button" class="wf-card" data-tpl="">
      <span class="wf-card-main">
        <p class="wf-card-name">Blank canvas</p>
        <p class="wf-card-meta">Just the Trigger. Draw the rest.</p>
      </span>
    </button>
    ${WF_TEMPLATES.map(t => `
      <button type="button" class="wf-card" data-tpl="${esc(t.key)}">
        <span class="wf-card-main">
          <p class="wf-card-name">${esc(t.name)}</p>
          <p class="wf-card-meta">${esc(t.tagline)} · ${t.make().nodes.length} blocks</p>
        </span>
      </button>`).join("")}
  `, () => {
    $("sheetBody").querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => {
      closeSheet();
      const tpl = WF_TEMPLATES.find(t => t.key === b.dataset.tpl);
      if (!tpl){ wfOpenBuilder(null); return; }
      const g = tpl.make();
      // a NEW draft seeded from the template: fresh doc id on first save,
      // status draft, everything editable - and dirty, because nothing
      // has been persisted yet
      wfOpenBuilder({ docId: null, name: tpl.name, version: 1, status: "draft",
        createdAt: null, nodes: g.nodes, edges: g.edges });
      wfMarkDirty();
    });
  });
}

/* ============================================================
   PAGE ENTRY
   ============================================================ */
function enterWorkflowPage(){
  const box = $("workflowBody");
  if (!box) return;
  if (!isAdmin){
    box.innerHTML = `<div id="wfStops"></div>`;
    wfWatchStops();
    wfRenderStops();
    return;
  }
  // returning to an open builder keeps the canvas exactly as it was -
  // the screens only hide, they don't unmount
  wfWatchStops();
  if (wfView === "builder" && $("wfCanvas")) return;
  wfRenderList();
}

/* ============================================================
   BLUEPRINT LIST
   ============================================================ */
async function wfRenderList(){
  wfView = "list";
  const box = $("workflowBody");
  box.innerHTML = `
    <div id="wfStops"></div>
    <div class="fpage-filters wf-tabs">
      <button type="button" class="chip" data-tab="blueprints" aria-pressed="${wfTab === "blueprints"}">Blueprints</button>
      <button type="button" class="chip" data-tab="runs" aria-pressed="${wfTab === "runs"}">Runs</button>
    </div>
    <div id="wfTabBody"></div>`;
  box.querySelectorAll("[data-tab]").forEach(c => c.onclick = () => {
    if (wfTab === c.dataset.tab) return;
    wfTab = c.dataset.tab;
    wfRenderList();
  });
  wfRenderStops();
  if (wfTab === "runs"){ wfWatchRuns(); wfRenderRuns(); }
  else await wfRenderBlueprints();
}

async function wfRenderBlueprints(){
  const host = $("wfTabBody");
  if (!host) return;
  host.innerHTML = `<div class="fpage-panel"><div class="empty">Loading blueprints…</div></div>`;
  let rows = [];
  try {
    const snap = await db.collection("blueprints").where("orgId", "==", WF_ORG).get();
    snap.forEach(d => rows.push({ docId: d.id, ...d.data() }));
  } catch (e) {
    console.error(e);
    host.innerHTML = `<div class="fpage-panel"><div class="empty">Couldn't load blueprints — check the connection and reopen this page.</div></div>`;
    return;
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  host.innerHTML = `
    <div class="fpage-bar">
      <p class="fpage-bar-note">${rows.length ? rows.length + " blueprint" + (rows.length === 1 ? "" : "s") : "Draw how work moves through the team; published blueprints carry real tasks."}</p>
      <div class="fpage-bar-acts">
        <button class="btn btn-go btn-sm" id="wfNew">New blueprint</button>
      </div>
    </div>
    <div id="wfList">
      ${rows.length ? rows.map(r => `
        <div class="wf-card">
          <button type="button" class="wf-card-main" data-open="${esc(r.docId)}">
            <p class="wf-card-name">${esc(r.name || "Untitled workflow")}</p>
            <p class="wf-card-meta">v${Number(r.version) || 1} · ${(r.nodes || []).length} block${(r.nodes || []).length === 1 ? "" : "s"} · ${r.updatedAt ? dayStamp(r.updatedAt) : ""}</p>
          </button>
          <span class="wf-status ${r.status === "published" ? "is-published" : "is-draft"}">${r.status === "published" ? "Published" : "Draft"}</span>
          ${r.status === "published" ? `<button type="button" class="btn btn-sm wf-run-btn" data-run="${esc(r.docId)}">Start run</button>` : ""}
        </div>`).join("")
      : `<div class="fpage-panel"><div class="empty">No blueprints yet. Start one and drag the six blocks into a track.</div></div>`}
    </div>`;
  $("wfNew").onclick = () => wfNewBlueprintSheet();
  host.querySelectorAll("[data-open]").forEach(c => c.onclick = () => {
    const r = rows.find(x => x.docId === c.dataset.open);
    if (r) wfOpenBuilder(r);
  });
  host.querySelectorAll("[data-run]").forEach(c => c.onclick = () => {
    const r = rows.find(x => x.docId === c.dataset.run);
    if (r) wfStartRunSheet(r);
  });
}

/* ============================================================
   BUILDER
   ============================================================ */
function wfOpenBuilder(bpDoc){
  wfView = "builder";
  wfNodes = new Map(); wfDf2Our = new Map(); wfOur2Df = new Map();
  wfErrList = []; wfIsDirty = false;
  wfCurrent = bpDoc
    ? { docId: bpDoc.docId, name: bpDoc.name || "Untitled workflow", version: Number(bpDoc.version) || 1, status: bpDoc.status || "draft", createdAt: bpDoc.createdAt || null,
        // pre-history blueprints have no counter: a live published doc IS
        // its own latest published version; a draft has published nothing
        lastPublishedVersion: bpDoc.lastPublishedVersion !== undefined ? bpDoc.lastPublishedVersion
          : (bpDoc.status === "published" ? Number(bpDoc.version) || 1 : 0) }
    : { docId: null, name: "Untitled workflow", version: 1, status: "draft", createdAt: null, lastPublishedVersion: 0 };

  // sign-out must dismantle the canvas: the next admin on this device
  // should never land in the previous session's half-edited blueprint
  if (!wfCleanupArmed && typeof onSessionEnd === "function"){
    onSessionEnd(() => { wfResetAll(); wfCleanupArmed = false; });
    wfCleanupArmed = true;
  }

  const box = $("workflowBody");
  box.innerHTML = `
    <div class="fpage-bar">
      <button class="btn btn-ghost btn-sm" id="wfBack">All blueprints</button>
      <div class="wf-bar-name"><input type="text" id="wfName" maxlength="80" value="${esc(wfCurrent.name)}" aria-label="Blueprint name"></div>
      <span class="wf-status ${wfCurrent.status === "published" ? "is-published" : "is-draft"}" id="wfStatusChip">${wfCurrent.status === "published" ? "Published" : "Draft"}</span>
      <div class="fpage-bar-acts">
        <button class="btn btn-ghost btn-sm" id="wfHistory">History</button>
        <button class="btn btn-sm" id="wfSave">Save draft</button>
        <button class="btn btn-go btn-sm" id="wfPublish">Publish</button>
      </div>
    </div>
    <div id="wfErrBar"></div>
    <div class="wf-palette" id="wfPalette">
      ${Object.keys(WF_TYPES).map(t => `
        <button type="button" class="wf-pal" data-type="${t}" draggable="true" title="Drag onto the canvas, or tap to add">
          <span class="wf-pal-dot"></span>${WF_TYPES[t].pal}
        </button>`).join("")}
    </div>
    <div class="wf-canvas-wrap" id="wfCanvasWrap">
      <div id="wfCanvas" tabindex="0"></div>
      <div class="wf-canvas-hint hidden" id="wfHint">Drag blocks up here and draw lines from a block's bottom port<br>to the next block's top port. Downward = forward.</div>
      <div class="wf-zoom">
        <button type="button" id="wfZoomOut" aria-label="Zoom out">−</button>
        <button type="button" id="wfZoomReset" aria-label="Reset zoom">◦</button>
        <button type="button" id="wfZoomIn" aria-label="Zoom in">+</button>
      </div>
    </div>`;

  wfEditor = new Drawflow($("wfCanvas"));
  wfEditor.reroute = false;
  wfEditor.zoom_max = 1.6;
  wfEditor.zoom_min = 0.4;
  wfEditor.start();

  let backArmed = false;
  $("wfBack").onclick = () => {
    if (wfIsDirty && !backArmed){
      backArmed = true;
      toast("Unsaved changes — tap again to leave without saving");
      setTimeout(() => { backArmed = false; }, 2600);
      return;
    }
    wfRenderList();
  };
  $("wfName").oninput = e => { wfCurrent.name = e.target.value; wfMarkDirty(); };
  $("wfSave").onclick = () => wfSaveDraft();
  $("wfPublish").onclick = () => wfPublish();
  $("wfHistory").onclick = () => wfVersionHistorySheet();
  $("wfZoomIn").onclick = () => wfEditor.zoom_in();
  $("wfZoomOut").onclick = () => wfEditor.zoom_out();
  $("wfZoomReset").onclick = () => wfEditor.zoom_reset();
  // the canvas takes focus on press so Drawflow's own Delete-key handling
  // (selected node or wire) actually receives the key
  $("wfCanvas").addEventListener("mousedown", () => $("wfCanvas").focus());

  // palette: drag onto the canvas (desktop) or tap to drop at center (touch)
  const palette = $("wfPalette");
  palette.querySelectorAll(".wf-pal").forEach(p => {
    p.addEventListener("dragstart", ev => ev.dataTransfer.setData("text/plain", p.dataset.type));
    p.onclick = () => {
      const wrap = $("wfCanvasWrap").getBoundingClientRect();
      wfAddBlockAtClient(p.dataset.type, wrap.x + wrap.width / 2, wrap.y + wrap.height / 2.6);
    };
  });
  const wrap = $("wfCanvasWrap");
  wrap.addEventListener("dragover", ev => ev.preventDefault());
  wrap.addEventListener("drop", ev => {
    ev.preventDefault();
    const type = ev.dataTransfer.getData("text/plain");
    if (WF_TYPES[type]) wfAddBlockAtClient(type, ev.clientX, ev.clientY);
  });

  // graph mutations: mark dirty, clear stale validation marks, keep the
  // waitFor badge honest on whichever node gained/lost an incoming line
  wfEditor.on("connectionCreated", info => {
    wfMarkDirty(); wfClearErrors();
    const oid = wfDf2Our.get(String(info.input_id));
    if (oid) wfRefreshNode(oid);
  });
  wfEditor.on("connectionRemoved", info => {
    wfMarkDirty(); wfClearErrors();
    const oid = wfDf2Our.get(String(info.input_id));
    if (oid) wfRefreshNode(oid);
  });
  wfEditor.on("nodeRemoved", dfId => {
    const oid = wfDf2Our.get(String(dfId));
    if (oid){ wfNodes.delete(oid); wfOur2Df.delete(oid); wfDf2Our.delete(String(dfId)); }
    wfMarkDirty(); wfClearErrors(); wfSyncPalette(); wfSyncHint();
  });
  wfEditor.on("nodeMoved", () => wfMarkDirty());

  if (bpDoc && (bpDoc.nodes || []).length){
    wfLoadIntoEditor(bpDoc);
  } else {
    // every track starts somewhere: seed the one allowed Trigger
    wfAddBlock("trigger", 120, 40);
    wfIsDirty = false; wfSyncSaveBtn();
  }
  wfSyncPalette();
  wfSyncHint();
}

function wfMarkDirty(){ wfIsDirty = true; wfSyncSaveBtn(); }
function wfSyncSaveBtn(){
  const b = $("wfSave");
  if (b) b.textContent = wfIsDirty ? "Save draft ·" : "Save draft";
}
function wfSyncHint(){
  const h = $("wfHint");
  if (h) h.classList.toggle("hidden", wfNodes.size > 0);
}
function wfSyncPalette(){
  const trig = document.querySelector('.wf-pal[data-type="trigger"]');
  if (!trig) return;
  const hasTrigger = [...wfNodes.values()].some(r => r.type === "trigger");
  trig.disabled = hasTrigger;
  trig.title = hasTrigger ? "Every workflow has exactly one Trigger" : "Drag onto the canvas, or tap to add";
}

/* ---------- adding blocks ---------- */
function wfDefaultConfig(type){
  if (type === "trigger") return { label: "Start" };
  if (type === "role") return { label: "", role: "", assigneeId: null, assignmentType: "role",
    outputs: [], requiresOutput: true, instructions: "", dueAfter: null };
  if (type === "split") return { mode: "route", branches: [
    { id: wfId("b"), label: "Branch 1", condition: null },
    { id: wfId("b"), label: "Else", isElse: true }
  ] };
  if (type === "logic") return { condition: null };
  if (type === "vault") return { vaultName: "", storeWhat: "", visibility: "team" };
  if (type === "action") return { actionType: "notify", params: {} };
  return {};
}

function wfAddBlockAtClient(type, clientX, clientY){
  // client px → canvas coordinates, through Drawflow's own pan+zoom
  const pre = wfEditor.precanvas.getBoundingClientRect();
  const x = (clientX - pre.x) / wfEditor.zoom;
  const y = (clientY - pre.y) / wfEditor.zoom;
  wfAddBlock(type, Math.round(x), Math.round(y));
}

function wfAddBlock(type, x, y){
  if (type === "trigger" && [...wfNodes.values()].some(r => r.type === "trigger")){
    toast("Every workflow has exactly one Trigger");
    return;
  }
  const oid = wfId("n");
  wfNodes.set(oid, { type, config: wfDefaultConfig(type), waitFor: null });
  wfAddDfNode(oid, x, y);
  wfMarkDirty(); wfClearErrors(); wfSyncPalette(); wfSyncHint();
}

function wfAddDfNode(oid, x, y){
  const rec = wfNodes.get(oid);
  const nIn = rec.type === "trigger" ? 0 : 1;
  const nOut = rec.type === "split" ? rec.config.branches.length : rec.type === "logic" ? 2 : 1;
  const dfId = wfEditor.addNode("wf_" + rec.type, nIn, nOut, x, y,
    "wf-node wf-" + rec.type, { oid }, wfNodeHTML(oid), false);
  wfDf2Our.set(String(dfId), oid);
  wfOur2Df.set(oid, dfId);
  wfWireNodeButtons(oid);
}

/* ---------- the block's face ---------- */
function wfIncomingCount(oid){
  const dfId = wfOur2Df.get(oid);
  if (dfId === undefined || !wfEditor) return 0;
  const dn = wfEditor.getNodeFromId(dfId);
  if (!dn || !dn.inputs || !dn.inputs.input_1) return 0;
  return (dn.inputs.input_1.connections || []).length;
}

function wfCondText(cond){
  if (!cond) return "no rule yet";
  const opTxt = cond.op === "==" ? "is" : cond.op === "!=" ? "isn't" : cond.op;
  const val = typeof cond.value === "boolean" ? (cond.value ? "yes" : "no") : cond.value;
  if (cond.source === "task") return "task · " + cond.path + " " + opTxt + " " + val;
  const src = wfNodes.get(cond.nodeId);
  const who = src ? (src.config.label || src.config.vaultName || WF_TYPES[src.type].name) : "a removed block";
  return who + " · " + cond.path + " " + opTxt + " " + val;
}

function wfNodeSummary(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  if (rec.type === "trigger") return "Work enters here";
  if (rec.type === "role"){
    const who = c.assignmentType === "person"
      ? (wfDirName(c.assigneeId) || "pick a person")
      : (c.role ? "any " + c.role : "pick a role");
    const outs = (c.outputs || []).length ? " · records " + c.outputs.map(o => o.key).join(", ") : "";
    return who + outs;
  }
  if (rec.type === "split") return (c.mode === "parallel" ? "All branches at once" : "One branch by rule")
    + " · " + c.branches.length + " out";
  if (rec.type === "logic") return wfCondText(c.condition);
  if (rec.type === "vault") return c.storeWhat ? "Stores " + c.storeWhat : "Storage checkpoint";
  if (rec.type === "action"){
    const a = WF_ACTION_TYPES.find(t => t.v === c.actionType);
    return a ? a.label : "pick an action";
  }
  return "";
}

function wfNodeTitle(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  return c.label || c.vaultName || (rec.type === "action" && c.actionType ? (WF_ACTION_TYPES.find(t => t.v === c.actionType) || {}).label : "") || WF_TYPES[rec.type].name;
}

function wfNodeHTML(oid){
  const rec = wfNodes.get(oid);
  const inc = wfIncomingCount(oid);
  let outLabels = "";
  if (rec.type === "split")
    outLabels = `<div class="wf-outlabels">${rec.config.branches.map(b =>
      `<span title="${esc(b.label || b.id)}">${esc(b.isElse ? "else" : (b.label || "·"))}</span>`).join("")}</div>`;
  if (rec.type === "logic")
    outLabels = `<div class="wf-outlabels"><span>Yes</span><span>No</span></div>`;
  return `
    <div class="wf-blk">
      <div class="wf-blk-head">
        <span class="wf-blk-dot"></span>
        <span class="wf-blk-type">${WF_TYPES[rec.type].name}</span>
        <button type="button" class="wf-blk-gear" title="Configure" aria-label="Configure block">${WF_GEAR_SVG}</button>
        <button type="button" class="wf-blk-x" title="Delete" aria-label="Delete block">${WF_X_SVG}</button>
      </div>
      <div class="wf-blk-title">${esc(wfNodeTitle(oid))}</div>
      <div class="wf-blk-sub">${esc(wfNodeSummary(oid))}</div>
      ${inc >= 2 ? `<span class="wf-blk-wait">${(wfNodes.get(oid).waitFor === "any") ? "first arrival wins" : "waits for all"}</span>` : ""}
      ${outLabels}
    </div>`;
}

function wfWireNodeButtons(oid){
  const dfId = wfOur2Df.get(oid);
  const el = document.getElementById("node-" + dfId);
  if (!el) return;
  const stop = ev => ev.stopPropagation();   // buttons must not start a node drag
  el.querySelectorAll(".wf-blk-gear, .wf-blk-x").forEach(b => {
    b.addEventListener("mousedown", stop);
    b.addEventListener("touchstart", stop, { passive: true });
  });
  const gear = el.querySelector(".wf-blk-gear");
  const x = el.querySelector(".wf-blk-x");
  if (gear) gear.onclick = () => wfOpenConfig(oid);
  if (x) x.onclick = () => wfEditor.removeNodeId("node-" + dfId);
}

function wfRefreshNode(oid){
  const dfId = wfOur2Df.get(oid);
  const el = document.getElementById("node-" + dfId);
  if (!el) return;
  el.querySelector(".drawflow_content_node").innerHTML = wfNodeHTML(oid);
  wfWireNodeButtons(oid);
  wfEditor.updateConnectionNodes("node-" + dfId);
}

/* ============================================================
   OUR SCHEMA ⇄ THE CANVAS
   (Drawflow's export is never persisted - it is only read here,
   joined with the sidecar map, and written out as a Blueprint.)
   ============================================================ */
function wfHandleFor(rec, outCls){
  const idx = Number(outCls.split("_")[1]) - 1;
  if (rec.type === "split") return (rec.config.branches[idx] || {}).id || null;
  if (rec.type === "logic") return idx === 0 ? "true" : "false";
  return null;
}

function wfSerializeGraph(){
  const data = wfEditor.export().drawflow.Home.data;
  const nodes = [], edges = [];
  Object.keys(data).forEach(k => {
    const dn = data[k];
    const oid = dn.data.oid;
    const rec = wfNodes.get(oid);
    if (!rec) return;
    const node = { id: oid, type: rec.type,
      position: { x: Math.round(dn.pos_x), y: Math.round(dn.pos_y) },
      config: wfClone2(rec.config) };
    if (rec.waitFor === "any") node.waitFor = "any";
    nodes.push(node);
    Object.keys(dn.outputs || {}).forEach(outCls => {
      ((dn.outputs[outCls] || {}).connections || []).forEach(c => {
        const toDn = data[c.node];
        if (!toDn) return;
        const toOid = toDn.data.oid;
        const handle = wfHandleFor(rec, outCls);
        const edge = { id: oid + "~" + (handle || "out") + "~" + toOid, from: oid, to: toOid };
        if (handle) edge.fromHandle = handle;
        edges.push(edge);
      });
    });
  });
  return { nodes, edges };
}

function wfBlueprintObj(status, version){
  const g = wfSerializeGraph();
  const now = Date.now();
  return {
    orgId: WF_ORG,
    ownerId: (auth.currentUser && auth.currentUser.uid) || "",
    name: (wfCurrent.name || "Untitled workflow").trim() || "Untitled workflow",
    version: version,
    status: status,
    nodes: g.nodes,
    edges: g.edges,
    createdAt: wfCurrent.createdAt || now,
    updatedAt: now
  };
}

function wfLoadIntoEditor(bp){
  (bp.nodes || []).forEach(n => {
    wfNodes.set(n.id, { type: n.type, config: wfClone2(n.config || {}), waitFor: n.waitFor || null });
    wfAddDfNode(n.id, (n.position || {}).x || 60, (n.position || {}).y || 60);
  });
  (bp.edges || []).forEach(e => {
    const fromDf = wfOur2Df.get(e.from), toDf = wfOur2Df.get(e.to);
    if (fromDf === undefined || toDf === undefined) return;
    const rec = wfNodes.get(e.from);
    let outCls = "output_1";
    if (rec.type === "split"){
      const i = rec.config.branches.findIndex(b => b.id === e.fromHandle);
      outCls = "output_" + (i >= 0 ? i + 1 : 1);
    } else if (rec.type === "logic"){
      outCls = e.fromHandle === "false" ? "output_2" : "output_1";
    }
    try { wfEditor.addConnection(fromDf, toDf, outCls, "input_1"); } catch (err) { console.error(err); }
  });
  // now that lines exist, the waitFor badges know what they're looking at
  wfNodes.forEach((rec, oid) => wfRefreshNode(oid));
  wfIsDirty = false; wfSyncSaveBtn();
}

/* ============================================================
   SAVE + PUBLISH
   ============================================================ */
async function wfSaveDraft(){
  // saving an edit always lands as a draft - a published blueprint's
  // content never changes silently underneath its name; publish is the
  // only door back to "published" and it re-validates on the way
  const btn = $("wfSave");
  btn.disabled = true;
  try {
    const docData = wfBlueprintObj("draft", wfCurrent.version);
    docData.lastPublishedVersion = wfCurrent.lastPublishedVersion || 0;
    if (!wfCurrent.docId) wfCurrent.docId = db.collection("blueprints").doc().id;
    await db.collection("blueprints").doc(wfCurrent.docId).set(docData);
    wfCurrent.createdAt = docData.createdAt;
    wfCurrent.status = "draft";
    wfIsDirty = false; wfSyncSaveBtn(); wfSyncStatusChip();
    toast("Draft saved");
  } catch (e) {
    console.error(e);
    toast("Save failed — check the connection");
  }
  btn.disabled = false;
}

/* The whole publish, decided as data before anything is written - pure,
   so tests can hold every branch of the versioning story to account.
   Returns {errs} when the wfValidate gate fails (nothing may be written),
   else { newVer, main, versionWrites }. Version history never matters to
   runs in flight: a run executes its own frozen blueprintSnapshot and
   reads neither the live blueprint nor this subcollection. */
function wfPublishPlan(fetched, docData){
  const errs = wfValidate(Object.assign({ id: "publish-probe" }, docData));
  if (errs.length) return { errs };
  const lastPub = fetched && fetched.lastPublishedVersion !== undefined
    ? Number(fetched.lastPublishedVersion) || 0
    : (fetched && fetched.status === "published" ? Number(fetched.version) || 1 : 0);
  const newVer = lastPub + 1;
  const versionWrites = [];
  // belt-and-braces for blueprints published before version history
  // existed: their live published content has no copy in versions/ yet,
  // so preserve the OUTGOING version before it is overwritten. Publishes
  // made after this feature already recorded their own copy (see below),
  // which onlyIfMissing leaves untouched - past versions never mutate.
  if (fetched && fetched.status === "published"){
    const outVer = Number(fetched.version) || 1;
    versionWrites.push({ id: String(outVer), onlyIfMissing: true, data: {
      version: outVer, name: fetched.name || "", nodes: fetched.nodes || [], edges: fetched.edges || [],
      publishedAt: fetched.updatedAt || 0, publishedBy: fetched.ownerId || "" } });
  }
  // every publish records itself: v1 on the first publish, vN forever after
  versionWrites.push({ id: String(newVer), data: {
    version: newVer, name: docData.name, nodes: docData.nodes, edges: docData.edges,
    publishedAt: docData.updatedAt, publishedBy: docData.ownerId } });
  return { errs: [], newVer, versionWrites,
    main: Object.assign({}, docData, { version: newVer, status: "published", lastPublishedVersion: newVer }) };
}

async function wfPublish(){
  const probe = wfBlueprintObj("published", wfCurrent.version);
  let fetched = null;
  if (wfCurrent.docId){
    // the OUTGOING content lives in Firestore, not on this canvas - fetch
    // it so the plan can preserve what's about to be overwritten
    try {
      const s = await db.collection("blueprints").doc(wfCurrent.docId).get();
      if (s.exists) fetched = s.data();
    } catch (e) {
      console.error(e);
      toast("Publish failed — check the connection");
      return;
    }
  }
  const plan = wfPublishPlan(fetched, probe);
  if (plan.errs.length){
    wfMarkErrors(plan.errs);
    toast(plan.errs.length === 1 ? "One thing to fix before publishing" : plan.errs.length + " things to fix before publishing");
    return;
  }
  const btn = $("wfPublish");
  btn.disabled = true;
  try {
    if (!wfCurrent.docId) wfCurrent.docId = db.collection("blueprints").doc().id;
    const ref = db.collection("blueprints").doc(wfCurrent.docId);
    const batch = db.batch();
    for (const vw of plan.versionWrites){
      const vRef = ref.collection("versions").doc(vw.id);
      if (vw.onlyIfMissing && (await vRef.get()).exists) continue;
      batch.set(vRef, vw.data);
    }
    batch.set(ref, plan.main);
    await batch.commit();
    wfCurrent.createdAt = plan.main.createdAt;
    wfCurrent.status = "published";
    wfCurrent.version = plan.newVer;
    wfCurrent.lastPublishedVersion = plan.newVer;
    wfIsDirty = false; wfSyncSaveBtn(); wfSyncStatusChip();
    toast("Published · v" + plan.newVer);
  } catch (e) {
    console.error(e);
    toast("Publish failed — check the connection");
  }
  btn.disabled = false;
}

/* ============================================================
   VERSION HISTORY — every publish preserved immutably under
   blueprints/{id}/versions/{n}. Viewing is read-only; restore
   only SEEDS a new draft from a past version's nodes/edges.
   In-flight runs stay untouched throughout: they read their own
   blueprintSnapshot, never the live blueprint or this history.
   ============================================================ */
async function wfVersionHistorySheet(){
  if (!wfCurrent || !wfCurrent.docId){
    toast("History starts at the first publish");
    return;
  }
  let rows = [];
  try {
    const snap = await db.collection("blueprints").doc(wfCurrent.docId).collection("versions").get();
    snap.forEach(d => rows.push(d.data()));
  } catch (e) {
    console.error(e);
    toast("Couldn't load history");
    return;
  }
  rows.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
  await wfLoadDirectory();
  openSheet(`
    <h2>Version history</h2>
    <p class="hint">Every publish is preserved here, immutably. Runs in flight never read these — each run carries its own frozen copy of the track.</p>
    ${rows.length ? rows.map(v => `
      <button type="button" class="wf-card" data-v="${Number(v.version) || 0}">
        <span class="wf-card-main">
          <p class="wf-card-name">v${Number(v.version) || 0}${Number(v.version) === wfCurrent.lastPublishedVersion ? " · current" : ""}</p>
          <p class="wf-card-meta">${esc(v.name || "")} · ${v.publishedAt ? dayStamp(v.publishedAt) + " " + clock(v.publishedAt) : "—"} · by ${esc(wfDirName(v.publishedBy) || "admin")}</p>
        </span>
      </button>`).join("")
    : `<p class="hint">No published versions yet — the first publish records v1.</p>`}
  `, () => {
    $("sheetBody").querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
      const v = rows.find(x => (Number(x.version) || 0) === Number(b.dataset.v));
      if (v) wfVersionViewSheet(v);
    });
  });
}

function wfVersionViewSheet(v){
  const nodes = v.nodes || [], edges = v.edges || [];
  const nameOf = id => {
    const n = nodes.find(x => x.id === id);
    if (!n) return id;
    const c = n.config || {};
    return c.label || c.vaultName || (WF_TYPES[n.type] ? WF_TYPES[n.type].name : n.type);
  };
  openSheet(`
    <h2>v${Number(v.version) || 0} · read-only</h2>
    <p class="hint">${esc(v.name || "")}${v.publishedAt ? " · published " + dayStamp(v.publishedAt) + " " + clock(v.publishedAt) : ""}. Looking, not touching — restore to edit a copy.</p>
    <p class="fpage-section-title">Blocks (${nodes.length})</p>
    <div class="wf-vv">
      ${nodes.map(n => `
        <div class="wf-vv-row">
          <span class="wf-vv-dot wf-${esc(n.type)}"></span>
          <span class="wf-vv-name">${esc(nameOf(n.id))}</span>
          <small>${esc(WF_TYPES[n.type] ? WF_TYPES[n.type].name : n.type)}</small>
        </div>`).join("")}
    </div>
    <p class="fpage-section-title">Lines (${edges.length})</p>
    <div class="wf-vv">
      ${edges.map(e => `
        <div class="wf-vv-row is-edge">
          <span class="wf-vv-name">${esc(nameOf(e.from))} → ${esc(nameOf(e.to))}${e.fromHandle ? ` <small>via ${esc(e.fromHandle)}</small>` : ""}</span>
        </div>`).join("")}
    </div>
    <button class="btn btn-go" id="wfvRestore">Restore this version as a new draft</button>
    <button class="btn btn-ghost btn-sm" id="wfvBack" style="margin-top:10px">Back to history</button>
  `, () => {
    $("wfvBack").onclick = () => wfVersionHistorySheet();
    $("wfvRestore").onclick = () => {
      closeSheet();
      wfOpenBuilder(wfRestoreDraftDoc(wfCurrent, v));
      wfMarkDirty();
      toast("v" + (Number(v.version) || 0) + " loaded as a fresh draft — publishing makes it v" + ((wfCurrent.lastPublishedVersion || 0) + 1));
    };
  });
}

/* restore never mutates the past: DEEP COPIES of the version's nodes and
   edges seed a draft on the SAME blueprint id; the publish counter rides
   along untouched, so the next publish becomes the next version */
function wfRestoreDraftDoc(current, v){
  return { docId: current.docId, name: current.name, version: current.version,
    status: "draft", createdAt: current.createdAt,
    lastPublishedVersion: current.lastPublishedVersion,
    nodes: wfClone2(v.nodes || []), edges: wfClone2(v.edges || []) };
}

function wfSyncStatusChip(){
  const chip = $("wfStatusChip");
  if (!chip) return;
  const pub = wfCurrent.status === "published";
  chip.className = "wf-status " + (pub ? "is-published" : "is-draft");
  chip.textContent = pub ? "Published" : "Draft";
}

/* ---------- validation marks (straight from wfValidate, never re-derived) ---------- */
function wfMarkErrors(errs){
  wfClearErrors();
  wfErrList = errs;
  const bar = $("wfErrBar");
  if (bar){
    bar.innerHTML = `<div class="wf-errbar">${errs.map(e => {
      const rec = e.nodeId ? wfNodes.get(e.nodeId) : null;
      const who = rec ? `<b>${esc(wfNodeTitle(e.nodeId))}</b> — ` : "";
      return `<p>${who}${esc(e.msg)}</p>`;
    }).join("")}</div>`;
  }
  errs.forEach(e => {
    if (e.nodeId && wfOur2Df.has(e.nodeId)){
      const el = document.getElementById("node-" + wfOur2Df.get(e.nodeId));
      if (!el) return;
      el.classList.add("wf-err");
      // one message inline on the block itself; the rest stay in the bar
      if (!el.querySelector(".wf-blk-errmsg")){
        const m = document.createElement("div");
        m.className = "wf-blk-errmsg";
        m.textContent = e.msg;
        el.querySelector(".wf-blk").appendChild(m);
        wfEditor.updateConnectionNodes("node-" + wfOur2Df.get(e.nodeId));
      }
    }
    if (e.edgeId){
      const [from, handle, to] = String(e.edgeId).split("~");
      const rec = wfNodes.get(from);
      const fromDf = wfOur2Df.get(from), toDf = wfOur2Df.get(to);
      if (!rec || fromDf === undefined || toDf === undefined) return;
      let outCls = "output_1";
      if (rec.type === "split"){
        const i = rec.config.branches.findIndex(b => b.id === handle);
        if (i >= 0) outCls = "output_" + (i + 1);
      } else if (rec.type === "logic"){
        outCls = handle === "false" ? "output_2" : "output_1";
      }
      const svg = document.querySelector(`.connection.node_out_node-${fromDf}.node_in_node-${toDf}.${outCls}`);
      if (svg) svg.classList.add("wf-err-edge");
    }
  });
}

function wfClearErrors(){
  if (!wfErrList.length) return;
  wfErrList = [];
  const bar = $("wfErrBar");
  if (bar) bar.innerHTML = "";
  document.querySelectorAll(".drawflow-node.wf-err").forEach(el => el.classList.remove("wf-err"));
  document.querySelectorAll(".wf-blk-errmsg").forEach(el => el.remove());
  document.querySelectorAll(".connection.wf-err-edge").forEach(el => el.classList.remove("wf-err-edge"));
}

/* ============================================================
   CONFIG SHEETS — each writes exactly the config shape the
   engine consumes (see the typedefs in workflow-engine.js).
   ============================================================ */
function wfDirName(uid){
  if (!uid || !wfDirCache) return "";
  const p = wfDirCache.find(d => d.uid === uid);
  return p ? p.name : "";
}
async function wfLoadDirectory(){
  if (wfDirCache) return wfDirCache;
  wfDirCache = [];
  try {
    const snap = await db.collection("directory").get();
    snap.forEach(d => {
      const v = d.data();
      if (v.name) wfDirCache.push({ uid: d.id, name: v.name, craft: v.craft || "" });
    });
    wfDirCache.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { console.error(e); }
  return wfDirCache;
}

/* upstream blocks whose recorded values a rule may read - computed from
   the live canvas, so the picker can only ever offer declared outputs
   (the publish invariant is unauthorable-by-construction here) */
function wfUpstreamDeclaring(oid){
  const g = wfSerializeGraph();
  const back = new Map();
  g.edges.forEach(e => {
    if (!back.has(e.to)) back.set(e.to, []);
    back.get(e.to).push(e.from);
  });
  const seen = new Set(), q = [...(back.get(oid) || [])];
  while (q.length){
    const n = q.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    (back.get(n) || []).forEach(p => { if (!seen.has(p)) q.push(p); });
  }
  const out = [];
  seen.forEach(id => {
    const rec = wfNodes.get(id);
    if (!rec) return;
    const keys = wfDeclaredKeys(rec);
    if (keys.length) out.push({ oid: id, title: wfNodeTitle(id), type: rec.type, keys });
  });
  return out;
}
function wfDeclaredKeys(rec){
  if (rec.type === "role") return (rec.config.outputs || []).map(o => ({ key: o.key, vtype: o.type || "text" }));
  if (rec.type === "logic") return [{ key: "result", vtype: "boolean" }];
  if (rec.type === "split" && (rec.config.mode || "route") === "route") return [{ key: "pickedBranch", vtype: "text" }];
  return [];
}

/* ---------- the condition editor (LOGIC + route branches share it) ---------- */
const WF_OPS = {
  boolean: [["==", "is"], ["!=", "isn't"]],
  number:  [["==", "="], ["!=", "≠"], [">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"]],
  text:    [["==", "is"], ["!=", "isn't"], ["contains", "contains"]]
};

function wfCondDraft(cond){
  if (!cond) return { source: "task", nodeId: null, path: "", op: "==", value: "", vtype: "text" };
  return { source: cond.source, nodeId: cond.nodeId || null, path: cond.path || "", op: cond.op || "==",
    value: cond.value, vtype: typeof cond.value === "boolean" ? "boolean" : typeof cond.value === "number" ? "number" : "text" };
}

function wfCondRender(host, draft, upstream){
  const nodeOpts = upstream.map(u =>
    `<option value="${esc(u.oid)}" ${draft.nodeId === u.oid ? "selected" : ""}>${esc(u.title)} (${WF_TYPES[u.type].name})</option>`).join("");
  const picked = upstream.find(u => u.oid === draft.nodeId);
  const keyOpts = picked ? picked.keys.map(k =>
    `<option value="${esc(k.key)}" ${draft.path === k.key ? "selected" : ""}>${esc(k.key)}</option>`).join("") : "";
  const vtype = draft.source === "nodeOutput"
    ? ((picked && (picked.keys.find(k => k.key === draft.path) || {}).vtype) || "text")
    : draft.vtype;
  const ops = WF_OPS[vtype] || WF_OPS.text;
  if (!ops.some(o => o[0] === draft.op)) draft.op = ops[0][0];
  const valueCtl = vtype === "boolean"
    ? `<select data-wfc="value">
         <option value="true" ${draft.value === true ? "selected" : ""}>yes</option>
         <option value="false" ${draft.value === false ? "selected" : ""}>no</option>
       </select>`
    : vtype === "number"
      ? `<input type="number" data-wfc="value" value="${draft.value === undefined || draft.value === "" ? "" : esc(String(draft.value))}" placeholder="0">`
      : `<input type="text" data-wfc="value" value="${draft.value === undefined ? "" : esc(String(draft.value))}" placeholder="value">`;

  host.innerHTML = `
    <label class="fld"><span>The rule reads</span>
      <select data-wfc="source">
        <option value="task" ${draft.source === "task" ? "selected" : ""}>A task field</option>
        <option value="nodeOutput" ${draft.source === "nodeOutput" ? "selected" : ""} ${upstream.length ? "" : "disabled"}>An earlier block's recorded value${upstream.length ? "" : " (none upstream yet)"}</option>
      </select>
    </label>
    ${draft.source === "nodeOutput" ? `
      <div class="wf-cond-grid">
        <label class="fld"><span>Block</span>
          <select data-wfc="node"><option value="">Pick a block…</option>${nodeOpts}</select>
        </label>
        <label class="fld"><span>Value</span>
          <select data-wfc="key" ${picked ? "" : "disabled"}><option value="">…</option>${keyOpts}</select>
        </label>
      </div>` : `
      <div class="wf-cond-grid">
        <label class="fld"><span>Field name</span>
          <input type="text" data-wfc="path" value="${esc(draft.path)}" placeholder="e.g. lane, priority">
        </label>
        <label class="fld"><span>Type</span>
          <select data-wfc="vtype">
            <option value="text" ${vtype === "text" ? "selected" : ""}>text</option>
            <option value="number" ${vtype === "number" ? "selected" : ""}>number</option>
            <option value="boolean" ${vtype === "boolean" ? "selected" : ""}>yes / no</option>
          </select>
        </label>
      </div>`}
    <div class="wf-cond-grid">
      <label class="fld"><span>Compare</span>
        <select data-wfc="op">${ops.map(o => `<option value="${o[0]}" ${draft.op === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")}</select>
      </label>
      <label class="fld"><span>Against</span>${valueCtl}</label>
    </div>`;

  const re = () => wfCondRender(host, draft, upstream);
  host.querySelector('[data-wfc="source"]').onchange = e => { draft.source = e.target.value; re(); };
  const nodeSel = host.querySelector('[data-wfc="node"]');
  if (nodeSel) nodeSel.onchange = e => { draft.nodeId = e.target.value || null; draft.path = ""; re(); };
  const keySel = host.querySelector('[data-wfc="key"]');
  if (keySel) keySel.onchange = e => { draft.path = e.target.value; draft.value = ""; re(); };
  const pathIn = host.querySelector('[data-wfc="path"]');
  if (pathIn) pathIn.oninput = e => { draft.path = e.target.value; };
  const vtypeSel = host.querySelector('[data-wfc="vtype"]');
  if (vtypeSel) vtypeSel.onchange = e => { draft.vtype = e.target.value; draft.value = ""; re(); };
  host.querySelector('[data-wfc="op"]').onchange = e => { draft.op = e.target.value; };
  const valCtl = host.querySelector('[data-wfc="value"]');
  valCtl.onchange = valCtl.oninput = e => { draft.value = e.target.value; };
}

/* draft → the engine's Condition shape (typed value), or null if unfinished */
function wfCondFromDraft(draft, upstream){
  if (!draft.path) return null;
  let vtype = draft.vtype;
  if (draft.source === "nodeOutput"){
    if (!draft.nodeId) return null;
    const picked = upstream.find(u => u.oid === draft.nodeId);
    vtype = (picked && (picked.keys.find(k => k.key === draft.path) || {}).vtype) || "text";
  }
  let value = draft.value;
  if (vtype === "boolean") value = value === true || value === "true";
  else if (vtype === "number"){
    if (value === "" || value === undefined || value === null) return null;
    value = Number(value);
    if (Number.isNaN(value)) return null;
  } else {
    value = String(value === undefined ? "" : value);
  }
  const cond = { source: draft.source, path: draft.path, op: draft.op, value };
  if (draft.source === "nodeOutput") cond.nodeId = draft.nodeId;
  return cond;
}

/* ---------- per-type sheets ---------- */
function wfOpenConfig(oid){
  const rec = wfNodes.get(oid);
  if (!rec) return;
  if (rec.type === "trigger") return wfSheetTrigger(oid);
  if (rec.type === "role") return wfSheetRole(oid);
  if (rec.type === "split") return wfSheetSplit(oid);
  if (rec.type === "logic") return wfSheetLogic(oid);
  if (rec.type === "vault") return wfSheetVault(oid);
  if (rec.type === "action") return wfSheetAction(oid);
}

function wfWaitForHTML(oid){
  if (wfIncomingCount(oid) < 2) return "";
  const rec = wfNodes.get(oid);
  return `
    <label class="fld"><span>Several lines come in — this block…</span></label>
    <div class="chips" id="wfcWait">
      <button type="button" class="chip" data-v="all" aria-pressed="${rec.waitFor !== "any"}">Waits for all paths</button>
      <button type="button" class="chip" data-v="any" aria-pressed="${rec.waitFor === "any"}">First arrival wins</button>
    </div>`;
}
function wfWaitForRead(oid){
  const box = $("wfcWait");
  if (!box) return;
  const picked = box.querySelector('.chip[aria-pressed="true"]');
  wfNodes.get(oid).waitFor = picked && picked.dataset.v === "any" ? "any" : null;
}
function wfWaitForWire(){
  const box = $("wfcWait");
  if (box) wireChipsIn(box, () => {});
}

function wfSheetSave(oid){
  wfMarkDirty(); wfClearErrors(); wfRefreshNode(oid);
  closeSheet();
}

function wfSheetTrigger(oid){
  const c = wfNodes.get(oid).config;
  openSheet(`
    <h2>Trigger</h2>
    <p class="hint">The one starting block. A task enters the track here when a run begins.</p>
    <label class="fld"><span>Label</span><input type="text" id="wfcLabel" maxlength="60" value="${esc(c.label || "")}"></label>
    <button class="btn btn-go" id="wfcSave">Done</button>
  `, () => {
    $("wfcSave").onclick = () => {
      c.label = $("wfcLabel").value.trim() || "Start";
      wfSheetSave(oid);
    };
  });
}

function wfSheetRole(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  const outputs = wfClone2(c.outputs || []);
  const draftState = { assignmentType: c.assignmentType || "role" };

  const renderOutputs = () => {
    const host = $("wfcOuts");
    host.innerHTML = outputs.map((o, i) => `
      <div class="wf-outrow" data-i="${i}">
        <input type="text" class="wf-okey" placeholder="key (e.g. approved)" maxlength="30" value="${esc(o.key || "")}">
        <span class="wf-otype chips" data-i="${i}">
          ${["boolean", "number", "text"].map(t => `<button type="button" class="chip" data-v="${t}" aria-pressed="${(o.type || "text") === t}">${t === "boolean" ? "yes/no" : t}</button>`).join("")}
        </span>
        <button type="button" class="wf-row-x" aria-label="Remove output">×</button>
      </div>`).join("");
    host.querySelectorAll(".wf-outrow").forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector(".wf-okey").oninput = e => { outputs[i].key = e.target.value.trim(); };
      wireChipsIn(row.querySelector(".wf-otype"), v => { outputs[i].type = v; });
      row.querySelector(".wf-row-x").onclick = () => { outputs.splice(i, 1); renderOutputs(); };
    });
  };

  wfLoadDirectory().then(dir => {
    const sel = $("wfcAssignee");
    if (!sel) return;
    sel.innerHTML = `<option value="">Pick a person…</option>` + dir.map(p =>
      `<option value="${esc(p.uid)}" ${c.assigneeId === p.uid ? "selected" : ""}>${esc(p.name)}${p.craft ? " · " + esc(p.craft) : ""}</option>`).join("");
  });

  openSheet(`
    <h2>Role</h2>
    <p class="hint">A human does work here — the task waits until they mark this stop complete.</p>
    <label class="fld"><span>Label</span><input type="text" id="wfcLabel" maxlength="60" value="${esc(c.label || "")}" placeholder="e.g. QA review"></label>
    <div class="chips" id="wfcAsgType">
      <button type="button" class="chip" data-v="role" aria-pressed="${draftState.assignmentType === "role"}">Anyone with a role</button>
      <button type="button" class="chip" data-v="person" aria-pressed="${draftState.assignmentType === "person"}">A specific person</button>
    </div>
    <label class="fld ${draftState.assignmentType === "person" ? "hidden" : ""}" id="wfcRoleFld"><span>Role name</span>
      <input type="text" id="wfcRole" maxlength="30" value="${esc(c.role || "")}" placeholder="e.g. designer, copywriter"></label>
    <label class="fld ${draftState.assignmentType === "person" ? "" : "hidden"}" id="wfcPersonFld"><span>Person</span>
      <select id="wfcAssignee"><option value="">Loading people…</option></select></label>
    <label class="fld"><span>Instructions</span><textarea id="wfcInstr" maxlength="600" placeholder="What should they do at this stop?">${esc(c.instructions || "")}</textarea></label>
    <label class="fld"><span>Due after (hours, optional)</span><input type="number" id="wfcDue" min="1" max="720" value="${c.dueAfter == null ? "" : esc(String(c.dueAfter))}" placeholder="e.g. 48"></label>
    <label class="fld"><span>This stop records (readable by later rules)</span></label>
    <div class="wf-rowlist" id="wfcOuts"></div>
    <button type="button" class="wf-addrow" id="wfcAddOut">+ Add a recorded value</button>
    <div class="chips" style="margin-top:14px" id="wfcReq">
      <button type="button" class="chip" data-v="yes" aria-pressed="${c.requiresOutput !== false}">Completion must record these</button>
      <button type="button" class="chip" data-v="no" aria-pressed="${c.requiresOutput === false}">Recording is optional</button>
    </div>
    ${wfWaitForHTML(oid)}
    <button class="btn btn-go" id="wfcSave">Done</button>
  `, () => {
    renderOutputs();
    wfWaitForWire();
    wireChipsIn($("wfcAsgType"), v => {
      draftState.assignmentType = v;
      $("wfcRoleFld").classList.toggle("hidden", v === "person");
      $("wfcPersonFld").classList.toggle("hidden", v !== "person");
    });
    wireChipsIn($("wfcReq"), () => {});
    $("wfcAddOut").onclick = () => { outputs.push({ key: "", type: "boolean" }); renderOutputs(); };
    $("wfcSave").onclick = () => {
      c.label = $("wfcLabel").value.trim();
      c.assignmentType = draftState.assignmentType;
      c.role = draftState.assignmentType === "role" ? $("wfcRole").value.trim() : "";
      c.assigneeId = draftState.assignmentType === "person" ? ($("wfcAssignee").value || null) : null;
      c.instructions = $("wfcInstr").value.trim();
      const due = $("wfcDue").value;
      c.dueAfter = due === "" ? null : Math.max(1, Number(due));
      c.outputs = outputs.filter(o => o.key);
      const reqPicked = $("wfcReq").querySelector('.chip[aria-pressed="true"]');
      c.requiresOutput = !reqPicked || reqPicked.dataset.v === "yes";
      wfWaitForRead(oid);
      wfSheetSave(oid);
    };
  });
}

function wfSheetSplit(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  const branches = wfClone2(c.branches || []);
  const upstream = wfUpstreamDeclaring(oid);
  let mode = c.mode || "route";
  const condDrafts = branches.map(b => wfCondDraft(b.condition));
  let openCond = -1;   // which branch's rule editor is expanded

  const renderBranches = () => {
    const host = $("wfcBranches");
    host.innerHTML = branches.map((b, i) => `
      <div>
        <div class="wf-brrow" data-i="${i}">
          <input type="text" maxlength="40" value="${esc(b.label || "")}" placeholder="Branch name">
          ${mode === "route" ? `
            <button type="button" class="wf-brrow-else" aria-pressed="${!!b.isElse}" title="The branch that catches everything unmatched">else</button>
            ${b.isElse ? "" : `<button type="button" class="wf-brrow-rule ${b.condition ? "has-rule" : ""}">${b.condition ? "rule ✓" : "rule…"}</button>`}` : ""}
          <button type="button" class="wf-row-x" aria-label="Remove branch" ${branches.length <= 2 ? "disabled" : ""}>×</button>
        </div>
        <div class="wf-cond ${openCond === i ? "" : "hidden"}" id="wfcCond${i}"></div>
      </div>`).join("");
    host.querySelectorAll(".wf-brrow").forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector("input").oninput = e => { branches[i].label = e.target.value; };
      const elseBtn = row.querySelector(".wf-brrow-else");
      if (elseBtn) elseBtn.onclick = () => {
        branches.forEach((b, j) => { if (j === i) b.isElse = true; else delete b.isElse; });
        openCond = -1;
        renderBranches();
      };
      const ruleBtn = row.querySelector(".wf-brrow-rule");
      if (ruleBtn) ruleBtn.onclick = () => {
        branches[i].condition = wfCondFromDraft(condDrafts[i], upstream) || branches[i].condition;
        openCond = openCond === i ? -1 : i;
        renderBranches();
      };
      const x = row.querySelector(".wf-row-x");
      x.onclick = () => {
        if (branches.length <= 2) return;
        branches.splice(i, 1); condDrafts.splice(i, 1);
        if (openCond === i) openCond = -1;
        renderBranches();
      };
    });
    if (openCond >= 0) wfCondRender($("wfcCond" + openCond), condDrafts[openCond], upstream);
  };

  openSheet(`
    <h2>Split</h2>
    <p class="hint">One path becomes many. Route takes exactly one branch by rule; parallel fires them all at once.</p>
    <div class="chips" id="wfcMode">
      <button type="button" class="chip" data-v="route" aria-pressed="${mode === "route"}">Route — one branch by rule</button>
      <button type="button" class="chip" data-v="parallel" aria-pressed="${mode === "parallel"}">Parallel — all at once</button>
    </div>
    <div class="wf-rowlist" id="wfcBranches"></div>
    <button type="button" class="wf-addrow" id="wfcAddBr">+ Add a branch</button>
    ${wfWaitForHTML(oid)}
    <button class="btn btn-go" style="margin-top:16px" id="wfcSave">Done</button>
  `, () => {
    renderBranches();
    wfWaitForWire();
    wireChipsIn($("wfcMode"), v => {
      mode = v;
      if (mode === "route" && !branches.some(b => b.isElse)) branches[branches.length - 1].isElse = true;
      openCond = -1;
      renderBranches();
    });
    $("wfcAddBr").onclick = () => {
      branches.push({ id: wfId("b"), label: "Branch " + (branches.length + 1), condition: null });
      condDrafts.push(wfCondDraft(null));
      renderBranches();
    };
    $("wfcSave").onclick = () => {
      if (openCond >= 0) branches[openCond].condition = wfCondFromDraft(condDrafts[openCond], upstream) || branches[openCond].condition;
      if (mode === "route" && !branches.some(b => b.isElse)) branches[branches.length - 1].isElse = true;
      branches.forEach(b => { if (b.isElse) b.condition = null; });
      // ports are positional but branches have identity: removing a middle
      // branch must NOT let its wire quietly re-attach to the next branch
      // down. Snapshot outgoing wires by branch id, rebuild the ports to
      // the new count, then re-draw each surviving branch's wires at its
      // new index.
      const outByBranch = {};
      wfSerializeGraph().edges.filter(e => e.from === oid && e.fromHandle).forEach(e => {
        (outByBranch[e.fromHandle] = outByBranch[e.fromHandle] || []).push(e.to);
      });
      const oldCount = rec.config.branches.length;
      rec.config = { mode, branches };
      wfNodes.set(oid, rec);
      const dfId = wfOur2Df.get(oid);
      for (let k = oldCount; k >= 1; k--) wfEditor.removeNodeOutput(dfId, "output_" + k);
      for (let k = 0; k < branches.length; k++) wfEditor.addNodeOutput(dfId);
      branches.forEach((b, i) => {
        (outByBranch[b.id] || []).forEach(toOid => {
          const toDf = wfOur2Df.get(toOid);
          if (toDf !== undefined) try { wfEditor.addConnection(dfId, toDf, "output_" + (i + 1), "input_1"); } catch (err) { console.error(err); }
        });
      });
      wfWaitForRead(oid);
      wfSheetSave(oid);
    };
  });
}

function wfSheetLogic(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  const upstream = wfUpstreamDeclaring(oid);
  const draft = wfCondDraft(c.condition);
  openSheet(`
    <h2>Logic gate</h2>
    <p class="hint">A yes/no check on one path. Yes exits the left port, no the right — “no” often loops back to an earlier Role for rework.</p>
    <div class="wf-cond" id="wfcCond"></div>
    ${wfWaitForHTML(oid)}
    <button class="btn btn-go" id="wfcSave">Done</button>
  `, () => {
    wfCondRender($("wfcCond"), draft, upstream);
    wfWaitForWire();
    $("wfcSave").onclick = () => {
      c.condition = wfCondFromDraft(draft, upstream);
      wfWaitForRead(oid);
      wfSheetSave(oid);
    };
  });
}

function wfSheetVault(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  openSheet(`
    <h2>Vault</h2>
    <p class="hint">A storage checkpoint — the deliverable is saved and stamped here, then the task KEEPS MOVING. Not an end.</p>
    <label class="fld"><span>Vault name</span><input type="text" id="wfcVName" maxlength="60" value="${esc(c.vaultName || "")}" placeholder="e.g. Final assets"></label>
    <label class="fld"><span>What gets stored</span><input type="text" id="wfcVWhat" maxlength="120" value="${esc(c.storeWhat || "")}" placeholder="e.g. the approved design files"></label>
    <div class="chips" id="wfcVVis">
      <button type="button" class="chip" data-v="team" aria-pressed="${(c.visibility || "team") === "team"}">Everyone on the run</button>
      <button type="button" class="chip" data-v="admins" aria-pressed="${c.visibility === "admins"}">Admins only</button>
    </div>
    ${wfWaitForHTML(oid)}
    <button class="btn btn-go" id="wfcSave">Done</button>
  `, () => {
    wireChipsIn($("wfcVVis"), () => {});
    wfWaitForWire();
    $("wfcSave").onclick = () => {
      c.vaultName = $("wfcVName").value.trim();
      c.storeWhat = $("wfcVWhat").value.trim();
      const vis = $("wfcVVis").querySelector('.chip[aria-pressed="true"]');
      c.visibility = vis && vis.dataset.v === "admins" ? "admins" : "team";
      wfWaitForRead(oid);
      wfSheetSave(oid);
    };
  });
}

function wfSheetAction(oid){
  const rec = wfNodes.get(oid);
  const c = rec.config;
  let actionType = c.actionType || "notify";
  const params = wfClone2(c.params || {});

  const paramsHTML = () => {
    if (actionType === "notify") return `
      <label class="fld"><span>Message</span><input type="text" id="wfcP1" maxlength="200" value="${esc(params.message || "")}" placeholder="e.g. Campaign assets are ready"></label>`;
    if (actionType === "email") return `
      <label class="fld"><span>To (email)</span><input type="text" id="wfcP1" maxlength="120" value="${esc(params.to || "")}" placeholder="client@example.com"></label>
      <label class="fld"><span>Subject</span><input type="text" id="wfcP2" maxlength="150" value="${esc(params.subject || "")}" placeholder="Subject line"></label>
      <label class="fld"><span>Message (optional)</span><textarea id="wfcP3" maxlength="600" placeholder="Included in the email body">${esc(params.message || "")}</textarea></label>
      <p class="hint">Sends through the app's mail pathway — EmailJS if configured, else the Firestore mail queue. Without EmailJS keys, rules only let an admin's advance queue mail to other people.</p>`;
    if (actionType === "webhook") return `
      <label class="fld"><span>Webhook URL</span><input type="text" id="wfcP1" maxlength="300" value="${esc(params.url || "")}" placeholder="https://…"></label>
      <div class="chips" id="wfcP2">
        <button type="button" class="chip" data-v="off" aria-pressed="${params.enabled ? "false" : "true"}">Off — safe while building</button>
        <button type="button" class="chip" data-v="on" aria-pressed="${params.enabled ? "true" : "false"}">On — fires for real</button>
      </div>
      <p class="hint">POSTs the run's context as JSON to this URL when the task lands here. Off by default, so a half-built track can never ping the outside world by accident.</p>`;
    return `<p class="hint">Marks the run's task complete. Nothing to configure.</p>`;
  };
  const wireParams = () => {
    const box = $("wfcP2");
    if (actionType === "webhook" && box) wireChipsIn(box, () => {});
  };
  const readParams = () => {
    if (actionType === "notify") return { message: $("wfcP1").value.trim() };
    if (actionType === "email") return { to: $("wfcP1").value.trim(), subject: $("wfcP2").value.trim(), message: $("wfcP3").value.trim() };
    if (actionType === "webhook"){
      const on = $("wfcP2").querySelector('.chip[aria-pressed="true"]');
      return { url: $("wfcP1").value.trim(), enabled: !!(on && on.dataset.v === "on") };
    }
    return {};
  };

  openSheet(`
    <h2>Action</h2>
    <p class="hint">The system does something automatically when the task lands here.</p>
    <div class="chips" id="wfcAType">
      ${WF_ACTION_TYPES.map(t => `<button type="button" class="chip" data-v="${t.v}" aria-pressed="${actionType === t.v}">${t.label}</button>`).join("")}
    </div>
    <div id="wfcParams">${paramsHTML()}</div>
    ${wfWaitForHTML(oid)}
    <button class="btn btn-go" id="wfcSave">Done</button>
  `, () => {
    wfWaitForWire();
    wireParams();
    wireChipsIn($("wfcAType"), v => {
      actionType = v;
      $("wfcParams").innerHTML = paramsHTML();
      wireParams();
    });
    $("wfcSave").onclick = () => {
      c.actionType = actionType;
      c.params = readParams();
      wfWaitForRead(oid);
      wfSheetSave(oid);
    };
  });
}

/* ============================================================
   RUNS — execution wired to Firestore.
   Starting is admin-only and freezes everything the run will
   ever read (blueprintSnapshot + task). Advancing happens inside
   a TRANSACTION: read the run doc (the serialization point) and
   its nodeRuns by ref, apply the pure wfAdvance, write back -
   so two branches finishing at once can't double-fire a join:
   the loser's transaction retries, sees the join already fired,
   and lands (or surfaces "already handled" if its own stop got
   taken). Effects run strictly AFTER commit, and each one is
   stamped dispatched on its nodeRun so a crash-retry can't
   double-send.
   ============================================================ */

/* ---------- starting a run (admin) ---------- */
function wfStartRunSheet(bpRow){
  const fields = [];
  const renderFields = () => {
    const host = $("wfrFields");
    host.innerHTML = fields.map((f, i) => `
      <div class="wf-outrow" data-i="${i}">
        <input type="text" class="wf-okey" placeholder="field (e.g. lane)" maxlength="30" value="${esc(f.key)}">
        <input type="text" class="wf-olabel" placeholder="value" maxlength="80" value="${esc(String(f.value))}">
        <button type="button" class="wf-row-x" aria-label="Remove field">×</button>
      </div>`).join("");
    host.querySelectorAll(".wf-outrow").forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector(".wf-okey").oninput = e => { fields[i].key = e.target.value.trim(); };
      row.querySelector(".wf-olabel").oninput = e => { fields[i].value = e.target.value; };
      row.querySelector(".wf-row-x").onclick = () => { fields.splice(i, 1); renderFields(); };
    });
  };
  openSheet(`
    <h2>Start a run</h2>
    <p class="hint">One real task rides “${esc(bpRow.name || "this blueprint")}” v${Number(bpRow.version) || 1}. It carries a frozen copy of the track — editing the blueprint later never touches it.</p>
    <label class="fld"><span>Task title</span><input type="text" id="wfrTitle" maxlength="80" placeholder="e.g. October launch banner"></label>
    <label class="fld"><span>Task fields (the track's rules can read these)</span></label>
    <div class="wf-rowlist" id="wfrFields"></div>
    <button type="button" class="wf-addrow" id="wfrAdd">+ Add a field</button>
    <button class="btn btn-go" style="margin-top:16px" id="wfrGo">Start run</button>
  `, () => {
    renderFields();
    $("wfrAdd").onclick = () => { fields.push({ key: "", value: "" }); renderFields(); };
    $("wfrGo").onclick = async () => {
      const title = $("wfrTitle").value.trim();
      if (!title){ toast("Give the task a title"); return; }
      const task = { title };
      fields.forEach(f => {
        if (!f.key) return;
        // typed the way conditions compare: yes/no and numbers, else text
        const raw = String(f.value).trim();
        task[f.key] = raw === "true" ? true : raw === "false" ? false
          : (raw !== "" && !Number.isNaN(Number(raw))) ? Number(raw) : raw;
      });
      const btn = $("wfrGo");
      btn.disabled = true;
      try {
        await wfRunStartCommit(bpRow, task);
        closeSheet();
        toast("Run started — it's moving");
      } catch (e) {
        console.error(e);
        toast(String((e && e.message) || "Couldn't start the run"));
        btn.disabled = false;
      }
    };
  });
}

async function wfRunStartCommit(bpRow, task){
  const runId = db.collection("runs").doc().id;
  const bp = { id: bpRow.docId, orgId: bpRow.orgId, ownerId: bpRow.ownerId, name: bpRow.name,
    version: bpRow.version, status: bpRow.status, nodes: bpRow.nodes, edges: bpRow.edges,
    createdAt: bpRow.createdAt, updatedAt: bpRow.updatedAt };
  // the pure engine builds the whole initial state; this only persists it
  const st = wfStartRun({ blueprint: bp, runId, taskId: null, task, orgId: WF_ORG, now: Date.now() });
  const batch = db.batch();
  batch.set(db.collection("runs").doc(runId),
    Object.assign({}, st.run, { nodeRunIds: st.nodeRuns.map(nr => nr.id), startedBy: auth.currentUser.uid }));
  st.nodeRuns.forEach(nr => batch.set(db.collection("nodeRuns").doc(nr.id), nr));
  await batch.commit();
  wfRunCache.set(runId, st.run);
  await wfDispatchEffects({ run: st.run, nodeRuns: st.nodeRuns }, st.effects);
}

/* ---------- the transactional advance ---------- */
async function wfAdvanceTx(runId, nodeRunId, output){
  const runRef = db.collection("runs").doc(runId);
  const result = await db.runTransaction(async tx => {
    const runSnap = await tx.get(runRef);
    if (!runSnap.exists) throw new Error("This run is gone");
    const run = runSnap.data();
    // transactions can't query - the run doc carries its nodeRun refs
    const snaps = await Promise.all((run.nodeRunIds || []).map(id => tx.get(db.collection("nodeRuns").doc(id))));
    const nodeRuns = snaps.filter(s => s.exists).map(s => s.data());
    const next = wfAdvance({ run, nodeRuns }, { type: "complete", nodeRunId, output }, { now: Date.now() });
    const prevById = new Map(nodeRuns.map(n => [n.id, JSON.stringify(n)]));
    next.nodeRuns.forEach(nr => {
      const before = prevById.get(nr.id);
      if (!before || before !== JSON.stringify(nr)) tx.set(db.collection("nodeRuns").doc(nr.id), nr);
    });
    // ONLY the allowlisted run fields - anything else would be rejected
    // for a worker and, worse, would un-freeze what must stay frozen
    tx.update(runRef, {
      status: next.run.status,
      activeNodeIds: next.run.activeNodeIds,
      hops: next.run.hops,
      completedAt: next.run.completedAt,
      nodeRunIds: next.nodeRuns.map(nr => nr.id)
    });
    return next;
  });
  wfRunCache.set(runId, result.run);
  await wfDispatchEffects(result, result.effects);
  return result;
}

/* ---------- effects: after commit, at-most-once, never lost silently ----------
   The engine still just RETURNS effects; this glue executes them. Every
   effect that belongs to a nodeRun gets its outcome stamped there as
   dispatch[type] = { state: "dispatched"|"failed"|"skipped", reason?, at }
   - the runs-board timeline renders these, so a failed send is VISIBLE,
   not swallowed. A retry (crash between commit and stamp, transaction
   rerun) checks the stamp first, so nothing double-sends. */
async function wfDispatchEffects(state, effects){
  for (const ef of (effects || [])){
    const nr = ef.nodeRunId ? state.nodeRuns.find(x => x.id === ef.nodeRunId) : null;
    // at-most-once: the old boolean stamp and the new per-effect map both count
    if (nr && (nr.dispatched || (nr.dispatch && nr.dispatch[ef.type]))) continue;
    let outcome = null;   // null = nothing worth stamping (no-op effect kinds)
    try {
      outcome = await wfExecEffect(ef, state);
    } catch (e) {
      console.error(e);
      outcome = { state: "failed", reason: String((e && e.message) || e).slice(0, 140) };
    }
    if (nr && outcome){
      try {
        const stamp = Object.assign({ at: Date.now() }, outcome);
        await db.collection("nodeRuns").doc(nr.id).update({ ["dispatch." + ef.type]: stamp });
        nr.dispatch = nr.dispatch || {};
        nr.dispatch[ef.type] = stamp;
      } catch (e) { console.error(e); }
    }
  }
}

/* one effect → one outcome. Throws are caught by the caller and become
   "failed" stamps; returning null means there is nothing to record. */
async function wfExecEffect(ef, state){
  const now = Date.now();
  const run = state.run;
  const taskTitle = (run.task && run.task.title) || "a workflow run";

  if (ef.type === "role-activated"){
    if (!ef.assigneeId) return null;   // role-based stops surface via the open pool
    await db.collection("notifications").add({
      toUid: ef.assigneeId, kind: "workflow", read: false, createdAt: now,
      text: "A task stopped at you: " + taskTitle
    });
    return { state: "dispatched" };
  }
  if (ef.type === "vault") return { state: "dispatched", reason: "stamped into the run record" };
  if (ef.type === "run-completed" || ef.type === "run-failed"){
    await db.collection("notifications").add({
      toRole: "admin", kind: "workflow", read: false, createdAt: now,
      text: (ef.type === "run-completed" ? "Run finished: " : "Run FAILED (loop cap): ") + taskTitle
    });
    return null;   // run-level, no nodeRun to stamp
  }
  if (ef.type !== "action") return null;

  const p = ef.params || {};
  if (ef.actionType === "notify"){
    await db.collection("notifications").add({
      toRole: "admin", kind: "workflow", read: false, createdAt: now,
      text: p.message || ("A workflow action fired on: " + taskTitle)
    });
    return { state: "dispatched" };
  }
  if (ef.actionType === "complete"){
    // there is no linked task doc to flip yet (runs carry taskId: null) -
    // saying "skipped" is honest; saying "dispatched" would be a lie
    return { state: "skipped", reason: "no linked task to mark complete" };
  }
  if (ef.actionType === "email"){
    if (!p.to) return { state: "failed", reason: "no recipient configured on this Action" };
    const subject = p.subject || ("Workflow update — " + taskTitle);
    const r = await queueAppEmail(p.to, subject, wfActionEmailHTML(run, p));
    return r.ok ? { state: "dispatched", reason: r.reason || "" }
                : { state: "failed", reason: r.reason || "send failed" };
  }
  if (ef.actionType === "webhook"){
    if (!p.enabled) return { state: "skipped", reason: "webhook is disabled — switch it on in the Action block" };
    if (!p.url) return { state: "failed", reason: "no URL configured on this Action" };
    try {
      // POST-only, JSON-only: the action's params plus the run context
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "workflow-action",
          runId: run.id, taskId: run.taskId || null, task: run.task || {},
          blueprint: { name: (run.blueprintSnapshot || {}).name || "", version: (run.blueprintSnapshot || {}).version || 0 },
          nodeId: ef.nodeId, nodeRunId: ef.nodeRunId, firedAt: now
        })
      });
      if (res.ok) return { state: "dispatched", reason: "endpoint answered " + res.status };
      return { state: "failed", reason: "endpoint answered " + res.status };
    } catch (e) {
      console.error(e);
      return { state: "failed", reason: "couldn't reach the endpoint (network or CORS)" };
    }
  }
  return { state: "skipped", reason: "unknown action type" };
}

/* the ACTION email body: the same inline-styled dialect email.js uses,
   built from the action's params plus the run/task context */
function wfActionEmailHTML(run, p){
  const task = run.task || {};
  const bp = run.blueprintSnapshot || {};
  const line = (k, v) => `<tr>
    <td style="padding:8px 10px;font:600 10px/1.4 -apple-system,'Segoe UI',Arial,sans-serif;letter-spacing:1px;color:#8a8578;text-transform:uppercase;border-bottom:1px solid #eee8db">${esc(k)}</td>
    <td style="padding:8px 10px;font:13px/1.5 -apple-system,'Segoe UI',Arial,sans-serif;color:#2b2b28;border-bottom:1px solid #eee8db">${esc(String(v))}</td></tr>`;
  const fields = Object.entries(task).filter(([k]) => k !== "title");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eeeae0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeeae0;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
      <tr><td style="background:#161922;padding:26px 28px">
        <div style="font:800 22px/1 -apple-system,'Segoe UI',Arial,sans-serif;color:#ffffff;letter-spacing:1px">EZ <span style="font-weight:300">CLOCK IN</span></div>
        <div style="font:13px/1.6 -apple-system,'Segoe UI',Arial,sans-serif;color:#b9bcc4;margin-top:8px">Workflow update · ${esc(bp.name || "a track")} v${Number(bp.version) || 1}</div>
      </td></tr>
      <tr><td style="padding:26px 28px 8px">
        <div style="font:700 19px/1.4 -apple-system,'Segoe UI',Arial,sans-serif;color:#161922">${esc(task.title || "A task moved")}</div>
        ${p.message ? `<div style="font:14px/1.7 -apple-system,'Segoe UI',Arial,sans-serif;color:#2b2b28;margin-top:10px">${esc(p.message)}</div>` : ""}
      </td></tr>
      ${fields.length ? `<tr><td style="padding:10px 28px 22px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${fields.map(([k, v]) => line(k, v)).join("")}</table>
      </td></tr>` : `<tr><td style="padding:0 0 22px"></td></tr>`}
      <tr><td style="padding:16px 28px;background:#f6f4ef">
        <div style="font:11px/1.6 -apple-system,'Segoe UI',Arial,sans-serif;color:#8a8578">Sent automatically by an Ez Clock In workflow Action.</div>
      </td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
}

/* ---------- my stops (and the open pool) ---------- */
let wfStopsMine = [], wfStopsPool = [], wfWatchersOn = false;
let wfRunCache = new Map();

function wfWatchStops(){
  if (wfWatchersOn || !db || !auth || !auth.currentUser) return;
  wfWatchersOn = true;
  const me = auth.currentUser.uid;
  const grab = snap => {
    const rows = [];
    snap.forEach(d => rows.push(d.data()));
    rows.sort((a, b) => (a.arrivedAt || 0) - (b.arrivedAt || 0));
    return rows;
  };
  // NEEDS the composite index nodeRuns(assigneeId ASC, status ASC)
  const u1 = db.collection("nodeRuns")
    .where("assigneeId", "==", me).where("status", "==", "in_progress")
    .onSnapshot(s => { wfStopsMine = grab(s); wfRenderStops(); }, e => console.error(e));
  // role-based stops have no assignee yet: a shared pool any teammate may
  // take (the same trusted-team tradeoff assignments already makes)
  const u2 = db.collection("nodeRuns")
    .where("status", "==", "in_progress")
    .onSnapshot(s => { wfStopsPool = grab(s).filter(r => !r.assigneeId); wfRenderStops(); }, e => console.error(e));
  onSessionEnd(() => {
    u1(); u2();
    wfWatchersOn = false; wfStopsMine = []; wfStopsPool = []; wfRunCache = new Map();
  });
}

/* run docs fetched once each, for stop titles + the frozen node config */
function wfRunFor(runId){
  if (wfRunCache.has(runId)) return wfRunCache.get(runId);
  wfRunCache.set(runId, null);
  db.collection("runs").doc(runId).get()
    .then(s => { if (s.exists){ wfRunCache.set(runId, s.data()); wfRenderStops(); } })
    .catch(e => console.error(e));
  return null;
}

function wfStopRow(nr, mine){
  const run = wfRunFor(nr.runId);
  const node = run && ((run.blueprintSnapshot || {}).nodes || []).find(n => n.id === nr.nodeId);
  const cfg = node ? (node.config || {}) : {};
  return `
    <button type="button" class="wf-stop" data-nr="${esc(nr.id)}">
      <span class="wf-stop-main">
        <p class="wf-stop-title">${esc(cfg.label || "A stop")}</p>
        <p class="wf-stop-meta">${run ? esc((run.task && run.task.title) || "Untitled task") : "Loading…"}${!mine && cfg.role ? " · any " + esc(cfg.role) : ""}</p>
      </span>
      <span class="wf-stop-go">${mine ? "Yours" : "Take it"}</span>
    </button>`;
}

function wfRenderStops(){
  const host = $("wfStops");
  if (!host) return;
  if (!wfStopsMine.length && !wfStopsPool.length){
    host.innerHTML = isAdmin ? "" : `
      <div class="fpage-panel">
        <div class="empty">
          <span class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="5" rx="1.5"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/><path d="M12 7.5V11M12 11H5.5v5M12 11h6.5v5"/></svg>
          </span>
          Nothing waiting on you. When a running task stops at you, it lands here.
        </div>
      </div>`;
    return;
  }
  host.innerHTML = `
    ${wfStopsMine.length ? `
      <div class="fpage-panel">
        <p class="fpage-section-title">Waiting on you</p>
        ${wfStopsMine.map(nr => wfStopRow(nr, true)).join("")}
      </div>` : ""}
    ${wfStopsPool.length ? `
      <div class="fpage-panel">
        <p class="fpage-section-title">Open stops — anyone on the team can take one</p>
        ${wfStopsPool.map(nr => wfStopRow(nr, false)).join("")}
      </div>` : ""}`;
  host.querySelectorAll(".wf-stop").forEach(b => b.onclick = () => {
    const nr = wfStopsMine.concat(wfStopsPool).find(x => x.id === b.dataset.nr);
    if (nr) wfOpenStop(nr);
  });
}

/* ---------- working a stop ---------- */
function wfOpenStop(nr){
  const run = wfRunFor(nr.runId);
  if (!run){ toast("Still loading this stop — try again in a second"); return; }
  const node = ((run.blueprintSnapshot || {}).nodes || []).find(n => n.id === nr.nodeId);
  if (!node){ toast("This stop's block is missing from the run's snapshot"); return; }
  const cfg = node.config || {};
  const outs = cfg.outputs || [];
  const required = cfg.requiresOutput !== false;
  openSheet(`
    <h2>${esc(cfg.label || "This stop")}</h2>
    <p class="hint"><b>${esc((run.task && run.task.title) || "Untitled task")}</b>${cfg.instructions ? " — " + esc(cfg.instructions) : ""}</p>
    ${outs.map((o, i) => o.type === "boolean" ? `
      <label class="fld"><span>${esc(o.label || o.key)}${required ? ' <b class="req">*</b>' : ""}</span></label>
      <div class="chips" id="wfso${i}">
        <button type="button" class="chip" data-v="true" aria-pressed="false">Yes</button>
        <button type="button" class="chip" data-v="false" aria-pressed="false">No</button>
      </div>` : `
      <label class="fld"><span>${esc(o.label || o.key)}${required ? ' <b class="req">*</b>' : ""}</span>
        <input type="${o.type === "number" ? "number" : "text"}" id="wfso${i}" maxlength="200"></label>`).join("")}
    <label class="fld"><span>Note (optional)</span><textarea id="wfsoNote" maxlength="600" placeholder="Anything the next stop should know"></textarea></label>
    <button class="btn btn-go" id="wfsoGo">Mark this stop complete</button>
  `, () => {
    outs.forEach((o, i) => { if (o.type === "boolean") wireChipsIn($("wfso" + i), () => {}); });
    $("wfsoGo").onclick = async () => {
      const output = {};
      let missing = null;
      outs.forEach((o, i) => {
        if (o.type === "boolean"){
          const p = $("wfso" + i).querySelector('.chip[aria-pressed="true"]');
          if (p) output[o.key] = p.dataset.v === "true";
          else if (required) missing = missing || (o.label || o.key);
        } else if (o.type === "number"){
          const v = $("wfso" + i).value;
          if (v !== "") output[o.key] = Number(v);
          else if (required) missing = missing || (o.label || o.key);
        } else {
          const v = $("wfso" + i).value.trim();
          if (v) output[o.key] = v;
          else if (required) missing = missing || (o.label || o.key);
        }
      });
      if (missing){ toast("This stop must record “" + missing + "”"); return; }
      const note = $("wfsoNote").value.trim();
      if (note) output.note = note;
      const btn = $("wfsoGo");
      btn.disabled = true;
      try {
        await wfAdvanceTx(nr.runId, nr.id, output);
        closeSheet();
        toast("Done — the task moved on");
      } catch (e) {
        console.error(e);
        toast(String((e && e.message) || "Couldn't complete this stop"));
        btn.disabled = false;
      }
    };
  });
}

/* ============================================================
   RUNS BOARD — admin monitoring. The LIST stays cheap on
   purpose: every row renders from the run doc alone (the frozen
   snapshot already carries the node labels activeNodeIds point
   at). nodeRuns load only when a run is opened, as its timeline.
   ============================================================ */
let wfTab = "blueprints";           // "blueprints" | "runs"
let wfRunsRows = [], wfRunsWatcherOn = false, wfRunsFilter = "running";

const WF_RUN_STATUS = {
  running:   { word: "Running",   cls: "is-published" },
  completed: { word: "Completed", cls: "is-draft" },
  failed:    { word: "Failed",    cls: "is-failed" },
  cancelled: { word: "Cancelled", cls: "is-cancelled" }
};

function wfWatchRuns(){
  if (wfRunsWatcherOn || !db || !auth || !auth.currentUser) return;
  wfRunsWatcherOn = true;
  const unsub = db.collection("runs").where("orgId", "==", WF_ORG)
    .onSnapshot(s => {
      const rows = [];
      s.forEach(d => rows.push(d.data()));
      rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      wfRunsRows = rows;
      wfRenderRuns();
    }, e => console.error(e));
  onSessionEnd(() => { unsub(); wfRunsWatcherOn = false; wfRunsRows = []; });
}

/* one line of "where is it": activeNodeIds → labels out of the run's own
   frozen snapshot - no nodeRun reads for the list, ever */
function wfRunWhere(r){
  if (r.status !== "running") return "";
  const nodes = (r.blueprintSnapshot || {}).nodes || [];
  const labels = (r.activeNodeIds || []).map(id => {
    const n = nodes.find(x => x.id === id);
    return n ? ((n.config || {}).label || WF_TYPES[n.type].name) : id;
  });
  return labels.length ? "at " + labels.join(" + ") : "moving…";
}

function wfRenderRuns(){
  const host = $("wfTabBody");
  if (!host || wfView !== "list" || wfTab !== "runs") return;
  const rows = wfRunsFilter === "running" ? wfRunsRows.filter(r => r.status === "running") : wfRunsRows;
  host.innerHTML = `
    <div class="fpage-bar">
      <div class="fpage-filters" style="margin:0" id="wfRunsFilter">
        <button type="button" class="chip" data-f="running" aria-pressed="${wfRunsFilter === "running"}">Running</button>
        <button type="button" class="chip" data-f="all" aria-pressed="${wfRunsFilter === "all"}">All</button>
      </div>
      <p class="fpage-bar-note">${rows.length} run${rows.length === 1 ? "" : "s"}</p>
    </div>
    ${rows.length ? rows.map(r => {
      const st = WF_RUN_STATUS[r.status] || WF_RUN_STATUS.running;
      const bp = r.blueprintSnapshot || {};
      const where = wfRunWhere(r);
      return `
        <button type="button" class="wf-stop" data-runid="${esc(r.id)}">
          <span class="wf-stop-main">
            <p class="wf-stop-title">${esc((r.task && r.task.title) || "Untitled task")}</p>
            <p class="wf-stop-meta">${esc(bp.name || "?")} v${Number(bp.version) || 1} · ${dayStamp(r.startedAt)} ${clock(r.startedAt)}${where ? " · " + esc(where) : ""}</p>
          </span>
          <span class="wf-status ${st.cls}">${st.word}</span>
        </button>`;
    }).join("") : `<div class="fpage-panel"><div class="empty">${wfRunsFilter === "running" ? "Nothing in flight. Start a run from a published blueprint." : "No runs yet."}</div></div>`}`;
  host.querySelectorAll("#wfRunsFilter .chip").forEach(c => c.onclick = () => {
    wfRunsFilter = c.dataset.f;
    wfRenderRuns();
  });
  host.querySelectorAll("[data-runid]").forEach(b => b.onclick = () => {
    const r = wfRunsRows.find(x => x.id === b.dataset.runid);
    if (r) wfOpenRunDetail(r);
  });
}

/* ---------- one run's full story ---------- */
function wfFmtOut(v){
  if (v === true) return "yes";
  if (v === false) return "no";
  if (typeof v === "number" && v > 1e12) return clock(v);   // engine time stamps
  return String(v);
}

async function wfOpenRunDetail(run){
  await wfLoadDirectory();
  let nrs = [];
  try {
    const snap = await db.collection("nodeRuns").where("runId", "==", run.id).get();
    snap.forEach(d => nrs.push(d.data()));
  } catch (e) {
    console.error(e);
    toast("Couldn't load this run's stops");
    return;
  }
  nrs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const bp = run.blueprintSnapshot || {};
  const st = WF_RUN_STATUS[run.status] || WF_RUN_STATUS.running;
  const nodeOf = id => (bp.nodes || []).find(n => n.id === id);

  const rowsHTML = nrs.map(nr => {
    const node = nodeOf(nr.nodeId);
    const cfg = node ? (node.config || {}) : {};
    const who = nr.assigneeId ? (wfDirName(nr.assigneeId) || "someone") : "";
    const outs = Object.entries(nr.output || {}).filter(([k]) => k !== "note");
    const word = nr.status === "in_progress" ? "waiting on a human" : nr.status.replace("_", " ");
    return `
      <div class="wf-tl-row is-${esc(nr.status)}">
        <span class="wf-tl-dot"></span>
        <div class="wf-tl-main">
          <p class="wf-tl-title">${esc(cfg.label || cfg.vaultName || (node ? WF_TYPES[node.type].name : nr.nodeType))}<small>${esc(nr.nodeType)}</small></p>
          <p class="wf-tl-meta">${esc(word)}${who ? " · " + esc(who) : ""} · in ${clock(nr.arrivedAt)}${nr.completedAt ? " · out " + clock(nr.completedAt) : ""}</p>
          ${outs.length ? `<p class="wf-tl-outs">${outs.map(([k, v]) => `<span>${esc(k)}: ${esc(wfFmtOut(v))}</span>`).join("")}</p>` : ""}
          ${nr.output && nr.output.note ? `<p class="wf-tl-note">“${esc(nr.output.note)}”</p>` : ""}
          ${nr.dispatch ? Object.entries(nr.dispatch).map(([k, d]) =>
            `<p class="wf-tl-disp is-${esc(d.state)}">${esc(k)} ${esc(d.state)}${d.reason ? " — " + esc(d.reason) : ""}</p>`).join("")
            : (nr.dispatched ? `<p class="wf-tl-disp is-dispatched">effect dispatched</p>` : "")}
        </div>
      </div>`;
  }).join("");

  openSheet(`
    <h2>${esc((run.task && run.task.title) || "Untitled task")}</h2>
    <p class="hint">${esc(bp.name || "?")} v${Number(bp.version) || 1} · ${st.word.toLowerCase()} · started ${dayStamp(run.startedAt)} ${clock(run.startedAt)}${run.completedAt ? " · ended " + clock(run.completedAt) : ""} · ${run.hops} hop${run.hops === 1 ? "" : "s"}</p>
    <div class="wf-tl">${rowsHTML || `<p class="hint">No stops recorded yet.</p>`}</div>
    ${run.status === "running" ? `<button class="btn" id="wfrdCancel">Cancel this run</button>` : ""}
  `, () => {
    const btn = $("wfrdCancel");
    if (!btn) return;
    let armed = false;
    btn.onclick = async () => {
      if (!armed){
        armed = true;
        btn.textContent = "Really cancel? It can't be restarted — tap again";
        setTimeout(() => { if (btn.isConnected){ armed = false; btn.textContent = "Cancel this run"; } }, 3000);
        return;
      }
      btn.disabled = true;
      try {
        await wfCancelRun(run.id);
        closeSheet();
        toast("Run cancelled");
      } catch (e) {
        console.error(e);
        toast(String((e && e.message) || "Couldn't cancel"));
        btn.disabled = false;
      }
    };
  });
}

/* Cancel rides the same transactional path as an advance: read the run
   and its nodeRuns by ref, write the outcome atomically. On the run doc
   it touches status + activeNodeIds and NOTHING else; in-flight stops
   get a glue-level "cancelled" stamp (the engine never emits or reads
   it - a cancelled run can't advance, so those attempts are inert).
   Admin-only by rules: the team allowlist can't write status
   "cancelled", so a worker calling this gets a permission error. */
async function wfCancelRun(runId){
  const runRef = db.collection("runs").doc(runId);
  await db.runTransaction(async tx => {
    const s = await tx.get(runRef);
    if (!s.exists) throw new Error("This run is gone");
    const run = s.data();
    if (run.status !== "running") throw new Error("Run is already " + run.status);
    const snaps = await Promise.all((run.nodeRunIds || []).map(id => tx.get(db.collection("nodeRuns").doc(id))));
    snaps.filter(x => x.exists).forEach(x => {
      const nr = x.data();
      if (nr.status === "in_progress")
        tx.update(db.collection("nodeRuns").doc(nr.id), { status: "cancelled", completedAt: Date.now() });
    });
    tx.update(runRef, { status: "cancelled", activeNodeIds: [] });
  });
  wfRunCache.delete(runId);
}
