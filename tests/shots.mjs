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
  document.getElementById("drawerFlow").classList.add("hidden");
  document.querySelector('.drawer-item[data-route=""]').classList.add("active");

  render();
  rlSync();
  document.getElementById("assignedTasksSection").classList.remove("hidden");
  const t = (id, task, store, due, extra) => Object.assign(
    { id, task, store, dueDate: due, fromName: "Ada", createdAt: Date.now() - 86400000 }, extra || {});
  const rows = [
    t("r1", "Write the spring launch email", "Store Epsilon", "2026-09-30", {
      itemId: "r1",
      handoff: { stop: { label: "Copy", index: 2, count: 4 },
        from: { uid: "u9", name: "Ada", label: "Brief", note: "Brief is final — lead with the restock, the discount is a footnote.", at: Date.now() - 2 * 3600000 },
        next: { label: "Design review", role: "designer", holders: [{ uid: "u2", name: "Sandy" }] }, done: false },
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
  // one card has been through a review: the block says what was asked for
  rvMine = [{ id: "r2:work:u1", itemId: "r2", nodeId: null, aboutUid: "u1", status: "changes", round: 1, reviewerUid: null,
    submission: { link: "https://docs.example.com/backlog", note: "Cut into two-week blocks", at: Date.now() - 3 * 3600000, byUid: "u1", iteration: null, dueAt: null, onTime: null },
    decision: { kind: "changes", feedback: "Two of the slipped items are still in - drop them or say why they stay.", scores: null, byUid: "u9", at: Date.now() - 3600000 },
    history: [], title: "Second pass on the sprint backlog", store: "Studio North", updatedAt: Date.now(), version: 2 }];
  dkRender(rows);
  renderAssignedBrief(rows);
});
await shoot("next-on-shift");
await page.evaluate(() => dkTo(1));
await page.waitForTimeout(900);
await page.evaluate(() => { dkPos = dkTarget; dkLayout(); });
await shoot("next-card-review");
await page.evaluate(() => { dkTo(0); });
await page.waitForTimeout(700);
await page.evaluate(() => { dkPos = dkTarget; dkLayout(); });

// ---- the done moment: the finish has landed, the line is through the title ----
await page.evaluate(() => { dkHold("r1"); dkStrike("r1"); });
await page.waitForTimeout(250);   // + the shoot's own 350ms: the line is fully drawn, the fade not begun
await shoot("next-done");
await page.evaluate(() => { dkRelease(); dkRender(dkRows); });

// ---- a block of the bar under the cursor: it rises and says what it was ----
await page.hover(".sb-seg.is-live");
await page.waitForTimeout(400);
await shoot("next-bar-hover");
await page.mouse.move(5, 5);

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
// ---- a sheet open over the shift: glass, fields, chips, the tinted action ----
await page.evaluate(() => {
  openSheet('<h2>Clock in</h2><p class="hint">Where are you working today?</p>'
    + '<label class="fld"><span>Store</span><input type="text" value="Store Epsilon"></label>'
    + '<div class="chips"><button type="button" class="chip" aria-pressed="true">Copy</button>'
    + '<button type="button" class="chip">Embed</button><button type="button" class="chip">Design review</button></div>'
    + '<button type="button" class="btn btn-go">Clock in</button>');
});
await page.waitForTimeout(700);
await shoot("next-sheet");
if (process.env.SHOTS_CLIP){
  // SHOTS_CLIP=x,y,w,h photographs one region at 3x, for looking at a corner
  const [x, y, w, h] = process.env.SHOTS_CLIP.split(",").map(Number);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 3, mobile: false });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "clip.png"), clip: { x, y, width: w, height: h } });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.detach();
  console.log("  clip.png");
}
await page.evaluate(() => { document.getElementById("sheet").classList.remove("on"); document.getElementById("scrim").classList.remove("on"); });
await page.waitForTimeout(400);

// ---- the steps editor: every control labelled, the line read back ----
// Photographed because the first version shipped green and unreadable:
// four unlabelled controls per step, and the owner asked what one meant.
await page.evaluate(() => {
  // the fixture org is for these three pictures only; the sections after
  // this one read whatever orgS the boot left, so it is put back
  window.__orgSBefore = orgS;
  orgS = { orgId: "orgA", org: { name: "Ez Agency" }, myRoleId: "owner", automations: [],
    members: [{ uid: "u1", roleId: "manager" }, { uid: "u2", roleId: "staff" }, { uid: "u3", roleId: "staff" }],
    dir: { u1: { name: "Ada" }, u2: { name: "Bo" }, u3: { name: "Cy" } },
    roles: [{ id: "owner", name: "Owner" }, { id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "simpletask", name: "Task", fields: [],
      statuses: [{ key: "to_do", label: "To do" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }] }] };
  orgTrackSheet(orgS.types[0]);
});
await page.waitForTimeout(500);
await shoot("next-steps-blank");
await page.evaluate(() => {
  orgTrackDraft = [{ label: "Write the draft", roleId: "staff", assignees: [], status: "doing", dueAfter: 2 * 86400000 },
                   { label: "Check it", roleId: "manager", assignees: [], status: "", dueAfter: null }];
  orgTrackRender(orgS.types[0]);
});
await page.waitForTimeout(500);
await shoot("next-steps-editor");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await shoot("next-steps-editor-390");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.evaluate(() => { closeSheet(); orgS = window.__orgSBefore; });
await page.waitForTimeout(400);

// ---- five tasks started this shift: the stack is three deep and scrolls ----
await page.evaluate(() => {
  const now = Date.now();
  S.shift.segs.push(
    { task: "Proof the newsletter", itemId: "r4", client: "Store Delta",
      startedAt: now - 40 * 60000, endedAt: now - 30 * 60000 },
    { task: "Update the price list", itemId: "r5", client: "Studio North",
      startedAt: now - 30 * 60000, endedAt: now - 20 * 60000 });
  // the deck has not loaded yet, so all five are still on the stack (once
  // it has, the two it no longer carries leave); and no shift length set
  // on this seat, so the bar assumes 8h and says so
  assignedTasksSeen = null;
  orgS.members[0].shiftMinutes = 0;
  render();
});
await page.waitForTimeout(600);
// the stack springs down to the newest card; a headless container runs
// that spring at a fraction of a real frame rate, so the photograph is of
// where it lands rather than of wherever it had got to
await page.evaluate(() => { stPos = stTarget; stLayout(); });
await shoot("next-started-five");
if (process.env.SHOTS_METRICS){
  console.log(await page.evaluate(() => {
    const r = sel => { const el = document.querySelector(sel); if (!el) return sel + ": none";
      const b = el.getBoundingClientRect(); return sel + ": " + Math.round(b.left) + "," + Math.round(b.top) + " " + Math.round(b.width) + "x" + Math.round(b.height); };
    const cs = (sel, prop) => sel + " " + prop + ": " + getComputedStyle(document.querySelector(sel))[prop];
    return [".clock", ".dock", ".pickup", ".pu-row", ".pu-chip", ".dock .btn", ".started", ".st-stage", ".shiftbar", ".band", ".clock-label"].map(r)
      .concat([cs(".app.panes", "gridTemplateColumns"), "stack pos/target/raf: " + stPos + " / " + stTarget + " / " + stRaf]).join("\n");
  }));
}

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

// ---- Admin view: the home that replaces the stage for an admin ----
await page.evaluate(() => {
  isAdmin = true; canAssignTasks = true;
  const now = Date.now(), H = 3600000;
  amCollect = async () => ({ at: now,
    caps: { admin: true, assign: true, owner: true, member: false, org: true, orgName: "Ez Agency" },
    pending: [{ uid: "p1", name: "Jordan Lee", email: "jordan@ezagency.com" }],
    assigns: [
      { id: "a1", done: true, ack: false, toName: "Sandy", store: "Store Epsilon", task: "Write the spring launch email", comment: "Drafts are up", doneAt: now - 20 * 60000 },
      { id: "a2", done: false, dueDate: "2026-09-02", store: "Studio North", task: "Second pass on the sprint backlog", toName: "Prashanna" },
      { id: "a3", done: false, dueDate: "2026-09-30", store: "Store Delta", task: "Approve the final artwork" },
      { id: "a4", done: true, ack: true, doneAt: now - 3 * H }
    ],
    team: [
      { uid: "u1", name: "Prashanna", status: "active", task: "Approve the final artwork", store: "Store Delta", netMs: 2.6 * H, doc: {} },
      { uid: "u2", name: "Sandy", status: "break", task: "Copy", store: "Store Epsilon", netMs: 4.1 * H, doc: {} },
      { uid: "u3", name: "Ada", status: "done", task: "Embed", store: "Studio North", netMs: 6 * H, doc: {} }
    ],
    gaps: [{ type: "Email campaign", at: 2, label: "Design review", roleId: "designer" }],
    errors: {},
    // the board: three people, one ranked, one building, one with nothing yet
    members: [{ uid: "u1", name: "Prashanna", roleId: "owner" }, { uid: "u2", name: "Sandy", roleId: "manager" }, { uid: "u3", name: "Ada", roleId: "staff" }, { uid: "u4", name: "Bo", roleId: "staff" }],
    roles: [{ id: "owner", name: "Owner" }, { id: "manager", name: "Manager" }, { id: "staff", name: "Staff" }],
    types: [{ id: "t", statuses: [{ key: "open" }, { key: "done" }] }],
    reviews: (function(){
      const DAY = 86400000, ym = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      let n = 0;
      const mk = (about, scores, daysAgo, extra) => {
        const at = now - daysAgo * DAY, tenths = scores.quality * 5 + scores.brief * 3 + scores.handoff * 2, round = (extra && extra.round) || 1;
        return Object.assign({ id: "w" + (++n) + ":work:" + about, itemId: "w" + n, nodeId: null, typeId: "t", aboutUid: about, aboutRoleId: null, reviewerUid: null,
          status: "approved", round, submission: { link: "https://docs.example.com/w" + n, note: "Drafts are up", at: at - 3600000, byUid: about, iteration: null, dueAt: at, onTime: true },
          decision: { kind: "approved", feedback: "Restock leads, the hero is clean and the files are named. A 4 on quality because section two runs long.", scores, byUid: "u2", at },
          history: [], weightedTenths: tenths, score: tenths / 10, scores, byUid: "u2", at, month: ym(new Date(at)), firstPass: round === 1, revisions: round - 1, onTime: true,
          title: "Spring launch email", stepLabel: "Copy", store: "Store Epsilon", updatedAt: at, version: 2 }, extra || {});
      };
      const out = [];
      for (let i = 0; i < 9; i++) out.push(mk("u3", { quality: 5, brief: 4, handoff: 5 }, i + 1, { onTime: i !== 4 }));
      for (let i = 0; i < 4; i++) out.push(mk("u3", { quality: 4, brief: 4, handoff: 3 }, 35 + i));
      for (let i = 0; i < 5; i++) out.push(mk("u4", { quality: 4, brief: 4, handoff: 4 }, i + 2, { round: i % 2 ? 2 : 1 }));
      for (let i = 0; i < 3; i++) out.push(mk("u4", { quality: 3, brief: 3, handoff: 4 }, 33 + i));
      for (let i = 0; i < 9; i++) out.push(mk("u2", { quality: 4, brief: 5, handoff: 4 }, i + 3));
      // two waiting on the owner, one of them a second round
      out.push({ id: "p1:work:u4", itemId: "p1", nodeId: null, typeId: "t", aboutUid: "u4", aboutRoleId: "staff", reviewerUid: null, status: "submitted", round: 2,
        submission: { link: "https://docs.example.com/backlog", note: "Slipped items dropped; the two that stay are flagged with why.", at: now - 2 * 3600000, byUid: "u4", iteration: null, dueDate: null, dueAt: now + DAY, onTime: true },
        decision: null, history: [{ round: 1, submission: { link: "https://docs.example.com/backlog", note: "Cut into two-week blocks", at: now - DAY, byUid: "u4" }, decision: { kind: "changes", feedback: "Two of the slipped items are still in.", scores: null, byUid: "u1", at: now - 20 * 3600000 } }],
        title: "Second pass on the sprint backlog", store: "Studio North", stepLabel: "", brief: "Re-cut the backlog into two-week blocks. Anything that slipped twice gets dropped or reassigned.", score: null, weightedTenths: null, scores: null, updatedAt: now - 2 * 3600000, version: 3 });
      out.push({ id: "p2:s1:u3", itemId: "p2", nodeId: "s1", typeId: "t", aboutUid: "u3", aboutRoleId: "staff", reviewerUid: null, status: "submitted", round: 1,
        submission: { link: null, note: "Final artwork exported at 2x, fonts outlined.", at: now - 40 * 60000, byUid: "u3", iteration: 1, dueAt: now - 3600000, onTime: false },
        decision: null, history: [], title: "Approve the final artwork", store: "Store Delta", stepLabel: "Design", brief: "", score: null, weightedTenths: null, scores: null, updatedAt: now - 40 * 60000, version: 1 });
      return out;
    })() });
  orgS = Object.assign({}, orgS, { myRoleId: "owner", dir: { u1: { name: "Prashanna" }, u2: { name: "Sandy" }, u3: { name: "Ada" }, u4: { name: "Bo" } },
    roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] }, { id: "manager", name: "Manager", permissions: ["review:decide:org"] }, { id: "staff", name: "Staff", permissions: [] }],
    members: [{ uid: "u1", roleId: "owner" }, { uid: "u2", roleId: "manager" }, { uid: "u3", roleId: "staff" }, { uid: "u4", roleId: "staff" }] });
  try { localStorage.removeItem("ez-adminmode-v1:u1"); } catch (e) {}
  amApply();
});
await page.waitForTimeout(700);
await shoot("next-admin");
// no page may scroll sideways, at any width - the board is the one
// thing allowed to, inside its own scrolling box
const noSideScroll = async label => {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, document.body.scrollWidth]);
  assert.ok(w[0] <= w[1] + 1 && w[2] <= w[1] + 1, label + ": the page scrolls sideways (" + w.join("/") + ")");
};
await noSideScroll("admin 1920");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await shoot("next-admin-390");
await noSideScroll("admin 390");
// the board on a phone: it scrolls inside its own box, the page does not
await page.evaluate(() => document.querySelector(".am-quality").scrollIntoView({ block: "start" }));
await page.waitForTimeout(300);
await shoot("next-admin-390-board");
await noSideScroll("admin 390 board");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(300);

// ---- the reviewer's sheet: the brief, the work and the person together, then the decision ----
await page.evaluate(() => { rvReviewSheet(amLast.reviews.find(r => r.id === "p1:work:u4")); });
await page.waitForTimeout(500);
await page.evaluate(() => {
  document.querySelector('.rv-kind-bt[data-kind="approved"]').click();
  document.querySelector('.rt-row[data-key="quality"] .rt-pt[data-v="4"]').click();
  document.querySelector('.rt-row[data-key="brief"] .rt-pt[data-v="5"]').click();
});
await page.waitForTimeout(400);
await shoot("next-review-sheet");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await shoot("next-review-sheet-390");
await noSideScroll("review sheet 390");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.evaluate(() => closeSheet());
await page.waitForTimeout(300);

// ---- the Reviews & Feedback page, as the person whose work it is ----
await page.evaluate(() => {
  const now = Date.now(), H = 3600000;
  const all = amLast.reviews;
  rvMine = all.filter(r => r.aboutUid === "u4").map(r => Object.assign({}, r, { aboutUid: "u1" }));
  rvMine.push({ id: "c1:work:u1", itemId: "c1", nodeId: null, typeId: "t", aboutUid: "u1", aboutRoleId: "staff", reviewerUid: "u2", status: "changes", round: 1,
    submission: { link: "https://docs.example.com/pricelist", note: "Prices updated from the sheet", at: now - 5 * H, byUid: "u1", iteration: null, dueAt: null, onTime: null },
    decision: { kind: "changes", feedback: "The March lines still show last quarter's numbers - check rows 14 to 22 against the sheet.", scores: null, byUid: "u2", at: now - 2 * H },
    history: [], title: "Update the price list", store: "Studio North", stepLabel: "", score: null, weightedTenths: null, scores: null, updatedAt: now - 2 * H, version: 2 });
  rvQueue = all.filter(r => r.status === "submitted");
  go("reviews");
});
await page.waitForTimeout(500);
await shoot("next-reviews");
await noSideScroll("reviews 1920");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await shoot("next-reviews-390");
await noSideScroll("reviews 390");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(300);

// ---- the submit sheet ----
await page.evaluate(() => {
  openSheet('<h2>Submit for review</h2><p class="hint"><b>Write the spring launch email</b> · Store Epsilon · Copy</p>'
    + '<div class="rv-brief"><p class="rv-k">The brief</p><p>Three-email sequence for the spring drop. Lead with the restock, not the discount.</p></div>'
    + '<label class="fld"><span>Link to the work</span><input type="url" id="rvLink" value="https://docs.example.com/spring-launch"></label>'
    + '<label class="fld"><span>Handoff note</span><textarea id="rvNote" rows="4">Subject lines A/B/C in the doc, body copy for email 1 final, 2 and 3 drafted.</textarea></label>'
    + '<p class="rv-note" id="rvHint">A link or a note - at least one. Due Wed, Sep 30 on your clock; submitting after that counts as late.</p>'
    + '<p class="rv-note">Goes to Sandy.</p><button class="btn btn-go" id="rvSend">Submit for review</button><button class="btn btn-ghost btn-sm" id="rvCancel">Cancel</button>');
});
await page.waitForTimeout(600);
await shoot("next-submit-sheet");
await page.evaluate(() => { closeSheet(); go(""); rvMine = null; rvQueue = null; });
await page.waitForTimeout(400);

// ---- the Team page, the admin's page laid across the desktop ----
await page.evaluate(() => { go("team"); });
await page.waitForTimeout(400);
await page.evaluate(() => {
  const now = Date.now(), H = 3600000, D = 86400000;
  const day = back => new Date(now - back * D);
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const rows = [
    { id: "a1", toName: "Sandy", store: "Store Epsilon", task: "Write the spring launch email", createdAt: now - 2 * D, dueDate: iso(day(-18)) },
    { id: "a2", toName: "Prashanna", store: "Studio North", task: "Second pass on the sprint backlog", createdAt: now - 6 * D, dueDate: iso(day(3)) },
    { id: "a3", toName: "Ada", store: "Store Delta", task: "Approve the final artwork", createdAt: now - D },
    { id: "a4", toName: "Chhoki", store: "alvera", task: "Copy", createdAt: now - 20 * D, done: true, ack: true, doneAt: now - 40 * 60000 },
    { id: "a5", toName: "Test1", store: "UNIQUE NAME", task: "COPIES", createdAt: now - 9 * D, done: true, ack: true, doneAt: now - 3 * D }
  ];
  assignRows = rows;
  renderTeamStatusCards(document.getElementById("teamRecentlyDone"), rows);
  // shifts must START today by the container's clock, which may be just
  // past midnight: so they start at 00:01 rather than "hours ago"
  const t0 = new Date(now); t0.setHours(0, 1, 0, 0);
  const at = m => t0.getTime() + m * 60000;
  const mk = (id, worker, startMin, open, task, store, brk) => ({ id, raw: { email: worker.toLowerCase() + "@ezagency.com" }, state: {
    worker, status: open ? "ACTIVE" : "IDLE",
    shift: open ? { client: store, startedAt: at(startMin), segs: [{ task, itemId: id + "t", client: store, startedAt: at(startMin), endedAt: null }],
      breaks: brk ? [{ reason: "Lunch", startedAt: at(startMin + 5), endedAt: at(startMin + 8) }] : [] } : null,
    history: open ? [] : [{ client: store, startedAt: at(startMin), endedAt: at(startMin + 12), netMs: 12 * 60000, breakMs: 0,
      segs: [{ task, client: store, startedAt: at(startMin), endedAt: at(startMin + 12) }], breaks: [] }] } });
  teamPageDocs = [mk("u1", "Prashanna", 0, true, "Approve the final artwork", "Store Delta", true),
    mk("u2", "Sandy", 2, true, "Write the spring launch email", "Store Epsilon", false),
    mk("u3", "Ada", 1, false, "Embed", "Studio North", false)];
  renderTodaysWork(teamPageDocs);
  teamPendingCount = 1;
  const pending = document.getElementById("teamPending");
  pending.insertAdjacentHTML("beforebegin", '<p class="hint" id="teamPendingHint" style="margin:0 0 10px">Pending approval</p>');
  pending.innerHTML = '<li><div><div class="h-c">Jordan Lee</div><div class="h-d">jordan@ezagency.com · waiting for approval</div></div>'
    + '<div class="row-acts"><button class="btn btn-go btn-sm" style="width:auto">Approve…</button></div></li>';
  renderTeamTiles();
  teamHistoryRows = []; renderTeamHistorySection();
});
await page.waitForTimeout(500);
await shoot("next-team");
await page.evaluate(() => go(""));
await page.waitForTimeout(300);

// ---- the Organization page, the owner's setup across the desktop ----
await page.evaluate(() => { go("org"); });
await page.waitForTimeout(400);
await page.evaluate(() => {
  orgS = { orgId: "orgA", org: { name: "Test EZ" }, myRoleId: "owner",
    roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] },
      { id: "manager", name: "Manager", permissions: ["item:create:org", "item:read:org", "item:update:org", "item:delete:org", "member:read:org", "member:invite:org", "member:hours:org", "workflow:read:org"] },
      { id: "senior", name: "Senior", permissions: ["item:create:org", "item:read:org", "item:update:org", "workflow:read:org", "report:read:org"] },
      { id: "staff", name: "Staff", permissions: ["item:create:org", "item:read:org", "item:update:assigned", "workflow:read:org"] }],
    types: [
      { id: "t1", name: "Sponsorship", pack: "content", fields: [{ key: "brand", label: "Brand", type: "text", required: true }, { key: "fee", label: "Fee", type: "number" }, { key: "due", label: "Due", type: "date" }],
        statuses: [{ key: "pitch", label: "Pitch" }, { key: "agreed", label: "Agreed" }, { key: "live", label: "Live" }, { key: "done", label: "Done" }],
        track: [{ label: "Pitch", roleId: "senior" }, { label: "Design review", roleId: "designer" }, { label: "Publish", roleId: "manager" }] },
      { id: "t2", name: "Video", pack: "content", fields: [{ key: "title", label: "Title", type: "text" }, { key: "len", label: "Length", type: "number" }], statuses: [{ key: "idea", label: "Idea" }, { key: "shoot", label: "Shoot" }, { key: "edit", label: "Edit" }, { key: "done", label: "Done" }] },
      { id: "t3", name: "Email marketing", fields: [{ key: "list", label: "List", type: "text" }], statuses: [{ key: "draft", label: "Draft" }, { key: "sent", label: "Sent" }] }
    ],
    automations: [],
    members: [{ uid: "u1", roleId: "owner" }, { uid: "u2", roleId: "manager", shiftMinutes: 480 }, { uid: "u3", roleId: "staff" }],
    dir: { u1: { name: "Prashanna" }, u2: { name: "Sandy" }, u3: { name: "Ada" } } };
  orgRender();
});
await page.waitForTimeout(500);
await shoot("next-org");
await page.evaluate(() => { const d = document.querySelector('details.org-rolefold[data-role-id="staff"]'); if (d) d.open = true; });
await page.waitForTimeout(300);
await shoot("next-org-people-open");

// ---- the Flow builder: the org as one picture, edited where it is seen ----
await page.evaluate(() => { go("flow"); });
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.__orgSBefore2 = orgS;
  orgS = { orgId: "orgA", org: { name: "Ez Agency" }, myRoleId: "owner",
    members: [{ uid: "u1", roleId: "owner" }, { uid: "u2", roleId: "manager" }, { uid: "u3", roleId: "staff" }, { uid: "u4", roleId: "staff" }],
    dir: { u1: { name: "Prashanna" }, u2: { name: "Sandy" }, u3: { name: "Ada" }, u4: { name: "Bo" } },
    roles: [{ id: "owner", name: "Owner", permissions: ["*:*:org"] },
      { id: "manager", name: "Manager", permissions: ["item:create:org", "item:read:org", "item:update:org", "member:read:org", "member:hours:org"] },
      { id: "staff", name: "Staff", permissions: ["item:create:org", "item:read:org", "item:update:assigned"] },
      { id: "designer", name: "Designer", permissions: ["item:read:org", "item:update:assigned"] }],
    types: [{ id: "simpletask", name: "Task", fields: [{ key: "brand", label: "Brand", type: "text" }],
      statuses: [{ key: "to_do", label: "To do" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }],
      track: [{ id: "w", label: "Write the draft", roleId: "staff", assignees: ["u3"], status: "doing", dueAfter: 2 * 86400000 },
              { id: "d", label: "Design it", roleId: "designer", assignees: [], status: "", dueAfter: null },
              { id: "p", label: "Pick the photos", roleId: "staff", assignees: ["u4"], status: "", dueAfter: null, together: true },
              { id: "c", label: "Check it", roleId: "manager", assignees: [], status: "", dueAfter: 1 * 86400000,
                choices: ["Approve", "Send back"], routes: [{ when: { kind: "choice", value: "Send back" }, to: "w" }] }], workflowId: "bp1" },
      { id: "video", name: "Video", fields: [], statuses: [{ key: "idea", label: "Idea" }, { key: "done", label: "Done" }] }],
    automations: [{ id: "au1", name: "Tell the manager", enabled: true, trigger: { verb: "item.created", typeId: "simpletask" }, conditions: [],
                    actions: [{ kind: "notify", toRole: "manager", message: "A new task is in" }] }] };
  flS = { orgId: "orgA", typeId: "simpletask", draft: null, dirty: false, drag: null, open: null };
  flRender();
});
await page.waitForTimeout(500);
await shoot("next-flow");
// one step open for editing
await page.evaluate(() => { flS.open = 3; flPaintCanvas(); });
await page.waitForTimeout(300);
await shoot("next-flow-open");
// the rule sheet, mid-edit
await page.evaluate(() => { flRuleSheet(orgS.automations[0]); document.querySelector('.fr-verb[data-v="item.status_changed"]').onclick(); document.querySelector('.fr-status[data-v="doing"]').onclick(); });
await page.waitForTimeout(500);
await shoot("next-flow-rule");
await page.evaluate(() => { closeSheet(); flS.open = null; flPaintCanvas(); });
await page.waitForTimeout(300);
// the people panel: roles folded, then one unfolded
await page.evaluate(() => { const d = document.querySelector('#flPeople details.fl-role[data-role-id="staff"]'); if (d) d.open = true; });
await page.waitForTimeout(300);
await shoot("next-flow-people-open");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await shoot("next-flow-390");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.evaluate(() => { orgS = window.__orgSBefore2; go(""); });
await page.waitForTimeout(400);

// ---- the finish sheet on a branching step: decide, then note ----
await page.evaluate(() => {
  assignedOpenRows = [{ id: "br1", itemId: "br1", task: "Spring launch brief", store: "Store Epsilon",
    handoff: { stop: { label: "Check it", index: 4, count: 4, choices: [{ value: "Approve", to: "Done", back: false }, { value: "Send back", to: "Write the draft", back: true }] },
      from: { uid: "u3", name: "Ada", note: "Second pass, cut by half" }, next: null, done: false } }];
  markAssignmentDone("br1");
});
await page.waitForTimeout(500);
await shoot("next-decide");
await page.evaluate(() => { closeSheet(); });
await page.waitForTimeout(300);

await page.evaluate(() => go(""));
await page.waitForTimeout(300);

// ---- the same admin, switched to Me: the worker's screen, plus the switch ----
await page.evaluate(() => amSet(false));
await page.waitForTimeout(600);
await shoot("next-admin-me");
await page.evaluate(() => { isAdmin = false; canAssignTasks = false; amApply(); });

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
