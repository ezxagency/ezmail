/* SCREENSHOTS — the dashboard in an actual browser.

     cd tests && npm run shots        # writes tests/.shots/*.png

   Not part of `npm test`: it needs a browser, so it stays a thing you
   run when you have changed how something LOOKS.

   It exists because the pure suites and the jsdom ones both passed on a
   deck whose front card was translucent enough to read the card behind
   it through, a scrubber legend sitting on top of its own timestamps,
   and a note rendering in capitals because it inherited text-transform
   from the bar it replaced. Every one of those is invisible to an
   assertion about markup and obvious in a picture.

   Firebase is stubbed before any script runs, so nothing dials out and
   no account is needed: the page boots, then the state is set by hand
   and the real render functions are called. That is the compromise -
   the CSS and the markup are the real ones, the DATA is a fixture. */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const OUT = join(here, ".shots");
mkdirSync(OUT, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(root, rel === "/" ? "index.html" : rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

/* A hardcoded build path rots the day Playwright bumps its browser. Take
   an explicit CHROMIUM_PATH, else the newest Chromium on disk under the
   Playwright browsers dir, else let Playwright resolve its own. */
const chromiumPath = (() => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    return readdirSync(dir).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
      .map(d => join(dir, d, "chrome-linux", "chrome")).find(p => existsSync(p));
  } catch { return undefined; }
})();
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
// Fixtures must never load the real Firebase SDK or contact live services.
await page.route("**/*", route => route.request().url().startsWith(base + "/")
  ? route.continue() : route.abort());

/* Everything the page reaches for at load, and nothing more. A stub that
   resolved with DATA would be a second fixture nobody can see; these all
   answer "nothing there" so the screen is drawn from what is set below. */
await page.addInitScript(() => {
  const col = {
    doc: () => docStub, where: () => col, orderBy: () => col, limit: () => col,
    onSnapshot: () => () => {}, add: () => Promise.resolve({ id: "x" }),
    get: () => Promise.resolve({ forEach(){}, empty: true, size: 0, docs: [] })
  };
  const docStub = {
    collection: () => col, onSnapshot: () => () => {},
    get: () => Promise.resolve({ exists: false, data: () => ({}) }),
    set: () => Promise.resolve(), update: () => Promise.resolve(), delete: () => Promise.resolve()
  };
  const fs = () => ({ collection: () => col, collectionGroup: () => col, doc: () => docStub,
    batch: () => ({ set(){}, update(){}, delete(){}, commit: () => Promise.resolve() }),
    runTransaction: fn => fn({ get: () => Promise.resolve({ exists: false, data: () => ({}) }), set(){}, update(){} }) });
  fs.FieldValue = { serverTimestamp: () => 0, delete: () => null,
    arrayUnion: (...a) => a, arrayRemove: (...a) => a };
  window.firebase = {
    initializeApp(){}, firestore: fs,
    auth: () => ({ currentUser: { uid: "u1", email: "prashanna@ez.com" },
      onAuthStateChanged(){}, signOut: () => Promise.resolve() }),
    functions: () => ({ httpsCallable: () => () => Promise.resolve({ data: {} }) })
  };
  window.Drawflow = function(){ return { start(){}, on(){}, addNode(){}, clear(){} }; };
});

const errs = [];
page.on("pageerror", e => errs.push(String(e.message).slice(0, 160)));
/* A PLAIN visit, with nothing set by hand. The harness used to add the
   ui-next class itself, which meant five slices were photographed
   without ever proving the flag does anything. Now it proves the
   default: no query string, no stored choice, new dashboard. */
await page.goto(base + "/index.html#/", { waitUntil: "load" });
await page.waitForTimeout(400);

const flagged = await page.evaluate(() => document.body.classList.contains("ui-next"));
if (!flagged){
  console.log("FAIL: a plain visit did not get the new dashboard");
  await browser.close(); server.close(); process.exit(1);
}
console.log("plain visit → the new dashboard (the default)");

const shoot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("  " + name + ".png");
};

// ---- on shift, four pieces of work assigned ----
await page.evaluate(() => {
  const H = 3600000, now = Date.now();
  const d = new Date(now), mid = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayAt = (back, h) => new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() - back, h).getTime();

  document.getElementById("loginScreen").classList.add("hidden");
  const app = document.getElementById("appScreen");
  app.classList.remove("hidden");
  app.classList.add("panes", "has-tasks");

  isAdmin = false; isMember = false;
  S.worker = "Prashanna";
  S.status = "ACTIVE";
  /* Segments carry the ITEM they were spent on, which is what makes two of
     these tasks PAUSED rather than merely past - and the chips under the
     dock are that list. A fixture without itemIds photographed a row that
     can never draw. */
  S.shift = { client: "Store Epsilon", startedAt: now - 3 * H - 17 * 60000,
    segs: [
      { task: "Write the spring launch email", itemId: "r1", client: "Store Epsilon",
        startedAt: now - 3 * H - 17 * 60000, endedAt: now - 2 * H },
      { task: "Second pass on the sprint backlog", itemId: "r2", client: "Studio North",
        startedAt: now - 80 * 60000, endedAt: now - 46 * 60000 },
      { task: "Approve the final artwork", itemId: "r3", client: "Store Delta",
        startedAt: now - 46 * 60000, endedAt: null }
    ],
    breaks: [{ reason: "Lunch", startedAt: now - 2 * H, endedAt: now - 80 * 60000 }] };
  S.history = [1, 2, 3, 4].map(b => ({
    client: "Store Epsilon", startedAt: dayAt(b, 9), endedAt: dayAt(b, 9 + (9 - b)),
    netMs: (9 - b) * H, breakMs: 0,
    segs: [{ task: b % 2 ? "Copy" : "Embed", startedAt: dayAt(b, 9), endedAt: dayAt(b, 12) }], breaks: [] }));

  orgS = { orgId: "orgA", org: { name: "Ez Agency" }, myRoleId: "staff",
    members: [{ uid: "u1", roleId: "staff", shiftMinutes: 360 }],
    roles: [{ id: "staff", name: "Staff", permissions: ["item:update:assigned"] }],
    types: [], dir: { u1: { name: "Prashanna" } } };

  document.querySelectorAll(".drawer-item").forEach(a => a.classList.remove("hidden"));
  document.getElementById("drawerTeam").classList.add("hidden");
  document.getElementById("drawerOrg").classList.add("hidden");
  document.querySelector('.drawer-item[data-route=""]').classList.add("active");

  render();
  rlSync();
  document.getElementById("assignedTasksSection").classList.remove("hidden");
  const t = (id, task, store, due, extra) => Object.assign(
    { id, task, store, dueDate: due, fromName: "Ada", createdAt: Date.now() - 86400000 }, extra || {});
  const rows = [
    t("r1", "Write the spring launch email", "Store Epsilon", "2026-09-30", {
      note: "Three-email sequence for the spring drop. Lead with the restock, not the discount — last quarter the discount-led version underperformed by 18%.",
      checklist: [
        { text: "Subject line, 3 variants", done: true },
        { text: "Body copy, email 1", done: false },
        { text: "Body copy, emails 2 and 3", done: false }
      ],
      attachments: [
        { name: "Spring launch brief.docx", meta: "248 KB · Sandy", url: "#", icon: "doc" },
        { name: "Product shots (12)", meta: "4.1 MB", url: "#", icon: "img" },
        { name: "Last quarter's sequence", meta: "Google Docs", url: "#", icon: "link" }
      ] }),
    t("r2", "Second pass on the sprint backlog", "Studio North", "2026-09-02", {
      note: "Re-cut the backlog into two-week blocks. Anything that slipped twice gets dropped or reassigned." }),
    t("r3", "Approve the final artwork", "Store Delta", "2026-09-08", {})
  ];
  dkRender(rows);
  renderAssignedBrief(rows);
});
await shoot("next-on-shift");

// Layout needs browser geometry: a DOM-only test cannot catch a grid row
// shrinking through its labels or seconds inheriting a microscopic em size.
for (const [width, height] of [[1920,1080], [1440,900], [1280,720], [1024,600], [1024,450], [768,900], [390,844]]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height }; };
    return {
      panels: [...document.querySelectorAll('.clock-panel')].map(rect),
      buttons: [...document.querySelectorAll('#dock .btn')].map(rect),
      seconds: [...document.querySelectorAll('.clock-panel .ring-sec')].map(el => parseFloat(getComputedStyle(el).fontSize)),
      clock: rect(document.querySelector('.clock')),
      shiftbar: rect(document.querySelector('.shiftbar')),
      rings: [...document.querySelectorAll('.clock-panel .ring')].map(rect)
    };
  });
  const label = `${width}x${height}`;
  assert.ok(layout.buttons[0].top - Math.max(...layout.panels.map(r => r.bottom)) >= 16, `${label}: clocks overlap dock`);
  assert.ok(layout.buttons.every(r => r.height >= 44 && r.height <= 60), `${label}: buttons should stay compact and tappable`);
  assert.ok(layout.seconds.every(size => size >= 16), `${label}: seconds should be readable`);
  assert.ok(layout.rings.every(r => r.left >= layout.clock.left && r.right <= layout.clock.right), `${label}: rings overflow clock column`);
  if (width >= 1024) assert.ok(layout.shiftbar.top - Math.max(...layout.buttons.map(r => r.bottom)) >= 12, `${label}: timeline overlaps dock`);
  await shoot(`next-active-${label}`);
}
await page.setViewportSize({ width:1920, height:1080 });

// ---- the same shift, close on the dock: the paused chips are the point ----
await page.evaluate(() => {
  const d = document.querySelector(".dock") || document.getElementById("dock");
  if (d) d.scrollIntoView({ block: "center" });
});

// ---- clocked out, nothing assigned: the state a new person opens on ----
await page.evaluate(() => {
  S.status = "IDLE"; S.shift = null;
  render(); dkRender([]); renderAssignedBrief([]);
});
await shoot("next-idle");

// ---- and the classic dashboard, reached the way a person reaches it ----
await page.goto(base + "/index.html?ui=classic#/", { waitUntil: "load" });
await page.waitForTimeout(300);
if (await page.evaluate(() => document.body.classList.contains("ui-next"))){
  console.log("FAIL: ?ui=classic did not turn the redesign off");
  await browser.close(); server.close(); process.exit(1);
}
await page.evaluate(() => {
  document.getElementById("loginScreen").classList.add("hidden");
  const app = document.getElementById("appScreen");
  app.classList.remove("hidden");
  app.classList.add("panes", "has-tasks");
  isAdmin = false; isMember = false;
  S.worker = "Prashanna";
  document.getElementById("assignedTasksSection").classList.remove("hidden");
  const H = 3600000, now = Date.now();
  S.status = "ACTIVE";
  S.shift = { client: "Store Epsilon", startedAt: now - 3 * H,
    segs: [{ task: "Design review", startedAt: now - 80 * 60000, endedAt: null }],
    breaks: [{ reason: "Lunch", startedAt: now - 2 * H, endedAt: now - 80 * 60000 }] };
  const rows = [{ id: "r1", task: "Copy", store: "Store Epsilon",
    dueDate: "2026-09-04", fromName: "Ada", createdAt: Date.now() }];
  render(); renderAssignedList(rows); renderAssignedBrief(rows);
});
await shoot("classic-unchanged");

console.log(errs.length ? "\nPAGE ERRORS:\n  " + errs.slice(0, 8).join("\n  ") : "\nno page errors");
await browser.close();
server.close();
process.exit(errs.length ? 1 : 0);
