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
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
// the one thing config.js reaches for at load. Stubbed so nothing dials out.
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;

// load order IS the dependency graph, exactly as index.html declares it
["js/config.js", "js/permissions.js", "js/item-engine.js", "js/ui.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js",
 // org.js calls dirInvalidate() from here: the harness only proves
 // anything if it carries the same shared scope the browser builds
 "js/notify.js",
 "js/packs.js", "js/handoff.js", "js/org.js", "js/work.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;

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

T("an owner is offered the import, and it says nothing is deleted", () => {
  run(`orgS.myRoleId = "owner"; orgRender();`);
  const body = doc.getElementById("orgBody");
  assert.ok(body.querySelector("#orgImportTasks"), "no task import");
  assert.ok(body.querySelector("#orgImportCampaigns"), "no campaign import");
  assert.ok(body.innerHTML.includes("Nothing is deleted"), "the promise is not on screen");
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
  assert.match(err, /Who holds this stop/);
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
  assert.match(doc.querySelector(".org-typefold").textContent, /No handoff/);
  assert.match(doc.querySelector(".org-track").textContent, /Set up handoff/);
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
  run(`orgS.myRoleId = "staff"; orgRender();`);
  assert.equal(doc.querySelector("#orgPackBtn"), null);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
