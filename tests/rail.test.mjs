/* The left rail — js/rail.js.

     node tests/rail.test.mjs

   The rail keeps no list of pages. It is built from the drawer's own
   items and re-read from them, so "which pages does this person get" is
   answered in one place: the role gating in js/auth.js. These assertions
   exist to keep it that way — a rail that started deciding for itself
   would be a second gate, and two gates that disagree is the failure this
   codebase has paid for more than once. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const drawerItem = (route, label, sub, hidden) =>
  `<a class="drawer-item${hidden ? " hidden" : ""}" href="#/${route}" data-route="${route}">
     <span class="drawer-ico"><svg data-for="${route || "home"}"></svg></span>
     <span class="drawer-txt">${label}<small>${sub}</small></span>
   </a>`;

const dom = new JSDOM(`<!doctype html><html><body>
  <aside class="rail" id="rail"></aside>
  <div id="drawer">
    ${drawerItem("", "Dashboard", "Clocks &amp; controls", false)}
    ${drawerItem("mission", "Daily Mission", "Today's shift, live", false)}
    ${drawerItem("history", "History", "Closed shifts", false)}
    ${drawerItem("team", "Team", "Roster &amp; approvals", true)}
    ${drawerItem("work", "Work", "Everything in flight", false)}
    ${drawerItem("org", "Organization", "People &amp; roles", true)}
    ${drawerItem("ledger", "Ledger Book", "Something added later", false)}
  </div>
  <span class="drawer-avatar" id="drawerAvatar">A</span>
  <span id="drawerName">Ada</span><span id="drawerMail">a@b.c</span>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/rail.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

const run = expr => vm.runInContext(expr, ctx);
const doc = dom.window.document;
const rail = () => doc.getElementById("rail");
const items = () => [...rail().querySelectorAll(".rail-item")];
const shown = () => items().filter(a => !a.classList.contains("hidden"));

run(`rlSync()`);

T("the rail carries one seat per drawer item, in the drawer's order", () => {
  assert.equal(items().length, 7);
  assert.deepEqual(items().map(a => a.dataset.route),
    ["", "mission", "history", "team", "work", "org", "ledger"]);
});

/* Six icons in the comp, eight routes in the app. Work is staff-visible
   today, so it gets a seat rather than quietly becoming unreachable. */
T("Work keeps a seat, and every route can be reached from the rail", () => {
  const work = items().find(a => a.dataset.route === "work");
  assert.ok(work, "Work has no seat in the rail");
  assert.equal(work.getAttribute("href"), "#/work");
  items().forEach(a =>
    assert.equal(a.getAttribute("href"), "#/" + a.dataset.route, a.dataset.route + " points nowhere"));
});

T("the labels are the rail's short ones, not the drawer's sentences", () => {
  const txt = r => items().find(a => a.dataset.route === r).querySelector(".rail-txt").textContent;
  assert.equal(txt(""), "Home");
  assert.equal(txt("mission"), "Mission", "\"Daily Mission\" does not fit a 116px column");
});

/* A page added to the drawer later must appear here without anybody
   remembering to register it in a second list. */
T("a page the rail has never heard of still gets a label", () => {
  const led = items().find(a => a.dataset.route === "ledger");
  assert.equal(led.querySelector(".rail-txt").textContent, "Ledger");
});

T("the icons come from the drawer, so there is one set to maintain", () => {
  const home = items()[0].querySelector(".rail-ico svg");
  assert.ok(home, "no icon was copied across");
  assert.equal(home.dataset.for, "home");
});

/* THE POINT OF THE FILE. Role gating happens once, on the drawer. */
T("a page hidden from this person is hidden in the rail too", () => {
  assert.deepEqual(shown().map(a => a.dataset.route),
    ["", "mission", "history", "work", "ledger"]);
  assert.ok(items().find(a => a.dataset.route === "team").classList.contains("hidden"));
  assert.ok(items().find(a => a.dataset.route === "org").classList.contains("hidden"));
});

T("a page unhidden later shows up on the next sync, with no rebuild", () => {
  run(`document.querySelector('.drawer-item[data-route="team"]').classList.remove("hidden"); rlSync();`);
  assert.ok(!items().find(a => a.dataset.route === "team").classList.contains("hidden"));
  assert.equal(items().length, 7, "the rail rebuilt itself and lost its identity");
});

T("the active page is marked, and only that one", () => {
  run(`document.querySelectorAll(".drawer-item").forEach(a =>
        a.classList.toggle("active", a.dataset.route === "history"));
      rlSync();`);
  const on = items().filter(a => a.classList.contains("is-on"));
  assert.equal(on.length, 1);
  assert.equal(on[0].dataset.route, "history");
});

T("the avatar copies the drawer's, photo and all", () => {
  const av = () => doc.getElementById("railAvatar");
  assert.equal(av().textContent, "A");
  run(`const d = $("drawerAvatar");
       d.classList.add("has-photo"); d.textContent = ""; d.style.backgroundImage = 'url("data:image/png;base64,xx")';
       rlSync();`);
  assert.ok(av().classList.contains("has-photo"));
  assert.ok(av().style.backgroundImage.includes("data:image/png"));
});

T("syncing before the drawer exists is quiet, not a crash", () => {
  const bare = new JSDOM(`<!doctype html><html><body><aside id="rail"></aside></body></html>`,
    { runScripts: "outside-only", url: "https://ezclockn.com/" });
  const c2 = bare.getInternalVMContext();
  c2.firebase = ctx.firebase; c2.console = console;
  ["js/config.js", "js/rail.js"].forEach(f =>
    vm.runInContext(readFileSync(join(here, "..", f), "utf8"), c2, { filename: f }));
  vm.runInContext(`rlSync()`, c2);
  assert.equal(bare.window.document.querySelectorAll(".rail-item").length, 0);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
