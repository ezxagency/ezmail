#!/usr/bin/env node
/* The cache-buster, scripted. Every css/js tag in the HTML carries the
   same ?v=N so fresh HTML can never pair with a stale cached asset - and
   the failure mode this file exists to kill is the HAND-bumped miss: one
   forgotten tag is a stale-asset outage on someone's phone. Run it after
   any css/js change; never edit ?v= by hand again.

     node tools/bump-version.mjs        # bump every tag to (highest found + 1)
     node tools/bump-version.mjs 140    # set every tag to exactly 140

   It rewrites whichever root HTML files actually carry ?v= tags (today
   just index.html - timeclock-v2.html is a redirect stub with none), so
   it also works mid-rebase on an older branch state where both files
   still carry tags. Mixed versions are unified and loudly warned about,
   because that state IS the outage half-happened. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = ["index.html", "timeclock-v2.html"];
const files = candidates.map(f => join(root, f)).filter(p => {
  try { return /\?v=\d+/.test(readFileSync(p, "utf8")); } catch { return false; }
});
if (!files.length){ console.error("No ?v= tags found in " + candidates.join(" / ") + " — nothing to bump."); process.exit(1); }

const versions = new Set();
files.forEach(p => (readFileSync(p, "utf8").match(/\?v=(\d+)/g) || []).forEach(m => versions.add(Number(m.slice(3)))));
const target = process.argv[2] !== undefined ? Number(process.argv[2]) : Math.max(...versions) + 1;
if (!Number.isInteger(target) || target < 1){ console.error("Target must be a positive integer, got: " + process.argv[2]); process.exit(1); }
if (versions.size > 1) console.warn("WARNING: mixed versions on disk (" + [...versions].sort((a, b) => a - b).join(", ") + ") — that is the outage half-happened. Unifying to " + target + ".");

for (const p of files){
  const out = readFileSync(p, "utf8").replace(/\?v=\d+/g, "?v=" + target);
  writeFileSync(p, out);
  console.log(p.slice(root.length + 1) + ": " + (out.match(/\?v=\d+/g) || []).length + " tags → ?v=" + target);
}
