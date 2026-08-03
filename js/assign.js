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
let afInPage = false;    // mounted inline on the Assign page vs. in a sheet
let afMembers = [], afStores = [];   // dropdown feeds, loaded async per open

// one key per store x task combination; a newline can't appear in either
// name (both come from single-line inputs), so it is a safe separator
const pairKey = (store, task) => store + "\n" + task;

/* The form is PEOPLE-first, exactly as sketched: each person block nests
   their stores, each store nests its own tasks - plus an optional note and
   due date of its own. "+ Another person" repeats the whole block, so one
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

function afRenderSentence(){
  const s = afState, el = $("afSentence");
  if (!el) return;
  const bits = s.people.map(p => {
    if (!p.name) return `<i class="af-slot">someone</i>`;
    const n = afPersonPairs(p).length;
    return `<b class="af-tok">${esc(p.name)}</b>${n
      ? ` — ${n} task${n === 1 ? "" : "s"} at ${esc(p.stores.join(", "))}` : ""}`;
  });
  const total = afAllPairs().length;
  el.innerHTML = bits.join(" · ")
    + (s.due ? `, due <b class="af-tok">${esc(afDueLabel(s.due))}</b>` : "")
    + (total > 1 ? `<span class="af-count">${total} tasks · one send</span>` : "");
}

/* Locks, pips and the Assign button all derive from the same validity
   checks, per person block: Where waits for Who, the store rows wait for
   Where, Details waits for every block being whole. */
function afSync(){
  const set = (el, done, locked) => {
    if (!el) return;
    el.classList.toggle("is-done", done);
    el.classList.toggle("is-locked", locked);
    el.querySelectorAll("button,input,textarea").forEach(c => { c.disabled = locked; });
  };
  afState.people.forEach((p, pi) => {
    set($("afStepwho" + pi), !!p.uid, false);
    set($("afStepwhere" + pi), p.stores.length > 0, !p.uid);
    set($("afStepwhat" + pi),
      p.stores.length > 0 && p.stores.every(st => (p.storeTasks[st] || []).length > 0),
      !p.stores.length);
  });
  const allBlocks = afState.people.every(afPersonValid);
  set($("afStepdetails"), afState.note.trim().length >= 3, !allBlocks);
  // the add buttons never disable (their click explains itself); they just
  // dim while pressing them couldn't succeed, and the store one's tooltip
  // names whose block it extends
  const add = $("afAddPerson");
  if (add) add.classList.toggle("is-idle", !allBlocks);
  const more = $("afAddMore");
  if (more){
    const last = afState.people[afState.people.length - 1];
    more.classList.toggle("is-idle", !last || !last.uid);
    const label = "Another store" + (last && last.name ? " for " + last.name : "");
    more.title = label;
    more.setAttribute("aria-label", label);
  }
  afRenderSentence();
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
  if (afOpen && !e.target.closest(".af-step, .af-trigger, .af-panel")) afCloseMenu();
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
    onPick(v, v);
  };
  ok.onclick = commit;
  input.onkeydown = e => {
    if (e.key === "Enter"){ e.preventDefault(); commit(); }
    else if (e.key === "Escape"){ e.preventDefault(); custom.hidden = true; trig.focus(); }
  };
}

/* One block per person, rebuilt whole whenever the roster of blocks
   changes. Each block owns its Who dropdown, its Where multi-select and
   its per-store task rows; the closures below carry the person object, so
   there is no global "current person" to get confused about. */
function afRenderPeople(){
  const box = $("afPeople");
  if (!box) return;
  afCloseMenu();
  box.innerHTML = afState.people.map((p, pi) => `
    <div class="af-person">
      ${afState.people.length > 1 ? `
      <div class="af-person-head">
        <span class="af-person-n">Person ${pi + 1}</span>
        <button type="button" class="af-person-x" data-px="${pi}" title="Remove this block">×</button>
      </div>` : ""}
      ${afDropdownMarkup("who" + pi, "Who", "Choose a team member")}
      ${afDropdownMarkup("where" + pi, "Where", "Choose stores")}
      <div class="af-step is-locked" id="afStepwhat${pi}">
        <div class="af-step-head">
          <span class="af-pip" aria-hidden="true"></span>
          <span class="af-step-label">What — per store</span>
        </div>
        <div id="afWhatRows${pi}"></div>
      </div>
    </div>`).join("");

  afState.people.forEach((p, pi) => {
    afWireDropdown("who" + pi, () => afMembers, (v, l) => {
      p.uid = v; p.name = l;
      const val = $("afValwho" + pi);
      if (val) val.textContent = l;
      afSync();
      const nxt = $("afTrigwhere" + pi);
      if (nxt && !nxt.disabled) nxt.focus();
    });
    afWireDropdown("where" + pi, () => afStores, v => {
      const i = p.stores.indexOf(v);
      if (i >= 0){
        p.stores.splice(i, 1);
        delete p.storeTasks[v]; delete p.storeNotes[v]; delete p.storeDues[v];
      } else {
        p.stores.push(v);
        // when this person's stores so far share one task set, a new store
        // inherits it - the same-everywhere case costs nothing extra
        const sets = p.stores.slice(0, -1).map(st => (p.storeTasks[st] || []).join("\n"));
        p.storeTasks[v] =
          (sets.length && sets.every(x => x && x === sets[0])) ? sets[0].split("\n") : [];
      }
      const val = $("afValwhere" + pi);
      if (val) val.textContent = p.stores.length ? p.stores.join(", ") : "Choose stores";
      afRenderStores(p, pi);
      afSync();
    }, "+ Another store", {
      chosen: () => p.stores,
      onDone: () => { const t = $(`afTrigwhat${pi}_0`); if (t && !t.disabled) t.focus(); }
    });
    if (p.name){ const v = $("afValwho" + pi); if (v) v.textContent = p.name; }
    if (p.stores.length){ const v = $("afValwhere" + pi); if (v) v.textContent = p.stores.join(", "); }
    afRenderStores(p, pi);
  });

  box.querySelectorAll(".af-person-x").forEach(b => b.onclick = () => {
    afState.people.splice(Number(b.dataset.px), 1);
    if (!afState.people.length) afState.people.push(afBlankPerson());
    afRenderPeople();
    afSync();
  });
  afSync();
}

/* One person's store rows: task picker per store, plus that store's own
   optional note and due date - "Task is nested to the store", exactly as
   sketched. The shared Details brief and date below stay the defaults. */
function afRenderStores(p, pi){
  const box = $("afWhatRows" + pi);
  if (!box) return;
  if (afOpen && String(afOpen).startsWith("what" + pi + "_")) afCloseMenu();
  if (!p.stores.length){
    box.innerHTML = `<p class="af-opt-none">Pick stores first — each gets its own tasks.</p>`;
    return;
  }
  box.innerHTML = p.stores.map((store, si) => {
    const k = `what${pi}_${si}`;
    const chosen = p.storeTasks[store] || [];
    return `
    <div class="af-sub">
      <span class="af-sub-store">${esc(store)}</span>
      <button type="button" class="af-trigger" id="afTrig${k}"
              aria-expanded="false" aria-controls="afPanel${k}">
        <span class="af-value">${esc(chosen.join(", ") || "Choose tasks")}</span>
        <svg class="af-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="af-panel" id="afPanel${k}" hidden></div>
      <div class="af-custom" id="afCustom${k}" hidden>
        <input type="text" id="afInput${k}" placeholder="Type a task" autocomplete="off">
        <button type="button" class="af-custom-ok" id="afOk${k}">Use</button>
      </div>
      <div class="af-sub-extra">
        <input type="text" class="af-sub-note" id="afSnote${k}" placeholder="Note just for ${esc(store)} (optional)" value="${esc(p.storeNotes[store] || "")}" autocomplete="off">
        <input type="date" class="af-sub-due" id="afSdue${k}" value="${esc(p.storeDues[store] || "")}" title="Due date for ${esc(store)} only (optional)">
      </div>
    </div>`;
  }).join("")
  + (p.stores.length > 1 ? `<button type="button" class="af-sub-copy" data-cp="1">Same tasks for every store</button>` : "");

  p.stores.forEach((store, si) => afWireStoreRow(p, pi, store, si));
  const cp = box.querySelector("[data-cp]");
  if (cp) cp.onclick = () => {
    const src = p.stores.map(st => p.storeTasks[st] || []).find(a => a.length);
    if (!src){ toast("Pick tasks under one store first"); return; }
    p.stores.forEach(st => { p.storeTasks[st] = [...src]; });
    afRenderStores(p, pi);
    afSync();
  };
}

// one store's picker: same open/roving-focus/custom-entry manners as the
// generic dropdowns, but its checkbox state lives on the person block
function afWireStoreRow(p, pi, store, si){
  const key = `what${pi}_${si}`;
  const trig = $("afTrig" + key), panel = $("afPanel" + key);
  const custom = $("afCustom" + key), input = $("afInput" + key), ok = $("afOk" + key);
  // CONFIG's list plus anything typed under any block this session - a
  // custom task picked once is one click everywhere else
  const options = () => {
    const seen = new Map();
    CONFIG.tasks.forEach(t => seen.set(t.toLowerCase(), t));
    afState.people.forEach(pp => Object.values(pp.storeTasks).flat()
      .forEach(t => seen.set(t.toLowerCase(), t)));
    return [...seen.values()];
  };
  const paint = () => {
    const chosen = p.storeTasks[store] || [];
    panel.innerHTML = options().map(t => {
      const on = chosen.includes(t);
      return `
      <button type="button" class="af-opt${on ? " is-on" : ""}" data-v="${esc(t)}" aria-pressed="${on}">
        <span class="af-check" aria-hidden="true">${on ? AF_TICK : ""}</span>
        <span class="af-opt-main">${esc(t)}</span>
      </button>`;
    }).join("")
    + `<button type="button" class="af-opt af-opt-new" data-v="__new">+ Another task</button>
       <button type="button" class="af-opt af-opt-done" data-v="__done">Done choosing</button>`;
    panel.querySelectorAll("button[data-v]").forEach(b => {
      b.onclick = () => {
        const v = b.dataset.v;
        if (v === "__done"){
          afCloseMenu();
          const nxt = $(`afTrigwhat${pi}_${si + 1}`) || $("afTrigwho" + (pi + 1)) || $("afNote");
          if (nxt && !nxt.disabled) nxt.focus();
          return;
        }
        if (v === "__new"){
          afCloseMenu();
          custom.hidden = false;
          input.value = "";
          input.focus();
          return;
        }
        const arr = p.storeTasks[store] = p.storeTasks[store] || [];
        const at = arr.indexOf(v);
        if (at >= 0) arr.splice(at, 1); else arr.push(v);
        trig.querySelector(".af-value").textContent = arr.join(", ") || "Choose tasks";
        paint();
        afSync();
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
  panel.onkeydown = e => {
    const opts = [...panel.querySelectorAll("button")];
    const at = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown"){ e.preventDefault(); (opts[at + 1] || opts[0]).focus(); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); (opts[at - 1] || opts[opts.length - 1]).focus(); }
    else if (e.key === "Escape"){ e.preventDefault(); afCloseMenu(); trig.focus(); }
  };
  const commit = () => {
    const v = input.value.trim();
    if (!OTHER_RE.test(v)){ input.focus(); return; }
    custom.hidden = true;
    const arr = p.storeTasks[store] = p.storeTasks[store] || [];
    if (!arr.includes(v)) arr.push(v);
    trig.querySelector(".af-value").textContent = arr.join(", ");
    afSync();
  };
  ok.onclick = commit;
  input.onkeydown = e => {
    if (e.key === "Enter"){ e.preventDefault(); commit(); }
    else if (e.key === "Escape"){ e.preventDefault(); custom.hidden = true; trig.focus(); }
  };
  const sn = $("afSnote" + key), sd = $("afSdue" + key);
  if (sn) sn.oninput = () => { p.storeNotes[store] = sn.value; };
  if (sd) sd.onchange = () => { p.storeDues[store] = sd.value; afRenderSentence(); };
}

async function openAssignFlow(preUid, preName, editThread){
  afEdit = editThread || null;
  // editing prefills the flow from the thread's still-open rows: the due
  // date is the one most of them carry (older groups could vary per line),
  // and combos absent from the cross product start dropped
  const openRows = afEdit ? afEdit.rows.filter(r => !r.done) : [];
  let sharedDue = "";
  if (openRows.length){
    const freq = new Map();
    openRows.forEach(r => freq.set(r.dueDate || "", (freq.get(r.dueDate || "") || 0) + 1));
    sharedDue = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
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
    due: sharedDue
  };
  afOpen = null;
  // On the Assign page the flow mounts inline; everywhere else (roster
  // quick-assign, small screens' menus) it stays a sheet. Only ever one
  // instance at a time, so the af* element ids stay unique.
  afInPage = currentRoute() === "assign" && !!$("assignFlowMount");
  afMembers = []; afStores = [];

  const body = `
    <p class="af-sentence" id="afSentence"></p>
    <div id="afPeople"></div>
    ${afEdit ? "" : `
    <div class="af-add-row">
      <button type="button" class="af-add-ico" id="afAddMore" aria-label="Another store" title="Another store">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5 5 4h14l1.5 5.5"/><path d="M5 9.5V20h14V9.5"/><path d="M12 12v5.4M9.3 14.7h5.4"/></svg>
      </button>
      <button type="button" class="af-add-ico" id="afAddPerson" aria-label="New person" title="New person">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.6"/><path d="M3.5 20.5c0-3.5 2.9-6 6.5-6 .9 0 1.8.16 2.6.45"/><path d="M17.5 14.5v6M14.5 17.5h6"/></svg>
      </button>
    </div>`}
    <div class="af-step is-locked" id="afStepdetails">
      <div class="af-step-head">
        <span class="af-pip" aria-hidden="true"></span>
        <span class="af-step-label">Details — for everyone</span>
      </div>
      <textarea id="afNote" placeholder="The shared brief — per-store notes above ride along with it"></textarea>
      <label class="af-due"><span>Due date</span><input type="date" id="afDue"></label>
    </div>
    <button class="btn btn-go" id="afSave" disabled>${afEdit ? "Save changes" : "Assign"}</button>
    <button class="btn btn-ghost btn-sm" id="afCancel">${afInPage ? (afEdit ? "Discard edit" : "Start over") : "Cancel"}</button>
  `;
  const setup = () => {
    afRenderPeople();
    // both add buttons stay clickable at all times: a press that can't be
    // honoured yet SAYS why, instead of a dead disabled button that reads
    // as broken
    const add = $("afAddPerson");
    if (add) add.onclick = () => {
      const bad = afState.people.find(p => !afPersonValid(p));
      if (bad){
        toast(!bad.uid ? "Pick who first — then add the next person"
          : !bad.stores.length ? `Give ${bad.name || "them"} a store first`
          : `Every store under ${bad.name || "this person"} needs a task first`);
        return;
      }
      afState.people.push(afBlankPerson());
      afRenderPeople();
      const t = $("afTrigwho" + (afState.people.length - 1));
      if (t) t.focus();
    };
    // more work for the SAME person: jump straight into their store picker
    // instead of making the admin re-add who they already added
    const more = $("afAddMore");
    if (more) more.onclick = () => {
      const pi = afState.people.length - 1;
      const p = afState.people[pi];
      if (!p.uid){ toast("Pick who first — the store belongs to a person"); return; }
      const t = $("afTrigwhere" + pi);
      if (!t) return;
      t.scrollIntoView({ behavior: "smooth", block: "center" });
      // deferred: a synthetic click fired synchronously here is still
      // nested inside afAddMore's own click event. That event keeps
      // bubbling to the document afterward, where the "click outside
      // closes menus" listener sees afAddMore (not the trigger) as the
      // target and immediately shuts the panel this just opened. Waiting
      // a tick lets that bubble finish first, so the fresh click on t is
      // its own event and the listener sees it land inside .af-trigger.
      setTimeout(() => {
        if (t.getAttribute("aria-expanded") !== "true") t.click();
        t.focus();
      }, 0);
    };
    $("afNote").oninput = () => { afState.note = $("afNote").value; afSync(); };
    $("afDue").onchange = () => { afState.due = $("afDue").value; afRenderSentence(); };
    $("afCancel").onclick = () => {
      afCloseMenu(); afEdit = null;
      if (afInPage) openAssignFlow();   // inline: reset back to a fresh flow
      else closeSheet();
    };
    $("afSave").onclick = afSubmit;
    $("afNote").value = afState.note;
    if (afState.due) $("afDue").value = afState.due;
    loadAssignOptions().then(d => { afMembers = d.members; afStores = d.stores; });
  };

  if (afInPage){
    const mount = $("assignFlowMount");
    const title = document.querySelector("#assignScreen .fpage-section-title");
    if (title) title.textContent = afEdit ? "Edit assignment" : "New assignment";
    mount.innerHTML = body;
    setup();
    // editing starts from a log row further down the page - bring the flow up
    if (afEdit || preUid) mount.closest(".assign-flow-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    openSheet(`<h2>${afEdit ? "Edit assignment" : "Assign task"}</h2>` + body, setup);
  }
}

/* Members carry their current open-task count, so you can see who is already
   loaded before piling more on. Stores come from what has actually been
   assigned as well as CONFIG, so the list learns instead of going stale. */
async function loadAssignOptions(){
  let rows = [];
  try {
    const snap = await db.collection("assignments").get();
    snap.forEach(doc => rows.push(doc.data()));
  } catch (e) { console.error(e); }

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

  return { members, stores };
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
    dueDate: p.storeDues[pr.store] || s.due || null
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
    if (afInPage){
      // inline: clear back to a fresh flow and let the log show what landed
      openAssignFlow();
      loadCompletionLog(true, $("assignLogBox"));
    } else {
      closeSheet();
      // the log may be on screen behind the sheet (Team page) - keep it honest
      if (!$("teamScreen").classList.contains("hidden")) loadCompletionLog(true, $("teamRecentlyDone"));
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    toast(afEdit ? "Couldn't save — check Firestore rules allow it"
                 : "Couldn't assign — check Firestore rules allow it");
  }
}

// entry points: the card menu opens it cold, the roster opens it with the
// member already chosen
const askAssignTaskPickMember = () => openAssignFlow();
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
            ? `From ${esc(r.fromName || "admin")}${r.createdAt ? " · your stage since " + dayStamp(r.createdAt) : ""}${r.multi ? " · " + esc(r.multi) : ""} · ${r.dueDate ? "due " + esc(r.dueDate) : "no due date"}`
            : `From ${esc(r.fromName || r.fromEmail || "admin")}${r.createdAt ? " · assigned " + dayStamp(r.createdAt) : ""} · ${r.dueDate ? "due " + esc(r.dueDate) : "no due date"}`;
          return `
          <li class="atask${tOpen ? " is-open" : ""}${late ? " is-late" : ""}">
            <button type="button" class="atask-head" data-tid="${esc(r.id)}" aria-expanded="${tOpen}">
              <span class="atask-name">${esc(r.task)}${r.cg ? `<span class="atask-cgchip">campaign</span>` : ""}</span>
              <span class="atask-due">${r.dueDate ? (late ? "overdue · " : "due ") + esc(r.dueDate) : ""}</span>
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
  const stat = (n, label, cls) =>
    `<li class="team-stat is-${cls}${n ? "" : " is-zero"}">
       <span class="team-dot is-${cls}">${STATUS_GLYPH[cls]}</span><b>${n}</b> ${label}
     </li>`;
  counts.innerHTML = `<ul class="team-stats">
      ${stat(rows.length, "open", "open")}${stat(late, "overdue", "late")}${stat(soon, "due today", "done")}
    </ul>`;

  // undated tasks sort last, so the headline is always something with a date
  // if one exists
  const up = [...rows].sort((a, b) =>
    (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"))[0];
  next.innerHTML = up
    ? `<div class="team-latest-who">${esc(up.store || "—")} · ${esc(up.task || "task")}</div>
       <div class="team-latest-what">${esc(up.note || "")}<span class="team-latest-when">${
         up.dueDate ? " · due " + esc(up.dueDate) : " · no due date"}</span></div>`
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

async function deleteWorker(uid, name){
  if (!confirm(`Delete ${name}? This removes their shift data and app access. This can't be undone.\n\nNote: it does NOT delete their login itself - to fully block them from signing in again, also remove them in Firebase Console > Authentication > Users.`)) return;
  try {
    await db.collection("appState").doc(uid).delete();
    await db.collection("users").doc(uid).delete();
    toast(name + " deleted");
    closeSheet();
    loadTeamData();      // the roster behind the sheet still lists them otherwise
    loadTeamPending();
  } catch (e) {
    console.error(e);
    toast("Couldn't delete - check Firestore rules allow admin deletes");
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

