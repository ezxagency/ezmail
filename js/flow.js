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

let flS = null;   // { typeId, draft: [step], dirty, drag: index | null, rules: [unsaved rule rows] }

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

const flBlankStep = () => ({ label: "", roleId: "", assignees: [], status: "", dueAfter: null });

/* A rule as one sentence, for the lane and for a rule's own name when the
   person did not give it one. Rules are stored as trigger + action
   documents; nobody thinks in those, so the lane never shows a verb key. */
function flRuleWords(rule, roleNameOf, statusNameOf){
  const t = ORG_TRIGGERS.find(x => x.verb === ((rule && rule.trigger) || {}).verb);
  const a = ((rule && rule.actions) || [])[0] || {};
  let then = "";
  if (a.kind === "notify") then = "tell " + ((roleNameOf && a.toRole && roleNameOf(a.toRole)) || "a role") + (a.message ? ': "' + a.message + '"' : "");
  else if (a.kind === "set_status") then = "mark it " + ((statusNameOf && a.status && statusNameOf(a.status)) || a.status || "…");
  else if (a.kind === "assign") then = "assign it to " + ((a.assigneeIds || []).length ? (a.assigneeIds.length === 1 ? "one person" : a.assigneeIds.length + " people") : "…");
  else if (a.kind === "set_field") then = "set " + (a.key || "a field") + (a.value != null && a.value !== "" ? " to " + a.value : "");
  else then = "do nothing";
  return "When " + (t ? t.label : "something happens") + ", " + then + ".";
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
    if (!flS || flS.orgId !== orgS.orgId) flS = { orgId: orgS.orgId, typeId: null, draft: null, dirty: false, drag: null, rules: [] };
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
  if (!flS.draft) { flS.draft = JSON.parse(JSON.stringify(type.track || [])); flS.dirty = false; flS.rules = []; }

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

  const start = '<div class="fl-node fl-start">' +
    '<p class="fl-node-k">Start</p><h3>New ' + esc(type.name || type.id) + '</h3>' +
    '<p class="fl-node-s">Made from Assign, kind "' + esc(type.name || type.id) + '". Starts as <b>' +
      esc(flStatusName(type, ((type.statuses || [])[0] || {}).key)) + '</b>.</p>' +
    (owner ? '<button type="button" class="fl-link" id="flEditKind">Fields &amp; statuses…</button>' : "") +
    '</div>';

  const end = '<div class="fl-node fl-end">' +
    '<p class="fl-node-k">End</p><h3>Done</h3>' +
    '<p class="fl-node-s">After the last step it is marked <b>' + esc(doneKey ? flStatusName(type, doneKey) : "done") + '</b>' +
      ' and the person who created it is told.</p>' +
    '</div>';

  const plus = i => owner
    ? '<button type="button" class="fl-plus" data-at="' + i + '" title="Add a step here" aria-label="Add a step here">+</button>'
    : '<span class="fl-plus is-off"></span>';

  const card = (st, i) => {
    const inRole = st.roleId === HO_ANY ? members : st.roleId ? members.filter(m => m.roleId === st.roleId) : [];
    const on = st.assignees || [];
    const gap = gapAt.has(i);
    return '<div class="fl-step' + (gap ? " gap" : "") + (flS.drag === i ? " is-drag" : "") + '" data-i="' + i + '"' +
        (owner ? ' draggable="true"' : "") + '>' +
      '<div class="fl-step-head">' +
        (owner ? '<span class="fl-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>' : "") +
        '<span class="fl-n">' + (i + 1) + '</span>' +
        '<input class="fl-name" type="text" maxlength="40" placeholder="What happens at this step" value="' + esc(st.label || "") + '"' + (owner ? "" : " disabled") + '>' +
        (owner ? '<span class="fl-step-acts">' +
          '<button type="button" class="fl-ic" data-move="-1" title="Move left" aria-label="Move left"' + (i === 0 ? " disabled" : "") + '>‹</button>' +
          '<button type="button" class="fl-ic" data-move="1" title="Move right" aria-label="Move right"' + (i === draft.length - 1 ? " disabled" : "") + '>›</button>' +
          '<button type="button" class="fl-ic fl-ic-x" data-del="1" title="Remove this step" aria-label="Remove this step">×</button></span>' : "") +
      '</div>' +
      '<p class="fl-lbl">Who does it</p>' +
      '<div class="fl-chips">' +
        '<button type="button" class="fl-chip' + (st.roleId === HO_ANY ? " is-on" : "") + '" data-role="' + esc(HO_ANY) + '"' + (owner ? "" : " disabled") + '>Anyone</button>' +
        roles.map(r => '<button type="button" class="fl-chip' + (r.id === st.roleId ? " is-on" : "") + '" data-role="' + esc(r.id) + '"' + (owner ? "" : " disabled") + '>' +
          esc(r.name) + '<i>' + members.filter(m => m.roleId === r.id).length + '</i></button>').join("") +
      '</div>' +
      (st.roleId
        ? '<div class="fl-people' + (gap ? " is-gap" : "") + '">' +
            (inRole.length
              ? '<p class="fl-lbl">' + (on.length ? esc("Only these " + on.length) : esc("Any of these " + inRole.length)) +
                  (owner ? ' <i>tick, or drag a person here</i>' : "") + '</p>' +
                inRole.map(m => '<button type="button" class="fl-av' + (on.indexOf(m.uid) >= 0 ? " is-on" : "") + '" data-uid="' + esc(m.uid) + '"' + (owner ? "" : " disabled") + '>' +
                  '<b>' + esc(flInitial(orgPersonName(m.uid))) + '</b>' + esc(orgPersonName(m.uid)) + '</button>').join("")
              : '<p class="fl-warn">Nobody is ' + esc(st.roleId === HO_ANY ? "in this organization" : orgRoleName(st.roleId)) +
                  ' right now, so work would wait here.' + (owner ? ' Drag a person here, or invite one.' : "") + '</p>') +
          '</div>'
        : '<p class="fl-warn">Pick who does this step.</p>') +
      '<div class="fl-opts">' +
        '<label class="fl-opt"><span>Days to finish</span><span class="fl-days"><input type="number" min="1" max="365" placeholder="No limit" value="' +
          esc(st.dueAfter ? String(Math.round(st.dueAfter / HO_DAY)) : "") + '"' + (owner ? "" : " disabled") + '><em>days</em></span></label>' +
        '<div class="fl-opt"><span>Mark the work as</span><div class="fl-chips fl-chips-sm">' +
          '<button type="button" class="fl-chip' + (!st.status ? " is-on" : "") + '" data-status=""' + (owner ? "" : " disabled") + '>Don\'t change</button>' +
          (type.statuses || []).map(x => '<button type="button" class="fl-chip' + (x.key === st.status ? " is-on" : "") + '" data-status="' + esc(x.key) + '"' + (owner ? "" : " disabled") + '>' + esc(x.label || x.key) + '</button>').join("") +
        '</div></div>' +
      '</div>' +
    '</div>';
  };

  const steps = draft.length
    ? draft.map((st, i) => plus(i) + card(st, i)).join("") + plus(draft.length)
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
    flS.draft.splice(+b.dataset.at, 0, flBlankStep());
    touch(); redraw();
    const inp = c.querySelector('.fl-step[data-i="' + b.dataset.at + '"] .fl-name');
    if (inp) inp.focus();
  });

  c.querySelectorAll(".fl-step").forEach(card => {
    const i = +card.dataset.i;
    const st = () => flS.draft[i];
    card.querySelector(".fl-name").oninput = e => { st().label = e.target.value; touch(); };
    card.querySelectorAll("[data-move]").forEach(b => b.onclick = () => {
      flS.draft = flMove(flS.draft, i, i + (+b.dataset.move)); touch(); redraw();
    });
    const del = card.querySelector("[data-del]");
    if (del) del.onclick = () => { flS.draft.splice(i, 1); touch(); redraw(); };
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
    card.querySelector(".fl-days input").onchange = e => {
      const d = parseFloat(e.target.value);
      st().dueAfter = d > 0 ? d * HO_DAY : null; touch();
    };

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
        flS.draft = flMove(flS.draft, flS.drag, i); flS.drag = null; touch(); redraw();
      }
    };
  });
}

/* ---------- the rules lane ---------- */

function flRules(){
  const type = flType();
  return (orgS.automations || []).filter(a => (a.trigger || {}).typeId === type.id);
}

function flPaintRules(){
  const type = flType(), owner = orgIsOwner();
  const roles = (orgS.roles || []);
  const saved = flRules();
  const rows = saved.concat(flS.rules || []);
  const others = (orgS.automations || []).filter(a => !(a.trigger || {}).typeId).length;

  const opts = (list, val, key, label) => list.map(x =>
    '<option value="' + esc(x[key]) + '"' + (x[key] === val ? " selected" : "") + '>' + esc(x[label]) + '</option>').join("");

  const row = (a, k) => {
    const act = (a.actions || [])[0] || { kind: "notify" };
    const disabled = owner ? "" : " disabled";
    let params = "";
    if (act.kind === "notify")
      params = '<select class="fl-p-role"' + disabled + '>' + opts(roles.filter(r => r.id !== "owner").concat(roles.filter(r => r.id === "owner")), act.toRole, "id", "name") + '</select>' +
        '<input class="fl-p-msg" type="text" maxlength="140" placeholder="saying…" value="' + esc(act.message || "") + '"' + disabled + '>';
    else if (act.kind === "set_status")
      params = '<select class="fl-p-status"' + disabled + '>' + (type.statuses || []).map(s =>
        '<option value="' + esc(s.key) + '"' + (s.key === act.status ? " selected" : "") + '>' + esc(s.label || s.key) + '</option>').join("") + '</select>';
    else if (act.kind === "assign")
      params = '<select class="fl-p-who"' + disabled + '>' + (orgS.members || []).map(m =>
        '<option value="' + esc(m.uid) + '"' + ((act.assigneeIds || []).indexOf(m.uid) >= 0 ? " selected" : "") + '>' + esc(orgPersonName(m.uid)) + '</option>').join("") + '</select>';
    else
      params = '<select class="fl-p-key"' + disabled + '>' + (type.fields || []).map(f =>
        '<option value="' + esc(f.key) + '"' + (f.key === act.key ? " selected" : "") + '>' + esc(f.label || f.key) + '</option>').join("") + '</select>' +
        '<input class="fl-p-val" type="text" maxlength="60" placeholder="to…" value="' + esc(act.value == null ? "" : act.value) + '"' + disabled + '>';
    const cond = (a.conditions || [])[0];
    return '<div class="fl-rule' + (a.id ? "" : " is-new") + '" data-k="' + k + '">' +
      '<span class="fl-rule-w">When</span>' +
      '<select class="fl-r-verb"' + disabled + '>' + opts(ORG_TRIGGERS, (a.trigger || {}).verb, "verb", "label") + '</select>' +
      (cond ? '<span class="fl-rule-if">if ' + esc(cond.path) + ' = ' + esc(String(cond.value)) + '</span>' : "") +
      '<span class="fl-rule-w">then</span>' +
      '<select class="fl-r-act"' + disabled + '>' + opts(ORG_AUTO_ACTIONS, act.kind, "kind", "label") + '</select>' +
      '<span class="fl-rule-p">' + params + '</span>' +
      (owner ? '<span class="fl-rule-acts">' +
        '<button type="button" class="fl-rule-save" hidden>Save</button>' +
        (a.id ? '<button type="button" class="fl-link fl-rule-more">More…</button>' : "") +
        '<button type="button" class="fl-ic fl-ic-x fl-rule-del" title="Delete this rule" aria-label="Delete this rule">×</button>' +
      '</span>' : "") +
    '</div>';
  };

  $("flRules").innerHTML =
    '<div class="fl-lane-head"><h4>Rules for ' + esc(type.name || type.id) + '</h4>' +
      '<p class="fl-note">Things that happen by themselves. Each one is a sentence.</p>' +
      (owner ? '<button type="button" class="org-btn org-btn-sm" id="flRuleAdd">+ Add a rule</button>' : "") + '</div>' +
    (rows.length ? rows.map(row).join("") : '<p class="fl-note">Nothing happens by itself yet for this kind.</p>') +
    (others ? '<p class="fl-note fl-note-sm">' + others + (others === 1 ? " rule applies" : " rules apply") + ' to every kind of work. They are on the Organization page.</p>' : "");

  if (!owner) return;
  $("flRuleAdd").onclick = () => { flS.rules.push(flRuleBlank(type.id, roles)); flPaintRules(); };
  $("flRules").querySelectorAll(".fl-rule").forEach(el => {
    const k = +el.dataset.k;
    const a = rows[k];
    const save = el.querySelector(".fl-rule-save");
    const changed = () => { save.hidden = false; };
    el.querySelector(".fl-r-verb").onchange = changed;
    el.querySelector(".fl-r-act").onchange = e => {
      // a different action needs different blanks: rebuild this row with
      // the kind changed and nothing saved yet
      const next = JSON.parse(JSON.stringify(a));
      next.actions = [{ kind: e.target.value }];
      if (a.id) { const i = (orgS.automations || []).findIndex(x => x.id === a.id); if (i >= 0) orgS.automations[i] = next; }
      else flS.rules[k - saved.length] = next;
      flPaintRules();
      const again = $("flRules").querySelector('.fl-rule[data-k="' + k + '"] .fl-rule-save');
      if (again) again.hidden = false;
    };
    el.querySelectorAll(".fl-rule-p select, .fl-rule-p input").forEach(x => { x.onchange = changed; x.oninput = changed; });
    if (!a.id) save.hidden = false;
    save.onclick = () => flRuleSave(el, a);
    const more = el.querySelector(".fl-rule-more");
    if (more) more.onclick = () => orgAutomationSheet(a);
    el.querySelector(".fl-rule-del").onclick = () => flRuleDelete(el, a, k - saved.length);
  });
}

async function flRuleSave(el, a){
  const type = flType();
  const verb = el.querySelector(".fl-r-verb").value;
  const kind = el.querySelector(".fl-r-act").value;
  const q = sel => { const x = el.querySelector(sel); return x ? x.value : ""; };
  let action;
  if (kind === "notify") action = { kind, toRole: q(".fl-p-role") || null, message: q(".fl-p-msg").trim() };
  else if (kind === "set_status") action = { kind, status: q(".fl-p-status") };
  else if (kind === "assign") action = { kind, assigneeIds: q(".fl-p-who") ? [q(".fl-p-who")] : [] };
  else action = { kind, key: q(".fl-p-key"), value: q(".fl-p-val").trim() };
  if (kind === "set_status" && !action.status) { toast("This kind has no statuses to move to."); return; }
  if (kind === "set_field" && !action.key) { toast("This kind has no fields to set."); return; }
  if (kind === "notify" && !action.toRole) { toast("Which role should be told?"); return; }
  const rule = { name: (a.name || "").trim() || flRuleWords({ trigger: { verb }, actions: [action] }, orgRoleName, k => flStatusName(type, k)).slice(0, 60),
    enabled: a.enabled !== false, trigger: Object.assign({}, a.trigger || {}, { verb, typeId: type.id }),
    conditions: a.conditions || [], actions: [action], updatedAt: Date.now() };
  const btn = el.querySelector(".fl-rule-save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const id = a.id || ("au" + orgNewId());
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(id).set(rule);
    itemsAutomationsCache = null;
    toast(a.id ? "Rule saved." : "Rule added.");
    flReload();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Save";
    toast("Could not save the rule.");
  }
}

async function flRuleDelete(el, a, newIndex){
  if (!a.id) { flS.rules.splice(newIndex, 1); flPaintRules(); return; }
  const btn = el.querySelector(".fl-rule-del");
  // two taps: the second is the confirmation, same as everywhere else here
  if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Delete?"; btn.classList.add("is-armed"); return; }
  try {
    await db.collection("orgs").doc(orgS.orgId).collection("automations").doc(a.id).delete();
    itemsAutomationsCache = null;
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

  const group = r => {
    const people = members.filter(m => m.roleId === r.id);
    return '<div class="fl-role' + (!people.length && usedBy.has(r.id) ? " is-gap" : "") + '">' +
      '<div class="fl-role-head"><b>' + esc(r.name) + '</b><small>' + esc(permSummary(r)) + '</small>' +
        (owner && r.id !== "owner" ? '<button type="button" class="fl-link" data-role-edit="' + esc(r.id) + '">What they can do…</button>' : "") + '</div>' +
      (people.length
        ? people.map(m => {
            const name = orgPersonName(m.uid);
            const canMove = owner && m.roleId !== "owner" && m.uid !== me;
            return '<div class="fl-person"' + (owner ? ' draggable="true"' : "") + ' data-uid="' + esc(m.uid) + '">' +
              '<b class="fl-av-b">' + esc(flInitial(name)) + '</b><span>' + esc(name) + '</span>' +
              (canMove ? '<select class="fl-person-role" title="Change their role" aria-label="Change their role">' + roleOpts(m) + '</select>' : "") +
            '</div>';
          }).join("")
        : '<p class="fl-note fl-note-sm">' + (usedBy.has(r.id) ? "Nobody yet, and a step needs one." : "Nobody yet.") + '</p>') +
    '</div>';
  };

  $("flPeople").innerHTML =
    '<div class="fl-lane-head"><h4>People &amp; roles</h4>' +
      '<p class="fl-note">A step is done by a role. ' + (owner ? 'Drag a person onto a step to give it to them. Change what a role may do, or move someone into another role, here.' : 'Who is in which role today.') + '</p></div>' +
    roles.map(group).join("") +
    (owner ? '<div class="org-actions fl-side-acts">' +
      '<button type="button" class="org-btn org-btn-sm" id="flInvite">Invite someone</button>' +
      '<button type="button" class="org-btn org-btn-sm" id="flNewRole">New role</button></div>' : "");

  if (!owner) return;
  $("flInvite").onclick = () => orgInviteSheet();
  $("flNewRole").onclick = () => orgRoleSheet(null);
  $("flPeople").querySelectorAll("[data-role-edit]").forEach(b => b.onclick = () =>
    orgRoleSheet((orgS.roles || []).find(r => r.id === b.dataset.roleEdit)));
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
  $("flBar").innerHTML =
    '<p class="fl-sentence">' + (line ? esc("How it flows: " + line) : esc("No steps: whoever is given a " + (type.name || "task") + " does all of it.")) + '</p>' +
    '<div id="flErr"></div>' +
    (owner ? '<div class="fl-bar-acts">' +
      '<span class="fl-state' + (flS.dirty ? " is-dirty" : "") + '">' + (flS.dirty ? "Unsaved changes" : "Saved") + '</span>' +
      '<button type="button" class="org-btn" id="flSave"' + (flS.dirty ? "" : " disabled") + '>Save steps</button>' +
      (type.workflowId && (type.track || []).length ? '<button type="button" class="org-btn org-btn-sm org-btn-danger" id="flOff">Turn steps off</button>' : "") +
    '</div>' : "");
  if (!owner) return;
  $("flSave").onclick = flSave;
  if ($("flOff")) $("flOff").onclick = () => orgTrackOff(type);
}

async function flSave(){
  const type = flType();
  const roleIds = (orgS.roles || []).map(r => r.id).concat([HO_ANY]);
  const statusKeys = (type.statuses || []).map(s => s.key);
  const errs = hoTrackErrors(flS.draft, roleIds, statusKeys, orgS.members || []);
  document.querySelectorAll("#flCanvas .fl-step").forEach(c => c.classList.toggle("bad", errs.some(e => e.at === +c.dataset.i)));
  if (errs.length) {
    $("flErr").innerHTML = '<p class="fl-err">' + errs.map(e => esc((e.at >= 0 ? "Step " + (e.at + 1) + ": " : "") + e.message)).join("<br>") + '</p>';
    return;
  }
  const btn = $("flSave");
  btn.disabled = true; btn.textContent = "Saving…";
  const r = await orgTrackCommit(type, flS.draft);
  if (!r.ok) {
    btn.disabled = false; btn.textContent = "Save steps";
    $("flErr").innerHTML = '<p class="fl-err">' + esc(r.error || "Could not save the steps.") + '</p>';
    return;
  }
  flS.dirty = false; flS.draft = null;
  toast("Steps saved. New " + (type.name || "work") + " will follow them.");
  flReload();
}

// after any write: the org is read again, the same kind stays on screen
function flReload(){
  orgInvalidate();
  if (flS) { flS.draft = flS.dirty ? flS.draft : null; flS.rules = []; }
  enterFlowPage();
}

if (typeof module !== "undefined" && module.exports){
  module.exports = { flMove, flGive, flToggle, flRuleWords, flRuleBlank };
}
