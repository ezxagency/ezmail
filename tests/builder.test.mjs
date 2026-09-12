/* DOM tests for the Flow builder - js/flow.js.

     node tests/builder.test.mjs

   Same harness shape as ui.test.mjs: the real files loaded into one
   shared global scope in the order index.html declares, Firebase stubbed
   so nothing dials out, and the page driven through the controls it
   draws. The pure helpers are asserted first; then the picture. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const plain = v => JSON.parse(JSON.stringify(v));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div>
  <div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div>
  <div id="orgBody"></div>
  <div id="flowBody"></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/clock.js", "js/permissions.js", "js/item-engine.js", "js/ui.js", "js/scrubber.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js", "js/notify.js",
 "js/packs.js", "js/handoff.js", "js/org.js", "js/flow.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;
run(`var isAdmin = false, isMember = true; var go = r => { window.__went = r; };`);

/* ---------- pure ---------- */
T("flMove moves one step and never mutates the list it was given", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(plain(run(`flMove(${JSON.stringify(list)}, 0, 2)`)), ["b", "c", "a", "d"]);
  assert.deepEqual(plain(run(`flMove(${JSON.stringify(list)}, 3, 0)`)), ["d", "a", "b", "c"]);
  assert.deepEqual(plain(run(`flMove(${JSON.stringify(list)}, 1, 9)`)), list, "an impossible move is a no-op");
});

T("dropping a person on a step gives it to them, taking their role with them", () => {
  // a step belongs to a role and may be narrowed within it; "give it to
  // Bo" has to mean "Staff, and of them Bo", never a bare name
  const s = plain(run(`flGive({ label: "Check", roleId: "manager", assignees: ["u1"] }, { uid: "u2", roleId: "staff" })`));
  assert.deepEqual(s, { label: "Check", roleId: "staff", assignees: ["u2"] });
  const t = plain(run(`flGive({ label: "Check", roleId: "staff", assignees: ["u2"] }, { uid: "u3", roleId: "staff" })`));
  assert.deepEqual(t.assignees, ["u2", "u3"], "a second person in the same role is added, not swapped");
});

T("ticking a person off the last named one means any of the role again", () => {
  assert.deepEqual(plain(run(`flToggle({ roleId: "staff", assignees: ["u2"] }, "u2")`)).assignees, []);
  assert.deepEqual(plain(run(`flToggle({ roleId: "staff", assignees: [] }, "u2")`)).assignees, ["u2"]);
});

T("a rule reads as one sentence, never as a verb key", () => {
  const w = run(`flRuleWords({ trigger: { verb: "item.created" }, actions: [{ kind: "notify", toRole: "manager", message: "New one" }] }, id => ({ manager: "Manager" })[id])`);
  assert.equal(w, 'When work is created, tell Manager: "New one".');
  const v = run(`flRuleWords({ trigger: { verb: "item.status_changed" }, actions: [{ kind: "set_status", status: "doing" }] }, null, k => ({ doing: "Doing" })[k])`);
  assert.equal(v, "When its status changes, mark it Doing.");
  assert.doesNotMatch(w + v, /item\./);
});

/* ---------- the picture ---------- */
const ORG = `orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner",
  members: [{ uid: "u1", roleId: "owner" }, { uid: "u2", roleId: "staff" }, { uid: "u3", roleId: "staff" }, { uid: "u4", roleId: "manager" }],
  dir: { u1: { name: "Ada" }, u2: { name: "Bo" }, u3: { name: "Cy" }, u4: { name: "Di" } },
  roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] }, { id: "manager", name: "Manager", permissions: ["item:read:org", "item:update:org"] },
          { id: "staff", name: "Staff", permissions: ["item:read:org"] }, { id: "qa", name: "QA", permissions: [] }],
  types: [{ id: "task", name: "Task", fields: [{ key: "brand", label: "Brand", type: "text" }],
            statuses: [{ key: "to_do", label: "To do" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }],
            track: [{ label: "Write the draft", roleId: "staff", assignees: [], status: "doing", dueAfter: 2 * 86400000 },
                    { label: "Check it", roleId: "manager", assignees: [], status: "", dueAfter: null }], workflowId: "bp1" },
          { id: "video", name: "Video", fields: [], statuses: [{ key: "idea", label: "Idea" }, { key: "done", label: "Done" }] }],
  automations: [{ id: "au1", name: "Tell the manager", enabled: true, trigger: { verb: "item.created", typeId: "task" }, conditions: [],
                  actions: [{ kind: "notify", toRole: "manager", message: "A new task" }] },
                { id: "au2", name: "Any kind", enabled: true, trigger: { verb: "item.updated" }, conditions: [], actions: [{ kind: "notify", toRole: "manager", message: "" }] }] };
  flS = { orgId: "orgA", typeId: "task", draft: null, dirty: false, drag: null, rules: [] };
  flRender();`;

T("the canvas draws start, one card per step in order, and the end", () => {
  run(ORG);
  assert.match(doc.querySelector(".fl-start").textContent, /New Task/);
  assert.match(doc.querySelector(".fl-start").textContent, /Starts as To do/);
  const names = [...doc.querySelectorAll(".fl-step .fl-name")].map(i => i.value);
  assert.deepEqual(plain(names), ["Write the draft", "Check it"]);
  assert.match(doc.querySelector(".fl-end").textContent, /marked Done/);
  assert.match(doc.getElementById("flBar").textContent, /How it flows: Write the draft \(Staff\) → Check it \(Manager\) → done/);
});

T("a card shows who does it as role chips with head counts, and the people in that role", () => {
  const card = doc.querySelector('.fl-step[data-i="0"]');
  const chips = [...card.querySelectorAll("[data-role]")].map(b => b.textContent);
  assert.deepEqual(plain(chips), ["Anyone", "Owner1", "Manager1", "Staff2", "QA0"]);
  assert.ok(card.querySelector('[data-role="staff"]').classList.contains("is-on"));
  assert.deepEqual(plain([...card.querySelectorAll(".fl-av")].map(b => b.textContent)), ["BBo", "CCy"]);
  assert.equal(card.querySelector(".fl-days input").value, "2");
  assert.ok(card.querySelector('[data-status="doing"]').classList.contains("is-on"));
});

T("every kind has a tab, and the tab carries how many steps it has", () => {
  const tabs = [...doc.querySelectorAll(".fl-tab[data-type]")].map(b => b.textContent);
  assert.deepEqual(plain(tabs), ["Task2", "Video"]);
  assert.ok(doc.querySelector(".fl-tab-new"), "an owner can make a new kind from here");
});

T("nothing is dirty until something changes, and then Save wakes up", () => {
  assert.ok(doc.getElementById("flSave").disabled);
  assert.match(doc.querySelector(".fl-state").textContent, /Saved/);
  const inp = doc.querySelector('.fl-step[data-i="0"] .fl-name');
  inp.value = "Draft it"; inp.oninput({ target: inp });
  assert.equal(run("flS.draft[0].label"), "Draft it");
  assert.ok(!doc.getElementById("flSave").disabled);
  assert.match(doc.querySelector(".fl-state").textContent, /Unsaved/);
});

T("pressing a role chip switches the role, clears the picks and redraws the people", () => {
  run(`flS.draft[0].assignees = ["u2"]; flPaintCanvas();`);
  doc.querySelector('.fl-step[data-i="0"] [data-role="manager"]').onclick();
  assert.equal(run("flS.draft[0].roleId"), "manager");
  assert.deepEqual(plain(run("flS.draft[0].assignees")), []);
  assert.deepEqual(plain([...doc.querySelectorAll('.fl-step[data-i="0"] .fl-av')].map(b => b.textContent)), ["DDi"]);
});

T("ticking a person narrows the step to them, and the sentence says so", () => {
  doc.querySelector('.fl-step[data-i="0"] .fl-av[data-uid="u4"]').onclick();
  assert.deepEqual(plain(run("flS.draft[0].assignees")), ["u4"]);
  assert.match(doc.querySelector('.fl-step[data-i="0"] .fl-people .fl-lbl').textContent, /Only these 1/);
  assert.match(doc.getElementById("flBar").textContent, /Draft it \(Manager, 1 named\)/);
});

T("the + between two steps inserts a step there; × removes it; ‹ › move it", () => {
  doc.querySelector('.fl-plus[data-at="1"]').onclick();
  let names = () => plain(run("flS.draft.map(s => s.label)"));
  assert.deepEqual(names(), ["Draft it", "", "Check it"]);
  assert.equal(doc.querySelectorAll(".fl-step").length, 3);
  doc.querySelector('.fl-step[data-i="1"] [data-del]').onclick();
  assert.deepEqual(names(), ["Draft it", "Check it"]);
  doc.querySelector('.fl-step[data-i="1"] [data-move="-1"]').onclick();
  assert.deepEqual(names(), ["Check it", "Draft it"]);
  assert.ok(doc.querySelector('.fl-step[data-i="0"] [data-move="-1"]').disabled, "the first card cannot move left");
});

const drop = (sel, data, dragIndex) => {
  run(`flS.drag = ${dragIndex == null ? "null" : dragIndex};`);
  doc.querySelector(sel).ondrop({ preventDefault(){}, dataTransfer: { getData: () => data } });
};

T("dropping a step on another reorders them", () => {
  drop('.fl-step[data-i="0"]', "step:1", 1);
  assert.deepEqual(plain(run("flS.draft.map(s => s.label)")), ["Draft it", "Check it"]);
  assert.equal(run("flS.drag"), null);
});

T("dropping a person on a step gives the step to them", () => {
  drop('.fl-step[data-i="1"]', "person:u2", null);
  assert.equal(run("flS.draft[1].roleId"), "staff");
  assert.deepEqual(plain(run("flS.draft[1].assignees")), ["u2"]);
  assert.ok(doc.querySelector('.fl-step[data-i="1"] .fl-av[data-uid="u2"]').classList.contains("is-on"));
});

T("a step with nobody in its role is marked on the card and in the panel", () => {
  doc.querySelector('.fl-step[data-i="1"] [data-role="qa"]').onclick();
  assert.ok(doc.querySelector('.fl-step[data-i="1"]').classList.contains("gap"));
  assert.match(doc.querySelector('.fl-step[data-i="1"] .fl-warn').textContent, /Nobody is QA right now/);
  run(`flPaintPeople();`);
  const qa = [...doc.querySelectorAll("#flPeople .fl-role")].find(r => /QA/.test(r.querySelector("b").textContent));
  assert.ok(qa.classList.contains("is-gap"));
  assert.match(qa.textContent, /a step needs one/);
});

T("saving an incomplete step marks the card and says what is missing, before any write", () => {
  doc.querySelector('.fl-plus[data-at="2"]').onclick();
  run(`flSave();`);
  assert.ok(doc.querySelector('.fl-step[data-i="2"]').classList.contains("bad"));
  assert.match(doc.getElementById("flErr").textContent, /Step 3: Every step needs a name/);
  assert.match(doc.getElementById("flErr").textContent, /Who does this step/);
});

/* ---------- rules ---------- */
T("the lane lists this kind's rules as sentences with their controls, and counts the org-wide ones", () => {
  const rules = doc.querySelectorAll("#flRules .fl-rule");
  assert.equal(rules.length, 1, "only the rule about Task belongs in Task's lane");
  assert.equal(rules[0].querySelector(".fl-r-verb").value, "item.created");
  assert.equal(rules[0].querySelector(".fl-p-role").value, "manager");
  assert.equal(rules[0].querySelector(".fl-p-msg").value, "A new task");
  assert.ok(rules[0].querySelector(".fl-rule-save").hidden, "Save hides until something changes");
  assert.match(doc.getElementById("flRules").textContent, /1 rule applies to every kind of work/);
});

T("adding a rule draws an unsaved sentence with Save showing", () => {
  doc.getElementById("flRuleAdd").onclick();
  const rows = doc.querySelectorAll("#flRules .fl-rule");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].classList.contains("is-new"));
  assert.ok(!rows[1].querySelector(".fl-rule-save").hidden);
});

T("choosing 'move it to a status' offers the kind's own statuses, not a free text key", () => {
  // the Organization sheet asks for the key "exactly as the work type
  // spells it"; a builder that offers the labels cannot be misspelled
  const row = doc.querySelectorAll("#flRules .fl-rule")[1];
  const sel = row.querySelector(".fl-r-act");
  sel.value = "set_status"; sel.onchange({ target: sel });
  const again = doc.querySelectorAll("#flRules .fl-rule")[1];
  const opts = [...again.querySelectorAll(".fl-p-status option")].map(o => o.textContent);
  assert.deepEqual(plain(opts), ["To do", "Doing", "Done"]);
  assert.ok(!again.querySelector(".fl-rule-save").hidden);
});

T("deleting an unsaved rule just drops the row; a saved one asks twice", () => {
  doc.querySelectorAll("#flRules .fl-rule")[1].querySelector(".fl-rule-del").onclick();
  assert.equal(doc.querySelectorAll("#flRules .fl-rule").length, 1);
  const del = doc.querySelector("#flRules .fl-rule .fl-rule-del");
  del.onclick();
  assert.equal(del.textContent, "Delete?");
  assert.equal(doc.querySelectorAll("#flRules .fl-rule").length, 1, "one tap must not delete");
});

/* ---------- people ---------- */
T("the panel lists every role with its people; a person can be moved to another role, never to owner", () => {
  const roles = [...doc.querySelectorAll("#flPeople .fl-role-head b")].map(b => b.textContent);
  assert.deepEqual(plain(roles), ["Owner", "Manager", "QA", "Staff"]);
  const bo = doc.querySelector('#flPeople .fl-person[data-uid="u2"]');
  assert.equal(bo.getAttribute("draggable"), "true");
  const opts = [...bo.querySelectorAll(".fl-person-role option")].map(o => o.value);
  assert.deepEqual(plain(opts), ["manager", "qa", "staff"]);
  assert.equal(doc.querySelector('#flPeople .fl-person[data-uid="u1"] .fl-person-role'), null, "the owner seat is not moved from here");
  assert.ok(doc.querySelector('#flPeople [data-role-edit="staff"]'), "what a role can do opens from here");
});

/* ---------- who may change it ---------- */
T("a manager sees the picture and can change none of it", () => {
  run(`orgS.myRoleId = "manager"; flS.draft = null; flS.dirty = false; flRender();`);
  assert.equal(doc.getElementById("flSave"), null);
  assert.ok([...doc.querySelectorAll(".fl-step input, .fl-step button")].every(el => el.disabled), "a control an owner-only write would refuse must not be offered");
  assert.equal(doc.querySelector(".fl-plus:not(.is-off)"), null);
  assert.equal(doc.getElementById("flRuleAdd"), null);
  assert.match(doc.getElementById("flowBody").textContent, /Only the owner can change this/);
});

/* ---------- empty states, each saying why ---------- */
T("no kinds of work offers to make one; a failed read says it could not reach, not that there is nothing", () => {
  run(`orgS.myRoleId = "owner"; orgS.types = []; flS.draft = null; flRender();`);
  assert.match(doc.getElementById("flowBody").textContent, /No kinds of work yet/);
  assert.ok(doc.getElementById("flNewKind"));
  run(`orgWhyNone = "error"; flRenderEmpty();`);
  assert.match(doc.getElementById("flowBody").textContent, /Could not reach/);
  run(`orgWhyNone = "none"; flRenderEmpty();`);
  assert.match(doc.getElementById("flowBody").textContent, /No organization yet/);
});

T("the Organization page hands off to the builder when the builder is the page on screen", () => {
  // the sheets the builder opens reload "the org page" after they save;
  // the page that is showing is the one that must reload
  run(`var currentRoute = () => "flow"; window.__entered = 0; var enterFlowPage = () => { window.__entered++; }; enterOrgPage();`);
  assert.equal(run("window.__entered"), 1);
  assert.equal(doc.getElementById("orgBody").innerHTML, "", "the hidden org page must not have been redrawn");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
