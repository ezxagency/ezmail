/* Repo guards - the conventions README > "Conventions" states in prose,
   enforced so a push can't quietly break them. Every check here is a rule
   the project already had; none of them are new policy.

     node tests/repo-guards.test.mjs

   Same runner shape as the other suites: PASS/FAIL lines, exit 1 on any
   failure. Pure node - no emulator, no DOM, no Firebase. */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = p => readFileSync(join(root, p), "utf8");
const bytes = p => readFileSync(join(root, p));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 200)); }
};

/* ---- the cp rule ------------------------------------------------------
   README: "timeclock-v2.html is a byte-for-byte copy of index.html".
   Editing one and forgetting `cp index.html timeclock-v2.html` ships two
   different apps to the same team. */
T("timeclock-v2.html is byte-for-byte identical to index.html", () => {
  assert.ok(bytes("index.html").equals(bytes("timeclock-v2.html")),
    "the two HTML files differ - re-run: cp index.html timeclock-v2.html");
});

/* ---- the ?v= rule -----------------------------------------------------
   README: "Every css/js reference in the HTML carries the same ?v=N".
   A missed bump pairs fresh HTML with stale cached JS - the exact failure
   the convention exists to prevent. */
const localRefs = html => [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"?]+)(\?v=(\d+))?"/g)]
  .map(m => ({ path: m[1], v: m[3] }));

const refs = localRefs(text("index.html"));

T("every local css/js reference carries a ?v=", () => {
  const bare = refs.filter(r => r.v === undefined).map(r => r.path);
  assert.equal(bare.length, 0, "missing ?v= on: " + bare.join(", "));
});

T("all ?v= values in index.html are the same", () => {
  const seen = [...new Set(refs.map(r => r.v))];
  assert.equal(seen.length, 1, "mixed cache-bust versions in play: " + seen.join(", "));
});

/* ---- references resolve ----------------------------------------------
   A renamed or deleted file that the HTML still points at is a 404 the
   browser swallows silently: the page loads, the feature is just gone. */
T("every referenced css/js file exists on disk", () => {
  const missing = refs.filter(r => { try { text(r.path); return false; } catch { return true; } })
                      .map(r => r.path);
  assert.equal(missing.length, 0, "referenced but absent: " + missing.join(", "));
});

/* The mirror of the above: a file added to css/ or js/ but never wired
   into the HTML is dead weight nobody notices until they debug why their
   new code never runs. */
T("every css/ and js/ file on disk is referenced by index.html", () => {
  const onDisk = ["css", "js"].flatMap(d =>
    readdirSync(join(root, d)).filter(f => /\.(css|js)$/.test(f)).map(f => d + "/" + f));
  const wired = new Set(refs.map(r => r.path));
  const orphans = onDisk.filter(p => !wired.has(p));
  assert.equal(orphans.length, 0, "on disk but never loaded: " + orphans.join(", "));
});

/* ---- the server runs the same engine, or it runs a different product ----
   Cloud Functions deploys only the functions/ directory, so the pure
   files the browser loads are copied in beside it. A copy that drifts is
   worse than no copy: the client and the server would quietly enforce
   different rules, and the client is the one you can see. Same shape as
   the timeclock-v2.html rule above, and for the same reason. */
["item-engine.js", "permissions.js"].forEach(f => {
  T("functions/shared/" + f + " is byte-for-byte identical to js/" + f, () => {
    assert.ok(bytes("js/" + f).equals(bytes("functions/shared/" + f)),
      "the server's copy has drifted - re-run: cp js/" + f + " functions/shared/" + f);
  });
});

/* ---- the manual-sync tradeoff, made automatic -------------------------
   js/config.js gates the UI; firestore.rules gates the database. They
   hardcode the same two lists by hand. Drift is one-directional and bad:
   drop someone from config.js and the buttons vanish, but the rules still
   say yes to anything they send straight at Firestore. */
const quoted = s => [...s.matchAll(/["']([^"']+)["']/g)].map(m => m[1].toLowerCase()).sort();

const fromConfig = name => {
  const m = text("js/config.js").match(new RegExp("const " + name + "\\s*=\\s*\\[([^\\]]*)\\]"));
  assert.ok(m, name + " not found in js/config.js");
  return quoted(m[1]);
};
const fromRules = fn => {
  const m = text("firestore.rules").match(new RegExp("function " + fn + "\\(\\)[^}]*?in\\s*\\[([^\\]]*)\\]", "s"));
  assert.ok(m, fn + "() not found in firestore.rules");
  return quoted(m[1]);
};

T("ADMIN_EMAILS matches isDesignatedAdminEmail() in firestore.rules", () => {
  assert.deepEqual(fromConfig("ADMIN_EMAILS"), fromRules("isDesignatedAdminEmail"),
    "js/config.js and firestore.rules disagree on who is admin");
});

T("ASSIGNER_EMAILS matches isAssignerEmail() in firestore.rules", () => {
  assert.deepEqual(fromConfig("ASSIGNER_EMAILS"), fromRules("isAssignerEmail"),
    "js/config.js and firestore.rules disagree on who may assign");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
