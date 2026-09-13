/* ============================================================
   FLOW — the builder page. One picture per kind of work.

   The Organization page answers "what do we have" as a list of sections:
   roles here, kinds of work there, rules in a third place, and the steps
   a kind travels behind a button inside a fold. Every one of those is the
   same decision seen from a different side - "who does step 2" is a role,
   the people in it, and what that role may do - and the owner's word for
   reading them in four places was "confusing".

   So this page draws the whole thing at once, left to right, the way a
   person would sketch it on a whiteboard:

     [ New Task ] -> [ 1 Write the draft · Staff ] -> [ 2 Check it · Manager ] -> [ Done ]

   and lets them change it where they see it. Every step is a card, edited
   in place. Cards are dragged to reorder (arrows on a phone, where there
   is no drag). A person is dragged from the panel onto a step to give
   that step to them. The rules that fire for this kind sit in a lane
   underneath, each one a sentence. The people and roles sit beside it.

   IT INVENTS NO NEW MODEL. The canvas edits the same `track` the steps
   editor on the Organization page edits, and saves it through the same
   orgTrackCommit() - one write path, whichever screen asked (docs/lessons.md
   > "Fixing casualties instead of the cause"). Rules are the same
   automations documents; people and roles are the same seats and roles;
   a kind's fields and a role's permissions still open the sheets that
   already know how to edit them. What is new is the picture, not the
   data, which is what lets tests/flow.test.mjs keep proving the flow.

   `fl` prefix throughout: js/ files share one global scope.
   ============================================================ */

let flS = null;   // { typeId, draft: [step], dirty, drag: index | null, open: index | null }
const flOpenRoles = new Set();   // roles the person has unfolded in the people panel
let flPeopleFind = "";           // what is typed in the panel's search box
const FL_ICO_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>';

/* ---------- pure ---------- */

/* Move the step at `from` so it sits at `to`. Returns a new array; the
   draft is never mutated by a pure helper, so a drop that goes wrong
   leaves the picture as it was. */
function flMove(list, from, to){
  const out = (list || []).slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/* Dropping a person on a step gives the step to them. If they are in a
   different role from the step's, the step takes THEIR role - a step
   belongs to a role and may be narrowed within it (js/handoff.js), so
   "give it to Bo" has to mean "Staff, and of them Bo", never a bare name.
   Dropping a second person in the same role adds them. */
function flGive(step, member){
  const s = Object.assign({}, step, { assignees: ((step || {}).assignees || []).slice() });
  if (!member || !member.uid || !member.roleId) return s;
  if (s.roleId !== member.roleId) { s.roleId = member.roleId; s.assignees = []; }
  if (s.assignees.indexOf(member.uid) < 0) s.assignees.push(member.uid);
  return s;
}

/* Tick a person on or off a step. Off for the last named one means
   "any of the role" again, which is the honest reading of an empty list. */
function flToggle(step, uid){
  const s = Object.assign({}, step, { assignees: (step.assignees || []).slice() });
  const i = s.assignees.indexOf(uid);
  if (i >= 0) s.assignees.splice(i, 1); else s.assignees.push(uid);
  return s;
}

const flBlankStep = () => ({ id: "st" + orgNewId(), label: "", roleId: "", assignees: [], status: "", dueAfter: null });

// insert a blank step after step i - after its whole group, if it runs
// alongside others - and make it the open card. Returns the new step.
function flAddAfter(i){
  const g = hoGroups(flS.draft).find(x => i >= x.from && i <= x.to);
  const at = (g ? g.to : i) + 1;
  const st = flBlankStep();
  flS.draft.splice(at, 0, st);
  flS.open = at;
  return st;
}

/* A rule as one sentence, for the lane and for a rule's own name when the
   person did not give it one. Rules are stored as trigger + action
   documents; nobody thinks in those, so the lane never shows a verb key. */
/* A rule read back as one sentence - the thing the lane shows and the
   sheet's title. `o` may carry typeName, fieldNameOf, personNameOf. The
   trigger "is marked X" is the status_changed verb with a status
   condition, because "its status changes" alone fires on every change
   and says nothing an admin can act on. */
function flRuleWords(rule, roleNameOf, statusNameOf, o){
  o = o || {};
  const r = rule || {}, t = r.trigger || {}, a = (r.actions || [])[0] || {};
  const conds = r.conditions || [];
  const st = conds.find(c => c && c.source === "task" && c.path === "status");
  const fc = conds.find(c => c && c.source === "field");
  const status = k => (statusNameOf && k && statusNameOf(k)) || k || "…";
  const subject = o.typeName ? "a " + o.typeName : "work";
  let when;
  if (t.verb === "item.created") when = "When " + subject + " is created";
  else if (t.verb === "item.status_changed") when = st ? "When " + (o.typeName ? "a " + o.typeName : "it") + " is marked " + status(st.value) : "When its status changes";
  else if (t.verb === "item.assigned") when = "When " + (o.typeName ? "a " + o.typeName : "it") + " is given to someone";
  else if (t.verb === "item.updated") when = "When " + (o.typeName ? "a " + o.typeName : "it") + " is edited";
  else when = "When something happens";
  if (fc) {
    const opw = { "==": "is", "!=": "is not", contains: "contains", ">": "is over", "<": "is under" }[fc.op || "=="] || fc.op;
    when += " and " + ((o.fieldNameOf && o.fieldNameOf(fc.path)) || fc.path) + " " + opw + " " + (fc.value === true ? "ticked" : fc.value === false ? "not ticked" : String(fc.value));
  }
  let then = "";
  if (a.kind === "notify") {
    const who = a.toWhom === "assignees" ? "whoever holds it" : a.toWhom === "creator" ? "whoever created it"
      : ((roleNameOf && a.toRole && roleNameOf(a.toRole)) || "a role");
    then = "tell " + who + (a.message ? ': "' + a.message + '"' : "");
  }
  else if (a.kind === "set_status") then = "mark it " + status(a.status);
  else if (a.kind === "assign") {
    const ids = a.assigneeIds || [];
    then = "give it to " + (ids.length ? (o.personNameOf ? ids.map(o.personNameOf).join(", ") : (ids.length === 1 ? "one person" : ids.length + " people")) : "…");
  }
  else if (a.kind === "set_field") then = "set " + ((o.fieldNameOf && a.key && o.fieldNameOf(a.key)) || a.key || "a field") + (a.value != null && a.value !== "" ? " to " + a.value : "");
  else then = "do nothing";
  return when + ", " + then + ".";
}

const flRuleBlank = (typeId, roles) => ({
  id: null, name: "", enabled: true,
  trigger: { verb: "item.created", typeId },
  conditions: [], actions: [{ kind: "notify", toRole: (roles.find(r => r.id !== "owner") || roles[0] || {}).id || null, message: "" }]
});

/* ---------- page entry ---------- */

function enterFlowPage(){
  const box = $("flowBody");
  if (!box) return;
  box.innerHTML = '<p class="fl-note">Loading…</p>';
  orgLoad().then(s => {
    orgS = s;
    if (!orgS) { flRenderEmpty(); return; }
    if (!flS || flS.orgId !== orgS.orgId) flS = { orgId: orgS.orgId, typeId: null, draft: null, dirty: false, drag: null, open: null };
    flRender();
  }).catch(e => {
    console.error(e);
    box.innerHTML = '<p class="fl-note fl-err">Could not load the organization. Check your connection and try again.</p>';
  });
}

/* No org is two different facts (docs/lessons.md > "An empty list must
   say why it is empty"): the read failed, or there is nothing to read. */
function flRenderEmpty(){
  $("flowBody").innerHTML = orgWhyNone === "error"
    ? '<p class="fl-note fl-err">Could not reach your organization. Check your connection and try again.</p>'
    : '<div class="fl-empty"><h2>No organization yet</h2>' +
      '<p>The builder draws how your organization\'s work moves. Create the organization first, on the Organization page.</p>' +
      '<button type="button" class="org-btn" onclick="go(\'org\')">Open Organization</button></div>';
}

/* ---------- the picture ---------- */

const flType = () => (orgS && orgS.types || []).find(t => t.id === flS.typeId) || null;
const flRoleName = id => id === HO_ANY ? "Anyone" : orgRoleName(id);
const flStatusName = (type, key) => { const s = ((type && type.statuses) || []).find(x => x.key === key); return s ? (s.label || s.key) : key; };
const flInitial = name => ((name || "?").trim().charAt(0) || "?").toUpperCase();

function flRender(){
  const box = $("flowBody");
  const types = (orgS.types || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const owner = orgIsOwner();

  if (!types.length) {
    box.innerHTML = '<div class="fl-empty"><h2>No kinds of work yet</h2>' +
      '<p>A kind of work is what travels the steps - a Task, a Brief, a Video. Make one, or start from a template on the Organization page.</p>' +
      (owner ? '<div class="org-actions"><button type="button" class="org-btn" id="flNewKind">Create a kind of work</button>' +
        '<button type="button" class="org-btn org-btn-sm" onclick="go(\'org\')">Templates</button></div>' : '') + '</div>';
    if ($("flNewKind")) $("flNewKind").onclick = () => orgTypeSheet(null);
    return;
  }

  // the kind on screen: the one picked, else the first. A different kind
  // means a fresh draft; the same kind keeps its unsaved edits
  if (!types.find(t => t.id === flS.typeId)) { flS.typeId = types[0].id; flS.draft = null; flS.dirty = false; }
  const type = flType();
  if (!flS.draft) { flS.draft = hoStopIds(JSON.parse(JSON.stringify(type.track || []))); flS.dirty = false; flS.open = null; }

  const tabs = types.map(t => '<button type="button" class="fl-tab' + (t.id === type.id ? " is-on" : "") +
    '" data-type="' + esc(t.id) + '">' + esc(t.name || t.id) +
    ((t.track || []).length ? '<i>' + t.track.length + '</i>' : "") + '</button>').join("") +
    (owner ? '<button type="button" class="fl-tab fl-tab-new" id="flNewKind">+ New kind</button>' : "");

  box.innerHTML =
    '<div class="fl-tabs" role="tablist">' + tabs + '</div>' +
    '<div class="fl-cols">' +
      '<div class="fl-main">' +
        '<div class="fl-canvas" id="flCanvas"></div>' +
        '<div class="fl-lane" id="flRules"></div>' +
      '</div>' +
      '<aside class="fl-side" id="flPeople"></aside>' +
    '</div>' +
    '<div class="fl-bar" id="flBar"></div>' +
    (owner ? "" : '<p class="fl-note">Only the owner can change this. You are looking at how it is set up today.</p>');

  box.querySelectorAll(".fl-tab[data-type]").forEach(b => b.onclick = () => {
    if (b.dataset.type === flS.typeId) return;
    if (flS.dirty && !flConfirmLeave()) return;
    flS.typeId = b.dataset.type; flS.draft = null; flS.dirty = false;
    flRender();
  });
  if ($("flNewKind")) $("flNewKind").onclick = () => orgTypeSheet(null);

  flPaintCanvas();
  flPaintRules();
  flPaintPeople();
  flPaintBar();
}

// unsaved steps and a tab press: the honest thing is to ask once
function flConfirmLeave(){
  try { return window.confirm("You have unsaved steps here. Leave without saving?"); } catch (e) { return true; }
}

/* ---------- the canvas ---------- */

function flPaintCanvas(){
  const type = flType(), owner = orgIsOwner();
  const members = orgS.members || [], roles = orgS.roles || [];
  const draft = flS.draft;
  const gapAt = new Set(hoTrackGaps(draft, members).map(g => g.at));
  const doneKey = itemDoneStatus(type);

  // the two ends of the line are one row each: what it is, and what it
  // becomes - the steps between them are the picture
  const start = '<div class="fl-node fl-start">' +
    '<p class="fl-node-k">Start</p><div class="fl-node-t"><h3>New ' + esc(type.name || type.id) + '</h3>' +
    '<p class="fl-node-s">Made from Assign · starts as <b>' + esc(flStatusName(type, ((type.statuses || [])[0] || {}).key)) + '</b></p></div>' +
    (owner ? '<button type="button" class="fl-link" id="flEditKind">Fields &amp; statuses…</button>' : "") +
    '</div>';

  const end = '<div class="fl-node fl-end">' +
    '<p class="fl-node-k">End</p><div class="fl-node-t"><h3>Done</h3>' +
    '<p class="fl-node-s">Marked <b>' + esc(doneKey ? flStatusName(type, doneKey) : "done") + '</b> · whoever created it is told</p></div>' +
    '</div>';

  const plus = (i, together) => owner
    ? '<button type="button" class="fl-plus' + (together ? " fl-plus-par" : "") + '" data-at="' + i + '"' + (together ? ' data-together="1"' : "") +
      ' title="' + (together ? "Add a step that runs at the same time" : "Add a step here") + '" aria-label="' + (together ? "Add a step that runs at the same time" : "Add a step here") + '">' +
      (together ? "+ at the same time" : "+") + '</button>'
    : '<span class="fl-plus is-off"></span>';

  const groups = hoGroups(draft);
  const fields = type.fields || [];
  const labelOf = st => (st.label || "").trim() || ("Step " + (draft.indexOf(st) + 1));
  // what "otherwise" means for a step: the entry of the next group, or Done
  const otherwiseOf = i => {
    const g = groups.findIndex(x => i >= x.from && i <= x.to);
    const nx = groups[g + 1];
    return nx ? labelOf(draft[nx.from]) : "Done";
  };

  const card = (st, i) => {
    const inRole = st.roleId === HO_ANY ? members : st.roleId ? members.filter(m => m.roleId === st.roleId) : [];
    const on = st.assignees || [];
    const gap = gapAt.has(i);
    const choices = (st.choices || []);
    const routes = (st.routes || []);
    const dis = owner ? "" : " disabled";
    // where a rule can send the work: any other step, Done - or a step
    // that does not exist yet, because "approved" usually means "now
    // somebody else takes it", and that somebody needs a step to hold it
    const targets = draft.map((x, j) => j === i ? null :
      '<option value="' + esc(x.id) + '">' + (j < i ? "↩ " : "→ ") + (j + 1) + ". " + esc(labelOf(x)) + '</option>').filter(Boolean).join("") +
      '<option value="done">→ Done</option>' +
      (owner ? '<option value="new">→ Someone else (adds a step after this one)</option>' : "");
    const routeRow = (r, k) => {
      const w = r.when || {};
      const what = w.kind === "choice" ? "choice:" + w.value : "field:" + (w.key || "");
      const fdef = w.kind === "field" ? fields.find(f => f.key === w.key) : null;
      return '<div class="fl-route" data-k="' + k + '">' +
        '<span class="fl-rule-w">If</span>' +
        '<select class="fl-r-what"' + dis + '>' +
          choices.map(c => '<option value="choice:' + esc(c) + '"' + (what === "choice:" + c ? " selected" : "") + '>they pick ' + esc(c) + '</option>').join("") +
          fields.map(f => '<option value="field:' + esc(f.key) + '"' + (what === "field:" + f.key ? " selected" : "") + '>' + esc(f.label || f.key) + '</option>').join("") +
        '</select>' +
        (w.kind === "field"
          ? '<select class="fl-r-op"' + dis + '>' + [["==", "is"], ["!=", "is not"], ["contains", "contains"], [">", "is over"], ["<", "is under"]].map(([v, l]) =>
              '<option value="' + v + '"' + ((w.op || "==") === v ? " selected" : "") + '>' + l + '</option>').join("") + '</select>' +
            (fdef && (fdef.type === "select" || fdef.type === "multiselect") && (fdef.options || []).length
              ? '<select class="fl-r-val"' + dis + '>' + fdef.options.map(o => '<option value="' + esc(o) + '"' + (String(w.value) === o ? " selected" : "") + '>' + esc(o) + '</option>').join("") + '</select>'
              : fdef && fdef.type === "checkbox"
                ? '<select class="fl-r-val"' + dis + '><option value="true"' + (w.value === true ? " selected" : "") + '>ticked</option><option value="false"' + (w.value === false ? " selected" : "") + '>not ticked</option></select>'
                : '<input class="fl-r-val" type="text" maxlength="60" placeholder="value" value="' + esc(w.value == null ? "" : String(w.value)) + '"' + dis + '>')
          : "") +
        '<span class="fl-rule-w">go to</span>' +
        '<select class="fl-r-to"' + dis + '>' + targets.replace('value="' + esc(r.to || "") + '"', 'value="' + esc(r.to || "") + '" selected') + '</select>' +
        (owner ? '<button type="button" class="fl-ic fl-ic-x fl-r-del" title="Remove this rule" aria-label="Remove this rule">×</button>' : "") +
      '</div>';
    };
    const after =
      '<details class="fl-after"' + (choices.length || routes.length || st.together ? " open" : "") + '>' +
        '<summary>After this step' + (routes.length ? ' <i>' + routes.length + (routes.length === 1 ? " rule" : " rules") + '</i>' : "") +
          (choices.length ? ' <i>' + choices.length + (choices.length === 1 ? " choice" : " choices") + '</i>' : "") +
          (st.together ? ' <i>together</i>' : "") + (st.rates ? ' <i>rates</i>' : "") + '</summary>' +
        '<p class="fl-lbl">When they finish, they pick <i>optional</i></p>' +
        '<div class="fl-chips fl-choices">' +
          choices.map(c => '<span class="fl-chip is-on fl-choice">' + esc(c) +
            (owner ? '<button type="button" class="fl-choice-x" data-choice="' + esc(c) + '" aria-label="Remove ' + esc(c) + '">×</button>' : "") + '</span>').join("") +
          (owner ? '<span class="fl-choice-add"><input type="text" class="fl-choice-in" maxlength="24" placeholder="' + (choices.length ? "another…" : "e.g. Approve") + '">' +
            '<button type="button" class="fl-ic fl-choice-go" aria-label="Add this choice">+</button></span>' : "") +
        '</div>' +
        '<p class="fl-lbl">Then</p>' +
        routes.map(routeRow).join("") +
        '<p class="fl-otherwise">' + (routes.length ? "Otherwise" : "It goes") + ' → <b>' + esc(otherwiseOf(i)) + '</b>' +
          (owner && otherwiseOf(i) === "Done" ? ' <button type="button" class="fl-link fl-next-add">+ Hand it to someone else next</button>' : "") + '</p>' +
        (owner ? '<button type="button" class="fl-link fl-route-add">+ Add an if</button>' : "") +
        (i > 0 && owner ? '<label class="fl-together"><input type="checkbox" class="fl-together-in"' + (st.together ? " checked" : "") + '> Runs at the same time as the step before it</label>' : "") +
        (i > 0 ? '<label class="fl-together fl-rates"><input type="checkbox" class="fl-rates-in"' + (st.rates ? " checked" : "") + (owner ? "" : " disabled") + '> Rates the work it receives <i>three scores, 1 to 5, feeds the leaderboard</i></label>' : "") +
      '</details>';
    /* At a glance: one line says who does it, how long they have, what
       it marks the work as, and what they decide. The controls only
       appear on the card that is open, so a six-step flow reads as six
       lines and not six forms. */
    const isOpen = flS.open === i;
    const names = on.length ? on.map(u => orgPersonName(u)).join(", ") : "";
    const whoChip = !st.roleId ? '<span class="fl-sum-chip is-warn">Nobody chosen</span>'
      : gap ? '<span class="fl-sum-chip is-warn">' + esc(st.roleId === HO_ANY ? "Anyone" : orgRoleName(st.roleId)) + ' · nobody yet</span>'
      : '<span class="fl-sum-chip is-who">' + esc(st.roleId === HO_ANY ? "Anyone" : orgRoleName(st.roleId)) + (names ? ' · ' + esc(names) : (inRole.length > 1 ? ' · any of ' + inRole.length : '')) + '</span>';
    const summary = '<button type="button" class="fl-sum" aria-expanded="' + (isOpen ? "true" : "false") + '" aria-label="' + (isOpen ? "Close" : "Open") + ' this step">' +
      whoChip +
      (st.dueAfter ? '<span class="fl-sum-chip">' + Math.round(st.dueAfter / HO_DAY) + (Math.round(st.dueAfter / HO_DAY) === 1 ? " day" : " days") + '</span>' : '') +
      (st.status ? '<span class="fl-sum-chip">marks it ' + esc(flStatusName(type, st.status)) + '</span>' : '') +
      (choices.length ? '<span class="fl-sum-chip">' + choices.map(esc).join(" / ") + '</span>' : '') +
      (routes.length ? '<span class="fl-sum-chip">' + routes.length + (routes.length === 1 ? " if" : " ifs") + '</span>' : '') +
      (st.rates ? '<span class="fl-sum-chip">rates</span>' : '') +
      '<i class="fl-sum-caret" aria-hidden="true"></i>' +
      '</button>';
    return '<div class="fl-step' + (gap ? " gap" : "") + (flS.drag === i ? " is-drag" : "") + (isOpen ? " is-open" : " is-shut") + '" data-i="' + i + '"' +
        (owner ? ' draggable="true"' : "") + '>' +
      '<div class="fl-step-head">' +
        (owner ? '<span class="fl-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>' : "") +
        '<span class="fl-n">' + (i + 1) + '</span>' +
        '<input class="fl-name" type="text" maxlength="40" placeholder="What happens at this step" value="' + esc(st.label || "") + '"' + dis + '>' +
        (owner ? '<span class="fl-step-acts">' +
          '<button type="button" class="fl-ic" data-move="-1" title="Move up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + '>↑</button>' +
          '<button type="button" class="fl-ic" data-move="1" title="Move down" aria-label="Move down"' + (i === draft.length - 1 ? " disabled" : "") + '>↓</button>' +
          '<button type="button" class="fl-ic fl-ic-x" data-del="1" title="Remove this step" aria-label="Remove this step">×</button></span>' : "") +
      '</div>' +
      summary +
      (isOpen ? '<div class="fl-step-body">' +
      '<p class="fl-lbl">Who does it</p>' +
      '<div class="fl-chips">' +
        '<button type="button" class="fl-chip' + (st.roleId === HO_ANY ? " is-on" : "") + '" data-role="' + esc(HO_ANY) + '"' + dis + '>Anyone</button>' +
        roles.map(r => '<button type="button" class="fl-chip' + (r.id === st.roleId ? " is-on" : "") + '" data-role="' + esc(r.id) + '"' + dis + '>' +
          esc(r.name) + '<i>' + members.filter(m => m.roleId === r.id).length + '</i></button>').join("") +
      '</div>' +
      (st.roleId
        ? '<div class="fl-people' + (gap ? " is-gap" : "") + '">' +
            (inRole.length
              ? '<p class="fl-lbl">' + (on.length ? esc("Only these " + on.length) : esc("Any of these " + inRole.length)) +
                  (owner ? ' <i>tick, or drag a person here</i>' : "") + '</p>' +
                inRole.map(m => '<button type="button" class="fl-av' + (on.indexOf(m.uid) >= 0 ? " is-on" : "") + '" data-uid="' + esc(m.uid) + '"' + dis + '>' +
                  '<b>' + esc(flInitial(orgPersonName(m.uid))) + '</b>' + esc(orgPersonName(m.uid)) + '</button>').join("")
              : '<p class="fl-warn">Nobody is ' + esc(st.roleId === HO_ANY ? "in this organization" : orgRoleName(st.roleId)) +
                  ' right now, so work would wait here.' + (owner ? ' Drag a person here, or invite one.' : "") + '</p>') +
          '</div>'
        : '<p class="fl-warn">Pick who does this step.</p>') +
      '<div class="fl-opts">' +
        '<label class="fl-opt"><span>Days to finish</span><span class="fl-days"><input type="number" min="1" max="365" placeholder="No limit" value="' +
          esc(st.dueAfter ? String(Math.round(st.dueAfter / HO_DAY)) : "") + '"' + dis + '><em>days</em></span></label>' +
        '<div class="fl-opt"><span>While it is at this step, its status is</span><div class="fl-chips fl-chips-sm">' +
          '<button type="button" class="fl-chip' + (!st.status ? " is-on" : "") + '" data-status=""' + dis + '>Don\'t change</button>' +
          (type.statuses || []).map(x => '<button type="button" class="fl-chip' + (x.key === st.status ? " is-on" : "") + '" data-status="' + esc(x.key) + '"' + dis + '>' + esc(x.label || x.key) + '</button>').join("") +
        '</div></div>' +
      '</div>' +
      after +
      '</div>' : "") +
    '</div>';
  };

  /* Steps that run together stand in one column under a shared label,
     so "two or three at once" looks like what it is; the + between
     groups adds a step in the line, the + inside a group adds one that
     runs alongside. */
  const steps = draft.length
    ? groups.map(g => plus(g.from) + (g.from === g.to
        ? card(draft[g.from], g.from)
        : '<div class="fl-par"><p class="fl-par-h">At the same time</p>' +
            draft.slice(g.from, g.to + 1).map((st, k) => card(st, g.from + k)).join("") +
            plus(g.to + 1, true) + '</div>')).join("") + plus(draft.length)
    : '<div class="fl-none">' +
        '<p>No steps yet. Whoever is given a ' + esc(type.name || "task") + ' does all of it.</p>' +
        (owner ? '<div class="fl-starts"><span>Start with</span>' +
          orgTrackStarts().map(q => '<button type="button" class="fl-start-btn" data-start="' + esc(q.key) + '">' + esc(q.label) + '</button>').join("") +
          '<button type="button" class="fl-start-btn" data-start="blank">A blank step</button></div>' : "") +
      '</div>';

  $("flCanvas").innerHTML = start + steps + end;
  flBindCanvas();
}

function flBindCanvas(){
  const c = $("flCanvas");
  if (!orgIsOwner()) return;
  const type = flType();
  const touch = () => { flS.dirty = true; flPaintBar(); };
  const redraw = () => { flPaintCanvas(); flPaintBar(); };

  if ($("flEditKind")) $("flEditKind").onclick = () => orgTypeSheet(type);
  c.querySelectorAll(".fl-start-btn").forEach(b => b.onclick = () => {
    const starts = orgTrackStarts();
    const q = starts.find(x => x.key === b.dataset.start);
    flS.draft = q ? JSON.parse(JSON.stringify(q.steps)) : [flBlankStep()];
    touch(); redraw();
  });
  c.querySelectorAll(".fl-plus").forEach(b => b.onclick = () => {
    const at = +b.dataset.at;
    const st = flBlankStep();
    // a step added inside a group joins it; one added between groups
    // stands on its own, and if it lands where a member used to be the
    // member behind it keeps running alongside the new one
    if (b.dataset.together) st.together = true;
    flS.draft.splice(at, 0, st);
    flS.open = at;   // a new step is the one being worked on
    touch(); redraw();
    const inp = c.querySelector('.fl-step[data-i="' + b.dataset.at + '"] .fl-name');
    if (inp) inp.focus();
  });

  c.querySelectorAll(".fl-step").forEach(card => {
    const i = +card.dataset.i;
    const st = () => flS.draft[i];
    // the summary line opens the card's controls, and closes them again
    const sum = card.querySelector(".fl-sum");
    if (sum) sum.onclick = () => { flS.open = flS.open === i ? null : i; flPaintCanvas(); };
    card.querySelector(".fl-name").oninput = e => { st().label = e.target.value; touch(); };
    card.querySelectorAll("[data-move]").forEach(b => b.onclick = () => {
      const to = i + (+b.dataset.move);
      flS.draft = flMove(flS.draft, i, to);
      if (flS.open === i) flS.open = to;
      touch(); redraw();
    });
    const del = card.querySelector("[data-del]");
    if (del) del.onclick = () => { flS.draft.splice(i, 1); if (flS.open === i) flS.open = null; touch(); redraw(); };
    card.querySelectorAll("[data-role]").forEach(b => b.onclick = () => {
      if (st().roleId === b.dataset.role) return;
      st().roleId = b.dataset.role; st().assignees = []; touch(); redraw();
    });
    card.querySelectorAll(".fl-av").forEach(b => b.onclick = () => {
      flS.draft[i] = flToggle(st(), b.dataset.uid); touch(); redraw();
    });
    card.querySelectorAll("[data-status]").forEach(b => b.onclick = () => {
      st().status = b.dataset.status; touch(); redraw();
    });
    const days = card.querySelector(".fl-days input");
    if (days) days.onchange = e => {
      const d = parseFloat(e.target.value);
      st().dueAfter = d > 0 ? d * HO_DAY : null; touch();
    };

    // ---- after this step: choices, rules, together ----
    const addChoice = () => {
      const inp = card.querySelector(".fl-choice-in");
      const v = (inp.value || "").trim();
      if (!v) return;
      const list = st().choices || [];
      if (list.indexOf(v) >= 0) { toast("That choice is already there."); return; }
      st().choices = list.concat([v]); touch(); redraw();
      const again = c.querySelector('.fl-step[data-i="' + i + '"] .fl-choice-in');
      if (again) again.focus();
    };
    const go = card.querySelector(".fl-choice-go");
    if (go) go.onclick = addChoice;
    const cin = card.querySelector(".fl-choice-in");
    if (cin) cin.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); addChoice(); } };
    card.querySelectorAll(".fl-choice-x").forEach(b => b.onclick = () => {
      const v = b.dataset.choice;
      st().choices = (st().choices || []).filter(x => x !== v);
      // a rule that read the choice has nothing to read now
      st().routes = (st().routes || []).filter(r => !(r.when && r.when.kind === "choice" && r.when.value === v));
      touch(); redraw();
    });
    // "then somebody else takes it": a new step right after this one (or
    // after its group), which is what "otherwise" now points at
    const focusName = () => { const inp = c.querySelector('.fl-step[data-i="' + flS.open + '"] .fl-name'); if (inp) inp.focus(); };
    const nextAdd = card.querySelector(".fl-next-add");
    if (nextAdd) nextAdd.onclick = () => { flAddAfter(i); touch(); redraw(); focusName(); };
    const addRoute = card.querySelector(".fl-route-add");
    if (addRoute) addRoute.onclick = () => {
      const ch = st().choices || [], fs = type.fields || [];
      if (!ch.length && !fs.length) { toast("Add a choice above, or give this kind of work a field, for a rule to look at."); return; }
      const when = ch.length ? { kind: "choice", value: ch[0] } : { kind: "field", key: fs[0].key, op: "==", value: "" };
      st().routes = (st().routes || []).concat([{ when, to: "done" }]); touch(); redraw();
    };
    card.querySelectorAll(".fl-route").forEach(row => {
      const k = +row.dataset.k;
      const r = () => st().routes[k];
      row.querySelector(".fl-r-what").onchange = e => {
        const v = e.target.value;
        r().when = v.indexOf("choice:") === 0 ? { kind: "choice", value: v.slice(7) }
          : { kind: "field", key: v.slice(6), op: (r().when && r().when.op) || "==", value: "" };
        touch(); redraw();
      };
      const op = row.querySelector(".fl-r-op");
      if (op) op.onchange = e => { r().when.op = e.target.value; touch(); };
      const val = row.querySelector(".fl-r-val");
      if (val) val.onchange = val.oninput = e => {
        // typed as text, stored as the field's own type: the rule compares
        // with ===, so "42" would never equal 42 and a tick is not "true"
        const fdef = (type.fields || []).find(f => f.key === r().when.key);
        const raw = e.target.value;
        r().when.value = fdef && typeof itemCoerce === "function" ? itemCoerce(fdef, raw) : raw;
        if (fdef && fdef.type === "checkbox") r().when.value = raw === "true";
        touch();
      };
      row.querySelector(".fl-r-to").onchange = e => {
        if (e.target.value === "new") { r().to = flAddAfter(i).id; touch(); redraw(); focusName(); return; }
        r().to = e.target.value; touch();
      };
      const del = row.querySelector(".fl-r-del");
      if (del) del.onclick = () => { st().routes.splice(k, 1); touch(); redraw(); };
    });
    const tog = card.querySelector(".fl-together-in");
    if (tog) tog.onchange = e => { st().together = !!e.target.checked; touch(); redraw(); };
    const rt = card.querySelector(".fl-rates-in");
    if (rt) rt.onchange = e => { st().rates = !!e.target.checked; touch(); redraw(); };

    /* Drag: a card by its grip to reorder; a person from the panel onto
       a card to give the step to them. Both arrive here as drops, told
       apart by what the drag carried. The inputs inside a card must not
       start a card drag, or typing a name would pick the card up. */
    card.ondragstart = e => {
      if (e.target !== card) return;
      flS.drag = i;
      try { e.dataTransfer.setData("text/plain", "step:" + i); e.dataTransfer.effectAllowed = "move"; } catch (x) {}
      card.classList.add("is-drag");
    };
    card.querySelectorAll("input,button").forEach(el => el.setAttribute("draggable", "false"));
    card.ondragend = () => { flS.drag = null; card.classList.remove("is-drag"); c.querySelectorAll(".is-over").forEach(x => x.classList.remove("is-over")); };
    card.ondragover = e => { e.preventDefault(); card.classList.add("is-over"); };
    card.ondragleave = () => card.classList.remove("is-over");
    card.ondrop = e => {
      e.preventDefault();
      card.classList.remove("is-over");
      let data = "";
      try { data = e.dataTransfer.getData("text/plain") || ""; } catch (x) {}
      if (data.indexOf("person:") === 0) {
        const m = (orgS.members || []).find(x => x.uid === data.slice(7));
        if (m) { flS.draft[i] = flGive(st(), m); touch(); redraw(); }
      } else if (flS.drag !== null && flS.drag !== i) {
        if (flS.open === flS.drag) flS.open = i;
        flS.draft = flMove(flS.draft, flS.drag, i); flS.drag = null; touch(); redraw();
      }
    };
  });
}

/* ---------- the rules lane ----------
   A rule is one sentence with a switch: what happens by itself, and
   whether it is on. Editing is a sheet that asks three things - WHEN
   (created, marked a status, given to someone, edited), ONLY IF (one
   field of this kind, optional) and THEN (tell people, mark it, give it
   to someone, set a field). Rules for every kind of work show here too,
   tagged, because what fires for this kind is what an admin needs to
   see in one place. */

function flRules(){
  const type = flType();
  return (orgS.automations || []).filter(a => (a.trigger || {}).typeId === type.id);
}
const flRuleIco = kind => ({
  notify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  set_status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10l6 5-6 5H4z"/></svg>',
  assign: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.4"/><path d="M3.5 20c0-3.3 2.9-5.6 6.5-5.6 1.5 0 2.9.4 4 1.1"/><path d="M18 14.5v6M15 17.5h6"/></svg>',
  set_field: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>'
}[kind] || "");

function flRuleOpts(type){
  return { typeName: type ? (type.name || type.id) : null,
    fieldNameOf: k => { const f = ((type && type.fields) || []).find(x => x.key === k); return f ? (f.label || f.key) : k; },
    personNameOf: uid => orgPersonName(uid) };
}

function flPaintRules(){
  const type = flType(), owner = orgIsOwner();
  const mine = flRules();
  const every = (orgS.automations || []).filter(a => !(a.trigger || {}).typeId);
  const words = (a, forType) => flRuleWords(a, orgRoleName, k => flStatusName(type, k), forType ? flRuleOpts(type) : flRuleOpts(null));
  const row = (a, forType) => {
    const kind = ((a.actions || [])[0] || {}).kind;
    const on = a.enabled !== false;
    return '<div class="fl-rule' + (on ? "" : " is-off") + '" data-id="' + esc(a.id) + '">' +
      (owner ? '<button type="button" class="fl-sw' + (on ? " is-on" : "") + '" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-toggle="' + esc(a.id) + '" title="' + (on ? "On - press to turn off" : "Off - press to turn on") + '"><i></i></button>' : '') +
      '<span class="fl-rule-ico">' + flRuleIco(kind) + '</span>' +
      '<span class="fl-rule-t"><b>' + esc(words(a, forType)) + '</b>' +
        (!forType ? '<small>Every kind of work</small>' : (a.name && a.name !== words(a, forType) ? '<small>' + esc(a.name) + '</small>' : '')) + '</span>' +
      (owner ? '<button type="button" class="fl-rule-edit" data-edit="' + esc(a.id) + '">Edit</button>' : '') +
    '</div>';
  };
  $("flRules").innerHTML =
    '<div class="fl-lane-head"><h4>Happens by itself</h4>' +
      '<p class="fl-note">What the app does on its own when a ' + esc(type.name || type.id) + ' changes. Steps move the work; rules only react.</p>' +
      (owner ? '<button type="button" class="org-btn org-btn-sm" id="flRuleAdd">+ Add a rule</button>' : "") + '</div>' +
    (mine.length || every.length
      ? '<div class="fl-rules">' + mine.map(a => row(a, true)).join("") + every.map(a => row(a, false)).join("") + '</div>'
      : '<p class="fl-note fl-note-sm">Nothing happens by itself yet.' + (owner ? ' Add a rule to tell someone when work arrives, or to mark it when it is given away.' : '') + '</p>');

  if (!owner) return;
  $("flRuleAdd").onclick = () => flRuleSheet(flRuleBlank(type.id, orgS.roles || []));
  $("flRules").querySelectorAll("[data-edit]").forEach(b => b.onclick = () =>
    flRuleSheet((orgS.automations || []).find(a => a.id === b.dataset.edit)));
  $("flRules").querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => flRuleToggle(b.dataset.toggle, b));
}

/* On or off, without deleting: a rule that is wrong for this week is
   not a rule to rebuild next week. */
async function flRuleToggle(id, btn){
  const a = (orgS.automations || []).find(x => x.id === id);
  if (!a) return;
  const next = a.enabled === false;
  btn.disabled = true;
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(id).update({ enabled: next, updatedAt: Date.now() });
    itemsAutomationsCache = null;
    a.enabled = next;
    flPaintRules();
    toast(next ? "Rule on." : "Rule off - it stays here until you delete it.");
  } catch (e) { console.error(e); btn.disabled = false; toast("Could not change the rule."); }
}

/* The sheet: three questions, every answer a choice from this kind's
   own statuses, fields, roles and people - nothing typed exactly. */
function flRuleSheet(rule){
  const type = flType();
  const roles = (orgS.roles || []).filter(r => r.id !== "owner").concat((orgS.roles || []).filter(r => r.id === "owner"));
  const fields = type.fields || [], statuses = type.statuses || [], members = orgS.members || [];
  const a = JSON.parse(JSON.stringify(rule));
  a.trigger = a.trigger || { verb: "item.created" };
  a.conditions = a.conditions || [];
  a.actions = a.actions && a.actions.length ? a.actions : [{ kind: "notify" }];
  const stc = a.conditions.find(c => c && c.source === "task" && c.path === "status");
  const fc = a.conditions.find(c => c && c.source === "field");
  // the working copy the controls edit; the document is built from it on save
  const w = {
    verb: a.trigger.verb || "item.created", status: stc ? stc.value : (statuses[0] || {}).key || "",
    cond: fc ? { key: fc.path, op: fc.op || "==", value: fc.value } : null,
    act: Object.assign({ kind: "notify" }, a.actions[0]),
    everyKind: !a.trigger.typeId && !!a.id
  };
  if (w.act.kind === "notify" && !w.act.toWhom && !w.act.toRole) w.act.toRole = (roles[0] || {}).id || null;
  const chip = (cls, v, label, on, extra) => '<button type="button" class="fl-chip' + (on ? " is-on" : "") + ' ' + cls + '" data-v="' + esc(v) + '"' + (extra || "") + '>' + label + '</button>';
  const opt = (v, label, on) => '<option value="' + esc(v) + '"' + (on ? " selected" : "") + '>' + esc(label) + '</option>';

  const paint = () => {
    const fdef = w.cond ? fields.find(f => f.key === w.cond.key) : null;
    const whenHtml =
      '<div class="fl-chips">' +
        chip("fr-verb", "item.created", "is created", w.verb === "item.created") +
        (statuses.length ? chip("fr-verb", "item.status_changed", "is marked…", w.verb === "item.status_changed") : "") +
        chip("fr-verb", "item.assigned", "is given to someone", w.verb === "item.assigned") +
        chip("fr-verb", "item.updated", "is edited", w.verb === "item.updated") +
      '</div>' +
      (w.verb === "item.status_changed" ? '<div class="fl-chips fl-chips-sm fr-sub">' +
        statuses.map(x => chip("fr-status", x.key, esc(x.label || x.key), w.status === x.key)).join("") + '</div>' : "");
    const condHtml = !fields.length ? '<p class="fl-note fl-note-sm">This kind has no fields to check.</p>' :
      '<div class="fl-rule-if">' +
        '<select id="frCondKey"><option value="">Always</option>' + fields.map(f => opt(f.key, "only if " + (f.label || f.key), w.cond && w.cond.key === f.key)).join("") + '</select>' +
        (w.cond ? '<select id="frCondOp">' + [["==", "is"], ["!=", "is not"], ["contains", "contains"], [">", "is over"], ["<", "is under"]].map(([v, l]) => opt(v, l, w.cond.op === v)).join("") + '</select>' +
          (fdef && (fdef.type === "select" || fdef.type === "multiselect") && (fdef.options || []).length
            ? '<select id="frCondVal">' + fdef.options.map(o => opt(o, o, String(w.cond.value) === o)).join("") + '</select>'
            : fdef && fdef.type === "checkbox"
              ? '<select id="frCondVal">' + opt("true", "ticked", w.cond.value === true) + opt("false", "not ticked", w.cond.value === false) + '</select>'
              : '<input id="frCondVal" type="text" maxlength="60" placeholder="value" value="' + esc(w.cond.value == null ? "" : String(w.cond.value)) + '">') : "") +
      '</div>';
    const k = w.act.kind;
    let params = "";
    if (k === "notify") {
      const who = w.act.toWhom || "role";
      params = '<p class="fl-lbl">Tell</p><div class="fl-chips fl-chips-sm">' +
        chip("fr-who", "assignees", "whoever holds it", who === "assignees") +
        chip("fr-who", "creator", "whoever created it", who === "creator") +
        roles.map(r => chip("fr-who", "role:" + r.id, esc(r.name) + '<i>' + members.filter(m => m.roleId === r.id).length + '</i>', who === "role" && w.act.toRole === r.id)).join("") + '</div>' +
        '<label class="fl-opt fr-msg"><span>Saying</span><input id="frMsg" type="text" maxlength="140" placeholder="e.g. A new one is in - please pick it up" value="' + esc(w.act.message || "") + '"></label>';
    } else if (k === "set_status") {
      params = '<p class="fl-lbl">Mark it as</p>' + (statuses.length ? '<div class="fl-chips fl-chips-sm">' +
        statuses.map(x => chip("fr-set-status", x.key, esc(x.label || x.key), w.act.status === x.key)).join("") + '</div>' : '<p class="fl-note fl-note-sm">This kind has no statuses.</p>');
    } else if (k === "assign") {
      params = '<p class="fl-lbl">Give it to <i>tick one or more</i></p><div class="fl-chips fl-chips-sm">' +
        members.map(m => chip("fr-assign", m.uid, esc(orgPersonName(m.uid)), (w.act.assigneeIds || []).indexOf(m.uid) >= 0)).join("") + '</div>';
    } else {
      params = '<p class="fl-lbl">Set</p>' + (fields.length ? '<div class="fl-rule-if">' +
        '<select id="frFieldKey">' + fields.map(f => opt(f.key, f.label || f.key, w.act.key === f.key)).join("") + '</select>' +
        '<span class="fl-rule-w">to</span><input id="frFieldVal" type="text" maxlength="60" placeholder="value" value="' + esc(w.act.value == null ? "" : String(w.act.value)) + '"></div>'
        : '<p class="fl-note fl-note-sm">This kind has no fields to set.</p>');
    }
    const thenHtml =
      '<div class="fl-chips">' +
        chip("fr-kind", "notify", "Tell people", k === "notify") +
        chip("fr-kind", "set_status", "Mark it", k === "set_status") +
        chip("fr-kind", "assign", "Give it to someone", k === "assign") +
        chip("fr-kind", "set_field", "Set a field", k === "set_field") +
      '</div><div class="fr-sub">' + params + '</div>';
    const preview = flRuleWords(flRuleBuild(w, type), orgRoleName, kk => flStatusName(type, kk), flRuleOpts(w.everyKind ? null : type));

    $("sheetBody").innerHTML =
      '<h2>' + (a.id ? "Edit rule" : "New rule") + '</h2>' +
      '<p class="fr-preview" id="frPreview">' + esc(preview) + '</p>' +
      '<p class="fl-lbl">When a ' + esc(type.name || type.id) + (w.everyKind ? ' <i>(and every other kind)</i>' : '') + '…</p>' + whenHtml +
      '<p class="fl-lbl">Only if</p>' + condHtml +
      '<p class="fl-lbl">Then</p>' + thenHtml +
      '<label class="fl-opt fr-name"><span>Name <i>optional</i></span><input id="frName" type="text" maxlength="60" placeholder="' + esc(preview.slice(0, 60)) + '" value="' + esc(a.name && a.name !== preview ? a.name : "") + '"></label>' +
      '<div class="org-actions"><button type="button" class="org-btn" id="frSave">' + (a.id ? "Save rule" : "Add rule") + '</button>' +
        (a.id ? '<button type="button" class="org-btn org-btn-danger" id="frDelete">Delete</button>' : '') +
        '<button type="button" class="org-btn org-btn-sm" id="frCancel">Cancel</button></div>';
    bind();
  };
  const bind = () => {
    const q = sel => $("sheetBody").querySelector(sel);
    const all = sel => [...$("sheetBody").querySelectorAll(sel)];
    all(".fr-verb").forEach(b => b.onclick = () => { w.verb = b.dataset.v; paint(); });
    all(".fr-status").forEach(b => b.onclick = () => { w.status = b.dataset.v; paint(); });
    all(".fr-kind").forEach(b => b.onclick = () => { if (w.act.kind !== b.dataset.v) { w.act = { kind: b.dataset.v }; if (w.act.kind === "notify") w.act.toRole = (roles[0] || {}).id || null; } paint(); });
    all(".fr-who").forEach(b => b.onclick = () => {
      const v = b.dataset.v;
      if (v.indexOf("role:") === 0) { w.act.toRole = v.slice(5); delete w.act.toWhom; } else { w.act.toWhom = v; w.act.toRole = null; }
      paint();
    });
    all(".fr-set-status").forEach(b => b.onclick = () => { w.act.status = b.dataset.v; paint(); });
    all(".fr-assign").forEach(b => b.onclick = () => {
      const ids = w.act.assigneeIds || [];
      w.act.assigneeIds = ids.indexOf(b.dataset.v) >= 0 ? ids.filter(x => x !== b.dataset.v) : ids.concat([b.dataset.v]);
      paint();
    });
    const ck = q("#frCondKey");
    if (ck) ck.onchange = () => { w.cond = ck.value ? { key: ck.value, op: "==", value: "" } : null; paint(); };
    const co = q("#frCondOp");
    if (co) co.onchange = () => { w.cond.op = co.value; refresh(); };
    const cv = q("#frCondVal");
    if (cv) cv.onchange = cv.oninput = () => {
      const fdef = fields.find(f => f.key === w.cond.key);
      w.cond.value = fdef && fdef.type === "checkbox" ? cv.value === "true" : (fdef && typeof itemCoerce === "function" ? itemCoerce(fdef, cv.value) : cv.value);
      refresh();
    };
    const msg = q("#frMsg"); if (msg) msg.oninput = () => { w.act.message = msg.value; refresh(); };
    const fk = q("#frFieldKey"); if (fk) fk.onchange = () => { w.act.key = fk.value; refresh(); };
    const fv = q("#frFieldVal"); if (fv) fv.oninput = () => { w.act.value = fv.value; refresh(); };
    q("#frCancel").onclick = closeSheet;
    q("#frSave").onclick = () => flRuleCommit(a, w, type, (q("#frName").value || "").trim());
    if (q("#frDelete")) q("#frDelete").onclick = () => flRuleDelete(a, q("#frDelete"));
  };
  // typing changes the sentence, not the whole sheet
  const refresh = () => {
    const p = $("frPreview");
    if (p) p.textContent = flRuleWords(flRuleBuild(w, type), orgRoleName, kk => flStatusName(type, kk), flRuleOpts(w.everyKind ? null : type));
  };
  openSheet("", paint);
}

/* The document the working copy means. Pure, so the preview and the
   save cannot disagree about what a rule says. */
function flRuleBuild(w, type){
  const conditions = [];
  if (w.verb === "item.status_changed" && w.status) conditions.push({ source: "task", path: "status", op: "==", value: w.status });
  if (w.cond && w.cond.key) conditions.push({ source: "field", path: w.cond.key, op: w.cond.op || "==", value: w.cond.value });
  const act = Object.assign({}, w.act);
  if (act.kind === "notify") { act.message = (act.message || "").trim(); if (act.toWhom) act.toRole = null; else delete act.toWhom; }
  if (act.kind === "set_field") act.value = (act.value || "").trim();
  const trigger = { verb: w.verb };
  if (!w.everyKind && type) trigger.typeId = type.id;
  return { trigger, conditions, actions: [act] };
}

/* What a rule still needs before it can be saved, in words the sheet
   shows - a rule that would do nothing is refused here, not wondered
   about later. */
function flRuleProblem(w, type){
  if (w.verb === "item.status_changed" && !w.status) return "Pick which status.";
  if (w.cond && w.cond.key && (w.cond.value === "" || w.cond.value == null)) return "Say what the field has to be, or set it back to Always.";
  const a = w.act;
  if (a.kind === "notify" && !a.toWhom && !a.toRole) return "Who should be told?";
  if (a.kind === "set_status" && !a.status) return "Which status should it be marked?";
  if (a.kind === "assign" && !(a.assigneeIds || []).length) return "Who should it go to?";
  if (a.kind === "set_field" && !a.key) return "Which field should it set?";
  return null;
}

async function flRuleCommit(a, w, type, name){
  const problem = flRuleProblem(w, type);
  if (problem) { toast(problem); return; }
  const built = flRuleBuild(w, type);
  const words = flRuleWords(built, orgRoleName, k => flStatusName(type, k), flRuleOpts(w.everyKind ? null : type));
  const rule = { name: name || words.slice(0, 60), enabled: a.enabled !== false,
    trigger: built.trigger, conditions: built.conditions, actions: built.actions, updatedAt: Date.now() };
  const btn = $("frSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const id = a.id || ("au" + orgNewId());
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(id).set(rule);
    itemsAutomationsCache = null;
    closeSheet();
    toast(a.id ? "Rule saved." : "Rule added.");
    flReload();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = a.id ? "Save rule" : "Add rule";
    toast("Could not save the rule.");
  }
}

async function flRuleDelete(a, btn){
  if (!a.id) return;
  // two taps: the second is the confirmation, same as everywhere else here
  if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Delete?"; return; }
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(a.id).delete();
    itemsAutomationsCache = null;
    closeSheet();
    toast("Rule deleted.");
    flReload();
  } catch (e) { console.error(e); toast("Could not delete the rule."); }
}

/* ---------- people & roles ---------- */

function flPaintPeople(){
  const owner = orgIsOwner();
  const roles = (orgS.roles || []).slice().sort((a, b) => (a.id === "owner" ? -1 : b.id === "owner" ? 1 : (a.name || "").localeCompare(b.name || "")));
  const members = orgS.members || [];
  const me = orgUid();
  const usedBy = new Set((flS.draft || []).map(s => s.roleId));

  const permSummary = r => r.id === "owner" ? "Everything" :
    ((r.permissions || []).length + ((r.permissions || []).length === 1 ? " permission" : " permissions"));
  const roleOpts = m => roles.filter(r => r.id !== "owner").map(r =>
    '<option value="' + esc(r.id) + '"' + (r.id === m.roleId ? " selected" : "") + '>' + esc(r.name) + '</option>').join("");

  /* Each role folds shut: a team of twenty is a list of roles with a
     count, not a column of every name. One line per role - the name, how
     many hold it, what it may do - with the role's own edit button at the
     end. A role opens when pressed, stays as the person left it across
     redraws, and a role a step needs but nobody holds starts open so the
     warning is on screen. Typing a name in the box narrows every role to
     the people who match and opens the ones that have any. */
  const q = (flPeopleFind || "").trim().toLowerCase();
  const matches = m => !q || orgPersonName(m.uid).toLowerCase().indexOf(q) >= 0;
  const group = r => {
    const people = members.filter(m => m.roleId === r.id);
    const shown = q ? people.filter(matches) : people;
    if (q && !shown.length) return "";
    const gap = !people.length && usedBy.has(r.id);
    const open = (q && shown.length) || flOpenRoles.has(r.id) || gap;
    const meta = (people.length ? people.length + (people.length === 1 ? " person" : " people") : "nobody") + " · " + permSummary(r);
    return '<details class="fl-role' + (gap ? " is-gap" : "") + '" data-role-id="' + esc(r.id) + '"' + (open ? " open" : "") + '>' +
      '<summary class="fl-role-head"><i class="fl-role-caret" aria-hidden="true"></i>' +
        '<span class="fl-role-t"><b>' + esc(r.name) + '</b><small class="fl-role-n">' + esc(meta) + '</small></span>' +
        (owner && r.id !== "owner"
          ? '<button type="button" class="fl-role-edit" data-role-edit="' + esc(r.id) + '" title="What ' + esc(r.name) + ' can do" aria-label="What ' + esc(r.name) + ' can do">' + FL_ICO_EDIT + '</button>'
          : "") + '</summary>' +
      '<div class="fl-role-body">' +
      (shown.length
        ? shown.map(m => {
            const name = orgPersonName(m.uid);
            const canMove = owner && m.roleId !== "owner" && m.uid !== me;
            return '<div class="fl-person"' + (owner ? ' draggable="true"' : "") + ' data-uid="' + esc(m.uid) + '">' +
              '<b class="fl-av-b">' + esc(flInitial(name)) + '</b><span>' + esc(name) + '</span>' +
              (canMove ? '<select class="fl-person-role" title="Change their role" aria-label="Change their role">' + roleOpts(m) + '</select>' : "") +
            '</div>';
          }).join("")
        : '<p class="fl-note fl-note-sm">' + (usedBy.has(r.id) ? "Nobody yet, and a step needs one." : "Nobody yet.") + '</p>') +
      '</div></details>';
  };

  const list = roles.map(group).join("");
  $("flPeople").innerHTML =
    '<div class="fl-lane-head"><h4>People &amp; roles</h4>' +
      '<p class="fl-note">' + (owner ? 'Open a role to see who holds it; drag a person onto a step to give it to them.' : 'Who is in which role today.') + '</p></div>' +
    '<label class="fl-find"><input type="search" id="flFind" placeholder="Find a person…" aria-label="Find a person" value="' + esc(flPeopleFind || "") + '"></label>' +
    '<div class="fl-roles">' + (list || '<p class="fl-note fl-note-sm">Nobody named like that.</p>') + '</div>' +
    (owner ? '<div class="org-actions fl-side-acts">' +
      '<button type="button" class="org-btn org-btn-sm" id="flInvite">Invite someone</button>' +
      '<button type="button" class="org-btn org-btn-sm" id="flNewRole">New role</button></div>' : "");

  // remember which roles are open, so a redraw after a move or a save
  // does not fold the list the person was just looking at
  $("flPeople").querySelectorAll("details.fl-role").forEach(d => d.ontoggle = () => {
    if (q) return;   // a search opens folds on its own behalf, not the person's
    if (d.open) flOpenRoles.add(d.dataset.roleId); else flOpenRoles.delete(d.dataset.roleId);
  });
  const find = $("flFind");
  find.oninput = () => {
    flPeopleFind = find.value;
    const at = find.selectionStart;
    flPaintPeople();
    const again = $("flFind"); again.focus(); try { again.setSelectionRange(at, at); } catch (e) {}
  };
  if (!owner) return;
  $("flInvite").onclick = () => orgInviteSheet();
  $("flNewRole").onclick = () => orgRoleSheet(null);
  // the button sits inside the summary: it must open the sheet, not fold the role
  $("flPeople").querySelectorAll("[data-role-edit]").forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    orgRoleSheet((orgS.roles || []).find(r => r.id === b.dataset.roleEdit));
  });
  $("flPeople").querySelectorAll(".fl-person").forEach(p => {
    p.ondragstart = e => {
      try { e.dataTransfer.setData("text/plain", "person:" + p.dataset.uid); e.dataTransfer.effectAllowed = "copy"; } catch (x) {}
      p.classList.add("is-drag");
    };
    p.ondragend = () => p.classList.remove("is-drag");
    const sel = p.querySelector(".fl-person-role");
    if (sel) sel.onchange = () => flMoveRole(p.dataset.uid, sel.value, sel);
  });
}

/* Move a person into another role. The same write orgMemberSaveRole makes
   from the person's card - one field, roleId - because the rules pin a
   delegated seat edit to exactly that (CLAUDE.md > the shift scrubber). */
async function flMoveRole(uid, roleId, sel){
  const m = (orgS.members || []).find(x => x.uid === uid);
  if (!m || !roleId || roleId === m.roleId) return;
  const who = orgPersonName(uid), what = orgRoleName(roleId);
  sel.disabled = true;
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("members").doc(uid).update({ roleId });
    toast(who + " is now " + what + ".");
    flReload();
  } catch (e) {
    console.error(e);
    sel.disabled = false; sel.value = m.roleId;
    toast("Could not change their role.");
  }
}

/* ---------- the bar: the sentence, the state, and save ---------- */

function flPaintBar(){
  const type = flType(), owner = orgIsOwner();
  const line = hoDescribe(flS.draft, flRoleName);
  const live = !!(type.workflowId && (type.track || []).length);
  $("flBar").innerHTML =
    '<p class="fl-sentence">' + (line ? esc("How it flows: " + line) : esc("No steps: whoever is given a " + (type.name || "task") + " does all of it.")) + '</p>' +
    '<div id="flErr"></div>' +
    (owner ? '<div class="fl-bar-acts">' +
      '<span class="fl-state' + (flS.dirty ? " is-dirty" : live ? " is-live" : "") + '">' +
        (flS.dirty ? "Unsaved changes" : live ? "Live · new " + esc(type.name || "work") + " follows these steps" : "Not published") + '</span>' +
      /* Publish is the one verb: it saves the steps, makes them what new
         work follows, and sends any of this kind that was waiting on no
         step to step 1. The owner asked for it by that name (2026-09-13)
         after "Save steps" left them unsure the flow was on. */
      '<button type="button" class="org-btn" id="flSave"' + (flS.draft.length ? "" : " disabled") + '>' + (flS.dirty || !live ? "Publish" : "Publish again") + '</button>' +
      (live && !flS.dirty ? '<button type="button" class="org-btn org-btn-sm" id="flStart">Start a ' + esc(type.name || "task") + '</button>' : "") +
      (live ? '<button type="button" class="org-btn org-btn-sm org-btn-danger" id="flOff">Turn steps off</button>' : "") +
    '</div>' : "");
  if (!owner) return;
  $("flSave").onclick = flSave;
  // the work starts here too: the composer opens on this kind, so the
  // first stop's people get it and the toast names them
  if ($("flStart")) $("flStart").onclick = () => { if (typeof openComposer === "function") openComposer(null, null, null, type.id); };
  if ($("flOff")) $("flOff").onclick = () => orgTrackOff(type);
}

async function flSave(){
  const type = flType();
  const roleIds = (orgS.roles || []).map(r => r.id).concat([HO_ANY]);
  const statusKeys = (type.statuses || []).map(s => s.key);
  const errs = hoTrackErrors(flS.draft, roleIds, statusKeys, orgS.members || [], (type.fields || []).map(f => f.key));
  document.querySelectorAll("#flCanvas .fl-step").forEach(c => c.classList.toggle("bad", errs.some(e => e.at === +c.dataset.i)));
  if (errs.length) {
    $("flErr").innerHTML = '<p class="fl-err">' + errs.map(e => esc((e.at >= 0 ? "Step " + (e.at + 1) + ": " : "") + e.message)).join("<br>") + '</p>';
    return;
  }
  const btn = $("flSave");
  btn.disabled = true; btn.textContent = "Publishing…";
  const r = await orgTrackCommit(type, flS.draft);
  if (!r.ok) {
    btn.disabled = false; btn.textContent = "Publish";
    $("flErr").innerHTML = '<p class="fl-err">' + esc(r.error || "Could not save the steps.") + '</p>';
    return;
  }
  flS.dirty = false; flS.draft = null;
  toast(orgTrackSavedWords(type, r));
  flReload();
}

// after any write: the org is read again, the same kind stays on screen
function flReload(){
  orgInvalidate();
  if (flS) { flS.draft = flS.dirty ? flS.draft : null; }
  enterFlowPage();
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { flMove, flGive, flToggle, flRuleWords, flRuleBlank };
}
