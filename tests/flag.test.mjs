/* The redesign flag — js/config.js, applyUiFlag().

     node tests/flag.test.mjs

   This file exists because of a hole in how the redesign was checked.
   Every screenshot was taken by adding the ui-next class BY HAND, so
   five slices were verified without ever proving that the thing which
   turns them on — ?ui=next in the address bar — does anything at all.
   docs/lessons.md: do not claim a property you did not verify. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_JS = readFileSync(join(here, "..", "js", "config.js"), "utf8");

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

/* Boot a page at a real URL and let config.js run exactly as the browser
   runs it — nothing is set by hand, which is the whole point. */
function boot(url, seed){
  const dom = new JSDOM(`<!doctype html><html><body><div id="appScreen"></div></body></html>`,
    { runScripts: "outside-only", url });
  if (seed !== undefined) dom.window.localStorage.setItem("ezUiNext", seed);
  const ctx = dom.getInternalVMContext();
  ctx.firebase = {
    initializeApp(){}, auth: () => ({ currentUser: null, onAuthStateChanged(){} }),
    firestore: () => ({ collection(){ throw new Error("no network"); } })
  };
  ctx.console = console;
  vm.runInContext(CONFIG_JS, ctx, { filename: "js/config.js" });
  return {
    on: dom.window.document.body.classList.contains("ui-next"),
    stored: dom.window.localStorage.getItem("ezUiNext"),
    run: expr => vm.runInContext(expr, ctx)
  };
}

const BASE = "https://ezclockn.com/";

/* THE DEFAULT. Flipped deliberately: a plain visit is now the redesign. */
T("a plain visit gets the new dashboard", () => {
  assert.equal(boot(BASE).on, true);
  assert.equal(boot(BASE + "#/").on, true, "a route stopped the default applying");
});

/* The difference that matters most now the default is on: "never chose"
   and "chose the old one" are not the same answer, and only the first is
   the default's to decide. */
T("choosing classic outranks the default, forever", () => {
  assert.equal(boot(BASE, "0").on, false,
    "somebody who chose the classic dashboard was dragged back to the new one");
  assert.equal(boot(BASE + "#/", "0").on, false);
});

T("a browser that refuses localStorage still gets the default", () => {
  // private windows and blocked site data throw on read; the screen must
  // still draw rather than the flag throwing on the way past
  assert.equal(boot(BASE).on, true);
});

/* The two shapes a person actually pastes. */
T("?ui=next BEFORE the hash turns it on", () => {
  assert.equal(boot(BASE + "?ui=next").on, true);
  assert.equal(boot(BASE + "?ui=next#/").on, true, "the flag was lost when a route followed it");
});

T("?ui=next INSIDE the route turns it on", () => {
  assert.equal(boot(BASE + "#/?ui=next").on, true);
  assert.equal(boot(BASE + "#/work?ui=next").on, true);
});

T("the choice is remembered either way", () => {
  assert.equal(boot(BASE + "?ui=next").stored, "1");
  assert.equal(boot(BASE + "?ui=classic").stored, "0");
  assert.equal(boot(BASE, "1").on, true, "the remembered choice was not honoured");
  assert.equal(boot(BASE + "#/", "1").on, true);
});

T("?ui=classic turns it off and REMEMBERS that too", () => {
  const back = boot(BASE + "?ui=classic", "1");
  assert.equal(back.on, false, "there was no way back to the classic dashboard");
  assert.equal(back.stored, "0");
  assert.equal(boot(BASE, "0").on, false);
});

/* A flag that only matches at a string edge would miss the common case. */
T("it is found among other query parameters", () => {
  assert.equal(boot(BASE + "?from=email&ui=next").on, true);
  assert.equal(boot(BASE + "?ui=next&t=123").on, true);
});

/* A lookalike must not be read as ?ui=classic either, now that classic is
   the thing a mistyped parameter could cost somebody. */
T("a lookalike parameter is not the flag", () => {
  assert.equal(boot(BASE + "?ui=nextish", "0").on, false, "?ui=nextish was read as ?ui=next");
  assert.equal(boot(BASE + "?ui=classical").on, true, "?ui=classical was read as ?ui=classic");
  assert.equal(boot(BASE + "?guide=nextweek", "0").on, false);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
