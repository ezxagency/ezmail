/* ============================================================
   SHEETS
   ============================================================ */
/* Sheets dismiss like modals should: tap the scrim or hit Esc and you are
   back on the parent view. A sheet that genuinely must be answered (the
   one-time name prompt) opts out with { dismissible: false }. */
let sheetDismissible = true;
let sheetThemeCls = null;
function openSheet(html, setup, opts){
  sheetDismissible = !opts || opts.dismissible !== false;
  if (sheetThemeCls) $("sheet").classList.remove(sheetThemeCls);
  sheetThemeCls = (opts && opts.cls) || null;
  if (sheetThemeCls) $("sheet").classList.add(sheetThemeCls);
  $("sheetBody").innerHTML = html;
  $("scrim").classList.add("on");
  $("sheet").classList.add("on");
  if (setup) setup();
  // the dialog owns focus once open; a setup() that focused its own input
  // (a textarea to type in) keeps that more specific choice
  if (!$("sheet").contains(document.activeElement)) $("sheet").focus();
}
function closeSheet(){ $("scrim").classList.remove("on"); $("sheet").classList.remove("on"); }
const sheetIsOpen = () => $("sheet").classList.contains("on");
$("scrim").onclick = () => { if (sheetDismissible) closeSheet(); };

/* Optionally carries one action ("Undo"). An action toast lingers longer -
   it is asking for a decision, not just narrating - and a new toast always
   cancels the old timer so a quick pair of actions can't cut the second
   toast short. */
let toastTimer = null;
function toast(msg, action){
  const t = $("toast");
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.classList.toggle("has-act", !!action);
  if (action){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { clearTimeout(toastTimer); t.classList.remove("on"); action.run(); };
    t.append(b);
  }
  t.classList.add("on");
  toastTimer = setTimeout(() => t.classList.remove("on"), action ? 6000 : 2100);
}

function chipGroup(list, allowOther){
  return list.map(x => `<button type="button" class="chip" data-v="${esc(x)}" aria-pressed="false">${esc(x)}</button>`).join("")
    + (allowOther ? `<button type="button" class="chip" data-v="__other" aria-pressed="false">Other…</button>` : "");
}
function wireChipsIn(container, onPick){
  const chips = container.querySelectorAll(".chip");
  chips.forEach(c => c.onclick = () => {
    chips.forEach(x => x.setAttribute("aria-pressed","false"));
    c.setAttribute("aria-pressed","true");
    onPick(c.dataset.v);
  });
}
function wireChips(onPick){ wireChipsIn($("sheetBody"), onPick); }
const OTHER_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-#]{1,39}$/;

/* ============================================================
   SCROLL WHEEL PICKER
   ============================================================ */
/* iOS-style scroll wheel - originally built for Campaigns' stage day/hour
   budget (bounded numeric ranges a wheel picks faster than typing into),
   now shared with Assign Task's store/task pickers too, so it lives here
   rather than in campaigns.js - team.js/nav.js already reuse a shared-helper
   file the same way (hxMonthKey/sparklineSvg). Native scroll + CSS
   scroll-snap does the physics (mouse wheel, trackpad, touch swipe all
   just work); this only tracks where it settled and reports that back.
   `options` is {v, label} pairs so numeric wheels (Campaigns) and text
   wheels (Assign Task store/task names) share one implementation. */
function wheelRender(containerId, opts){
  const { value, onChange, options } = opts;
  const box = $(containerId);
  if (!box) return;
  // itemH: row height override (Assign Task's Figma-canvas wheels use 50px
  // rows; Campaigns keeps the 32px default). noFade: skip the JS-inline
  // opacity tiers so CSS can own the neighbor styling instead.
  const ITEM_H = opts.itemH || 32;
  box.innerHTML = `
    <div class="wheel-track" id="${containerId}Track" style="padding:${ITEM_H}px 0">
      ${options.map(o => `<div class="wheel-item" data-v="${o.v === null ? "" : o.v}">${esc(o.label)}</div>`).join("")}
    </div>
    <div class="wheel-highlight"></div>`;
  const track = $(containerId + "Track");
  const items = [...track.querySelectorAll(".wheel-item")];
  const idxOf = v => Math.max(0, options.findIndex(o => o.v === v));
  const paint = () => {
    const center = Math.round(track.scrollTop / ITEM_H);
    items.forEach((el, i) => {
      const dist = Math.abs(i - center);
      el.classList.toggle("is-sel", dist === 0);
      el.style.opacity = opts.noFade ? "" : (dist === 0 ? "1" : dist === 1 ? ".5" : ".22");
    });
  };
  // A short wheel (few options, so little scrollable range) can end up with
  // scroll-snap-type:mandatory fighting a smooth scrollTo - the snap system
  // treats the in-flight animation as "not yet at a valid point" and keeps
  // correcting it back toward the start, so the scroll never actually
  // arrives. Sidestepping that entirely: drop snap for one frame, jump the
  // position directly, put snap back once the jump has landed. This trades
  // the smooth glide for an instant reposition on tap/settle, but it's the
  // one thing that reliably works regardless of how many options there are.
  const scrollToIndex = i => {
    track.style.scrollSnapType = "none";
    track.scrollTop = i * ITEM_H;
    requestAnimationFrame(() => requestAnimationFrame(() => { track.style.scrollSnapType = ""; }));
  };
  scrollToIndex(idxOf(value));
  paint();

  let raf = null, settle = null;
  track.onscroll = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
    clearTimeout(settle);
    settle = setTimeout(() => {
      const center = Math.max(0, Math.min(options.length - 1, Math.round(track.scrollTop / ITEM_H)));
      scrollToIndex(center);
      onChange(options[center].v);
    }, 130);
  };
  items.forEach((el, i) => el.onclick = () => scrollToIndex(i));
}

