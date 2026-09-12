/* DOM tests for the generated UI - js/work.js and js/org.js.

   The pure suites prove what the engine DECIDES. They cannot prove that
   a control the app draws is a control the app can read back, because
   that round trip only exists in a document. This loads the real files
   into one shared global scope - the same architecture index.html has -
   and drives them.

     node tests/ui.test.mjs

   Firebase is stubbed, not reached: nothing here touches a network or a
   real project. Same runner shape as the other suites. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

/* Values built inside the VM context carry that realm's prototypes, so
   assert.deepEqual rejects them on identity even when every member
   matches. Normalising through JSON compares what we actually care
   about - the data - rather than which realm made the array. */
const plain = v => JSON.parse(JSON.stringify(v));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

/* ---------- the page shell these files expect ---------- */
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div>
  <div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div>
  <div id="orgBody"></div>
  <div id="workBody"></div>
  <div id="shiftbar" class="shiftbar"></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
// the one thing config.js reaches for at load. Stubbed so nothing dials out.
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;

// load order IS the dependency graph, exactly as index.html declares it
["js/config.js", "js/clock.js", "js/permissions.js", "js/item-engine.js", "js/ui.js", "js/scrubber.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js",
 // org.js calls dirInvalidate() from here: the harness only proves
 // anything if it carries the same shared scope the browser builds
 "js/notify.js",
 "js/packs.js", "js/handoff.js", "js/org.js", "js/work.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;
// js/boot.js declares these before org.js loads; the same scope here
run(`var isAdmin = false, isMember = false;`);

/* ---------- a type using every one of the eleven ---------- */
run(`
  orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner",
    members: [{ uid: "u1", roleId: "owner" }, { uid: "u2", roleId: "staff" }],
    roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] }],
    types: [], dir: { u1: { name: "Ada" }, u2: { name: "Grace" } } };
  wkTypes = [{ id: "everything", name: "Everything", statuses: [{key:"open",label:"Open"},{key:"done",label:"Done"}],
    fields: [
      { key: "f_text", label: "Text", type: "text" },
      { key: "f_long", label: "Long", type: "longtext" },
      { key: "f_num",  label: "Num",  type: "number" },
      { key: "f_money",label: "Money",type: "money" },
      { key: "f_date", label: "Date", type: "date" },
      { key: "f_url",  label: "Url",  type: "url" },
      { key: "f_file", label: "File", type: "file" },
      { key: "f_check",label: "Check",type: "checkbox" },
      { key: "f_sel",  label: "Sel",  type: "select", options: ["high","low"] },
      { key: "f_multi",label: "Multi",type: "multiselect", options: ["a","b","c"] },
      { key: "f_user", label: "User", type: "user" }
    ] }];
  wkTypeId = "everything";
  wkItemSheet(null);
`);

T("the generated form draws a control for every one of the eleven types", () => {
  const rows = doc.querySelectorAll(".wk-f");
  assert.equal(rows.length, 11, "expected 11 field controls, drew " + rows.length);
});

T("a person field is a picker over the roster, never a free text box", () => {
  const el = doc.querySelector('.wk-f[data-type="user"] select');
  assert.ok(el, "user field is not a select");
  const names = [...el.options].map(o => o.textContent);
  assert.ok(names.includes("Ada") && names.includes("Grace"), names.join(","));
});

T("a choice field offers exactly the options the type declared", () => {
  const el = doc.querySelector('.wk-f[data-type="select"] select');
  const vals = [...el.options].map(o => o.value).filter(Boolean);
  assert.deepEqual(vals, ["high", "low"]);
});

/* ---------- the round trip the pure tests cannot reach ---------- */
T("every control reads back the value it was given", () => {
  const set = (type, fn) => fn(doc.querySelector('.wk-f[data-type="' + type + '"]'));
  set("text",     el => el.querySelector("input").value = "hello");
  set("longtext", el => el.querySelector("textarea").value = "two\nlines");
  set("number",   el => el.querySelector("input").value = "42");
  set("money",    el => el.querySelector("input").value = "10.5");
  set("date",     el => el.querySelector("input").value = "2026-09-11");
  set("url",      el => el.querySelector("input").value = " https://example.com ");
  set("file",     el => el.querySelector("input").value = "https://example.com/f.pdf");
  set("checkbox", el => el.querySelector("input").checked = true);
  set("select",   el => el.querySelector("select").value = "high");
  set("multiselect", el => {
    const boxes = el.querySelectorAll("input");
    boxes[0].checked = true; boxes[2].checked = true;
  });
  set("user",     el => el.querySelector("select").value = "u2");

  const got = plain(run(`wkReadFields(wkType(wkTypeId))`));
  assert.deepEqual(got, {
    f_text: "hello", f_long: "two\nlines", f_num: 42, f_money: 10.5,
    f_date: "2026-09-11", f_url: "https://example.com",
    f_file: "https://example.com/f.pdf", f_check: true,
    f_sel: "high", f_multi: ["a", "c"], f_user: "u2"
  });
});

T("an empty number reads as null, not as zero", () => {
  doc.querySelector('.wk-f[data-type="number"] input').value = "";
  assert.equal(run(`wkReadFields(wkType(wkTypeId))`).f_num, null);
});

T("what the form reads back is what the engine accepts", () => {
  doc.querySelector('.wk-f[data-type="number"] input').value = "7";
  const ok = plain(run(`(function(){
    const fields = wkReadFields(wkType(wkTypeId));
    const r = itemCommit({ type: wkType(wkTypeId), item: null,
      actor: { uid: "u1", orgId: "orgA" }, allow: () => true, now: 1, id: "x",
      intent: { kind: "create", title: "Round trip", fields } });
    return r.ok ? r.item.facets : ("REFUSED " + r.error + " " + JSON.stringify(r.details));
  })()`));
  assert.ok(Array.isArray(ok), String(ok));
  assert.ok(ok.includes("f_sel:high"), ok.join(","));
  assert.ok(ok.includes("f_user:u2"), "a uid must survive as itself");
  assert.ok(ok.includes("f_check:true"));
  assert.ok(!ok.some(f => f.startsWith("f_num:")), "a number must not become a facet");
});

/* ---------- the type builder's own read-back ---------- */
T("the builder reads its field rows back out of the DOM", () => {
  run(`
    orgTypeDraft = { id: null, name: "X", statuses: [{key:"open",label:"Open"}],
      fields: [{ key: "", label: "Priority", type: "select", required: false, options: ["high"] }] };
    $("sheetBody").innerHTML = '<div id="orgTypeFields"></div>';
    orgTypeRenderFields();
  `);
  const row = doc.querySelector(".org-fieldrow");
  assert.ok(row, "no field row rendered");
  row.querySelector(".oft-label").value = "Urgency";
  row.querySelector(".oft-required").checked = true;
  row.querySelector(".oft-options").value = "high, low , ";
  const f = plain(run(`(orgTypeReadFields(), orgTypeDraft.fields[0])`));
  assert.equal(f.label, "Urgency");
  assert.equal(f.required, true);
  assert.deepEqual(f.options, ["high", "low"], "blank choices must be dropped");
});

T("a choice field shows an options input; a text field does not", () => {
  run(`orgTypeDraft.fields = [{ key:"", label:"A", type:"text", required:false, options:[] }]; orgTypeRenderFields();`);
  assert.equal(doc.querySelectorAll(".oft-options").length, 0);
  run(`orgTypeDraft.fields = [{ key:"", label:"A", type:"select", required:false, options:["x"] }]; orgTypeRenderFields();`);
  assert.equal(doc.querySelectorAll(".oft-options").length, 1);
});

/* ---------- the org page renders without a database ---------- */
T("the org page renders roles, types and people", () => {
  run(`orgS.types = [{ id: "t1", name: "Brief", fields: [{key:"a"}], statuses: [{key:"open"}] }]; orgRender();`);
  const html = doc.getElementById("orgBody").innerHTML;
  ["Roles", "Work types", "People", "Brief", "Owner"].forEach(word =>
    assert.ok(html.includes(word), "missing from the page: " + word));
});

T("Ez Agency's admin, as owner, is offered the import, and it says nothing is deleted", () => {
  run(`orgS.myRoleId = "owner"; isAdmin = true; orgRender();`);
  const body = doc.getElementById("orgBody");
  assert.ok(body.querySelector("#orgImportTasks"), "no task import");
  assert.ok(body.querySelector("#orgImportCampaigns"), "no campaign import");
  assert.ok(body.innerHTML.includes("Nothing is deleted"), "the promise is not on screen");
  run(`isAdmin = false;`);
});

/* Every row in that section reads assignments, campaigns or users - Ez
   Agency's own pre-tenancy collections, which the rules refuse a customer.
   Drawn for a founder-door owner it was a button that could only fail. */
T("a customer owner is NOT offered the import", () => {
  run(`orgS.myRoleId = "owner"; isAdmin = false; orgRender();`);
  const body = doc.getElementById("orgBody");
  assert.equal(body.querySelector("#orgImportTasks"), null, "a customer was offered an import the rules refuse");
  assert.equal(body.querySelector("#orgSeatTeam"), null, "a customer was offered 'Add the whole team', which reads users/");
});

T("a non-owner sees no editing controls, and cannot start an import", () => {
  run(`orgS.myRoleId = "staff"; orgRender();`);
  const body = doc.getElementById("orgBody");
  assert.equal(body.querySelector("#orgAddType"), null);
  assert.equal(body.querySelector("#orgInviteBtn"), null);
  assert.equal(body.querySelector("#orgAddRole"), null);
  assert.equal(body.querySelector("#orgImportTasks"), null);
});

/* ---------- the roster and the person behind it ----------
   Every row has to hand back the uid its own handler reads, or a person
   is on screen and unreachable. And the sheet has to refuse the two
   changes that would damage the org: a second owner by mistap, and an
   owner demoting the seat everything hangs from. */
const ROSTER = `orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner",
  members: [
    { uid: "u1", roleId: "owner",   joinedAt: 1700000000000 },
    { uid: "u3", roleId: "staff",   joinedAt: 1700000000000 },
    { uid: "u2", roleId: "manager", joinedAt: 1700000000000 }
  ],
  roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] },
          { id: "manager", name: "Manager", permissions: ["item:read:org"] },
          { id: "staff", name: "Staff", permissions: ["item:read:org"] }],
  types: [], automations: [],
  dir: { u1: { name: "Ada", email: "ada@x.com" },
         u2: { name: "Max", email: "max@x.com" },
         u3: { name: "Bo",  email: "bo@x.com"  } } };`;

T("every person is a row that hands back their own uid", () => {
  run(ROSTER + " orgRender();");
  const rows = [...doc.querySelectorAll(".org-member")];
  assert.equal(rows.length, 3);
  rows.forEach(r => assert.ok(run(`!!(orgS.members || []).find(m => m.uid === ${JSON.stringify(r.dataset.member)})`),
    r.dataset.member + " is on screen but resolves to nobody"));
});

T("the owner sits first, everyone else by name", () => {
  assert.deepEqual([...doc.querySelectorAll(".org-member")].map(r => r.dataset.member),
    ["u1", "u3", "u2"]);   // Ada (owner), then Bo, then Max
});

T("the roster collapses but starts open", () => {
  const fold = doc.querySelector(".org-fold");
  assert.ok(fold, "no collapsible section");
  assert.ok(fold.open, "a settings page should not hide your own team at rest");
  assert.match(fold.querySelector("summary").textContent, /3 people/);
});

T("opening a person shows who they are", () => {
  run(`orgMemberSheet((orgS.members || []).find(m => m.uid === "u2"));`);
  const body = doc.getElementById("sheetBody").textContent;
  assert.match(body, /Max/);
  assert.match(body, /max@x\.com/);
  assert.match(body, /Manager/);
});

T("an owner can move them, and the list never offers owner", () => {
  const opts = [...doc.querySelectorAll("#omRole option")].map(o => o.value);
  assert.deepEqual(plain(opts), ["manager", "staff"]);
  assert.equal(doc.querySelector("#omRole").value, "manager");
  assert.ok(doc.querySelector("#omRemove"), "an owner should be able to remove them");
});

T("the owner's own seat cannot be reassigned from here", () => {
  run(`orgMemberSheet((orgS.members || []).find(m => m.uid === "u1"));`);
  assert.equal(doc.querySelector("#omRole"), null);
  assert.equal(doc.querySelector("#omRemove"), null, "nor removed");
  assert.match(doc.getElementById("sheetBody").textContent, /owner's role is fixed/);
});

T("removing takes two taps, and the first only arms it", () => {
  run(`orgMemberSheet((orgS.members || []).find(m => m.uid === "u3"));`);
  const btn = doc.querySelector("#omRemove");
  assert.match(btn.textContent, /Remove from organization/);
  btn.onclick();                       // first tap: arm only, no write
  assert.match(btn.textContent, /Tap again/);
  assert.equal(btn.dataset.armed, "1");
});

T("a staff member sees the roster but is offered nothing to change", () => {
  run(ROSTER + ' orgS.myRoleId = "staff"; orgRender();');
  assert.equal(doc.querySelectorAll(".org-member").length, 3, "they can still see who is here");
  run(`orgMemberSheet((orgS.members || []).find(m => m.uid === "u2"));`);
  assert.equal(doc.querySelector("#omRole"), null);
  assert.match(doc.getElementById("sheetBody").textContent, /Only an owner can change roles/);
});

/* ---------- a kind of work, opened ----------
   A list of names cannot answer the question anyone arrives with: what
   does a Brief look like, and what happens to one. The fields, the
   stages and the rules watching it have to be under the type itself. */
T("a work type opens to show its fields and stages", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [], dir: {},
    roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] }],
    types: [{ id: "brief", name: "Brief",
      fields: [{ key: "client", label: "Client", type: "text", required: true },
               { key: "due", label: "Due", type: "date" }],
      statuses: [{ key: "new", label: "New" }, { key: "done", label: "Done" }] }],
    automations: [
      { id: "a1", name: "Tell the senior", enabled: true,
        trigger: { verb: "item.status_changed", typeId: "brief" }, conditions: [],
        actions: [{ kind: "notify", toRole: "lead" }] },
      { id: "a2", name: "Something else", enabled: true,
        trigger: { verb: "item.created", typeId: "other" }, conditions: [],
        actions: [{ kind: "notify", toRole: "lead" }] }
    ] };
    orgRender();`);
  const fold = doc.querySelector(".org-typefold");
  assert.ok(fold, "the type is not a collapsible");
  assert.ok(!fold.open, "several types all open at once is the wall of text this replaces");
  const body = fold.textContent;
  assert.match(body, /Client/);
  assert.match(body, /required/i);
  assert.match(body, /Due/);
  assert.match(body, /New/);
  assert.match(body, /Done/);
});

T("only the rules that watch THIS type appear under it", () => {
  const fold = doc.querySelector(".org-typefold");
  const names = [...fold.querySelectorAll(".org-auto")].map(b => b.dataset.auto);
  assert.deepEqual(plain(names), ["a1"], "a rule aimed at another type leaked in");
});

T("the edit button inside still resolves to the type", () => {
  const btn = doc.querySelector(".org-typefold .org-type");
  assert.ok(btn, "no way to edit the type any more");
  assert.equal(btn.dataset.type, "brief");
  assert.ok(run(`!!(orgS.types || []).find(t => t.id === "brief")`));
});

T("a type nothing watches says so, rather than showing an empty box", () => {
  run(`orgS.automations = []; orgRender();`);
  assert.match(doc.querySelector(".org-typefold").textContent, /Nothing happens by itself/);
});

T("a staff member can open a type but is offered no edit", () => {
  run(`orgS.myRoleId = "staff"; orgRender();`);
  assert.ok(doc.querySelector(".org-typefold"), "they should still see what the work looks like");
  assert.equal(doc.querySelector(".org-typefold .org-type"), null);
});

T("types are grouped by the template they came from", () => {
  // Sponsorship and Video are one industry's answer; Brief is another's.
  // A flat list says the opposite of that.
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [], dir: {},
    roles: [], automations: [],
    types: [{ id: "video", name: "Video", fields: [], statuses: [{key:"a",label:"A"},{key:"b",label:"B"}] },
            { id: "brief", name: "Brief", fields: [], statuses: [{key:"a",label:"A"},{key:"b",label:"B"}] },
            { id: "sponsor", name: "Sponsorship", fields: [], statuses: [{key:"a",label:"A"},{key:"b",label:"B"}] },
            { id: "t9zz", name: "Something I made", fields: [], statuses: [{key:"a",label:"A"},{key:"b",label:"B"}] }] };
    orgRender();`);
  const heads = [...doc.querySelectorAll(".org-group-head")].map(h => h.textContent);
  assert.deepEqual(plain(heads), ["Agency or studio", "Content or channel", "Your own"]);
  // and the right types sit under the right heading
  const groups = [...doc.querySelectorAll(".org-group")].map(g =>
    [...g.querySelectorAll(".org-typefold b")].map(b => b.textContent));
  assert.deepEqual(plain(groups), [["Brief"], ["Sponsorship", "Video"], ["Something I made"]]);
});

T("one group is not a grouping", () => {
  // a lone heading over the only list on screen labels what you can see
  run(`orgS.types = [{ id: "brief", name: "Brief", fields: [], statuses: [{key:"a",label:"A"},{key:"b",label:"B"}] }];
       orgRender();`);
  assert.equal(doc.querySelector(".org-group-head"), null);
  assert.equal(doc.querySelectorAll(".org-typefold").length, 1);
});

/* ---------- the handoff track editor ----------
   A track is only real if it compiles to a blueprint the engine accepts,
   so the editor's job is to refuse everything that would not. */
T("the track editor offers every role and every status of that type", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [], dir: {}, automations: [],
    roles: [{ id: "owner", name: "Owner" }, { id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "sponsor", name: "Sponsorship", fields: [],
      statuses: [{ key: "talking", label: "Talking" }, { key: "agreed", label: "Agreed" }] }] };
    orgTrackSheet(orgS.types[0]);`);
  const roles = [...doc.querySelectorAll(".otk-role option")].map(o => o.value);
  assert.ok(roles.includes("manager") && roles.includes("staff"));
  assert.ok(roles.includes(run("HO_ANY")), "there is no way to say anyone");
  const sts = [...doc.querySelectorAll(".otk-status option")].map(o => o.value);
  assert.deepEqual(plain(sts), ["", "talking", "agreed"]);
});

T("an incomplete stop is refused with a reason, not saved", () => {
  run(`orgTrackDraft = [{ label: "", roleId: "", status: "" }]; orgTrackSave(orgS.types[0]);`);
  const err = doc.getElementById("otkErr").textContent;
  assert.match(err, /needs a name/);
  assert.match(err, /Who does this step/);
  // and the step itself is marked, so the message and the box it is
  // about are found together
  assert.equal(doc.querySelectorAll("#sheetBody .org-stop.bad").length, 1);
});

T("every control in a step has a visible label, in plain words", () => {
  // the owner's first question about the old editor was "what does that
  // mean" - of a menu whose only explanation was its first entry.
  // docs/lessons.md > "A control with no label"
  const labels = [...doc.querySelectorAll("#sheetBody .org-stop .otk-lbl")].map(l => l.textContent.trim());
  assert.deepEqual(plain(labels), ["Step name", "Who does it", "Days to finish optional", "Mark the work as optional"]);
  const first = doc.querySelector(".otk-status option").textContent;
  assert.match(first, /Don't change it/);
  assert.doesNotMatch(first, /alone/);
  // the label IS the control's label: each one wraps the control it names
  doc.querySelectorAll("#sheetBody .org-stop .otk-field").forEach(l =>
    assert.ok(l.querySelector("input,select"), "a label with nothing inside it"));
});

T("a blank track offers two ready-made shapes, and one press fills the steps", () => {
  run(`orgTrackDraft = [{ label: "", roleId: "", assignees: [], status: "", dueAfter: null }]; orgTrackRender(orgS.types[0]);`);
  const starts = [...doc.querySelectorAll(".otk-start")].map(b => b.textContent);
  assert.equal(starts.length, 2, "two shapes: " + JSON.stringify(starts));
  assert.match(starts[1], /then a manager checks it/);
  doc.querySelectorAll(".otk-start")[1].onclick();
  const draft = plain(run("orgTrackDraft"));
  assert.deepEqual(draft.map(s => [s.label, s.roleId]), [["Do the work", "staff"], ["Check it", "manager"]]);
  // the shapes are for a blank track only: once it has steps they are gone
  assert.equal(doc.querySelector(".otk-start"), null);
  assert.equal(doc.querySelectorAll("#sheetBody .org-stop").length, 2);
});

T("the line is read back as one sentence, and follows the typing", () => {
  assert.match(doc.getElementById("otkPreview").textContent, /How it flows: Do the work \(Staff\) \u2192 Check it \(Manager\) \u2192 done/);
  const name = doc.querySelector(".otk-label");
  name.value = "Write the draft";
  name.oninput();
  assert.match(doc.getElementById("otkPreview").textContent, /Write the draft \(Staff\)/);
});

T("a valid track compiles to a blueprint the real engine accepts", () => {
  // the whole claim of js/handoff.js, checked through the same validator
  // the Workflows page publishes against
  const bad = run(`
    var _t = orgS.types[0];
    var _bp = hoBuildBlueprint(_t, [{ label: "Agree", roleId: "manager", status: "agreed" },
                                    { label: "Deliver", roleId: "staff" }], { id: "bp1", orgId: "orgA", now: 1 });
    JSON.stringify(wfValidate(_bp));`);
  assert.equal(bad, "[]");
});

T("the type shows its track, and offers to set one up when it has none", () => {
  run(`orgS.types[0].track = [{ label: "Agree", roleId: "manager" }]; orgRender();`);
  const body = doc.querySelector(".org-typefold").textContent;
  assert.match(body, /Agree/);
  assert.match(body, /Manager/);
  assert.ok(doc.querySelector(".org-track"), "no way in to the editor");
  run(`orgS.types[0].track = null; orgRender();`);
  assert.match(doc.querySelector(".org-typefold").textContent, /No steps/);
  assert.match(doc.querySelector(".org-track").textContent, /Set up steps/);
});

T("picking a role offers the people in it, none ticked by default", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", automations: [],
    members: [{ uid: "u1", roleId: "manager" }, { uid: "u2", roleId: "staff" }, { uid: "u3", roleId: "staff" }],
    dir: { u1: { name: "Ada" }, u2: { name: "Bo" }, u3: { name: "Cy" } },
    roles: [{ id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "sponsor", name: "Sponsorship", fields: [], statuses: [{ key: "agreed", label: "Agreed" }],
      track: [{ label: "Outreach", roleId: "staff" }] }] };
    orgTrackSheet(orgS.types[0]);`);
  const boxes = [...doc.querySelectorAll(".otk-person")];
  assert.deepEqual(plain(boxes.map(b => b.value)), ["u2", "u3"], "it offers the wrong role's people");
  assert.ok(boxes.every(b => !b.checked));
  assert.match(doc.querySelector(".otk-who-head").textContent, /Any of these 2 can do it/);
});

T("ticking some of them narrows the stop to those people", () => {
  doc.querySelectorAll(".otk-person")[0].checked = true;
  doc.getElementById("otkSave").onclick();
  assert.deepEqual(plain(run("orgTrackDraft[0].assignees")), ["u2"]);
});

T("changing the role clears the picks, because they were another role's", () => {
  run(`orgTrackDraft = [{ label: "Outreach", roleId: "staff", assignees: ["u2"] }]; orgTrackRender(orgS.types[0]);`);
  const sel = doc.querySelector(".otk-role");
  sel.value = "manager";
  sel.onchange();
  assert.deepEqual(plain(run("orgTrackDraft[0].assignees")), []);
  assert.deepEqual(plain([...doc.querySelectorAll(".otk-person")].map(b => b.value)), ["u1"]);
});

T("a narrowed stop says so on the type", () => {
  run(`orgS.types[0].track = [{ label: "Outreach", roleId: "staff", assignees: ["u2"] }]; orgRender();`);
  assert.match(doc.querySelector(".org-typefold .org-chip u").textContent, /1 named/);
});

T("a stop can be given days, and the type shows the budget", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", dir: {}, automations: [],
    members: [{ uid: "u1", roleId: "manager" }],
    roles: [{ id: "manager", name: "Manager" }],
    types: [{ id: "sponsor", name: "Sponsorship", fields: [],
      statuses: [{ key: "agreed", label: "Agreed" }],
      track: [{ label: "Agree", roleId: "manager", dueAfter: 2 * 86400000 }] }] };
    orgRender();`);
  assert.match(doc.querySelector(".org-typefold .org-chip u").textContent, /2d/);
});

T("the editor shows days back, and reads them as milliseconds", () => {
  // days in the box, milliseconds in the model - converting at the edge
  // is what stops the two drifting
  run(`orgTrackSheet(orgS.types[0]);`);
  assert.equal(doc.querySelector(".otk-days").value, "2");
  doc.querySelector(".otk-days").value = "5";
  doc.getElementById("otkSave").onclick();          // reads the rows, then validates
  assert.equal(run("orgTrackDraft[0].dueAfter"), 5 * 86400000);
});

T("a nonsense budget is refused with a reason", () => {
  run(`orgTrackDraft = [{ label: "X", roleId: "manager", dueAfter: 0 }];`);
  const errs = run(`JSON.stringify(hoTrackErrors(orgTrackDraft, ["manager"], ["agreed"]))`);
  assert.match(errs, /number above zero/);
});

T("a stop nobody holds is marked, and named underneath", () => {
  // the cause, found from configuration - before any work has been
  // created, let alone got stuck
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", dir: {}, automations: [],
    members: [{ uid: "u2", roleId: "staff" }],
    roles: [{ id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "sponsor", name: "Sponsorship", fields: [],
      statuses: [{ key: "agreed", label: "Agreed" }],
      track: [{ label: "Agree the terms", roleId: "manager", status: "agreed" },
              { label: "Deliver it", roleId: "staff" }] }] };
    orgRender();`);
  const body = doc.querySelector(".org-typefold");
  assert.equal(body.querySelectorAll(".org-chip.gap").length, 1, "the empty stop is not marked");
  assert.match(body.querySelector(".org-warn").textContent, /Work would wait at Agree the terms/);
  assert.match(body.querySelector(".org-warn").textContent, /nobody is Manager/);
});

T("seat somebody in the role and the warning goes", () => {
  run(`orgS.members.push({ uid: "u1", roleId: "manager" }); orgRender();`);
  assert.equal(doc.querySelector(".org-typefold .org-warn"), null);
  assert.equal(doc.querySelectorAll(".org-typefold .org-chip.gap").length, 0);
});

T("the editor warns too, and still lets it be saved", () => {
  // a warning, not a refusal: an owner may draw the track before seating
  // anyone, and the honest thing is to say what will happen
  run(`orgS.members = [{ uid: "u2", roleId: "staff" }];
       orgTrackSheet(orgS.types[0]);`);
  assert.equal(doc.querySelectorAll("#sheetBody .org-stop.gap").length, 1);
  assert.match(doc.getElementById("sheetBody").textContent, /You can still save this/);
  assert.ok(doc.getElementById("otkSave"), "saving must still be offered");
});

T("a staff member is not offered the handoff editor", () => {
  run(`orgS.myRoleId = "staff"; orgRender();`);
  assert.equal(doc.querySelector(".org-track"), null);
});

T("dropping the org cache drops the directory cache with it", () => {
  // the directory is read per-organization now, so a cached roster from
  // one tenant must never survive into another
  run(`orgS = { orgId: "orgA" }; notifDir = [{ uid: "u1", name: "Ada" }]; orgInvalidate();`);
  assert.equal(run("orgS"), null);
  assert.equal(run("notifDir"), null);
});

/* ---------- the mirror's one promise ----------
   js/items.js mirrors assignments into Items after the composer has
   already committed and already told the person it worked. The whole
   safety story is that it cannot turn that success into a failure, so
   it is worth proving rather than trusting: the Firestore stub in this
   harness throws on every call - the worst case - and the mirror still
   has to resolve quietly. */
const TA = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 170)); }
};

await TA("mirroring an assignment never throws, whatever the database does", async () => {
  // an org IS present, so the mirror gets past its early return and
  // reaches the database - which in this harness fails on contact
  run(`orgS = { orgId: "orgA", myRoleId: "owner", roles: [{ id: "owner", permissions: ["*:*:org"] }], members: [], dir: {} };`);
  await vm.runInContext(
    `itemsMirrorAssignments([{ id: "a1", row: { store: "S", task: "T", toUid: "u2", createdAt: 1 } }])`, ctx);
});

await TA("mirroring a status change never throws either", async () => {
  await vm.runInContext(`itemsMirrorAssignmentStatus("a1", true)`, ctx);
});

/* ---------- the template picker ----------
   The picker is generated from PACKS, and every row has to carry the key
   its own click handler reads back off the DOM. That round trip is the
   whole reason this suite exists: a pack could be perfectly valid and
   still be unreachable because the button forgot to say which one it is. */
T("the picker draws a row per pack, each readable back", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [],
        roles: [], types: [], automations: [], dir: {} };
       orgPackSheet();`);
  const rows = [...doc.querySelectorAll("#sheetBody .org-pack")];
  assert.equal(rows.length, run("PACKS.length"));
  const keys = rows.map(r => r.dataset.pack);
  assert.deepEqual(plain(keys), plain(run("PACKS.map(p => p.key)")));
  // every key the DOM hands back resolves to a real pack
  keys.forEach(k => assert.ok(run(`!!packByKey(${JSON.stringify(k)})`), k + " does not resolve"));
});

T("each row says what it would actually add", () => {
  const first = doc.querySelector("#sheetBody .org-pack");
  const count = first.querySelector(".org-pack-count").textContent;
  assert.match(count, /kinds? of work/);
  assert.ok(!first.disabled, "an empty org should be able to add any pack");
});

T("a pack already applied is offered but marked, not silently missing", () => {
  // the alternative - hiding it - leaves somebody hunting for a template
  // they can see in the docs and not on the screen
  run(`
    var _p = packByKey("simple"), _plan = packPlan(_p, {});
    orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [], dir: {},
      roles: _plan.roles.map(r => ({ id: r.id, name: r.doc.name, permissions: r.doc.permissions })),
      types: _plan.itemTypes.map(t => ({ id: t.id, name: t.doc.name })),
      automations: [] };
    orgPackSheet();`);
  const row = doc.querySelector('#sheetBody .org-pack[data-pack="simple"]');
  assert.ok(row, "the applied pack vanished from the list");
  assert.ok(row.disabled, "it should not offer to add it again");
  assert.match(row.textContent, /Added/);
  // and a different pack is still offered
  assert.ok(!doc.querySelector('#sheetBody .org-pack[data-pack="clinic"]').disabled);
});

T("the Organization page offers templates to an owner and not to anyone else", () => {
  run(`orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner", members: [],
        roles: [], types: [], automations: [], dir: {} }; orgRender();`);
  assert.ok(doc.querySelector("#orgPackBtn"), "no way in for an owner");
  assert.ok(doc.querySelector("#orgResetOrg"), "the owner's reset row is missing");
  // every section carries its name, and sits in one of the two groups
  const secs = [...doc.querySelectorAll("#orgBody .org-sec")].map(x => x.dataset.sec);
  assert.deepEqual(secs, ["about", "types", "rules", "roles", "people", "reset"]);
  assert.ok(doc.querySelector("#orgBody .org-main [data-sec=types]") && doc.querySelector("#orgBody .org-side [data-sec=roles]"));
  run(`orgS.myRoleId = "staff"; orgRender();`);
  assert.equal(doc.querySelector("#orgPackBtn"), null);
  assert.equal(doc.querySelector("#orgResetOrg"), null, "a non-owner is offered the reset");
});

/* ---------- the scrubber, drawn into an actual document ----------
   sbPlan's arithmetic is proved in tests/scrubber.test.mjs. What only a
   document can prove is the other half: that the numbers reach the bar,
   and that a screen which does not YET know somebody's hours does not
   tell them their hours are unset. */
const sbHost = () => doc.getElementById("shiftbar");
const sbDraw = () => { run(`sbRender($("shiftbar"))`); return sbHost().innerHTML; };

T("the bar draws a segment per block and a legend, and no playhead dot", () => {
  run(`
    orgS.members = [{ uid: "u1", roleId: "owner", shiftMinutes: 360 }];
    var t0 = Date.now() - 3 * 3600000;
    S.status = "ACTIVE";
    S.shift = { client: "Store", startedAt: t0,
      segs: [{ task: "Copy", startedAt: t0, endedAt: t0 + 3600000 },
             { task: "Copy", startedAt: t0 + 2 * 3600000, endedAt: null }],
      breaks: [{ reason: "Lunch", startedAt: t0 + 3600000, endedAt: t0 + 2 * 3600000 }] };
  `);
  const html = sbDraw();
  assert.equal((html.match(/class="sb-seg sb-work/g) || []).length, 2);
  assert.equal((html.match(/class="sb-seg sb-break/g) || []).length, 1);
  assert.ok(!html.includes("sb-play"), "the green dot is back");
  assert.ok(html.includes("Remaining"), "no remaining key in the legend");
  assert.ok(/6h\s*shift/i.test(html), "the header never named the scheduled length");
  assert.ok(/data-tip="Copy · /.test(html), "a block does not say what it was");
  assert.ok(/data-tip="Lunch · /.test(html), "the break does not say what it was");
  assert.ok(html.includes("is-live"), "the open block is not marked live");
  assert.equal((html.match(/sb-tick/g) || []).length, 5, "a six-hour bar has five hour marks");
});

/* The bar is ticked every second. Rebuilt every second, its playhead
   would jump instead of glide and its live block's light would restart
   sixty times a minute - so a tick that changes no structure must move
   the pieces it already has, and only a new block may rebuild it. */
T("a second later the bar is moved, not rebuilt; a new block rebuilds it", () => {
  const bar = sbHost().querySelector(".sb-bar");
  const seg = sbHost().querySelector(".sb-seg.is-live");
  const wasLeft = sbHost().querySelector(".sb-t-live").style.left;
  run(`S.shift.startedAt -= 5 * 60000; S.shift.segs.forEach(s => { s.startedAt -= 5 * 60000; if (s.endedAt) s.endedAt -= 5 * 60000; });
       S.shift.breaks.forEach(b => { b.startedAt -= 5 * 60000; b.endedAt -= 5 * 60000; }); sbRender($("shiftbar"));`);
  assert.equal(sbHost().querySelector(".sb-bar"), bar, "the bar was rebuilt for a tick");
  assert.equal(sbHost().querySelector(".sb-seg.is-live"), seg, "the live block was rebuilt for a tick");
  assert.notEqual(sbHost().querySelector(".sb-t-live").style.left, wasLeft, "the live time did not move");
  // the new block must have SOME length, or the plan drops it as empty
  run(`S.shift.segs[1].endedAt = Date.now() - 60000; S.shift.segs.push({ task: "Embed", itemId: "r9", startedAt: Date.now() - 60000, endedAt: null }); sbRender($("shiftbar"));`);
  assert.notEqual(sbHost().querySelector(".sb-bar"), bar, "a new block did not rebuild the bar");
  assert.equal(sbHost().querySelectorAll(".sb-seg").length, 4);
});

T("pressing a block brings its task to the front of the deck", () => {
  run(`var __sbTo = -1; dkRows = [{ id: "r0" }, { id: "r9" }]; dkTo = n => { __sbTo = n; };
       if (typeof dkItemId === "undefined") dkItemId = r => r.itemId || r.id;`);
  sbHost().querySelector('.sb-seg[data-item="r9"]').click();
  assert.equal(run(`__sbTo`), 1);
  run(`__sbTo = -1;`);
  sbHost().querySelector('.sb-seg[data-n="0"]').click();
  assert.equal(run(`__sbTo`), -1, "a block with no task behind it sent the deck somewhere");
});

T("running over the schedule is marked, not clipped", () => {
  run(`
    orgS.members = [{ uid: "u1", roleId: "owner", shiftMinutes: 60 }];
    var t0 = Date.now() - 2 * 3600000;
    S.status = "ACTIVE";
    S.shift = { client: "Store", startedAt: t0,
      segs: [{ task: "Copy", startedAt: t0, endedAt: null }], breaks: [] };
  `);
  const html = sbDraw();
  assert.ok(html.includes("sb-target"), "nothing marks where the schedule ended");
  assert.ok(/over/.test(html), "the overtime is not stated");
});

/* The failure this app has paid for most often: a screen confidently
   saying something it is not in a position to know. */
T("an unloaded roster says nothing about hours; an empty one says so", () => {
  run(`orgS = null; S.status = "IDLE"; S.shift = null;`);
  const unknown = sbDraw();
  assert.ok(!unknown.includes("No shift length set"),
    "told somebody their hours are unset before the roster had loaded");

  assert.ok(/8h\s*shift/.test(unknown), "the bar should span eight hours while the roster loads");
  assert.ok(!unknown.includes("sb-default"), "called the hours a default before knowing they are unset");

  run(`
    orgS = { orgId: "orgA", org: { name: "T" }, myRoleId: "owner",
      members: [{ uid: "u1", roleId: "owner" }], roles: [], types: [], dir: {} };
  `);
  const unset = sbDraw();
  assert.ok(unset.includes("No shift length set"), "a genuinely unset schedule went unmentioned");
  assert.ok(unset.includes("sb-default"), "the assumed eight hours is not marked as a default");
});

/* The owner's call, in as many words: no shift length set means eight
   hours, not a bar that measures nothing. It still has to SAY it is a
   default, and the fill still has to run from the left edge. */
T("with no length set, a live bar spans eight hours from clock-in and says so", () => {
  run(`
    var t0 = Date.now() - 2 * 3600000;
    S.status = "ACTIVE";
    S.shift = { client: "Store", startedAt: t0, segs: [{ task: "Copy", startedAt: t0, endedAt: null }], breaks: [] };
  `);
  const html = sbDraw();
  assert.ok(/8h\s*shift/.test(html), "the span is not eight hours");
  assert.ok(html.includes("sb-default"), "does not say the eight hours is assumed");
  assert.ok(!html.includes("sb-note-live"), "the old foot note is back, on top of the start time");
  const seg = sbHost().querySelector(".sb-seg");
  assert.equal(parseFloat(seg.style.left), 0, "the fill does not start at the left edge");
  assert.ok(Math.abs(parseFloat(seg.style.width) - 25) < 0.5, "two hours of eight is a quarter, got " + seg.style.width);
  assert.equal((html.match(/sb-tick/g) || []).length, 7, "eight hours has seven hour marks");
  assert.ok(html.includes("Remaining"), "no remaining key");
});

/* ---------- two saves that once threw away what they were not showing ---------- */
await TA("saving a tracked item does not un-assign the baton holder", () => {
  const calls = [];
  ctx.__calls = calls;
  run(`itemSave = async (type, item, intent) => { __calls.push(intent); return { ok: true, item }; };
    itemsHandoffLoad = async () => null; wkPaintHandoff = async () => {};
    wkTypes = [{ id: "video", name: "Video", workflowId: "bp1", statuses: [{key:"open",label:"Open"},{key:"done",label:"Done"}], fields: [] }];
    wkTypeId = "video"; wkRows = [{ id: "v1", typeId: "video", title: "Spring cut", fields: {}, status: "open",
      assigneeIds: ["u2"], workflowRunId: "run1" }];
    wkItemSheet(wkRows[0]); document.getElementById("wkSave").click();`);
  return new Promise(res => setTimeout(res, 20)).then(() => {
    assert.ok(calls.some(c => c.kind === "update"), "no update intent was sent");
    assert.ok(!calls.some(c => c.kind === "assign"),
      "Save sent an assign intent for a tracked item - with the people the run chose read back as nobody");
    run(`closeSheet();`);
  });
});

await TA("editing a type keeps the handoff it already had", () => {
  let saved = null;
  ctx.__typeSave = t => { saved = t; };
  run(`itemTypeSave = async t => { __typeSave(t); return { ok: true, id: t.id }; };
    enterOrgPage = () => {};   // the real one reloads the org, which the tests after this one hold by hand
    orgTypeSheet({ id: "video", name: "Video", statuses: [{key:"open",label:"Open"}], fields: [],
      track: [{ roleId: "staff", label: "Cut" }], workflowId: "bp1" });
    document.getElementById("orgTypeName").value = "Video edit";
    document.getElementById("orgTypeSave").click();`);
  return new Promise(res => setTimeout(res, 20)).then(() => {
    assert.ok(saved, "the type was never saved");
    assert.equal(saved.name, "Video edit");
    assert.equal(saved.workflowId, "bp1", "renaming the type turned its handoff off");
    assert.deepEqual(plain(saved.track), [{ roleId: "staff", label: "Cut" }]);
    run(`closeSheet();`);
  });
});

T("hours outside a day are not treated as a schedule", () => {
  run(`orgS.members = [{ uid: "u1", roleId: "owner", shiftMinutes: 5000 }];`);
  assert.ok(sbDraw().includes("No shift length set"),
    "a nonsense shiftMinutes was drawn as a real target");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
