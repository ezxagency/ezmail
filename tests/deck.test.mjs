/* The assigned deck — js/deck.js, both halves.

     node tests/deck.test.mjs

   The pure half answers one question and it is the one that breaks: when
   the card in front is finished it leaves the snapshot, and what the deck
   shows NEXT must be the work that took its place - not card one, and not
   an index off the end.

   The DOM half is here because the deck's whole claim is that FOUR kinds
   of work wear the same card and only the action changes. That is a claim
   about markup, and only a document can check it. The real files are
   loaded into one shared scope exactly as index.html arranges them, so
   the card is built by the same code the browser runs. */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { dkPick } = createRequire(import.meta.url)(join(here, "..", "js", "deck.js"));

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 180)); }
};

/* ---------- the pure half ---------- */
const rows = ids => ids.map(id => ({ id, task: "T" + id }));

T("an empty deck picks nothing rather than card zero", () => {
  assert.deepEqual(dkPick([], "a", 0), { idx: -1, id: null });
  assert.deepEqual(dkPick(null, "a", 3), { idx: -1, id: null });
});

T("the same work stays in front even when the order changes under it", () => {
  const p = dkPick(rows(["c", "a", "b"]), "a", 0);
  assert.equal(p.id, "a");
  assert.equal(p.idx, 1, "followed the position instead of the work");
});

/* Finishing a card is the common case, and "show me the next one" is the
   only answer that does not feel like the app lost your place. */
T("when the front card is finished, its position shows what took its place", () => {
  const p = dkPick(rows(["a", "c", "d"]), "b", 1);
  assert.equal(p.idx, 1);
  assert.equal(p.id, "c");
});

T("finishing the LAST card falls back onto the new last one", () => {
  const p = dkPick(rows(["a", "b"]), "c", 2);
  assert.equal(p.idx, 1);
  assert.equal(p.id, "b");
});

T("a remembered index from a longer deck cannot point off the end", () => {
  const p = dkPick(rows(["a"]), "gone", 9);
  assert.equal(p.idx, 0);
  assert.equal(p.id, "a");
});

/* ---------- the DOM half ----------
   §12a collapsed four kinds of work into one card with one pair of
   buttons, so these assertions are about THAT: the same card, the same
   two buttons, and a left button that changes with state rather than
   with where the work came from. */
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="scrim"></div><div id="sheet" tabindex="-1"><div id="sheetBody"></div></div>
  <div id="toast"></div><div id="orgBody"></div><div id="workBody"></div>
  <div id="shiftbar"></div><div id="cxScrim"></div><footer id="dock"></footer>
  <div id="appScreen"><aside id="assignedTasksSection">
    <span id="assignedCount"></span><p id="assignedCounts"></p><div id="assignedNext"></div>
    <ul id="assignedTasksList"></ul><div id="assignedDeck" tabindex="0"></div>
  </aside></div>
</body></html>`, { runScripts: "outside-only", url: "https://ezclockn.com/" });

const ctx = dom.getInternalVMContext();
ctx.firebase = {
  initializeApp(){}, auth(){ return { currentUser: { uid: "u1", email: "a@b.c" } }; },
  firestore(){ return { collection(){ throw new Error("no network in this test"); } }; }
};
ctx.console = console;

// load order IS the dependency graph, exactly as index.html declares it
["js/config.js", "js/clock.js", "js/permissions.js", "js/item-engine.js", "js/ui.js",
 "js/migrate.js", "js/items.js", "js/workflow-engine.js", "js/automation.js",
 "js/notify.js", "js/packs.js", "js/handoff.js", "js/org.js", "js/work.js",
 "js/team.js", "js/assign.js", "js/deck.js"].forEach(f =>
  vm.runInContext(readFileSync(join(here, "..", f), "utf8"), ctx, { filename: f }));

/* render() lives in js/render.js, which this harness does not load - and
   without it dkStart() threw the moment it finished its work, quietly, as
   a rejected promise. Every assertion below still passed, because the
   state was already set: exactly the kind of silence that lets a bug
   AFTER that line go untested. Stubbed so the action runs to its end. */
vm.runInContext(`function render(){}`, ctx);

const run = expr => vm.runInContext(expr, ctx);
const deck = () => dom.window.document.getElementById("assignedDeck");
const draw = js => { run(js); return deck().innerHTML; };
/* Strict on purpose. This used to fall back to the first .dk-card, which
   is how a rebuild that marked NO card as front passed every test here
   while the real screen showed blurred glass. */
const front = () => deck().querySelector(".dk-card.is-front");
const rowJs = (extra) => `dkReset(); S.status = "IDLE"; S.shift = null; dkRender([Object.assign(
  { id:"r1", task:"Write the spring launch email", store:"Store Epsilon", fromName:"Sandy" }, ${extra || "{}"})]);`;

T("the header is Your work, with a count sentence", () => {
  draw(`dkReset(); S.status="IDLE"; S.shift=null; dkRender([
    { id:"r1", task:"Copy", store:"A", dueDate:"2000-01-01" },
    { id:"r2", task:"Design", store:"B", dueDate:"2000-01-02" },
    { id:"r3", task:"Embed", store:"C" }]);`);
  assert.ok(deck().querySelector(".dk-head h2").textContent.match(/your work/i));
  const sub = deck().querySelector(".dk-sub").textContent;
  assert.ok(sub.includes("3 tasks"), "the sentence does not count the work: " + sub);
  assert.ok(sub.includes("2 overdue"));
  assert.ok(deck().querySelector(".dk-sub b i"), "the overdue count lost its red dot");
});

T("one card per piece of work, all of them in the stack", () => {
  draw(`dkReset(); S.status="IDLE"; S.shift=null; dkRender([
    { id:"r1", task:"Copy" }, { id:"r2", task:"Design" }, { id:"r3", task:"Embed" }]);`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 3);
  assert.equal(deck().querySelectorAll(".dk-card.is-front").length, 1);
  assert.equal(deck().querySelectorAll(".dk-dots i").length, 3);
});

/* THE COLLAPSE. Four kinds, one pair of buttons. */
T("every kind of work wears the same two buttons", () => {
  const kinds = ["{}", '{ transferredFrom:"Ada" }'];
  kinds.forEach(k => {
    draw(rowJs(k));
    assert.equal(front().querySelectorAll(".dk-start").length, 1, "no Start task for " + k);
    assert.equal(front().querySelectorAll(".dk-done").length, 1, "no Done for " + k);
    assert.equal(front().querySelectorAll(".dk-bt").length, 2, "more than two buttons for " + k);
  });
});

T("Pass forward, Open and Work this stop are gone", () => {
  draw(rowJs('{ transferredFrom:"Ada" }'));
  const txt = front().textContent;
  ["Pass forward", "Approve", "Open", "Work this stop"].forEach(w =>
    assert.ok(!txt.includes(w), "the card still says " + w));
});

/* §4a: the LEFT button is the one that changes, and only with state. */
T("Start task becomes Put down once the work is running", () => {
  draw(rowJs());
  assert.equal(front().querySelectorAll(".dk-down").length, 0,
    "Put down was offered before the work had been opened");
  run(`S.status = "ACTIVE"; S.shift = { client:"Store Epsilon", startedAt: 1,
    segs: [{ task:"Write the spring launch email", itemId:"r1", startedAt: 1, endedAt: null, via:"task" }],
    breaks: [] };
    dkRender([{ id:"r1", task:"Write the spring launch email", store:"Store Epsilon", fromName:"Sandy" }]);`);
  assert.equal(front().querySelectorAll(".dk-down").length, 1, "running work cannot be put down");
  assert.equal(front().querySelectorAll(".dk-start").length, 0, "running work was offered Start task");
  assert.equal(front().querySelectorAll(".dk-done").length, 1, "Done left when Put down arrived");
});

T("running work says so, and paused work says how long it had", () => {
  run(`S.status = "ACTIVE"; S.shift = { client:"A", startedAt: 0,
    segs: [{ task:"Copy", itemId:"r1", startedAt: 0, endedAt: 60000, via:"task" },
           { task:"Design", itemId:"r2", startedAt: 60000, endedAt: null, via:"task" }], breaks: [] };
    dkRender([{ id:"r2", task:"Design" }, { id:"r1", task:"Copy" }]);`);
  const cards = [...deck().querySelectorAll(".dk-card")];
  assert.ok(cards[0].textContent.includes("Running"), "the running card is not marked");
  assert.ok(cards[1].textContent.includes("Paused"), "the paused card does not say so");
  assert.ok(/1m/.test(cards[1].textContent), "the paused card lost its accumulated time");
});

/* The comp's card is full because its fixture is full. Inventing rows here
   would put words on screen that nobody wrote. */
T("brief, checklist and attachments appear only when the work carries them", () => {
  draw(rowJs());
  assert.equal(front().querySelectorAll(".dk-blk").length, 0, "empty blocks were drawn anyway");
  draw(rowJs(`{ note:"Lead with the restock.",
    checklist:[{text:"Subject lines",done:true},{text:"Body copy",done:false}],
    attachments:[{name:"Brief.docx",meta:"248 KB",url:"https://x/y"}] }`));
  assert.ok(front().textContent.includes("Lead with the restock"));
  assert.equal(front().querySelectorAll(".dk-chk").length, 2);
  assert.equal(front().querySelectorAll(".dk-chk.is-done").length, 1);
  assert.equal(front().querySelectorAll(".dk-file").length, 1);
  assert.ok(front().textContent.includes("248 KB"));
});

T("work whose type was deleted gets no button at all, and says why", () => {
  draw(rowJs('{ orphanType:"Brief" }'));
  assert.equal(front().querySelectorAll(".dk-bt").length, 0, "an orphan was offered an action");
  assert.ok(front().textContent.includes("Brief"), "the missing type is not named");
  assert.ok(front().textContent.includes("Work page"));
});

T("overdue is stated as overdue, not as a due date", () => {
  draw(rowJs('{ dueDate:"2000-01-01" }'));
  assert.ok(front().querySelector(".dk-pill.dk-late"), "a late card is not marked late");
  assert.ok(front().textContent.includes("Overdue"));
});

T("the arrows move one card and stop at both ends", () => {
  draw(`dkReset(); S.status="IDLE"; S.shift=null; dkRender([
    { id:"r1", task:"Copy" }, { id:"r2", task:"Design" }, { id:"r3", task:"Embed" }]);`);
  const arrows = () => [...deck().querySelectorAll(".dk-ab")];
  assert.equal(arrows()[0].disabled, true, "Previous is live on the first card");
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Design"));
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Embed"));
  assert.equal(arrows()[1].disabled, true, "Next is live on the last card");
  run(`dkGo(1)`);
  assert.ok(front().textContent.includes("Embed"), "the deck ran past its own end");
});

T("a dot jumps straight to its card", () => {
  draw(`dkReset(); S.status="IDLE"; S.shift=null; dkRender([
    { id:"r1", task:"Copy" }, { id:"r2", task:"Design" }, { id:"r3", task:"Embed" }]);`);
  run(`dkTo(2)`);
  assert.ok(front().textContent.includes("Embed"));
  assert.ok(deck().querySelectorAll(".dk-dots i")[2].classList.contains("on"));
});

/* Same three-way distinction the list makes, and for the same reason. */
T("an empty deck is a CARD that says why it is empty", () => {
  run(`assignedEmptyReason = null;`);
  draw(`dkReset(); dkRender([]);`);
  assert.ok(deck().querySelector(".dk-card"), "the column collapsed instead of holding a card");
  assert.ok(deck().textContent.includes("No tasks assigned"));
  run(`assignedEmptyReason = "no-org";`);
  assert.ok(draw(`dkRender([]);`).includes("not in an organization"));
  run(`assignedEmptyReason = "org-error";`);
  assert.ok(draw(`dkRender([]);`).includes("could not load it"));
  run(`assignedEmptyReason = null;`);
});

/* ---------- Start task moves the clock (spec §3) ---------- */
T("Start task clocks in, with the card's own store and task, and no sheet", () => {
  run(`dkReset(); S.status = "IDLE"; S.shift = null; S.history = [];
       dkStart({ id:"r1", task:"Copy", store:"Store Epsilon" });`);
  assert.equal(run(`S.status`), "ACTIVE");
  assert.equal(run(`S.shift.client`), "Store Epsilon");
  assert.equal(run(`S.shift.segs.length`), 1);
  assert.equal(run(`S.shift.segs[0].itemId`), "r1");
  assert.equal(run(`S.shift.segs[0].task`), "Copy");
  assert.equal(run(`S.shift.segs[0].endedAt`), null);
});

T("starting another task pauses the one running rather than losing it", () => {
  run(`dkStart({ id:"r2", task:"Design", store:"Store Beta" });`);
  assert.equal(run(`S.shift.segs.length`), 2);
  assert.equal(run(`S.shift.segs[0].endedAt === null`), false, "the first task was never closed");
  assert.equal(run(`clkOpenItemId(S.shift)`), "r2");
  assert.equal(run(`clkPaused(S.shift, Date.now()).map(p => p.itemId).join(",")`), "r1");
});

T("starting the task already running does nothing", () => {
  const before = run(`S.shift.segs.length`);
  run(`dkStart({ id:"r2", task:"Design" });`);
  assert.equal(run(`S.shift.segs.length`), before, "a second segment was opened for the same task");
});

/* §5: the invariant. ACTIVE with no open segment crashes the next Pause. */
T("finishing leaves an IDLE segment open, never nothing", () => {
  run(`dkIdleAfter({ id:"r2", task:"Design" });`);
  const open = run(`JSON.stringify(openSeg(S.shift) || null)`);
  assert.ok(open !== "null", "the shift was left ACTIVE with no open segment");
  assert.equal(run(`openSeg(S.shift).itemId`), null);
  assert.equal(run(`openSeg(S.shift).task`), null);
  assert.equal(run(`clkIsIdle(S.shift)`), true);
});

T("finishing a task that is not the one running leaves the clock alone", () => {
  const before = run(`S.shift.segs.length`);
  run(`dkIdleAfter({ id:"r1", task:"Copy" });`);
  assert.equal(run(`S.shift.segs.length`), before);
});

T("Start task while on a break ends the break and starts the work", () => {
  run(`S.status = "ON_BREAK";
       S.shift.segs[S.shift.segs.length - 1].endedAt = 1;
       S.shift.breaks.push({ reason:"Lunch", startedAt: 1, endedAt: null });
       dkStart({ id:"r3", task:"Embed" });`);
  assert.equal(run(`S.status`), "ACTIVE");
  assert.equal(run(`openBreak(S.shift) ? 1 : 0`), 0, "the break was left open");
  assert.equal(run(`clkOpenItemId(S.shift)`), "r3");
});

/* Pressing Start task redraws the deck onto the SAME index, and the redraw
   marked nothing as front - dkSettled still said that index was settled -
   so the front card came up blurred and translucent. */
T("a redraw onto the same card marks it front again", () => {
  run(`dkReset(); S.status="IDLE"; S.shift=null;
       dkRender([{ id:"a", task:"One" }, { id:"b", task:"Two" }, { id:"c", task:"Three" }]);
       dkTo(1);`);
  assert.equal(deck().querySelectorAll(".dk-card.is-front").length, 1);
  run(`dkRefresh();`);
  const fronts = deck().querySelectorAll(".dk-card.is-front");
  assert.equal(fronts.length, 1, "the rebuilt deck has " + fronts.length + " front cards");
  assert.equal(fronts[0].dataset.n, "1", "the front moved");
  assert.equal(deck().querySelectorAll(".dk-dots i.on").length, 1, "the dot went out");
});

/* The done moment. The card used to fade the instant Done was PRESSED -
   before the sheet was confirmed, so cancelling left an invisible card -
   and the snapshot then removed it before the eye caught up. Now nothing
   happens until the finish lands: the write arms a hold, the rows the
   snapshot delivers wait, the strike draws through the title, and only
   then do the waiting rows apply. A failed finish releases at once. */
T("pressing Done changes nothing on the card until the finish lands", () => {
  run(`dkReset(); S.status = "IDLE"; S.shift = null; markAssignmentDone = () => {};
       dkRender([{ id: "a", task: "One" }, { id: "b", task: "Two" }]); dkFinish(dkRows[0]);`);
  const card = deck().querySelector('.dk-card[data-id="a"]');
  assert.ok(!card.classList.contains("is-done") && !card.classList.contains("is-going"), "the card reacted to the press");
  assert.equal(card.style.opacity, "1");
});

T("the finish holds the deck, strikes the title, then lets the new rows apply", () => {
  run(`dkHold("a"); dkRender([{ id: "b", task: "Two" }]);`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 2, "the snapshot's rows applied during the hold");
  run(`dkRefresh();`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 2, "a refresh rebuilt the held picture");
  run(`dkStrike("a");`);
  assert.ok(deck().querySelector('.dk-card[data-id="a"]').classList.contains("is-done"), "no strike through the title");
  assert.ok(deck().querySelector('.dk-card[data-id="a"] .dk-title span'), "the title has no span for the line to draw across");
  run(`dkRelease();`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 1, "the waiting rows did not apply after the hold");
  assert.equal(deck().querySelector(".dk-card").dataset.id, "b");
});

T("a finish that fails releases the hold and leaves the card alone", () => {
  run(`dkReset(); dkRender([{ id: "a", task: "One" }, { id: "b", task: "Two" }]); dkHold("a"); dkRelease();`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 2);
  assert.ok(!deck().querySelector(".is-done"));
  run(`dkRender([{ id: "b", task: "Two" }]);`);
  assert.equal(deck().querySelectorAll(".dk-card").length, 1, "renders are still held after the release");
});

/* Written, never read - shape 3: the hold exists only if the write path
   arms it, strikes on success and releases on failure. */
T("finishAssignment() drives the hold, the strike and the release", () => {
  const src = readFileSync(join(here, "..", "js", "assign.js"), "utf8");
  const body = src.slice(src.indexOf("async function finishAssignment"), src.indexOf("function watchCompletionNotifications"));
  assert.ok(/dkHold\(id\)/.test(body), "the write never arms the hold");
  assert.equal((body.match(/dkStrike\(id\)/g) || []).length, 2, "both finish paths must strike on success");
  assert.equal((body.match(/dkRelease\(\)/g) || []).length, 2, "both failure paths must release");
});

/* Work on a track: the card IS the handoff. It says which stop, who
   passed it and what they wrote, who is next - and Done is Pass on. */
T("a tracked card shows who passed it, the note, who is next, and offers Pass on", () => {
  run(`dkReset(); S.status = "IDLE"; S.shift = null; dkRender([{ id: "h1", itemId: "h1", task: "Cut the teaser", store: "Store Delta",
    handoff: { stop: { label: "Edit", index: 2, count: 3 },
      from: { uid: "u1", name: "Sandy", label: "Shoot", note: "B-roll is in the shared drive", at: 1 },
      next: { label: "Publish", role: "manager", holders: [{ uid: "u3", name: "Ada" }] }, done: false } }]);`);
  const c = front();
  assert.ok(/step 2 of 3 · Edit/.test(c.querySelector(".dk-hand .dk-blk-h").textContent));
  assert.ok(/From Sandy/.test(c.querySelector(".dk-hand-from").textContent) && /B-roll is in the shared drive/.test(c.querySelector(".dk-hand-from").textContent));
  assert.ok(/Next · Publish → Ada/.test(c.querySelector(".dk-hand-next").textContent), c.querySelector(".dk-hand-next").textContent);
  assert.equal(c.querySelector(".dk-done").textContent.trim(), "Pass on");
});

T("at the first stop it started with you; at the last, Done becomes Finish; off a track it stays Done", () => {
  run(`dkReset(); dkRender([{ id: "h2", itemId: "h2", task: "Plan it",
    handoff: { stop: { label: "Plan", index: 1, count: 2 }, from: null, next: { label: "Do", role: "staff", holders: [] }, done: false } }]);`);
  assert.ok(/First step/.test(front().querySelector(".dk-hand-from").textContent));
  assert.ok(/nobody holds staff yet/.test(front().querySelector(".dk-hand-next").textContent));
  run(`dkReset(); dkRender([{ id: "h3", itemId: "h3", task: "Ship it",
    handoff: { stop: { label: "Ship", index: 2, count: 2 }, from: { uid: "u1", name: "Sandy", note: "", at: 1 }, next: null, done: false } }]);`);
  assert.ok(/Last step/.test(front().querySelector(".dk-hand-next").textContent));
  assert.equal(front().querySelector(".dk-done").textContent.trim(), "Finish");
  run(`dkReset(); dkRender([{ id: "p1", task: "Plain" }]);`);
  assert.ok(!front().querySelector(".dk-hand"), "a plain assignment grew a handoff block");
  assert.equal(front().querySelector(".dk-done").textContent.trim(), "Done");
});

/* The bug this exists for: Start task writes the SHIFT and never touches
   the assignments, so the snapshot watcher that draws the deck never
   fired. The card went on offering Start task on work that was already
   running, and the Running pill never appeared. dkRefresh() is the redraw
   that closes that gap, and render() is what calls it. */
T("the card follows the shift, not only the snapshot", () => {
  run(`dkReset(); S.status="IDLE"; S.shift=null;
       dkRender([{ id:"r1", task:"Copy", store:"Alpha" }]);`);
  assert.ok(front().querySelector(".dk-start"), "should start out offering Start task");
  run(`dkStart(dkRows[0]);`);
  run(`dkRefresh();`);
  assert.ok(front().querySelector(".dk-down"),
    "the card still offers Start task on work that is already running");
  assert.ok(front().querySelector(".dk-live"), "the Running pill never appeared");
});

/* Written, never read - shape 3. dkRefresh() existing proves nothing if
   nothing calls it, and the only caller is in another file. */
T("render() is wired to that redraw", () => {
  const src = readFileSync(join(here, "..", "js", "render.js"), "utf8");
  assert.ok(/dkRefresh\(\)/.test(src),
    "js/render.js never asks the deck to redraw, so the card goes stale again");
});

T("an orphan cannot be started, because nothing can be done with it", () => {
  const before = run(`S.shift.segs.length`);
  run(`dkStart({ id:"r9", task:"Ghost", orphanType:"Brief" });`);
  assert.equal(run(`S.shift.segs.length`), before, "a segment was opened for unreachable work");
});

/* Thirty tasks stuttered where three did not. The spring never stopped
   asking for frames, so every card was restyled sixty times a second all
   day - and a card two back, at opacity 0, was still a full-size glass
   pane the browser blurred, shadowed and composited on each of them. The
   deck must ask for frames only while it MOVES, and paint only what can
   be seen. Frames are faked here so the loop can be stepped by hand. */
T("the spring stops when the deck is at rest, and only the visible cards are painted", () => {
  run(`var __q = []; requestAnimationFrame = cb => { __q.push(cb); return __q.length; };
       function __frame(){ const q = __q.splice(0); q.forEach(cb => cb(16)); return q.length; }
       dkReset(); S.status = "IDLE"; S.shift = null;
       dkRender(Array.from({ length: 30 }, (_, i) => ({ id: "r" + i, task: "Task " + i, store: "Alpha" })));`);
  let frames = 0;
  while (run(`__frame()`) && frames < 200) frames++;
  assert.ok(frames < 5, "at rest the loop kept running: " + frames + " frames");
  assert.equal(run(`dkRaf`), 0, "still holding a frame request while nothing moves");
  const shown = () => [...deck().querySelectorAll(".dk-card")]
    .filter(c => !c.classList.contains("is-off")).map(c => Number(c.dataset.n));
  assert.deepEqual(shown(), [0, 1], "cards nobody can see are still being painted");

  run(`dkTo(15)`);
  assert.notEqual(run(`dkRaf`), 0, "moving the deck did not restart the frames");
  frames = 0;
  while (run(`__frame()`) && frames < 400) frames++;
  assert.ok(frames > 5 && frames < 400, "the spring settled in " + frames + " frames");
  assert.equal(run(`dkPos`), 15, "did not land on the card it was sent to");
  assert.equal(run(`dkRaf`), 0, "still ticking after settling");
  assert.deepEqual(shown(), [14, 15, 16]);
  assert.ok(deck().querySelector('.dk-card[data-n="15"]').classList.contains("is-front"));
  assert.ok(deck().querySelector('.dk-card[data-n="0"]').style.opacity === "" ||
    deck().querySelector('.dk-card[data-n="0"]').classList.contains("is-off"));
  run(`delete globalThis.requestAnimationFrame;`);
});

/* The spring was tuned at 60Hz and stepped per frame, so a 120Hz screen
   ran it twice as fast. It steps by wall-clock time now: the same span of
   milliseconds lands the same distance however many frames it is cut
   into. And a frame that is missing its timestamp - a test's fake, or a
   tab back from the background - counts as one frame, never as a jump. */
T("the spring covers the same ground in the same milliseconds at 60Hz and 120Hz", () => {
  const go = (stepMs, frames) => {
    // let the previous run settle first: a loop still holding a frame
    // request would refuse to start again, and measure nothing
    run(`if (typeof __frameAt === "function") while (__frameAt(__t += 16));`);
    run(`var __q = []; var __t = 1000; requestAnimationFrame = cb => { __q.push(cb); return __q.length; };
         function __frameAt(ms){ const q = __q.splice(0); q.forEach(cb => cb(ms)); return q.length; }
         dkReset(); S.status = "IDLE"; S.shift = null;
         dkRender(Array.from({ length: 10 }, (_, i) => ({ id: "r" + i, task: "Task " + i })));
         while (__frameAt(__t)) __t += 16;
         dkTo(6);`);
    for (let i = 1; i <= frames; i++) run(`__frameAt(__t + ${i * stepMs})`);
    return run(`dkPos`);
  };
  const at60 = go(16.667, 12);   // 200ms in twelve frames
  const at120 = go(8.333, 24);   // 200ms in twenty-four frames
  assert.ok(at60 > 0.5 && at60 < 6, "the spring did not move in 200ms: " + at60);
  // within one frame: the first frame after a start has no previous
  // timestamp and counts as one 60Hz frame at either rate, by design
  assert.ok(Math.abs(at60 - at120) < 0.15, "60Hz reached " + at60 + ", 120Hz reached " + at120);
  const glass = deck().querySelector('.dk-card[data-n="0"]').style.getPropertyValue("--d");
  assert.ok(glass !== "", "the depth is not written onto the card for the glass to use");
  run(`delete globalThis.requestAnimationFrame;`);
});

/* The per-frame numbers the deck writes (--d, --o, --v) may only reach
   properties the compositor changes without a repaint. Fed into a
   gradient, a border, a shadow or a backdrop blur radius they repainted
   every visible card sixty times a second, and the deck lagged the hand. */
T("the deck's per-frame depth drives only transform, opacity and filter", () => {
  const css = readFileSync(join(here, "..", "css", "ios.css"), "utf8");
  const bad = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]*var\(--[dov]\)[^;{}]*)/g)){
    if (!/^(filter|-webkit-filter|opacity|transform)$/.test(m[1])) bad.push(m[1] + ": " + m[2].trim().slice(0, 60));
  }
  assert.deepEqual(bad, [], "painted properties driven per frame");
});

T("a trackpad's small deltas add up to one notch; a mouse notch moves at once", () => {
  run(`dkReset(); S.status = "IDLE"; S.shift = null;
       dkRender(Array.from({ length: 10 }, (_, i) => ({ id: "r" + i, task: "Task " + i })));`);
  const wheel = (dy, t) => deck().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
  wheel(100);
  assert.equal(run(`dkTarget`), 1, "a mouse notch did not move a card");
  wheel(10); wheel(10); wheel(10);
  assert.equal(run(`dkTarget`), 1, "three small trackpad deltas moved a card each");
  wheel(10); wheel(15);
  assert.equal(run(`dkTarget`), 2, "fifty pixels of trackpad did not add up to a card");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
