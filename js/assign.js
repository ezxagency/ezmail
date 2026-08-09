/* ============================================================
   ASSIGN TASK — one decision at a time.

   Who → where → what → details. Each answer unlocks the next, and the line
   at the top composes into a sentence you can read back before committing,
   so the confirmation is the form rather than a separate summary step.
   Replaces the old two-surface flow (full-page member picker, then a form).
   ============================================================ */
let afState = null;      // { people: [...], note, due } - the answers so far
let afOpen = null;       // key of the dropdown currently open, if any
let afEdit = null;       // the thread being edited, or null when assigning fresh
let afMembers = [], afStores = [];   // dropdown feeds, loaded async per open
let afRoles = [];        // "ALL <craft>" bulk options, built from the directory
let afBoardRows = [];    // open assignments for the execution board
// ASSIGN TARGET is a GROUP: everyone toggled since the last ADD OPERATIVE
// shares one stores/tasks config (their person entries are kept in sync).
// afGroupStart marks where the current group begins in afState.people.
let afGroupStart = 0;
// this one sheet's own light/dark preference, independent of the rest of
// the (always-dark) app - see .af-sheet-light in sheets.css
let afLightTheme = localStorage.getItem("afTheme") === "light";

// one key per store x task combination; a newline can't appear in either
// name (both come from single-line inputs), so it is a safe separator
const pairKey = (store, task) => store + "\n" + task;

/* The form is PEOPLE-first, exactly as sketched: each person block nests
   their stores, each store nests its own tasks - plus an optional note and
   due date of its own. "+ ADD OPERATIVE" repeats the whole block, so one
   submit can hand different work at different stores to different
   teammates: Pz gets Design at abc while Jack gets Copy at mno. */
const afBlankPerson = () => ({ uid: "", name: "", stores: [], storeTasks: {}, storeNotes: {}, storeDues: {} });
const afPersonPairs = p => p.stores.flatMap(st => (p.storeTasks[st] || []).map(task => ({ store: st, task })));
const afPersonValid = p => !!p.uid && p.stores.length > 0
  && p.stores.every(st => (p.storeTasks[st] || []).length > 0);
const afAllPairs = () => afState.people.flatMap(afPersonPairs);
const afReady = () => afState.people.every(afPersonValid)
  && afAllPairs().length > 0 && afState.note.trim().length >= 3;

function afDueLabel(iso){
  const p = String(iso).split("-").map(Number);
  if (p.length !== 3 || p.some(isNaN)) return iso;
  return new Date(p[0], p[1] - 1, p[2])
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// due time is display-only (see dueWithTime) - this just makes "17:30"
// read as "5:30 PM" wherever it's shown in prose
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

/* The submit button and the ADD OPERATIVE dimming derive from the same
   validity checks. Unlike the old step-sequence UI, NOTHING locks here -
   the terminal layout isn't sequential, so the brief/due fields stay
   typeable in any order and only the submit itself is gated. */
function afSync(){
  const allBlocks = afState.people.every(afPersonValid);
  // ADD OPERATIVE never disables (its click explains itself); it just dims
  // while pressing it couldn't succeed yet
  const addPerson = $("afCommitPerson");
  if (addPerson) addPerson.classList.toggle("is-idle", !allBlocks);
  const save = $("afSave");
  if (save) save.disabled = !afReady();
}

// a click anywhere outside the open dropdown's own step closes it - the
// assign flow's menus behave like every other nested layer now.
// Ticking a checkbox repaints its panel, which detaches the clicked button
// before this document-level listener runs - a detached target has no
// ancestors to match, and multi-select would slam shut on every pick.
document.addEventListener("click", e => {
  if (!e.target.isConnected) return;
  if (afOpen && !e.target.closest(".af-step, .af-trigger, .af-panel, .af-custom")) afCloseMenu();
});

function afCloseMenu(){
  if (!afOpen) return;
  const panel = $("afPanel" + afOpen), trig = $("afTrig" + afOpen);
  if (panel) panel.hidden = true;
  if (trig) trig.setAttribute("aria-expanded", "false");
  afOpen = null;
}

/* A dropdown, not a <select>: the native control can't show the second line
   of context each option carries, and can't be styled to match the sheet. */
function afDropdownMarkup(key, label, placeholder){
  return `
    <div class="af-step is-locked" id="afStep${key}">
      <div class="af-step-head">
        <span class="af-pip" aria-hidden="true"></span>
        <span class="af-step-label">${esc(label)}</span>
      </div>
      <button type="button" class="af-trigger" id="afTrig${key}"
              aria-expanded="false" aria-controls="afPanel${key}">
        <span class="af-value" id="afVal${key}">${esc(placeholder)}</span>
        <svg class="af-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="af-panel" id="afPanel${key}" hidden></div>
      <div class="af-custom" id="afCustom${key}" hidden>
        <input type="text" id="afInput${key}" placeholder="Type a name" autocomplete="off">
        <button type="button" class="af-custom-ok" id="afOk${key}">Use</button>
      </div>
    </div>`;
}

const AF_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4 10-10"/></svg>';

function afWireDropdown(key, getItems, onPick, customLabel, opts){
  const trig = $("afTrig" + key), panel = $("afPanel" + key);
  const custom = $("afCustom" + key), input = $("afInput" + key), ok = $("afOk" + key);
  // multi-select state now lives with the caller (per person block)
  const multi = !!(opts && opts.chosen);

  const paint = () => {
    const items = getItems();
    const chosen = multi ? opts.chosen() : [];
    panel.innerHTML = (items.length
      ? items.map(it => {
          const on = multi && chosen.includes(it.value);
          return `
          <button type="button" class="af-opt${on ? " is-on" : ""}" data-v="${esc(it.value)}"${multi ? ` aria-pressed="${on}"` : ""}>
            ${multi ? `<span class="af-check" aria-hidden="true">${on ? AF_TICK : ""}</span>` : ""}
            <span class="af-opt-main">${esc(it.label)}</span>
            ${it.meta ? `<span class="af-opt-meta">${esc(it.meta)}</span>` : ""}
          </button>`;
        }).join("")
      : `<p class="af-opt-none">Nothing to choose from yet.</p>`)
      + (customLabel ? `<button type="button" class="af-opt af-opt-new" data-v="__new">${esc(customLabel)}</button>` : "")
      + (multi ? `<button type="button" class="af-opt af-opt-done" data-v="__done">Done choosing</button>` : "");

    panel.querySelectorAll("button[data-v]").forEach(b => {
      b.onclick = () => {
        const v = b.dataset.v;
        if (v === "__done"){ afCloseMenu(); if (opts && opts.onDone) opts.onDone(); return; }
        if (v === "__new"){
          afCloseMenu();
          custom.hidden = false;
          input.value = "";
          input.focus();
          return;
        }
        // multi-select keeps the panel open and repaints in place, so picking
        // three stores is three clicks rather than three round trips
        if (multi){ onPick(v); paint(); return; }
        afCloseMenu();
        custom.hidden = true;
        onPick(v, b.querySelector(".af-opt-main").textContent);
      };
    });
  };

  const open = () => {
    if (afOpen && afOpen !== key) afCloseMenu();
    paint();
    panel.hidden = false;
    trig.setAttribute("aria-expanded", "true");
    afOpen = key;
    const first = panel.querySelector("button");
    if (first) first.focus();
  };

  trig.onclick = () => (afOpen === key ? afCloseMenu() : open());
  trig.onkeydown = e => { if (e.key === "ArrowDown"){ e.preventDefault(); open(); } };

  // roving focus inside the panel; Esc always returns you to the trigger
  panel.onkeydown = e => {
    const opts = [...panel.querySelectorAll("button")];
    const i = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown"){ e.preventDefault(); (opts[i + 1] || opts[0]).focus(); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); (opts[i - 1] || opts[opts.length - 1]).focus(); }
    else if (e.key === "Escape"){ e.preventDefault(); afCloseMenu(); trig.focus(); }
  };

  const commit = () => {
    const v = input.value.trim();
    if (!OTHER_RE.test(v)) { input.focus(); return; }
    custom.hidden = true;
    // in multi-select, onPick is a toggle - typing a name that's already
    // chosen would otherwise remove it (and its tasks/notes/due date)
    // instead of just being a no-op the way re-clicking the same checkbox is
    if (multi && opts.chosen().includes(v)){ toast(`${v} is already added`); return; }
    onPick(v, v);
  };
  ok.onclick = commit;
  input.onkeydown = e => {
    if (e.key === "Enter"){ e.preventDefault(); commit(); }
    else if (e.key === "Escape"){ e.preventDefault(); custom.hidden = true; trig.focus(); }
  };
}

/* ============================================================
   ASSIGN TASK — "terminal kit" UI.

   Rebuilt from the user's terminal/HUD-style inspiration screen
   (status card, workload matrix, node/protocol rows, assign-target
   card, configuration section) with the SITE'S own palette - the
   inspo's neon green swapped for --wk-green, its blue-black for the
   sheet's existing navy glass. Unlike the previous fixed-canvas
   approach this is ordinary flowing markup, so it's responsive for
   free. Data model unchanged: stores multi-select via ORIGIN NODE,
   tasks multi-select via PROTOCOL (applied across the selected
   stores), person via ASSIGN TARGET, and the cross product still
   becomes one Firestore doc per store x task pair in afSubmit.
   ============================================================ */
const AF_TK_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z"/></svg>';
const AF_TK_STORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5 5.3 4h13.4L20 9.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-5.5h5V20"/><path d="M4 9.5h16"/></svg>';
const AF_TK_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 10h6M9 14h6M9 18h3.5"/></svg>';
const AF_TK_PERSONADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.6"/><path d="M3.5 20.5c0-3.5 2.9-6 6.5-6 .9 0 1.8.16 2.6.45"/><path d="M17.5 14.5v6M14.5 17.5h6"/></svg>';
const AF_TK_SLIDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13M21 17h-1"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="19" cy="17" r="2"/></svg>';
const AF_TK_SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 1-6.4 2.6"/></svg>';
const AF_TK_CHEV = '<svg class="tk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const AF_TK_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const AF_TK_HELP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.6 2.6 0 0 1 4.9 1.1c0 1.7-2.5 2.1-2.5 3.6"/><circle cx="12" cy="17.4" r=".4" fill="currentColor"/></svg>';

// CONFIG's list plus anything typed under any block this session - a
// custom task picked once is one click everywhere else
function afTaskOptions(){
  const seen = new Map();
  CONFIG.tasks.forEach(t => seen.set(t.toLowerCase(), t));
  afState.people.forEach(pp => Object.values(pp.storeTasks).flat()
    .forEach(t => seen.set(t.toLowerCase(), t)));
  return [...seen.values()].map(t => ({ value: t, label: t }));
}

// the active person's task list as PROTOCOL shows it: the union across
// their stores (per-store variance from old edits survives untouched
// until a task is explicitly toggled)
const afUnionTasks = p => [...new Set(p.stores.flatMap(st => p.storeTasks[st] || []))];

/* Every committed store+task pair across every person, as a togglable
   list inside the CONFIGURATION section. Tap the tick to drop a pair. */
function afPairsHTML(){
  const multi = afState.people.length > 1;
  const rows = [];
  afState.people.forEach((pp, pi) =>
    afPersonPairs(pp).forEach(pr => rows.push({ pi, name: pp.name, store: pr.store, task: pr.task })));
  if (!rows.length) return "";
  return `
    <div class="af-pairs">
      ${rows.map(r => `
      <div class="af-pair" data-pi="${r.pi}" data-store="${esc(r.store)}" data-task="${esc(r.task)}">
        <button type="button" class="af-pair-tog" aria-label="Remove ${esc(r.store)} · ${esc(r.task)}">${AF_TICK}</button>
        <span class="af-pair-name">${multi ? esc(r.name) + " — " : ""}${esc(r.store)} · ${esc(r.task)}</span>
      </div>`).join("")}
    </div>`;
}

// dropdown skeleton for one row key (panel + type-your-own input) - these
// FLOAT over the content below their row (see .tk-slot) instead of shoving
// the whole sheet down every time a picker opens
function afTkPanelHTML(key, typePlaceholder){
  return `
    <div class="af-panel" id="afPanel${key}" hidden></div>
    <div class="af-custom" id="afCustom${key}" hidden>
      <input type="text" id="afInput${key}" placeholder="${esc(typePlaceholder)}" autocomplete="off">
      <button type="button" class="af-custom-ok" id="afOk${key}">Use</button>
    </div>`;
}

/* The ORIGIN NODE / PROTOCOL rows + ASSIGN TARGET card for the ACTIVE
   (last) person. Earlier people live on as chips in the config section.
   Each row + its floating panel share a .tk-slot anchor. */
function afRowsHTML(p, pi){
  return `
    <div class="tk-slot">
      <button type="button" class="tk-row af-trigger" id="afTrigwhere${pi}"
              aria-expanded="false" aria-controls="afPanelwhere${pi}">
        <span class="tk-row-ico" aria-hidden="true">${AF_TK_STORE}</span>
        <span class="tk-row-main">
          <span class="tk-label">ORIGIN NODE</span>
          <span class="tk-row-val af-value${p.stores.length ? "" : " is-placeholder"}" id="afValwhere${pi}">${esc(afWhereText(p))}</span>
        </span>
        ${AF_TK_CHEV}
      </button>
      ${afTkPanelHTML("where" + pi, "Type a store")}
    </div>
    <div class="tk-link" aria-hidden="true"></div>

    <div class="tk-slot">
      <button type="button" class="tk-row af-trigger" id="afTrigproto${pi}"
              aria-expanded="false" aria-controls="afPanelproto${pi}">
        <span class="tk-row-ico" aria-hidden="true">${AF_TK_CLIP}</span>
        <span class="tk-row-main">
          <span class="tk-label">PROTOCOL</span>
          <span class="tk-row-val af-value${afUnionTasks(p).length ? "" : " is-placeholder"}" id="afValproto${pi}">${afUnionTasks(p).length ? esc(afUnionTasks(p).join(", ")) : "Choose tasks"}</span>
        </span>
        ${AF_TK_CHEV}
      </button>
      ${afTkPanelHTML("proto" + pi, "Type a task")}
    </div>
    <div class="tk-link" aria-hidden="true"></div>

    <div class="tk-slot">
      <button type="button" class="tk-target af-trigger" id="afTrigwho${pi}"
              aria-expanded="false" aria-controls="afPanelwho${pi}">
        <span class="tk-target-ico" aria-hidden="true">${AF_TK_PERSONADD}</span>
        <span class="tk-label">ASSIGN TARGET</span>
        <span class="tk-target-name af-value${afWhoText() === "CHOOSE WHO" ? " is-placeholder" : ""}" id="afValwho${pi}">${esc(afWhoText())}</span>
      </button>
      ${afTkPanelHTML("who" + pi, "Type a name")}
    </div>`;
}

/* ----- the active assignee GROUP -----
   Everyone toggled in ASSIGN TARGET since the last ADD OPERATIVE. They all
   share one stores/tasks config; mutations below run across the group so
   the entries never drift apart. */
const afGroup = () => afState.people.slice(afGroupStart);
const afGroupUids = () => afGroup().map(gp => gp.uid).filter(Boolean);

function afWhoText(){
  const names = afGroup().map(gp => gp.name).filter(Boolean);
  return names.length ? names.join(", ") : "CHOOSE WHO";
}
function afWhereText(p){
  if (!p.stores.length) return "Choose stores";
  if (afStores.length && p.stores.length === afStores.length) return "ALL LOCATIONS";
  return p.stores.join(", ");
}

function afAddGroupMember(uid, name){
  const g = afGroup();
  const blank = g.find(gp => !gp.uid);
  if (blank){ blank.uid = uid; blank.name = name; return; }
  // a new member joins with a copy of the group's current config
  const src = g[0] || afBlankPerson();
  const clone = afBlankPerson();
  clone.uid = uid; clone.name = name;
  clone.stores = [...src.stores];
  src.stores.forEach(st => {
    clone.storeTasks[st] = [...(src.storeTasks[st] || [])];
    if (src.storeNotes[st]) clone.storeNotes[st] = src.storeNotes[st];
    if (src.storeDues[st]) clone.storeDues[st] = src.storeDues[st];
  });
  afState.people.push(clone);
}
function afRemoveGroupMember(uid){
  for (let i = afState.people.length - 1; i >= afGroupStart; i--){
    if (afState.people[i].uid === uid){ afState.people.splice(i, 1); break; }
  }
  // the group (and the sheet) always needs an active person to hang the
  // rows off - an emptied group gets its placeholder back
  if (afState.people.length <= afGroupStart) afState.people.push(afBlankPerson());
}

// the workload matrix shows the heaviest-loaded member of the group (the
// same "N open" meta the member list already computes) - 0..4+ fills the
// four segments left to right
function afUpdateMeta(){
  const bars = $("afLoadBars");
  if (!bars) return;
  let n = 0;
  afGroupUids().forEach(uid => {
    const m = afMembers.find(x => x.value === uid);
    if (m && m.meta){ const num = parseInt(m.meta, 10); if (!isNaN(num)) n = Math.max(n, num); }
  });
  n = Math.min(4, n);
  [...bars.children].forEach((el, i) => el.classList.toggle("is-on", i < n));
}

// repaint just the chips + their remove wiring (called on every state nudge
// without tearing down whichever dropdown panel is open)
function afPaintPairs(){
  const pairsBox = $("afPairsBox");
  if (!pairsBox) return;
  pairsBox.innerHTML = afPairsHTML();
  pairsBox.querySelectorAll(".af-pair-tog").forEach(b => b.onclick = () => {
    const row = b.closest(".af-pair");
    const pi0 = Number(row.dataset.pi);
    const pp = afState.people[pi0];
    const store = row.dataset.store, task = row.dataset.task;
    const arr = pp.storeTasks[store];
    if (arr){
      const at = arr.indexOf(task);
      if (at >= 0) arr.splice(at, 1);
      if (!arr.length){
        delete pp.storeTasks[store];
        pp.stores = pp.stores.filter(s => s !== store);
        delete pp.storeNotes[store]; delete pp.storeDues[store];
      }
    }
    // a person from a PREVIOUS group with nothing left assigned has no rows
    // on screen to act on anymore - drop them rather than leaving an
    // invisible, invalid person silently blocking submit. (Current-group
    // members stay: they're still visible in ASSIGN TARGET.)
    if (!afPersonPairs(pp).length && pi0 < afGroupStart){
      afState.people.splice(pi0, 1);
      afGroupStart--;
      if (!afState.people.length){ afState.people.push(afBlankPerson()); afGroupStart = 0; }
    }
    afRenderPeople();
  });
}

/* Rebuild the active group's rows + wire their dropdowns. Picks update
   text + chips in place (multi-select panels stay open); the whole box
   only re-renders when the roster itself changes shape. */
function afRenderPeople(){
  const box = $("afPeople");
  if (!box) return;
  afCloseMenu();
  const pi = afState.people.length - 1;
  const p = afState.people[pi];
  box.innerHTML = afRowsHTML(p, pi);

  // ASSIGN TARGET: multi-select group of members, plus "ALL <craft>" bulk
  // options from the directory. Editing an existing thread stays
  // single-person (its submit path rebuilds exactly one person's rows).
  const whoItems = () => afMembers.concat(afRoles.map(r =>
    ({ value: r.value, label: r.label, meta: r.uids.length + " ppl" })));
  const syncWho = () => {
    const val = $("afValwho" + pi);
    if (val){
      const t = afWhoText();
      val.textContent = t;
      val.classList.toggle("is-placeholder", t === "CHOOSE WHO");
    }
    afPaintPairs();
    afUpdateMeta();
    afSync();
  };
  if (afEdit){
    afWireDropdown("who" + pi, () => afMembers, (v, l) => {
      p.uid = v; p.name = l;
      afRenderPeople();
    });
  } else {
    afWireDropdown("who" + pi, whoItems, v => {
      if (String(v).startsWith("role:")){
        const r = afRoles.find(x => x.value === v);
        if (!r) return;
        const allIn = r.uids.every(u => afGroupUids().includes(u));
        r.uids.forEach(u => {
          const m = afMembers.find(mm => mm.value === u);
          if (!m) return;
          if (allIn) afRemoveGroupMember(u);
          else if (!afGroupUids().includes(u)) afAddGroupMember(u, m.label);
        });
      } else {
        const m = afMembers.find(mm => mm.value === v);
        if (!m) return;
        if (afGroupUids().includes(v)) afRemoveGroupMember(v);
        else afAddGroupMember(v, m.label);
      }
      syncWho();
    }, null, {
      chosen: afGroupUids,
      onDone: () => { const t = $("afTrigwhere" + pi); if (t) t.focus(); }
    });
  }

  // ORIGIN NODE: multi-select stores, "ALL LOCATIONS" as a one-tap bulk
  // toggle - applied across every member of the group
  const whereItems = () => (afStores.length > 1
    ? [{ value: "__all", label: "ALL LOCATIONS", meta: afStores.length + "" }] : []).concat(afStores);
  afWireDropdown("where" + pi, whereItems, v => {
    if (v === "__all"){
      const allOn = afStores.length && p.stores.length === afStores.length;
      afGroup().forEach(gp => {
        if (allOn){
          gp.stores = []; gp.storeTasks = {}; gp.storeNotes = {}; gp.storeDues = {};
        } else {
          afStores.forEach(s => {
            if (!gp.stores.includes(s.value)){
              gp.stores.push(s.value);
              gp.storeTasks[s.value] = afUnionTasks(gp).filter(t => t);
            }
          });
        }
      });
    } else {
      const on = p.stores.includes(v);
      afGroup().forEach(gp => {
        const i = gp.stores.indexOf(v);
        if (on){
          if (i >= 0){ gp.stores.splice(i, 1); delete gp.storeTasks[v]; delete gp.storeNotes[v]; delete gp.storeDues[v]; }
        } else if (i < 0){
          gp.stores.push(v);
          // a new store inherits the group's current task set
          gp.storeTasks[v] = afUnionTasks(gp).filter(t => t);
        }
      });
    }
    const val = $("afValwhere" + pi);
    if (val){ val.textContent = afWhereText(p); val.classList.toggle("is-placeholder", !p.stores.length); }
    afPaintPairs();
    afSync();
  }, "+ Another store", {
    chosen: () => p.stores,
    onDone: () => { const t = $("afTrigproto" + pi); if (t) t.focus(); }
  });

  // PROTOCOL: task multi-select, applied to every store of every group member
  afWireDropdown("proto" + pi, afTaskOptions, v => {
    if (!p.stores.length){ toast("Pick a store first — tasks attach to stores"); return; }
    const has = afUnionTasks(p).includes(v);
    afGroup().forEach(gp => {
      gp.stores.forEach(st => {
        const arr = gp.storeTasks[st] = gp.storeTasks[st] || [];
        const at = arr.indexOf(v);
        if (has){ if (at >= 0) arr.splice(at, 1); }
        else if (at < 0) arr.push(v);
      });
    });
    const val = $("afValproto" + pi);
    const u = afUnionTasks(p);
    if (val){ val.textContent = u.length ? u.join(", ") : "Choose tasks"; val.classList.toggle("is-placeholder", !u.length); }
    afPaintPairs();
    afSync();
  }, "+ Another task", {
    chosen: () => afUnionTasks(p),
    onDone: () => { const t = $("afTrigwho" + pi); if (t) t.focus(); }
  });

  afPaintPairs();
  afUpdateMeta();
  afSync();
}

async function openAssignFlow(preUid, preName, editThread){
  afEdit = editThread || null;
  // editing prefills the flow from the thread's still-open rows: the due
  // date is the one most of them carry (older groups could vary per line),
  // and combos absent from the cross product start dropped
  const openRows = afEdit ? afEdit.rows.filter(r => !r.done) : [];
  let sharedDue = "", sharedDueTime = "";
  if (openRows.length){
    const freq = new Map();
    openRows.forEach(r => freq.set(r.dueDate || "", (freq.get(r.dueDate || "") || 0) + 1));
    sharedDue = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const withShared = openRows.find(r => r.dueDate === sharedDue && r.dueTime);
    sharedDueTime = withShared ? withShared.dueTime : "";
  }
  // the first (often only) person block; editing rebuilds it from the
  // thread's rows - the nested shape IS the stored shape
  const first = afBlankPerson();
  first.uid = preUid || (openRows[0] ? openRows[0].toUid : "") || "";
  first.name = preName || (openRows[0] ? openRows[0].toName : "") || "";
  openRows.forEach(r => {
    if (!r.store || !r.task) return;
    if (!first.stores.includes(r.store)) first.stores.push(r.store);
    const arr = first.storeTasks[r.store] = first.storeTasks[r.store] || [];
    if (!arr.includes(r.task)) arr.push(r.task);
    if (r.snote) first.storeNotes[r.store] = r.snote;
    if (r.dueDate && r.dueDate !== sharedDue) first.storeDues[r.store] = r.dueDate;
  });
  afState = {
    people: [first],
    note: openRows.length ? (openRows[0].note || "") : "",
    due: sharedDue,
    dueTime: sharedDueTime
  };
  afOpen = null;
  afMembers = []; afStores = []; afRoles = []; afBoardRows = [];
  afGroupStart = 0;

  const body = `
    <div class="tk-head">
      <button type="button" class="tk-icon-btn" id="afCancel" aria-label="Close">${AF_TK_X}</button>
      <div class="tk-head-title">
        <b>${afEdit ? "EDIT TASK" : "ASSIGN TASK"}</b>
        <span>SYS_OP_04</span>
      </div>
      <button type="button" class="tk-icon-btn" id="afHelp" aria-label="Help">${AF_TK_HELP}</button>
    </div>

    <div class="tk-card tk-status">
      <div class="tk-status-top">
        <div class="tk-field">
          <span class="tk-label">STATE</span>
          <button type="button" class="tk-tog" id="afThemeTog" aria-label="Light theme" aria-pressed="${afLightTheme}"><i></i></button>
        </div>
        <div class="tk-field">
          <span class="tk-label">P-RATING</span>
          <span class="tk-rating"><span class="tk-rating-star" aria-hidden="true">${AF_TK_STAR}</span><b>0</b>/5</span>
        </div>
      </div>
      <div class="tk-divider" aria-hidden="true"></div>
      <div class="tk-status-bottom">
        <div class="tk-time">
          <span class="tk-label">TOTAL TIME</span>
          <span class="tk-clock" id="afTotalTime">00:00:00</span>
          <span class="tk-sub">EST. COMPLEXITY: —</span>
        </div>
        <div class="tk-ring" aria-hidden="true">
          <svg viewBox="0 0 72 72">
            <circle class="tk-ring-track" cx="36" cy="36" r="29"></circle>
            <circle class="tk-ring-fill" cx="36" cy="36" r="29" stroke-dasharray="182.2" style="stroke-dashoffset:182.2"></circle>
          </svg>
          <span class="tk-ring-pct" id="afRingPct">0%</span>
        </div>
      </div>
    </div>

    <div class="tk-card tk-load">
      <div class="tk-load-head">
        <span class="tk-dot" aria-hidden="true"></span>
        <span class="tk-label">WORKLOAD MATRIX</span>
        <span class="tk-spin" aria-hidden="true">${AF_TK_SPIN}</span>
      </div>
      <div class="tk-load-bars" id="afLoadBars"><i></i><i></i><i></i><i></i></div>
      <div class="tk-load-lbl"><span>IDLE</span><span>MAX</span></div>
    </div>

    <div id="afPeople"></div>

    <div id="afPairsBox"></div>
    ${afEdit ? "" : `<button type="button" class="tk-add" id="afCommitPerson">+ ADD OPERATIVE</button>`}

    <div class="tk-card tk-config" id="afStepdetails">
      <div class="tk-config-head">
        <span class="tk-config-ico" aria-hidden="true">${AF_TK_SLIDERS}</span>
        <span class="tk-label tk-label-lg">CONFIGURATION DATA</span>
        <span class="tk-chip">GLOBAL_SCOPE</span>
      </div>
      <textarea id="afNote" placeholder="The shared brief — it rides along with every task in this send"></textarea>
      <div class="af-due-row">
        <label class="af-due"><span>Due date</span><input type="date" id="afDue"></label>
        <label class="af-due"><span>Due time</span><input type="time" id="afDueTime"></label>
      </div>
    </div>

    <button type="button" class="tk-go" id="afSave" disabled>${afEdit ? "COMMIT CHANGES" : "INITIATE ASSIGNMENT"}</button>

    <div id="afBoardBox"></div>
  `;
  const setup = () => {
    afRenderPeople();
    $("afNote").oninput = () => { afState.note = $("afNote").value; afSync(); };
    $("afDue").onchange = () => { afState.due = $("afDue").value; };
    $("afDueTime").onchange = () => { afState.dueTime = $("afDueTime").value; };
    $("afCancel").onclick = () => {
      afCloseMenu(); afEdit = null;
      closeSheet();
    };
    const help = $("afHelp");
    if (help) help.onclick = () => toast("Pick who, the stores and the tasks — then initiate.");
    const themeTog = $("afThemeTog");
    if (themeTog) themeTog.onclick = () => {
      afLightTheme = !afLightTheme;
      localStorage.setItem("afTheme", afLightTheme ? "light" : "dark");
      $("sheet").classList.toggle("af-sheet-light", afLightTheme);
      // keep the wide class in the tracked set so the NEXT sheet still
      // removes both, not just the light theme
      sheetThemeCls = "af-sheet-wide" + (afLightTheme ? " af-sheet-light" : "");
      themeTog.setAttribute("aria-pressed", afLightTheme);
    };
    const addPerson = $("afCommitPerson");
    if (addPerson) addPerson.onclick = () => {
      const bad = afState.people.find(pp => !afPersonValid(pp));
      if (bad){
        toast(!bad.uid ? "Pick who first — then add the next person"
          : `Add at least one store + task for ${bad.name || "them"} first`);
        return;
      }
      // close out the current group; the next toggles build a fresh one
      afGroupStart = afState.people.length;
      afState.people.push(afBlankPerson());
      afRenderPeople();
      const t = $("afTrigwho" + (afState.people.length - 1));
      if (t) t.focus();
    };
    $("afSave").onclick = afSubmit;
    $("afNote").value = afState.note;
    if (afState.due) $("afDue").value = afState.due;
    if (afState.dueTime) $("afDueTime").value = afState.dueTime;
    // the member/store/role lists + board rows load async - re-render once
    // they land so the rows can populate their panels with real options
    loadAssignOptions().then(d => {
      afMembers = d.members; afStores = d.stores;
      afRoles = d.roles || []; afBoardRows = d.board || [];
      afRenderPeople();
      afRenderBoard();
    });
  };

  openSheet(body, setup, { cls: "af-sheet-wide" + (afLightTheme ? " af-sheet-light" : "") });
}

/* ---------- execution board ----------
   Every OPEN assignment across the team, right inside the assign sheet -
   see what's already in flight while handing out more, and resolve a line
   with one tap (with the same undo the worker-side Done flow has). Hidden
   while editing a thread; shown only when there's data to show. */
function afRenderBoard(){
  const box = $("afBoardBox");
  if (!box) return;
  if (afEdit || !afBoardRows.length){ box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="tk-card tk-board">
      <div class="tk-load-head">
        <span class="tk-dot" aria-hidden="true"></span>
        <span class="tk-label">EXECUTION BOARD</span>
        <span class="tk-chip">${afBoardRows.length} OPEN</span>
      </div>
      <div class="tk-board-rows">
        ${afBoardRows.map(r => `
        <div class="tk-brow" data-id="${esc(r.id)}">
          <span class="tk-brow-chip">PENDING</span>
          <span class="tk-brow-main">${esc(r.toName || "—")} — ${esc(r.store || "—")} · ${esc(r.task || "—")}</span>
          <button type="button" class="tk-brow-done" aria-label="Mark done">${AF_TICK}</button>
        </div>`).join("")}
      </div>
    </div>`;
  box.querySelectorAll(".tk-brow-done").forEach(b => b.onclick = async () => {
    const row = b.closest(".tk-brow");
    const id = row.dataset.id;
    b.disabled = true;
    try {
      // ack:true - resolving your own board shouldn't ring your own bell
      await db.collection("assignments").doc(id).update({ done: true, doneAt: Date.now(), ack: true });
      afBoardRows = afBoardRows.filter(r => r.id !== id);
      afRenderBoard();
      toast("Marked done", { label: "Undo", run: () => undoDone([id]) });
    } catch (e) {
      console.error(e);
      b.disabled = false;
      toast("Couldn't mark it done — check your connection");
    }
  });
}

/* Members carry their current open-task count, so you can see who is already
   loaded before piling more on. Stores come from what has actually been
   assigned as well as CONFIG, so the list learns instead of going stale. */
async function loadAssignOptions(){
  let rows = [];
  try { rows = await fetchAssignRows(); } catch (e) { console.error(e); rows = assignRows || []; }

  const openBy = new Map();
  rows.forEach(r => { if (!r.done && r.toUid) openBy.set(r.toUid, (openBy.get(r.toUid) || 0) + 1); });
  // campaign batons weigh on a member too - "clear" must mean actually clear
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
      const n = openBy.get(doc.id) || 0;
      members.push({
        value: doc.id,
        label: s.worker || data.email || "Unnamed",
        meta: n ? `${n} open` : "clear"
      });
    });
  } catch (e) { console.error(e); }
  members.sort((a, b) => a.label.localeCompare(b.label));

  const seen = new Map();
  CONFIG.clients.forEach(c => seen.set(c.toLowerCase(), c));
  rows.forEach(r => { if (r.store) seen.set(String(r.store).toLowerCase(), r.store); });
  const stores = [...seen.values()].sort((a, b) => a.localeCompare(b))
    .map(s => ({ value: s, label: s }));

  // "ALL <craft>" bulk targets, from the same directory the @mention
  // autocomplete and campaign role-routing already read
  let roles = [];
  try {
    const dir = await loadDirectory();
    const byCraft = new Map();
    dir.forEach(pp => {
      const craft = (pp.craft || "").trim().toLowerCase();
      if (!craft || !members.some(m => m.value === pp.uid)) return;
      if (!byCraft.has(craft)) byCraft.set(craft, []);
      byCraft.get(craft).push(pp.uid);
    });
    roles = [...byCraft.entries()]
      .filter(([, uids]) => uids.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([craft, uids]) => ({
        value: "role:" + craft,
        label: "ALL " + craft.toUpperCase(),
        uids
      }));
  } catch (e) { console.error(e); }

  // the execution board: every still-open line, soonest due first
  const board = rows.filter(r => !r.done)
    .sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"))
    .map(r => ({ id: r.id, toName: r.toName, store: r.store, task: r.task }));

  return { members, stores, roles, board };
}

/* Every store x task pair becomes its own assignment rather than one record
   holding arrays. It keeps the existing single-value shape - so the roster,
   the tables and the exports need no changes - and it means each one can be
   ticked off on its own, which is how they actually get worked. Pairs born
   from one submit share a groupId, so every surface can fold them back into
   the single thread the admin meant them as; assigned one at a time there is
   no groupId and each stays its own thread. Written as a batch so a partial
   set can't land.

   Editing reuses the same submit: open rows are matched by store+task, so an
   unchanged line keeps its doc id (no phantom "new task" for the assignee),
   removed lines are deleted, added lines join under the same groupId, and
   done rows are left alone apart from the group arithmetic. Whoever saves
   the edit becomes the assignment's face - "who asked me to do this" should
   name the person whose latest version it is. */
async function afSubmit(){
  const s = afState;
  const btn = $("afSave");
  btn.disabled = true;

  const col = db.collection("assignments");
  const from = {
    // who assigned it, by name - an email is not an answer to "who asked
    // me to do this"
    fromName: S.worker || "",
    fromEmail: (auth.currentUser && auth.currentUser.email) || ""
  };
  // one row per store x task, carrying that store's own note and due date
  // when given; the shared brief and date are the defaults
  const rowFor = (p, pr) => ({
    toUid: p.uid, toName: p.name, ...from,
    store: pr.store, task: pr.task,
    note: s.note.trim(),
    snote: (p.storeNotes[pr.store] || "").trim() || null,
    dueDate: p.storeDues[pr.store] || s.due || null,
    // only carries the shared due time - a per-store due override has no
    // time of its own, so tagging the shared time onto a different date
    // would misrepresent it
    dueTime: p.storeDues[pr.store] ? null : (s.dueTime || null)
  });

  try {
    const batch = db.batch();
    if (afEdit){
      const p = s.people[0];
      const pairs = afPersonPairs(p);
      const openRows = afEdit.rows.filter(r => !r.done);
      const doneRows = afEdit.rows.filter(r => r.done);
      const oldByKey = new Map(openRows.map(r => [pairKey(r.store, r.task), r]));
      const total = doneRows.length + pairs.length;
      // a single edited into several needs the groupId it never had
      const groupId = afEdit.groupId || (total > 1 ? col.doc().id : null);
      const createdAt = afEdit.rows[0].createdAt || Date.now();
      pairs.forEach(pr => {
        const base = {
          ...rowFor(p, pr), groupId, groupSize: total,
          // edited means changed - the receipt resets so it needs seeing again
          seenAt: null
        };
        const k = pairKey(pr.store, pr.task), old = oldByKey.get(k);
        if (old){
          oldByKey.delete(k);
          batch.update(col.doc(old.id), base);
        } else {
          batch.set(col.doc(), { ...base, createdAt, done: false, doneAt: null });
        }
      });
      oldByKey.forEach(old => batch.delete(col.doc(old.id)));
      doneRows.forEach(r => batch.update(col.doc(r.id), { groupId, groupSize: total }));
      await batch.commit();
      toast("Assignment updated");
    } else {
      // one batch, several people: each person's pairs travel as THEIR
      // group (own groupId, own thread, own notification on their side).
      // groupSize rides on every doc because the open-tasks listener only
      // sees rows still open - "4 of 6 done" needs to know it started as 6
      const now = Date.now();
      s.people.forEach(p => {
        const pairs = afPersonPairs(p);
        const groupId = pairs.length > 1 ? col.doc().id : null;
        pairs.forEach(pr => batch.set(col.doc(), {
          ...rowFor(p, pr), createdAt: now, done: false, doneAt: null,
          groupId, groupSize: pairs.length
        }));
      });
      await batch.commit();
      const total = afAllPairs().length;
      const who = s.people.map(p => p.name).join(", ");
      toast(total === 1
        ? `${afAllPairs()[0].task} assigned to ${who}`
        : `${total} tasks assigned to ${who}`);
    }

    afEdit = null;
    afCloseMenu();
    if (isAdmin) loadTeamPane();
    closeSheet();
    // the log may be on screen behind the sheet (Team page) - keep it honest
    if (!$("teamScreen").classList.contains("hidden")) loadCompletionLog(true, $("teamRecentlyDone"));
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast(afEdit ? "Couldn't save — check Firestore rules allow it"
                 : "Couldn't assign — check Firestore rules allow it");
  }
}

// entry point: the roster opens it with the member already chosen. Every
// "cold" open (card menu, dock icons) calls openAssignFlow() directly.
const askAssignTask = (uid, name) => openAssignFlow(uid, name);

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

