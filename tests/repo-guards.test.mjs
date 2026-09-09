/* Repo guards - the conventions README > "Conventions" states in prose,
   enforced so a push can't quietly break them. Every check here is a rule
   the project already had; none of them are new policy.

     node tests/repo-guards.test.mjs

   Same runner shape as the other suites: PASS/FAIL lines, exit 1 on any
   failure. Pure node - no emulator, no DOM, no Firebase. */
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/* Every collection-group query needs a declared index, and Firestore will
   not make one for you the way it does for ordinary single-field queries.
   A missing one does not degrade - it THROWS, and the caller here turns
   that into "you are in no organization", which is how somebody spent an
   evening looking for a membership bug that was an index. */
T("every collectionGroup query has an index declared for it", () => {
  const idx = JSON.parse(readFileSync(join(root, "firestore.indexes.json"), "utf8"));
  const declared = new Set();
  (idx.fieldOverrides || []).forEach(f =>
    (f.indexes || []).forEach(i => {
      if (i.queryScope === "COLLECTION_GROUP") declared.add(f.collectionGroup + "." + f.fieldPath);
    }));
  (idx.indexes || []).forEach(i => {
    if (i.queryScope !== "COLLECTION_GROUP") return;
    (i.fields || []).forEach(f => declared.add(i.collectionGroup + "." + f.fieldPath));
  });

  const missing = [];
  readdirSync(join(root, "js")).filter(f => f.endsWith(".js")).forEach(f => {
    const src = readFileSync(join(root, "js", f), "utf8");
    // collectionGroup("x") ... .where("y", ...)
    const re = /collectionGroup\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)([\s\S]{0,200}?)\.where\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g;
    let m2;
    while ((m2 = re.exec(src))) {
      const key = m2[1] + "." + m2[3];
      if (!declared.has(key)) missing.push(f + ": " + key);
    }
  });
  assert.deepEqual(missing, [], "collection-group queries with no declared index: " + missing.join(", "));
});

/* ---- the memory rule --------------------------------------------------
   CLAUDE.md > "Memory between sessions": sessions do not remember each
   other, so docs/lessons.md carries what each one learned and the
   SessionStart hooks put it in front of the next one. That mechanism is
   only worth anything while all three pieces still point at each other -
   a renamed hook or a deleted log fails silently and nobody notices until
   a bug already fixed comes back. */
T("sign-out forgets the organization and the caches built from it", () => {
  // orgS, the type cache and the Work page's rows belong to the account
  // that left. Kept, the next sign-in on a shared device answered "which
  // org, which role" - and so the client's permission grants - with the
  // previous person's. auth.js's sign-out branch is the one place that
  // resets session state, so that is where this looks.
  const auth = text("js/auth.js");
  const signOut = auth.slice(auth.indexOf("if (!user) {"), auth.indexOf("try {", auth.indexOf("if (!user) {")));
  ["orgInvalidate()", "itemsTaskTypeCache = null", "itemsAutomationsCache = null", "wkTypes = null", "isMember = false"]
    .forEach(s => assert.ok(signOut.includes(s), "sign-out no longer does: " + s));
});

T("the session-memory mechanism is wired end to end", () => {
  const lessons = text("docs/lessons.md");
  assert.ok(/^## Failure shapes/m.test(lessons),
    "docs/lessons.md has lost its Failure shapes section - the hook reads it by that heading");
  assert.ok(/^## Entries/m.test(lessons),
    "docs/lessons.md has lost its Entries section - the hook reads it by that heading");
  assert.ok(text("CLAUDE.md").includes("docs/lessons.md"),
    "CLAUDE.md no longer points at docs/lessons.md");

  const settings = JSON.parse(text(".claude/settings.json"));
  const cmds = (settings.hooks?.SessionStart || [])
    .flatMap(g => (g.hooks || []).map(h => h.command || ""));
  ["session-memory.sh", "session-start.sh"].forEach(name => {
    assert.ok(cmds.some(c => c.endsWith(name)),
      name + " is not registered in .claude/settings.json");
    const mode = statSync(join(root, ".claude/hooks/" + name)).mode;
    assert.ok(mode & 0o111, ".claude/hooks/" + name + " is not executable");
  });
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
