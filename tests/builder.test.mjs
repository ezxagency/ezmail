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
  assert.match(doc.querySelector(".fl-start").textContent, /starts as To do/);
  const names = [...doc.querySelectorAll(".fl-step .fl-name")].map(i => i.value);
  assert.deepEqual(plain(names), ["Write the draft", "Check it"]);
  assert.match(doc.querySelector(".fl-end").textContent, /Marked Done/);
  assert.match(doc.getElementById("flBar").textContent, /How it flows: Write the draft \(Staff\) → Check it \(Manager\) → done/);
});

// a card is a summary line until it is opened; the controls live on the open one
const open = i => run(`flS.open = ${i}; flPaintCanvas();`);

T("shut, a card is one line: who does it, the days, what it marks, its choices; nothing else", () => {
  const sum = doc.querySelector('.fl-step[data-i="0"] .fl-sum');
  assert.ok(sum, "no summary line");
  assert.ok(doc.querySelector('.fl-step[data-i="0"]').classList.contains("is-shut"));
  assert.deepEqual(plain([...sum.querySelectorAll(".fl-sum-chip")].map(c => c.textContent)), ["Staff · any of 2", "2 days", "marks it Doing"]);
  assert.equal(doc.querySelector('.fl-step[data-i="0"] .fl-step-body'), null, "a shut card must not carry its editor");
  // pressing the line opens it, and only it
  sum.onclick();
  assert.ok(doc.querySelector('.fl-step[data-i="0"]').classList.contains("is-open"));
  assert.ok(doc.querySelector('.fl-step[data-i="0"] .fl-step-body'));
  assert.ok(doc.querySelector('.fl-step[data-i="1"]').classList.contains("is-shut"));
  doc.querySelector('.fl-step[data-i="1"] .fl-sum').onclick();
  assert.ok(doc.querySelector('.fl-step[data-i="0"]').classList.contains("is-shut"), "two cards open at once");
  doc.querySelector('.fl-step[data-i="1"] .fl-sum').onclick();
  assert.equal(doc.querySelector(".fl-step.is-open"), null, "pressing an open card's line should shut it");
});

T("a card shows who does it as role chips with head counts, and the people in that role", () => {
  open(0);
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

/* The bar's one verb is Publish (the owner's word, 2026-09-13): it saves
   the steps and makes them what new work follows. A published kind says
   it is live and offers to start a piece of work right there. */
T("a published kind reads Live and offers Start; a change reads Unsaved and Publish", () => {
  assert.match(doc.querySelector(".fl-state").textContent, /Live · new Task follows these steps/);
  assert.equal(doc.getElementById("flSave").textContent, "Publish again");
  assert.ok(doc.getElementById("flStart"), "no way to start a Task from the builder");
  assert.equal(doc.getElementById("flStart").textContent, "Start a Task");
  run(`__cx = null; openComposer = (a, b, c, kind) => { __cx = [a, b, c, kind]; };`);
  doc.getElementById("flStart").onclick();
  assert.deepEqual(plain(run("__cx")), [null, null, null, "task"], "the composer did not open on this kind");
  const inp = doc.querySelector('.fl-step[data-i="0"] .fl-name');
  inp.value = "Draft it"; inp.oninput({ target: inp });
  assert.equal(run("flS.draft[0].label"), "Draft it");
  assert.ok(!doc.getElementById("flSave").disabled);
  assert.equal(doc.getElementById("flSave").textContent, "Publish");
  assert.match(doc.querySelector(".fl-state").textContent, /Unsaved/);
  assert.equal(doc.getElementById("flStart"), null, "unsaved steps must not offer to start work on them");
});

T("pressing a role chip switches the role, clears the picks and redraws the people", () => {
  run(`flS.draft[0].assignees = ["u2"]; flS.open = 0; flPaintCanvas();`);
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

T("the + between two steps inserts a step there and opens it; × removes it; ↑ ↓ move it", () => {
  doc.querySelector('.fl-plus[data-at="1"]').onclick();
  let names = () => plain(run("flS.draft.map(s => s.label)"));
  assert.deepEqual(names(), ["Draft it", "", "Check it"]);
  assert.equal(doc.querySelectorAll(".fl-step").length, 3);
  assert.ok(doc.querySelector('.fl-step[data-i="1"]').classList.contains("is-open"), "a new step should open for editing");
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
  open(1);
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

/* ---------- after a step: choices, if-rules, together ---------- */
T("a step can be given choices, each one drawn as a chip", () => {
  run(ORG); open(1);
  const card = doc.querySelector('.fl-step[data-i="1"]');
  assert.ok(card.querySelector(".fl-after"), "no after-this-step section");
  assert.equal(card.querySelectorAll(".fl-choice").length, 0);
  const inp = card.querySelector(".fl-choice-in");
  inp.value = "Approve"; card.querySelector(".fl-choice-go").onclick();
  const again = () => doc.querySelector('.fl-step[data-i="1"]');
  again().querySelector(".fl-choice-in").value = "Send back";
  again().querySelector(".fl-choice-in").onkeydown({ key: "Enter", preventDefault(){} });
  assert.deepEqual(plain(run("flS.draft[1].choices")), ["Approve", "Send back"]);
  assert.deepEqual(plain([...again().querySelectorAll(".fl-choice")].map(c => c.textContent.replace("×", ""))), ["Approve", "Send back"]);
  assert.ok(again().querySelector(".fl-after").open, "the section stays open once it has something");
});

T("an if-rule reads a choice or a field, and goes to a step or Done; the otherwise is the list order", () => {
  const card = () => doc.querySelector('.fl-step[data-i="1"]');
  assert.match(card().querySelector(".fl-otherwise").textContent, /It goes → Done/);
  card().querySelector(".fl-route-add").onclick();
  const row = card().querySelector(".fl-route");
  assert.ok(row, "no rule row was drawn");
  const whats = [...row.querySelectorAll(".fl-r-what option")].map(o => o.textContent);
  assert.deepEqual(plain(whats), ["they pick Approve", "they pick Send back", "Brand"]);
  const tos = [...row.querySelectorAll(".fl-r-to option")].map(o => o.textContent);
  assert.deepEqual(plain(tos), ["↩ 1. Write the draft", "→ Done", "→ Someone else (adds a step after this one)"]);
  assert.equal(row.querySelector(".fl-r-op"), null, "a choice rule has no comparison");
  row.querySelector(".fl-r-what").value = "choice:Send back"; row.querySelector(".fl-r-what").onchange({ target: row.querySelector(".fl-r-what") });
  const r2 = card().querySelector(".fl-route");
  r2.querySelector(".fl-r-to").value = run("flS.draft[0].id"); r2.querySelector(".fl-r-to").onchange({ target: r2.querySelector(".fl-r-to") });
  assert.deepEqual(plain(run("flS.draft[1].routes")), [{ when: { kind: "choice", value: "Send back" }, to: run("flS.draft[0].id") }]);
  assert.match(card().querySelector(".fl-otherwise").textContent, /Otherwise → Done/);
  assert.match(doc.getElementById("flBar").textContent, /Check it \(Manager\) \[if Send back → back to Write the draft\] → done/);
});

T("a field rule gets a comparison, and its value is stored as the field's own type", () => {
  const card = () => doc.querySelector('.fl-step[data-i="1"]');
  card().querySelector(".fl-route-add").onclick();
  let row = card().querySelectorAll(".fl-route")[1];
  row.querySelector(".fl-r-what").value = "field:brand"; row.querySelector(".fl-r-what").onchange({ target: row.querySelector(".fl-r-what") });
  row = card().querySelectorAll(".fl-route")[1];
  assert.ok(row.querySelector(".fl-r-op"), "a field rule needs a comparison");
  assert.deepEqual(plain([...row.querySelectorAll(".fl-r-op option")].map(o => o.textContent)), ["is", "is not", "contains", "is over", "is under"]);
  row.querySelector(".fl-r-val").value = "Nike"; row.querySelector(".fl-r-val").oninput({ target: row.querySelector(".fl-r-val") });
  assert.deepEqual(plain(run("flS.draft[1].routes[1].when")), { kind: "field", key: "brand", op: "==", value: "Nike" });
  row.querySelector(".fl-r-del").onclick();
  assert.equal(run("flS.draft[1].routes.length"), 1);
});

T("removing a choice removes the rule that read it", () => {
  const card = () => doc.querySelector('.fl-step[data-i="1"]');
  card().querySelector('.fl-choice-x[data-choice="Send back"]').onclick();
  assert.deepEqual(plain(run("flS.draft[1].choices")), ["Approve"]);
  assert.deepEqual(plain(run("flS.draft[1].routes")), []);
});

T("ticking 'at the same time' groups the step with the one before, drawn as one column", () => {
  doc.querySelector('.fl-plus[data-at="2"]').onclick();
  const third = () => doc.querySelector('.fl-step[data-i="2"]');
  third().querySelector(".fl-name").value = "Copy"; third().querySelector(".fl-name").oninput({ target: third().querySelector(".fl-name") });
  third().querySelector('[data-role="staff"]').onclick();
  assert.equal(doc.querySelector(".fl-par"), null);
  const tog = third().querySelector(".fl-together-in");
  tog.checked = true; tog.onchange({ target: tog });
  assert.equal(run("flS.draft[2].together"), true);
  const par = doc.querySelector(".fl-par");
  assert.ok(par, "the group is not drawn as a column");
  assert.equal(par.querySelectorAll(".fl-step").length, 2);
  assert.match(par.textContent, /At the same time/);
  assert.match(doc.getElementById("flBar").textContent, /\{ Check it \(Manager\) \+ Copy \(Staff\) together \}/);
  // the + inside the group adds another member
  par.querySelector(".fl-plus-par").onclick();
  assert.equal(run("flS.draft[3].together"), true);
  assert.equal(doc.querySelector(".fl-par").querySelectorAll(".fl-step").length, 3);
  assert.equal(doc.querySelector('.fl-step[data-i="0"] .fl-together-in'), null, "the first step has nothing to run alongside");
});

T("a step can be told to rate the work it receives; the first step cannot", () => {
  const second = () => doc.querySelector('.fl-step[data-i="1"]');
  open(0);
  assert.equal(doc.querySelector('.fl-step[data-i="0"] .fl-rates-in'), null, "a first step receives nothing to rate");
  open(1);
  const rt = second().querySelector(".fl-rates-in");
  assert.ok(rt, "no rates switch on the second step");
  rt.checked = true; rt.onchange({ target: rt });
  assert.equal(run("flS.draft[1].rates"), true);
  assert.match(second().querySelector(".fl-after > summary").textContent, /rates/);
});

T("a kind with no steps yet reads Not published, and Publish waits for a step", () => {
  run(`flS.draft = []; flS.dirty = false; orgS.types[0].workflowId = null; flPaintCanvas(); flPaintBar();`);
  assert.match(doc.querySelector(".fl-state").textContent, /Not published/);
  assert.ok(doc.getElementById("flSave").disabled, "nothing to publish yet");
  assert.equal(doc.getElementById("flStart"), null);
  doc.querySelectorAll(".fl-start-btn")[0].onclick();
  assert.ok(!doc.getElementById("flSave").disabled);
  assert.equal(doc.getElementById("flSave").textContent, "Publish");
  run(ORG);
});

T("the third ready-made shape is the approve-or-send-back loop", () => {
  run(`flS.draft = []; flPaintCanvas();`);
  const starts = [...doc.querySelectorAll(".fl-start-btn")].map(b => b.textContent);
  assert.equal(starts.length, 5, JSON.stringify(starts));
  assert.match(starts[2], /approves it, or sends it back/);
  doc.querySelectorAll(".fl-start-btn")[2].onclick();
  const d = plain(run("flS.draft"));
  assert.deepEqual(d.map(s => s.label), ["Do the work", "Check it"]);
  assert.deepEqual(d[1].choices, ["Approve", "Send back"]);
  assert.equal(d[1].routes[0].to, d[0].id);
  assert.equal(d[1].rates, true, "a checker rates what they check");
  run(ORG);
});

/* Approved is not finished. The owner's own words, 2026-09-12: "he said
   done/approved, that means the task is ready to hand over to another
   person". So the fourth shape has a third step, Approve points at it,
   and nobody is guessed into it - the card says so until the owner picks. */
T("the fourth ready-made shape hands approved work to a third step that somebody still has to be chosen for", () => {
  run(`flS.draft = []; flPaintCanvas();`);
  const starts = [...doc.querySelectorAll(".fl-start-btn")].map(b => b.textContent);
  assert.match(starts[3], /approves it and hands it to someone else/);
  doc.querySelectorAll(".fl-start-btn")[3].onclick();
  const d = plain(run("flS.draft"));
  assert.deepEqual(d.map(s => s.label), ["Do the work", "Check it", "Hand it on"]);
  assert.deepEqual(d[1].routes.map(r => [r.when.value, r.to]), [["Send back", d[0].id], ["Approve", d[2].id]]);
  assert.equal(d[1].rates, true);
  assert.equal(d[2].roleId, "", "no role is guessed for the hand-on step");
  assert.match(doc.querySelector('.fl-step[data-i="2"] .fl-sum').textContent, /Nobody chosen/);
  // the picture reads it: Approve goes to step 3, and Done is a step further on
  open(1);
  const to = doc.querySelectorAll('.fl-step[data-i="1"] .fl-r-to')[1];
  assert.equal(to.value, d[2].id);
  assert.match(to.selectedOptions[0].textContent, /3\. Hand it on/);
  run(ORG);
});

T("a route can point at a step that does not exist yet: picking 'someone else' adds the step and sends the work there", () => {
  run(`flS.draft = []; flPaintCanvas();`);
  doc.querySelectorAll(".fl-start-btn")[2].onclick();   // Do the work → Check it (Approve / Send back)
  open(1);
  const card = () => doc.querySelector('.fl-step[data-i="1"]');
  // the Approve rule is not written yet, so Approve falls through to Done - and the card offers the way on
  assert.match(card().querySelector(".fl-otherwise").textContent, /Otherwise → Done/);
  assert.ok(card().querySelector(".fl-next-add"), "no 'hand it to someone else next' offer beside Done");
  card().querySelector(".fl-route-add").onclick();
  const sel = card().querySelectorAll(".fl-r-to")[1];
  assert.ok([...sel.options].some(o => o.value === "new" && /Someone else/.test(o.textContent)), "no 'someone else' target");
  sel.value = "new"; sel.onchange({ target: sel });
  const d = plain(run("flS.draft"));
  assert.equal(d.length, 3, "picking 'someone else' adds a step");
  assert.equal(d[1].routes[1].to, d[2].id, "the rule points at the new step");
  assert.equal(run("flS.open"), 2, "the new step is the open card");
  assert.equal(run("flS.dirty"), true);
  // and the older route's target survives the redraw
  open(1);
  const tos = doc.querySelectorAll('.fl-step[data-i="1"] .fl-r-to');
  assert.equal(tos[0].value, d[0].id);
  assert.equal(tos[1].value, d[2].id);
  run(ORG);
});

T("'hand it to someone else next' adds a step after the group, and 'otherwise' follows it there", () => {
  run(`flS.draft = []; flPaintCanvas();`);
  doc.querySelectorAll(".fl-start-btn")[1].onclick();   // Do the work → Check it
  open(1);
  doc.querySelector('.fl-step[data-i="1"] .fl-next-add').onclick();
  const d = plain(run("flS.draft"));
  assert.equal(d.length, 3);
  assert.equal(run("flS.open"), 2);
  open(1);
  assert.match(doc.querySelector('.fl-step[data-i="1"] .fl-otherwise').textContent, /→ Step 3/);
  assert.equal(doc.querySelector('.fl-step[data-i="1"] .fl-next-add'), null, "the offer is only there when the way on is Done");
  // a step that runs alongside others gets the new step after the whole group
  run(`flS.draft[2].together = true; flPaintCanvas();`);
  open(1);
  doc.querySelector('.fl-step[data-i="1"] .fl-next-add').onclick();
  assert.equal(run("flS.draft.length"), 4);
  assert.equal(run("flS.open"), 3, "after the group, not inside it");
  run(ORG);
});

T("the status chips say what they are for: the status while the work sits at the step", () => {
  run(`flS.draft = []; flPaintCanvas();`);
  doc.querySelectorAll(".fl-start-btn")[0].onclick();
  open(0);
  const opt = [...doc.querySelectorAll('.fl-step[data-i="0"] .fl-opt > span:first-child')].map(x => x.textContent);
  assert.ok(opt.some(t => /While it is at this step, its status is/.test(t)), JSON.stringify(opt));
  run(ORG);
});

/* ---------- rules ---------- */
T("a rule reads as one sentence: the kind, the trigger, the status it fires on, the field it checks, and who is told", () => {
  const o = `{ typeName: "Task", fieldNameOf: k => ({ brand: "Brand" })[k] || k, personNameOf: u => ({ u2: "Bo" })[u] || u }`;
  const say = r => run(`flRuleWords(${JSON.stringify(r)}, id => ({ manager: "Manager" })[id], k => ({ doing: "Doing", review: "Review" })[k], ${o})`);
  assert.equal(say({ trigger: { verb: "item.created" }, actions: [{ kind: "notify", toRole: "manager", message: "New one" }] }), 'When a Task is created, tell Manager: "New one".');
  assert.equal(say({ trigger: { verb: "item.status_changed" }, conditions: [{ source: "task", path: "status", op: "==", value: "review" }], actions: [{ kind: "notify", toWhom: "assignees" }] }), "When a Task is marked Review, tell whoever holds it.");
  assert.equal(say({ trigger: { verb: "item.status_changed" }, actions: [{ kind: "set_status", status: "doing" }] }), "When its status changes, mark it Doing.");
  assert.equal(say({ trigger: { verb: "item.assigned" }, conditions: [{ source: "field", path: "brand", op: "==", value: "Nike" }], actions: [{ kind: "assign", assigneeIds: ["u2"] }] }), "When a Task is given to someone and Brand is Nike, give it to Bo.");
  assert.equal(say({ trigger: { verb: "item.updated" }, actions: [{ kind: "notify", toWhom: "creator", message: "" }] }), "When a Task is edited, tell whoever created it.");
});

T("the lane lists this kind's rules as sentences with a switch, and the org-wide ones tagged", () => {
  run(ORG);
  const rules = [...doc.querySelectorAll("#flRules .fl-rule")];
  assert.equal(rules.length, 2, "this kind's rule and the every-kind rule");
  assert.match(rules[0].querySelector(".fl-rule-t b").textContent, /^When a Task is created, tell Manager: "A new task"\.$/);
  assert.match(rules[1].querySelector(".fl-rule-t small").textContent, /Every kind of work/);
  assert.ok(rules[0].querySelector('.fl-sw[data-toggle="au1"]').classList.contains("is-on"), "an enabled rule shows its switch on");
  assert.ok(rules[0].querySelector('[data-edit="au1"]'), "no Edit on a rule");
  assert.match(doc.getElementById("flRules").textContent, /Happens by itself/);
  assert.doesNotMatch(doc.getElementById("flRules").textContent, /item\./, "a verb key leaked onto the screen");
});

T("the rule sheet asks three things, offers this kind's own statuses and fields, and reads the rule back as it is built", () => {
  doc.getElementById("flRuleAdd").onclick();
  const body = doc.getElementById("sheetBody");
  assert.match(body.textContent, /New rule/);
  assert.equal(doc.getElementById("frPreview").textContent, "When a Task is created, tell Manager.");
  // "is marked…" opens the kind's statuses, never a typed key
  body.querySelector('.fr-verb[data-v="item.status_changed"]').onclick();
  assert.deepEqual(plain([...body.querySelectorAll(".fr-status")].map(b => b.textContent)), ["To do", "Doing", "Done"]);
  body.querySelector('.fr-status[data-v="doing"]').onclick();
  assert.equal(doc.getElementById("frPreview").textContent, "When a Task is marked Doing, tell Manager.");
  // only if: the kind's fields, the comparison, the value
  const ck = doc.getElementById("frCondKey");
  assert.deepEqual(plain([...ck.options].map(o => o.textContent)), ["Always", "only if Brand"]);
  ck.value = "brand"; ck.onchange();
  doc.getElementById("frCondVal").value = "Nike"; doc.getElementById("frCondVal").oninput();
  assert.equal(doc.getElementById("frPreview").textContent, "When a Task is marked Doing and Brand is Nike, tell Manager.");
  // tell whoever holds it, saying something
  body.querySelector('.fr-who[data-v="assignees"]').onclick();
  doc.getElementById("frMsg").value = "Yours now"; doc.getElementById("frMsg").oninput();
  assert.equal(doc.getElementById("frPreview").textContent, 'When a Task is marked Doing and Brand is Nike, tell whoever holds it: "Yours now".');
  // then: mark it, with the statuses as chips
  body.querySelector('.fr-kind[data-v="set_status"]').onclick();
  assert.deepEqual(plain([...body.querySelectorAll(".fr-set-status")].map(b => b.textContent)), ["To do", "Doing", "Done"]);
  body.querySelector('.fr-set-status[data-v="done"]').onclick();
  assert.equal(doc.getElementById("frPreview").textContent, "When a Task is marked Doing and Brand is Nike, mark it Done.");
  run("closeSheet();");
});

T("the document a rule builds is what the engine reads: verb, status and field conditions, one action; an empty rule is refused with a reason", () => {
  const type = plain(run("flType()"));
  const w = { verb: "item.status_changed", status: "doing", cond: { key: "brand", op: "==", value: "Nike" }, act: { kind: "notify", toWhom: "assignees", message: " Yours now " } };
  const built = plain(run(`flRuleBuild(${JSON.stringify(w)}, ${JSON.stringify(type)})`));
  assert.deepEqual(built, { trigger: { verb: "item.status_changed", typeId: "task" },
    conditions: [{ source: "task", path: "status", op: "==", value: "doing" }, { source: "field", path: "brand", op: "==", value: "Nike" }],
    actions: [{ kind: "notify", toWhom: "assignees", message: "Yours now", toRole: null }] });
  // and the engine agrees it fires on that, and only on that
  const rule = Object.assign({ id: "r", enabled: true }, built);
  const item = { id: "i", typeId: "task", status: "doing", assigneeIds: ["u2"], fields: { brand: "Nike" } };
  const plan = plain(run(`autoPlan({ automations: [${JSON.stringify(rule)}], event: { verb: "item.status_changed" }, item: ${JSON.stringify(item)} })`));
  assert.deepEqual(plan.fired, ["r"]);
  assert.deepEqual(plan.steps[0].toUids, ["u2"], "whoever holds it should be told");
  const miss = plain(run(`autoPlan({ automations: [${JSON.stringify(rule)}], event: { verb: "item.status_changed" }, item: ${JSON.stringify(Object.assign({}, item, { status: "done" }))} })`));
  assert.deepEqual(miss.fired, [], "marked Done must not fire a rule about Doing");
  assert.equal(run(`flRuleProblem({ verb: "item.created", cond: null, act: { kind: "assign", assigneeIds: [] } }, ${JSON.stringify(type)})`), "Who should it go to?");
  assert.equal(run(`flRuleProblem({ verb: "item.status_changed", status: "", cond: null, act: { kind: "notify", toRole: "manager" } }, ${JSON.stringify(type)})`), "Pick which status.");
  assert.equal(run(`flRuleProblem({ verb: "item.created", cond: { key: "brand", op: "==", value: "" }, act: { kind: "notify", toRole: "manager" } }, ${JSON.stringify(type)})`), "Say what the field has to be, or set it back to Always.");
  assert.equal(run(`flRuleProblem({ verb: "item.created", cond: null, act: { kind: "notify", toRole: "manager" } }, ${JSON.stringify(type)})`), null);
});

T("editing a saved rule opens it as it is; deleting asks twice", () => {
  doc.querySelector('#flRules [data-edit="au1"]').onclick();
  const body = doc.getElementById("sheetBody");
  assert.match(body.textContent, /Edit rule/);
  assert.ok(body.querySelector('.fr-verb[data-v="item.created"]').classList.contains("is-on"));
  assert.ok(body.querySelector('.fr-who[data-v="role:manager"]').classList.contains("is-on"));
  assert.equal(doc.getElementById("frMsg").value, "A new task");
  const del = doc.getElementById("frDelete");
  del.onclick();
  assert.equal(del.textContent, "Delete?");
  assert.equal(run("orgS.automations.length"), 2, "one tap must not delete");
  run("closeSheet();");
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

T("each role folds: closed with its count, open when pressed, still open after a redraw; a role a step needs and nobody holds starts open", () => {
  const fold = id => doc.querySelector('#flPeople details.fl-role[data-role-id="' + id + '"]');
  assert.ok(fold("staff") && !fold("staff").open, "the staff list should start folded");
  assert.match(fold("staff").querySelector(".fl-role-n").textContent, /\d+ (person|people)/);
  assert.ok(fold("staff").querySelector(".fl-person"), "the people are still inside the fold, ready to drag");
  fold("staff").open = true; fold("staff").dispatchEvent(new dom.window.Event("toggle"));
  run(`flPaintPeople();`);
  assert.ok(fold("staff").open, "a redraw folded the list the person had opened");
  fold("staff").open = false; fold("staff").dispatchEvent(new dom.window.Event("toggle"));
  run(`flPaintPeople();`);
  assert.ok(!fold("staff").open);
  // put a step on QA, which nobody holds: that fold starts open, so the warning shows
  run(`flS.draft[1].roleId = "qa"; flPaintPeople();`);
  assert.ok(fold("qa").open && fold("qa").classList.contains("is-gap"), "a role a step needs and nobody holds should start open");
  assert.match(fold("qa").textContent, /a step needs one/);
  run(`flS.draft[1].roleId = "manager"; flPaintPeople();`);
  assert.ok(!fold("qa").open, "with the step moved off QA the fold should close again");
  // the "what they can do" button opens the sheet and does not toggle the fold
  run(`__sheets = 0; orgRoleSheet = () => { __sheets++; };`);
  const wasOpen = fold("staff").open;
  fold("staff").querySelector("[data-role-edit]").click();
  assert.equal(run("__sheets"), 1);
  assert.equal(fold("staff").open, wasOpen, "pressing the link folded or unfolded the role");
});

T("typing a name narrows the panel to the people who match, opens their roles, and hides the rest", () => {
  const find = doc.getElementById("flFind");
  const people = () => [...doc.querySelectorAll("#flPeople .fl-person span")].map(x => x.textContent);
  const before = people().length;
  find.value = "bo"; find.oninput();
  assert.deepEqual(plain(people()), ["Bo"]);
  const roles = [...doc.querySelectorAll("#flPeople details.fl-role")];
  assert.ok(roles.length === 1 && roles[0].open, "only Bo's role should be shown, and open");
  assert.equal(doc.getElementById("flFind").value, "bo", "the redraw lost what was typed");
  doc.getElementById("flFind").value = "zzz"; doc.getElementById("flFind").oninput();
  assert.match(doc.getElementById("flPeople").textContent, /Nobody named like that/);
  doc.getElementById("flFind").value = ""; doc.getElementById("flFind").oninput();
  assert.equal(people().length, before, "clearing the box must bring everyone back");
  assert.ok(!doc.querySelector('#flPeople details.fl-role[data-role-id="staff"]').open, "a search must not leave folds open behind it");
});

/* ---------- who may change it ---------- */
T("a manager sees the picture and can change none of it", () => {
  run(`orgS.myRoleId = "manager"; flS.draft = null; flS.dirty = false; flRender();`);
  assert.equal(doc.getElementById("flSave"), null);
  assert.ok([...doc.querySelectorAll(".fl-step input, .fl-step button:not(.fl-sum)")].every(el => el.disabled), "a control an owner-only write would refuse must not be offered");
  assert.ok(doc.querySelector(".fl-step .fl-sum"), "a viewer may still open a step to read it");
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
