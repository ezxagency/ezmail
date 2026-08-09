/* ============================================================
   ASSIGNMENTS — the composer, shared helpers, the worker-side queue.

   The old admin flow (dropdown steps, then the terminal-kit sheet) was
   deleted wholesale and rebuilt from scratch as THE COMPOSER: one input
   that understands names, stores and tasks, and an assignment that
   writes itself as a three-line sentence (SEND / TO / AT) of removable
   chips. See css/assign.css for the look. The data model is unchanged:
   one Firestore doc per person x store x task, batch-written, pairs
   from one send sharing a groupId.
   ============================================================ */

// one key per store x task combination; a newline can't appear in either
// name (both come from single-line inputs), so it is a safe separator
const pairKey = (store, task) => store + "\n" + task;

// makes "17:30" read as "5:30 PM" wherever a due time is shown in prose -
// campaigns.js reuses it for stage due times
function afTimeLabel(hhmm){
  const p = String(hhmm).split(":").map(Number);
  if (p.length !== 2 || p.some(isNaN)) return hhmm;
  return new Date(2000, 0, 1, p[0], p[1]).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* dueTime is purely additive display info, never part of comparisons -
   dueDate stays a plain YYYY-MM-DD string everywhere it's sorted or
   checked against "today" (r.dueDate === today, r.dueDate < today), since
   swapping it for a datetime would break every one of those exact-match
   checks. This just tacks the time on for the rows that show a due date. */
function dueWithTime(r){ return r.dueDate ? r.dueDate + (r.dueTime ? " " + r.dueTime : "") : ""; }

// the shared tick glyph - the Pomodoro settings dropdowns and Campaigns'
// stage pips render it too, so it lives here rather than in any one feature
const AF_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>';

/* ============================================================
   THE COMPOSER — type-first assigning.

   One bar. Type "des" and the deck under it offers the task Design, the
   designer Desmond and ALL DESIGN; pick with a click or ↵. Every pick
   becomes a chip in the sentence below - SEND [tasks] TO [people] AT
   [stores] - and the send button spells out exactly what will land
   ("Assign 4 tasks → 2 people"). Backspace on the empty bar takes the
   last chip back; Esc clears, then closes.

   Editing an existing thread reuses the same surface with the person
   locked; on save, open rows are matched by store+task so unchanged
   lines keep their doc ids, removed lines are deleted, and new lines
   join under the same groupId (done rows only get the group arithmetic).
   NOTE the one model simplification vs the old flow: the composer's
   sentence is a grid - every task applies at every store for everyone
   in the send. Different work for different people = two quick sends.
   ============================================================ */
let cx = null;         // open composer: { who, stores, tasks, note, due, dueTime, edit, order }
let cxData = null;     // { members, stores, tasks, roles } - loaded async per open
let cxSugList = [];    // suggestion rows currently on screen
let cxHi = 0;          // highlighted suggestion index
let cxKindHint = null; // lane a tapped placeholder slot asked to fill next
let cxPrevFocus = null;

const CX_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';

const cxIsOpen = () => $("cx").classList.contains("on");
const cxPairCount = () => cx ? cx.who.length * cx.stores.length * cx.tasks.length : 0;
const cxReady = () => !!cx && cx.who.length > 0 && cx.stores.length > 0
  && cx.tasks.length > 0 && cx.note.trim().length >= 3;

/* Members carry their open-task count (assignments + live campaign batons),
   so the deck shows who is loaded before more lands on them. Stores and
   tasks come from CONFIG plus everything actually assigned before, so both
   lists learn instead of going stale. */
async function cxLoadOptions(){
  let rows = [];
  try { rows = await fetchAssignRows(); } catch (e) { console.error(e); rows = assignRows || []; }

  const openBy = new Map();
  rows.forEach(r => { if (!r.done && r.toUid) openBy.set(r.toUid, (openBy.get(r.toUid) || 0) + 1); });
  (typeof cgRows !== "undefined" && cgRows ? cgRows : [])
    .filter(c => c.status === "active")
    .forEach(c => cgOwnersOf(cgStage(c)).forEach(o =>
      openBy.set(o.uid, (openBy.get(o.uid) || 0) + 1)));

  const members = [];
  try {
    const snap = await db.collection("appState").get();
    snap.forEach(doc => {
      const data = doc.data();
      let s; try { s = JSON.parse(data.json); } catch { s = null; }
      if (!s) return;
      members.push({ uid: doc.id, name: s.worker || data.email || "Unnamed", open: openBy.get(doc.id) || 0 });
    });
  } catch (e) { console.error(e); }
  members.sort((a, b) => a.name.localeCompare(b.name));

  const storeSeen = new Map();
  CONFIG.clients.forEach(c => storeSeen.set(c.toLowerCase(), c));
  rows.forEach(r => { if (r.store) storeSeen.set(String(r.store).toLowerCase(), r.store); });
  const stores = [...storeSeen.values()].sort((a, b) => a.localeCompare(b));

  const taskSeen = new Map();
  CONFIG.tasks.forEach(t => taskSeen.set(t.toLowerCase(), t));
  rows.forEach(r => { if (r.task) taskSeen.set(String(r.task).toLowerCase(), r.task); });
  const tasks = [...taskSeen.values()].sort((a, b) => a.localeCompare(b));

  // "ALL <craft>" team picks, from the same directory the @mention
  // autocomplete and campaign role-routing already read
  let roles = [];
  try {
    const dir = await loadDirectory();
    const byCraft = new Map();
    dir.forEach(pp => {
      const craft = (pp.craft || "").trim().toLowerCase();
      if (!craft || !members.some(m => m.uid === pp.uid)) return;
      if (!byCraft.has(craft)) byCraft.set(craft, []);
      byCraft.get(craft).push(pp.uid);
    });
    roles = [...byCraft.entries()]
      .filter(([, uids]) => uids.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([craft, uids]) => ({ craft, label: "ALL " + craft.toUpperCase(), uids }));
  } catch (e) { console.error(e); }

  return { members, stores, tasks, roles };
}

function openComposer(preUid, preName, editThread){
  const edit = editThread || null;
  const openRows = edit ? edit.rows.filter(r => !r.done) : [];
  // editing prefills from the thread's still-open rows; the due date is the
  // one most of them carry (older groups could vary per line)
  let due = "", dueTime = "";
  if (openRows.length){
    const freq = new Map();
    openRows.forEach(r => freq.set(r.dueDate || "", (freq.get(r.dueDate || "") || 0) + 1));
    due = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const withShared = openRows.find(r => r.dueDate === due && r.dueTime);
    dueTime = withShared ? withShared.dueTime : "";
  }
  cx = {
    edit, order: [],
    who: [], stores: [], tasks: [],
    note: openRows.length ? (openRows[0].note || "") : "",
    due, dueTime
  };
  if (edit){
    cx.who = [{ uid: openRows[0].toUid, name: openRows[0].toName }];
    openRows.forEach(r => {
      if (r.store && !cx.stores.includes(r.store)) cx.stores.push(r.store);
      if (r.task && !cx.tasks.includes(r.task)) cx.tasks.push(r.task);
    });
  } else if (preUid){
    cx.who = [{ uid: preUid, name: preName || "" }];
  }
  cxData = null; cxSugList = []; cxHi = 0; cxKindHint = null;
  cxPrevFocus = document.activeElement;

  $("cx").innerHTML = `
    <div class="cx-top">
      <span class="cx-eyebrow">${edit ? "Edit assignment" : "New assignment"}</span>
      <button type="button" class="cx-x" id="cxClose" aria-label="Close">${CX_X}</button>
    </div>
    <div class="cx-inputrow">
      <span class="cx-prompt" aria-hidden="true">›</span>
      <input type="text" id="cxInput" placeholder="Type a name, a store or a task…"
             autocomplete="off" spellcheck="false" enterkeyhint="done"
             role="combobox" aria-expanded="false" aria-controls="cxSugs" aria-autocomplete="list">
      <kbd class="cx-kbd" aria-hidden="true">↵</kbd>
    </div>
    <div class="cx-sugs" id="cxSugs" role="listbox" aria-label="Suggestions"></div>
    <div class="cx-line" id="cxLine"></div>
    <label class="cx-label" for="cxNote">Brief</label>
    <textarea id="cxNote" placeholder="What does done look like? It rides along with every task in this send."></textarea>
    <div class="cx-due">
      <label><span class="cx-label">Due date</span><input type="date" id="cxDue"></label>
      <label><span class="cx-label">Due time</span><input type="time" id="cxDueTime"></label>
    </div>
    <button type="button" class="cx-send" id="cxSend" disabled>Assign work</button>`;

  const input = $("cxInput");
  input.oninput = () => { cxKindHint = null; cxHi = 0; cxPaintSugs(); };
  input.onkeydown = e => {
    if (e.key === "ArrowDown"){
      e.preventDefault();
      if (cxSugList.length){ cxHi = (cxHi + 1) % cxSugList.length; cxPaintSugs(); }
    } else if (e.key === "ArrowUp"){
      e.preventDefault();
      if (cxSugList.length){ cxHi = (cxHi - 1 + cxSugList.length) % cxSugList.length; cxPaintSugs(); }
    } else if (e.key === "Enter"){
      e.preventDefault();
      cxPick(cxSugList[cxHi]);
    } else if (e.key === "Backspace" && !input.value){
      const last = cx.order.pop();
      if (!last) return;
      if (last.kind === "who") cx.who = cx.who.filter(p => p.uid !== last.v);
      else if (last.kind === "store") cx.stores = cx.stores.filter(s => s !== last.v);
      else cx.tasks = cx.tasks.filter(t => t !== last.v);
      cxPaintLine(); cxPaintSugs();
    }
  };
  $("cxNote").value = cx.note;
  $("cxNote").oninput = () => { cx.note = $("cxNote").value; cxPaintSend(); };
  if (cx.due) $("cxDue").value = cx.due;
  if (cx.dueTime) $("cxDueTime").value = cx.dueTime;
  $("cxDue").onchange = () => { cx.due = $("cxDue").value; };
  $("cxDueTime").onchange = () => { cx.dueTime = $("cxDueTime").value; };
  $("cxClose").onclick = closeComposer;
  $("cxSend").onclick = cxSubmit;
  // Esc peels one layer per press: text in the bar first, then the dialog.
  // preventDefault marks it handled so nav.js's document ladder skips it.
  $("cx").onkeydown = e => {
    if (e.key === "Escape"){
      e.preventDefault();
      if (input.value){ input.value = ""; cxHi = 0; cxPaintSugs(); input.focus(); }
      else closeComposer();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && cxReady()){
      cxSubmit();
    }
  };

  cxPaintLine();
  $("cxScrim").classList.add("on");
  $("cx").classList.add("on");
  input.focus();

  // the roster/stores/tasks land async; the deck fills in once they do
  cxLoadOptions().then(d => {
    if (!cxIsOpen()) return;
    cxData = d;
    cxPaintSugs();
  });
}

// the Team page's edit pencil lands here: same composer, person locked
function openComposerEdit(t){
  const open = t.rows.filter(r => !r.done);
  if (!open.length) return;
  openComposer(open[0].toUid, open[0].toName, t);
}

function closeComposer(){
  if (!cxIsOpen()) return;
  $("cx").classList.remove("on");
  $("cxScrim").classList.remove("on");
  cx = null; cxData = null; cxSugList = []; cxHi = 0; cxKindHint = null;
  // dropping the markup drops every listener with it, once the fade is done
  setTimeout(() => { if (!cxIsOpen()) $("cx").innerHTML = ""; }, 240);
  if (cxPrevFocus && cxPrevFocus.focus) cxPrevFocus.focus();
  cxPrevFocus = null;
}
$("cxScrim").onclick = () => closeComposer();

/* ---------- the sentence ---------- */
function cxChip(kind, value, label, removable){
  return `<span class="cx-chip${removable ? "" : " no-x"}">${esc(label)}${removable
    ? `<button type="button" class="cx-chip-x" data-kind="${kind}" data-v="${esc(value)}" aria-label="Remove ${esc(label)}">${CX_X}</button>`
    : ""}</span>`;
}

function cxPaintLine(){
  const line = $("cxLine");
  if (!line || !cx) return;
  const row = (verb, kind, chips, slotText) => `
    <div class="cx-row">
      <span class="cx-verb">${verb}</span>
      ${chips.join("")}
      ${slotText ? `<button type="button" class="cx-slot" data-kind="${kind}">${slotText}</button>` : ""}
    </div>`;
  line.innerHTML =
    row("SEND", "task", cx.tasks.map(t => cxChip("task", t, t, true)), cx.tasks.length ? "" : "what task?")
    + row("TO", "who", cx.who.map(p => cxChip("who", p.uid, p.name, !cx.edit)), cx.who.length ? "" : "who?")
    + row("AT", "store", cx.stores.map(s => cxChip("store", s, s, true)), cx.stores.length ? "" : "which store?");
  line.querySelectorAll(".cx-chip-x").forEach(b => b.onclick = () => {
    const k = b.dataset.kind, v = b.dataset.v;
    if (k === "who") cx.who = cx.who.filter(p => p.uid !== v);
    else if (k === "store") cx.stores = cx.stores.filter(s => s !== v);
    else cx.tasks = cx.tasks.filter(t => t !== v);
    cx.order = cx.order.filter(o => !(o.kind === k && o.v === v));
    cxPaintLine(); cxPaintSugs();
    $("cxInput").focus();
  });
  // a tapped placeholder tells the deck which lane to guide toward
  line.querySelectorAll(".cx-slot").forEach(b => b.onclick = () => {
    cxKindHint = b.dataset.kind;
    cxPaintSugs();
    $("cxInput").focus();
  });
  cxPaintSend();
}

function cxPaintSend(){
  const btn = $("cxSend");
  if (!btn || !cx) return;
  btn.disabled = !cxReady();
  if (cx.edit){ btn.textContent = "Save changes"; return; }
  if (!cxReady()){ btn.textContent = "Assign work"; return; }
  const n = cxPairCount();
  const who = cx.who.length === 1 ? cx.who[0].name : cx.who.length + " people";
  btn.textContent = `Assign ${n} task${n === 1 ? "" : "s"} → ${who}`;
}

/* ---------- the deck ---------- */
function cxSuggestions(qRaw){
  const q = qRaw.trim().toLowerCase();
  if (!cxData) return q ? [{ kind: "none", label: "Loading the roster…" }] : [];
  const chosen = cx.who.map(p => p.uid);
  const members = cxData.members.filter(m => !chosen.includes(m.uid));
  const stores = cxData.stores.filter(s => !cx.stores.includes(s));
  const tasks = cxData.tasks.filter(t => !cx.tasks.includes(t));
  const out = [];
  const push = (kind, value, label, meta) => out.push({ kind, value, label, meta });

  if (!q){
    // empty bar: guide toward whichever lane the sentence still needs
    const hint = cxKindHint
      || (!cx.tasks.length ? "task" : !cx.who.length ? "who" : !cx.stores.length ? "store" : null);
    if (hint === "who" && !cx.edit){
      [...members].sort((a, b) => a.open - b.open).slice(0, 4)
        .forEach(m => push("who", m.uid, m.name, m.open ? m.open + " open" : "clear"));
      cxData.roles.slice(0, 2).forEach(r => push("role", r.craft, r.label, r.uids.length + " ppl"));
    } else if (hint === "store"){
      if (stores.length > 1 && !cx.stores.length)
        push("all", "", "ALL LOCATIONS", cxData.stores.length + " stores");
      stores.slice(0, 5).forEach(s => push("store", s, s));
    } else if (hint === "task"){
      tasks.slice(0, 6).forEach(t => push("task", t, t));
    }
    return out;
  }

  // substring match everywhere, earlier hits first
  const rank = list => list
    .map(x => ({ x, i: x.l.indexOf(q) }))
    .filter(r => r.i >= 0)
    .sort((a, b) => a.i - b.i || a.x.l.localeCompare(b.x.l))
    .map(r => r.x);

  if (!cx.edit){
    rank(members.map(m => ({ l: m.name.toLowerCase(), m }))).slice(0, 3)
      .forEach(({ m }) => push("who", m.uid, m.name, m.open ? m.open + " open" : "clear"));
    rank(cxData.roles.map(r => ({ l: r.label.toLowerCase(), r }))).slice(0, 2)
      .forEach(({ r }) => push("role", r.craft, r.label, r.uids.length + " ppl"));
  }
  if ("all locations".includes(q) && stores.length > 1)
    push("all", "", "ALL LOCATIONS", cxData.stores.length + " stores");
  rank(stores.map(s => ({ l: s.toLowerCase(), s }))).slice(0, 3).forEach(({ s }) => push("store", s, s));
  rank(tasks.map(t => ({ l: t.toLowerCase(), t }))).slice(0, 3).forEach(({ t }) => push("task", t, t));

  // nothing named that yet? offer to coin it - task first (the commoner case)
  const v = qRaw.trim();
  if (OTHER_RE.test(v)){
    if (!cxData.tasks.some(t => t.toLowerCase() === q) && !cx.tasks.some(t => t.toLowerCase() === q))
      push("new-task", v, `New task “${v}”`);
    if (!cxData.stores.some(s => s.toLowerCase() === q) && !cx.stores.some(s => s.toLowerCase() === q))
      push("new-store", v, `New store “${v}”`);
  }
  if (!out.length) push("none", "", "No match — try a teammate, a store or a task name");
  return out.slice(0, 8);
}

const CX_TAG = { who: "PERSON", role: "TEAM", store: "STORE", task: "TASK", all: "ALL", "new-task": "NEW", "new-store": "NEW" };
function cxPaintSugs(){
  const box = $("cxSugs"), input = $("cxInput");
  if (!box || !input || !cx) return;
  cxSugList = cxSuggestions(input.value);
  cxHi = Math.min(cxHi, Math.max(0, cxSugList.length - 1));
  box.innerHTML = cxSugList.map((s, i) => s.kind === "none"
    ? `<p class="cx-none">${esc(s.label)}</p>`
    : `
    <button type="button" class="cx-sug${i === cxHi ? " is-hi" : ""}" id="cxSug${i}" role="option" aria-selected="${i === cxHi}">
      <span class="cx-tag${s.kind.indexOf("new") === 0 ? " cx-tag-new" : ""}" aria-hidden="true">${CX_TAG[s.kind]}</span>
      <span class="cx-sug-main">${esc(s.label)}</span>
      ${s.meta ? `<span class="cx-sug-meta${s.meta === "clear" ? " is-clear" : ""}">${esc(s.meta)}</span>` : ""}
    </button>`).join("");
  const hasRows = cxSugList.some(s => s.kind !== "none");
  input.setAttribute("aria-expanded", String(hasRows));
  input.setAttribute("aria-activedescendant", hasRows ? "cxSug" + cxHi : "");
  box.querySelectorAll(".cx-sug").forEach(b =>
    b.onclick = () => cxPick(cxSugList[Number(b.id.slice(5))]));
}

function cxPick(s){
  if (!s || s.kind === "none" || !cx) return;
  const add = (kind, v) => cx.order.push({ kind, v });
  if (s.kind === "who"){
    const m = cxData.members.find(x => x.uid === s.value);
    if (m && !cx.who.some(p => p.uid === m.uid)){ cx.who.push({ uid: m.uid, name: m.name }); add("who", m.uid); }
  } else if (s.kind === "role"){
    const r = cxData.roles.find(x => x.craft === s.value);
    if (r) r.uids.forEach(uid => {
      const m = cxData.members.find(x => x.uid === uid);
      if (m && !cx.who.some(p => p.uid === uid)){ cx.who.push({ uid, name: m.name }); add("who", uid); }
    });
  } else if (s.kind === "all"){
    cxData.stores.forEach(st => { if (!cx.stores.includes(st)){ cx.stores.push(st); add("store", st); } });
  } else if (s.kind === "store" || s.kind === "new-store"){
    if (!cx.stores.includes(s.value)){ cx.stores.push(s.value); add("store", s.value); }
  } else if (!cx.tasks.includes(s.value)){
    cx.tasks.push(s.value); add("task", s.value);
  }
  cxKindHint = null;
  const input = $("cxInput");
  input.value = "";
  cxHi = 0;
  cxPaintLine();
  cxPaintSugs();
  input.focus();
}

/* ---------- submit: same batch shape the queue/tables/exports expect ----------
   Fresh: each person's store x task grid travels as THEIR group (own
   groupId, own thread, own notification). Editing: open rows are matched
   by store+task, so an unchanged line keeps its doc id (no phantom "new
   task" for the assignee), removed lines are deleted, added lines join
   under the same groupId, and done rows only get the group arithmetic.
   Whoever saves an edit becomes the assignment's face - "who asked me to
   do this" should name the person whose latest version it is. */
async function cxSubmit(){
  if (!cxReady()) return;
  const btn = $("cxSend");
  btn.disabled = true;
  const state = cx;
  const col = db.collection("assignments");
  const from = {
    fromName: S.worker || "",
    fromEmail: (auth.currentUser && auth.currentUser.email) || ""
  };
  const rowFor = (p, store, task) => ({
    toUid: p.uid, toName: p.name, ...from, store, task,
    note: state.note.trim(), snote: null,
    dueDate: state.due || null, dueTime: state.dueTime || null
  });
  const pairs = [];
  state.stores.forEach(st => state.tasks.forEach(t => pairs.push({ store: st, task: t })));

  try {
    const batch = db.batch();
    if (state.edit){
      const p = state.who[0];
      const openRows = state.edit.rows.filter(r => !r.done);
      const doneRows = state.edit.rows.filter(r => r.done);
      const oldByKey = new Map(openRows.map(r => [pairKey(r.store, r.task), r]));
      const total = doneRows.length + pairs.length;
      // a single edited into several needs the groupId it never had
      const groupId = state.edit.groupId || (total > 1 ? col.doc().id : null);
      const createdAt = state.edit.rows[0].createdAt || Date.now();
      pairs.forEach(pr => {
        const base = {
          ...rowFor(p, pr.store, pr.task), groupId, groupSize: total,
          // edited means changed - the receipt resets so it needs seeing again
          seenAt: null
        };
        const old = oldByKey.get(pairKey(pr.store, pr.task));
        if (old){ oldByKey.delete(pairKey(pr.store, pr.task)); batch.update(col.doc(old.id), base); }
        else batch.set(col.doc(), { ...base, createdAt, done: false, doneAt: null });
      });
      oldByKey.forEach(old => batch.delete(col.doc(old.id)));
      doneRows.forEach(r => batch.update(col.doc(r.id), { groupId, groupSize: total }));
      await batch.commit();
      toast("Assignment updated");
    } else {
      const now = Date.now();
      state.who.forEach(p => {
        const groupId = pairs.length > 1 ? col.doc().id : null;
        pairs.forEach(pr => batch.set(col.doc(), {
          ...rowFor(p, pr.store, pr.task), createdAt: now, done: false, doneAt: null,
          groupId, groupSize: pairs.length
        }));
      });
      await batch.commit();
      const n = state.who.length * pairs.length;
      const who = state.who.map(p => p.name).join(", ");
      toast(n === 1 ? `${state.tasks[0]} assigned to ${who}` : `${n} tasks assigned to ${who}`);
    }
    closeComposer();
    if (isAdmin) loadTeamPane();
    // the log may be on screen behind the composer (Team page) - keep it honest
    if (!$("teamScreen").classList.contains("hidden")) loadCompletionLog(true, $("teamRecentlyDone"));
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast(state.edit ? "Couldn't save — check Firestore rules allow it"
                     : "Couldn't assign — check Firestore rules allow it");
  }
}

/* ---------- worker: tasks assigned to me (v1) - live, not a one-time
   load, so a task assigned while you're already on the page shows up
   (and toasts) without needing a reload ---------- */
let assignedTasksSeen = null; // null = first snapshot hasn't landed yet
let assignedOpenRows = [];    // last snapshot, so "All done" knows the group's ids
function watchAssignedTasks(){
  const box = $("assignedTasksSection"), list = $("assignedTasksList");
  if (!box || !auth.currentUser) return;
  // Fresh subscription, fresh baseline - carrying the previous user's ids
  // over would make every one of this user's existing tasks look new and
  // fire a "New task from ..." toast for each on the first snapshot.
  assignedTasksSeen = null;
  const unsub = db.collection("assignments")
    .where("toUid", "==", auth.currentUser.uid)
    .where("done", "==", false)
    .onSnapshot(snap => {
      const rows = [];
      snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
      rows.sort((a,b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
      assignedOpenRows = rows;

      // The receipt: the queue rendering on their screen is "seen". Stamped
      // only on rows that lack it, so the write this triggers re-enters the
      // listener exactly once and then goes quiet.
      const unseen = rows.filter(r => !r.seenAt);
      if (unseen.length){
        const stamp = db.batch();
        unseen.forEach(r => stamp.update(db.collection("assignments").doc(r.id), { seenAt: Date.now() }));
        stamp.commit().catch(e => console.error(e));
      }

      const threads = groupAssignments(rows);

      // one toast per thread, not per task - six tasks assigned in one go is
      // one piece of news, not six
      if (assignedTasksSeen) {
        threads.forEach(t => {
          const fresh = t.rows.filter(r => !assignedTasksSeen.has(r.id));
          if (!fresh.length) return;
          const from = t.rows[0].fromName || t.rows[0].fromEmail || "admin";
          toast(fresh.length === 1
            ? `New task from ${from}: ${fresh[0].store} · ${fresh[0].task}`
            : `New from ${from}: ${fresh.length} tasks · ${threadStores(t).join(", ")}`);
        });
      }
      assignedTasksSeen = new Set(rows.map(r => r.id));

      renderAssignedQueue();
    }, e => console.error(e));
  onSessionEnd(() => {
    unsub(); assignedTasksSeen = null; assignedOpenRows = [];
    box.classList.add("hidden");
    $("appScreen").classList.remove("has-tasks");
    list.innerHTML = "";
  });
}

/* ---------- one queue, two sources ----------
   The dashboard card renders assignments AND campaign batons as one list -
   same store groups, same due sorting. Assignments stay the only thing in
   assignedOpenRows (the seenAt stamping and Done flow depend on that);
   batons come in as view-only rows from cgBatonRows() at render time and
   are re-merged whenever EITHER watcher fires. The pane is the non-admin's
   second block and stays up even empty - the dashboard keeping both cards
   reads calmer than one wide card that reshapes whenever the queue drains.
   An admin's third column is already the Team card, so theirs still only
   mounts when there is something in it. */
function renderAssignedQueue(){
  const box = $("assignedTasksSection"), list = $("assignedTasksList");
  if (!box || !list || !auth || !auth.currentUser) return;
  const batons = (typeof cgBatonRows === "function") ? cgBatonRows() : [];
  const rows = assignedOpenRows.concat(batons);
  rows.sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  const app = $("appScreen");
  const count = $("assignedCount");
  if (!rows.length && isAdmin) {
    box.classList.add("hidden");
    app.classList.remove("has-tasks");
    list.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  app.classList.toggle("has-tasks", !isAdmin);
  if (count) count.textContent = rows.length ? rows.length + " open" : "";
  renderAssignedBrief(rows);
  renderAssignedList(rows);
}

/* ---------- the queue itself, nested by store ----------
   One collapsible group per store/brand; inside it one row per task. The
   caret is the affordance: a task row expands inline into its full brief
   (note, who assigned it, dates) with Done living in the expanded body.
   Open/closed choices survive re-renders and snapshot updates. */
let assignedClosedStores = new Set();  // store groups the user collapsed
let assignedOpenTasks = new Set();     // task rows expanded to their details

const CARET_SVG = cls => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

function renderAssignedList(rows){
  const list = $("assignedTasksList");
  if (!list) return;
  // the pane stays mounted with an empty queue, so the expanded view needs
  // words rather than a blank column
  if (!rows.length){
    list.innerHTML = `
      <li class="atask-empty">
        <span class="atask-empty-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5l2.2 2.2L15.5 9"/><rect x="4.5" y="4" width="15" height="17" rx="2.4"/><path d="M9 4V2.8h6V4"/></svg>
        </span>
        <b>No tasks assigned</b>
        <span>You're all caught up. New tasks from the admin land here.</span>
      </li>`;
    return;
  }
  const stores = [];
  const byStore = new Map();
  rows.forEach(r => {
    const k = r.store || "—";
    if (!byStore.has(k)){ byStore.set(k, []); stores.push(k); }
    byStore.get(k).push(r);
  });
  const today = todayISO();

  list.innerHTML = stores.map((store, si) => {
    const items = byStore.get(store);
    const open = !assignedClosedStores.has(store);
    return `
    <li class="store-group${open ? " is-open" : ""}">
      <button type="button" class="store-head" data-si="${si}" aria-expanded="${open}">
        ${CARET_SVG("store-caret")}
        <span class="store-name">${esc(store)}</span>
        <span class="store-count">${items.length}</span>
      </button>
      <ul class="store-tasks">
        ${items.map(r => {
          const late = r.dueDate && r.dueDate < today;
          const tOpen = assignedOpenTasks.has(r.id);
          // a baton row is the same row, but finishing it IS the handoff -
          // its buttons route to the campaign, never to markAssignmentDone
          const acts = r.cg
            ? `<button type="button" class="btn btn-go btn-sm atask-pass" data-cg="${esc(r.cg)}">${r.multi ? "Approve" : "Pass forward"}</button>
               ${r.canBack ? `<button type="button" class="btn btn-ghost btn-sm atask-sendback" data-cg="${esc(r.cg)}">Send back</button>` : ""}
               <button type="button" class="btn btn-ghost btn-sm atask-view" data-cg="${esc(r.cg)}">Open</button>`
            : `<button type="button" class="btn btn-go btn-sm atask-done" data-id="${r.id}">Done</button>`;
          const meta = r.cg
            ? `From ${esc(r.fromName || "admin")}${r.createdAt ? " · your stage since " + dayStamp(r.createdAt) : ""}${r.multi ? " · " + esc(r.multi) : ""} · ${r.dueDate ? "due " + esc(dueWithTime(r)) : "no due date"}`
            : `From ${esc(r.fromName || r.fromEmail || "admin")}${r.createdAt ? " · assigned " + dayStamp(r.createdAt) : ""} · ${r.dueDate ? "due " + esc(dueWithTime(r)) : "no due date"}`;
          return `
          <li class="atask${tOpen ? " is-open" : ""}${late ? " is-late" : ""}">
            <button type="button" class="atask-head" data-tid="${esc(r.id)}" aria-expanded="${tOpen}">
              <span class="atask-name">${esc(r.task)}${r.cg ? `<span class="atask-cgchip">campaign</span>` : ""}${r.transferredFrom ? `<span class="atask-cgchip">from ${esc(r.transferredFrom)}</span>` : ""}</span>
              <span class="atask-due">${r.dueDate ? (late ? "overdue · " : "due ") + esc(dueWithTime(r)) : ""}</span>
              ${CARET_SVG("atask-caret")}
            </button>
            <div class="atask-body">
              ${r.note ? `<p class="atask-note">${esc(r.note)}</p>` : ""}
              ${r.snote ? `<p class="atask-note">${esc(r.snote)}</p>` : ""}
              <p class="atask-meta">${meta}</p>
              ${acts}
            </div>
          </li>`;
        }).join("")}
      </ul>
    </li>`;
  }).join("");

  // collapse/expand re-renders go through the merged queue, so batons
  // don't vanish on the first tap
  list.querySelectorAll(".store-head").forEach(b => b.onclick = () => {
    const s = stores[Number(b.dataset.si)];
    if (assignedClosedStores.has(s)) assignedClosedStores.delete(s); else assignedClosedStores.add(s);
    renderAssignedQueue();
  });
  list.querySelectorAll(".atask-head").forEach(b => b.onclick = () => {
    const id = b.dataset.tid;
    if (assignedOpenTasks.has(id)) assignedOpenTasks.delete(id); else assignedOpenTasks.add(id);
    renderAssignedQueue();
  });
  list.querySelectorAll(".atask-done").forEach(b => b.onclick = () => markAssignmentDone(b.dataset.id));
  list.querySelectorAll(".atask-pass").forEach(b => b.onclick = () => cgPassSheet(b.dataset.cg));
  list.querySelectorAll(".atask-sendback").forEach(b => b.onclick = () => cgBackSheet(b.dataset.cg));
  list.querySelectorAll(".atask-view").forEach(b => b.onclick = () => cgOpenDetail(b.dataset.cg));
}

// the other half of a Done toast: one mistap shouldn't be a conversation
// with the admin, so the toast offers to reopen what it just closed
async function undoDone(ids){
  try {
    const batch = db.batch();
    ids.forEach(id => batch.update(db.collection("assignments").doc(id),
      { done: false, doneAt: null }));
    await batch.commit();
    toast(ids.length === 1 ? "Brought back" : `Brought all ${ids.length} back`);
  } catch (e) {
    console.error(e);
    toast("Couldn't undo — check Firestore rules allow it");
  }
}

/* The collapsed state of the employee's pane. Same shape as the admin's Team
   card - a status line then the one thing that matters most - but about your
   own queue rather than the team's. The headline is the next thing due, since
   that is the question the card is answering. */
function renderAssignedBrief(rows){
  const counts = $("assignedCounts"), next = $("assignedNext");
  if (!counts || !next) return;

  const today = todayISO();
  const late = rows.filter(r => r.dueDate && r.dueDate < today).length;
  const soon = rows.filter(r => r.dueDate === today).length;
  counts.innerHTML = `<ul class="team-stats">
      ${teamStatPip(rows.length, "open", "open")}${teamStatPip(late, "overdue", "late")}${teamStatPip(soon, "due today", "done")}
    </ul>`;

  // undated tasks sort last, so the headline is always something with a date
  // if one exists
  const up = [...rows].sort((a, b) =>
    (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"))[0];
  next.innerHTML = up
    ? `<div class="team-latest-who">${esc(up.store || "—")} · ${esc(up.task || "task")}</div>
       <div class="team-latest-what">${esc(up.note || "")}<span class="team-latest-when">${
         up.dueDate ? " · due " + esc(dueWithTime(up)) : " · no due date"}</span></div>`
    : `<div class="team-latest-none">Nothing assigned right now.</div>`;
}

/* Done opens a comment dialog first: say how it went, @mention teammates
   (autocomplete from the company directory), and the mention engine turns
   the tags into in-app notifications for the tagged people and the admin. */
function markAssignmentDone(id){
  const row = assignedOpenRows.find(r => r.id === id) || {};
  openSheet(`
    <h2>Task complete</h2>
    <p class="hint"><b>${esc([row.store, row.task].filter(Boolean).join(" · ") || "This task")}</b> — add a comment for the team. Tag someone with @ and they get an Accept / Decline hand-off in their inbox.</p>
    <div class="mention-wrap">
      <textarea id="doneNote" placeholder="e.g. Drafts are up — @Jack please review"></textarea>
      <div class="af-panel mention-pop" id="mentionPop" hidden></div>
    </div>
    <button class="btn btn-go" id="doneSend">Mark done</button>
    <button class="btn btn-ghost btn-sm" id="doneCancel">Cancel</button>
  `, () => {
    wireMentionBox($("doneNote"), $("mentionPop"));
    $("doneCancel").onclick = closeSheet;
    $("doneSend").onclick = () => finishAssignment(id, row, $("doneNote").value.trim());
    $("doneNote").focus();
  });
}

async function finishAssignment(id, row, comment){
  const btn = $("doneSend");
  if (btn) btn.disabled = true;
  try {
    const now = Date.now();
    // ack:false so the admin notification badge picks this up as new
    const patch = { done: true, doneAt: now, ack: false };
    if (comment){ patch.comment = comment; patch.commentAt = now; }
    await db.collection("assignments").doc(id).update(patch);
    closeSheet();
    // the notification fan-out is fire-and-forget: the task is done either
    // way. Runs with or without a comment - a completion alone still rings
    // the admin's bell; a comment adds its text and tags its @mentions.
    dispatchMentionNotifications(comment, id, row).catch(e => console.error(e));
    toast("Marked done", { label: "Undo", run: () => undoDone([id]) });
  } catch (e) {
    console.error(e);
    if (btn) btn.disabled = false;
    toast("Couldn't update — check Firestore rules allow it");
  }
}

/* ---------- admin: notified when a team member completes an assigned task ---------- */
function watchCompletionNotifications(){
  const badge = $("adminNotifBadge");
  if (!badge) return;
  const unsub = db.collection("assignments")
    .where("done", "==", true)
    .where("ack", "==", false)
    .onSnapshot(snap => {
      badge.textContent = snap.size;
      badge.classList.toggle("hidden", snap.empty);
      // keep the Team pane's counts and "latest completion" in step with the
      // badge instead of going stale until the next reload
      loadTeamPane();
    }, e => console.error(e));
  onSessionEnd(() => { unsub(); badge.textContent = "0"; badge.classList.add("hidden"); });
}

async function ackCompletedAssignments(){
  try {
    const snap = await db.collection("assignments").where("done", "==", true).where("ack", "==", false).get();
    if (snap.empty) return [];
    const rows = [];
    const batch = db.batch();
    snap.forEach(doc => { rows.push(doc.data()); batch.update(doc.ref, { ack: true }); });
    await batch.commit();
    return rows;
  } catch (e) {
    console.error(e);
    return [];
  }
}

/* Every trace of them: their shift/app state, their directory entry, and
   any tasks still assigned to them (left behind otherwise, orphaned - "who
   is this?" the next time someone opens the Team log). Batched delete caps
   at 500 writes; nobody on a small team has anywhere near that many open
   assignments; not worth paging for. */
async function deleteWorker(uid, name){
  if (!confirm(`Delete ${name}? This removes their shift data, assigned tasks, and app access. This can't be undone.\n\nNote: it does NOT delete their login itself - to fully block them from signing in again, also remove them in Firebase Console > Authentication > Users.`)) return;
  try {
    await db.collection("appState").doc(uid).delete();
    await db.collection("users").doc(uid).delete();
    const asg = await db.collection("assignments").where("toUid", "==", uid).get();
    if (!asg.empty){
      const batch = db.batch();
      asg.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    toast(name + " deleted");
    closeSheet();
    loadTeamData();      // the roster behind the sheet still lists them otherwise
    loadTeamPending();
  } catch (e) {
    console.error(e);
    toast("Couldn't delete - check Firestore rules allow admin deletes");
  }
}

/* A pending sign-up rejected instead of approved: deletes the directory
   entry outright rather than leaving a "denied" status to pile up - there's
   no shift data or assigned tasks to worry about orphaning yet, since
   nothing here has ever been approved into the app. Same login-account
   caveat as deleteWorker: this is Firestore only, not Firebase Auth. */
async function rejectPendingUser(uid, email){
  if (!confirm(`Permanently delete ${email}'s pending sign-up? This can't be undone.\n\nNote: it does NOT delete their login itself - they could sign up again later and would need approval again.`)) return;
  try {
    await db.collection("users").doc(uid).delete();
    await db.collection("appState").doc(uid).delete();
    toast(email + " removed");
    loadTeamPending();
  } catch (e) {
    console.error(e);
    toast("Couldn't remove - check Firestore rules allow admin deletes");
  }
}

// Single-worker export used by the admin dashboard's per-worker "Export to
// Excel" button. Produces one polished sheet (same summary/task-breakdown/
// history layout as exportAllExcel()'s per-worker sheets) instead of the
// flat two-sheet dump exportExcel() makes for a worker's own self-export.
async function exportWorkerExcel(name, email, hist){
  if (!window.ExcelJS) { toast("Excel export isn't available right now"); return; }
  if (!hist.length) return;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeSheetName(name, new Set()));
  fillWorkerSheet(ws, name, email, hist);

  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "member";
  await downloadWorkbook(wb, "shift-report-" + slug + "-" + new Date().toISOString().slice(0,10) + ".xlsx");
  toast("Excel file downloaded");
}

