/* "Pick up where you left off" — js/hero.js.

     node tests/hero.test.mjs

   The chips name real work, which is the whole reason this file has
   tests: a hardcoded pair would have looked identical in the comp and
   been a screen stating something untrue. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { hrPickups, hrPairsOf } = createRequire(import.meta.url)(join(here, "..", "js", "hero.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

const shift = (client, segs) => ({ client, segs });
const seg = (task, at, client, open) =>
  ({ task, startedAt: at, endedAt: open ? null : at + 1000, client });

T("the newest work comes first", () => {
  const p = hrPickups([shift("Alpha", [seg("Copy", 10), seg("Design", 20)])], null);
  assert.deepEqual(p.map(x => x.task), ["Design", "Copy"]);
});

/* A switch records the store only when the store is what changed, so the
   store has to be carried forward - the same walk currentStore() does. */
T("a segment that named no store inherits the one before it", () => {
  const p = hrPairsOf(shift("Alpha", [seg("Copy", 10), seg("Design", 20), seg("Embed", 30, "Beta")]));
  assert.deepEqual(p.map(x => x.store), ["Alpha", "Alpha", "Beta"]);
});

T("the same store and task twice is one chip, not two", () => {
  const p = hrPickups([
    shift("Alpha", [seg("Copy", 10), seg("Copy", 20)]),
    shift("Alpha", [seg("Copy", 5)])], null);
  assert.equal(p.length, 1);
  assert.equal(p[0].task, "Copy");
});

T("the same task at a different store is a different chip", () => {
  const p = hrPickups([shift("Alpha", [seg("Copy", 10), seg("Copy", 20, "Beta")])], null);
  assert.equal(p.length, 2);
});

T("two chips at most, however much history there is", () => {
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push(seg("Task" + i, i * 10));
  assert.equal(hrPickups([shift("Alpha", segs)], null).length, 2);
});

/* Work you are doing RIGHT NOW is not work to pick back up. */
T("the open segment is not offered back to you", () => {
  const open = shift("Alpha", [seg("Copy", 10), seg("Design", 20, null, true)]);
  const p = hrPickups([], open);
  assert.deepEqual(p.map(x => x.task), ["Copy"]);
});

T("an open shift's finished segments still count, and come first", () => {
  const open = shift("Beta", [seg("Embed", 100), seg("Review", 200, null, true)]);
  const p = hrPickups([shift("Alpha", [seg("Copy", 10)])], open);
  assert.deepEqual(p.map(x => x.task), ["Embed", "Copy"]);
});

T("no history is no chips, not an empty row", () => {
  assert.deepEqual(hrPickups([], null), []);
  assert.deepEqual(hrPickups(null, null), []);
});

/* ---- drawn ---- */
const dom = new JSDOM(`<!doctype html><html><body><footer id="dock"></footer></body></html>`,
  { runScripts: "outside-only", url: "https://ezclockn.com/" });
const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;
["js/config.js", "js/clock.js", "js/hero.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));
const run = expr => vm.runInContext(expr, ctx);
const dock = () => dom.window.document.getElementById("dock");

T("the chips name the store and the task", () => {
  run(`S.history = [{ client: "Store Epsilon",
        segs: [{ task: "Design review", startedAt: 10, endedAt: 20 }] }];
      S.shift = null; $("dock").innerHTML = ""; hrRenderPickup($("dock"));`);
  assert.equal(dock().querySelectorAll(".pu-chip").length, 1);
  assert.ok(dock().textContent.includes("Store Epsilon"));
  assert.ok(dock().textContent.includes("Design review"));
});

/* A caption over an empty row is furniture pretending to be information. */
T("nothing on record draws nothing at all — not even the caption", () => {
  run(`S.history = []; S.shift = null; $("dock").innerHTML = ""; hrRenderPickup($("dock"));`);
  assert.equal(dock().innerHTML, "");
});

T("a chip is not a button", () => {
  run(`S.history = [{ client: "A", segs: [{ task: "Copy", startedAt: 1, endedAt: 2 }] }];
      $("dock").innerHTML = ""; hrRenderPickup($("dock"));`);
  assert.equal(dock().querySelectorAll("button, a").length, 0,
    "the chips render as something pressable while a tap does nothing");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
