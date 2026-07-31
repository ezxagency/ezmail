/* ============================================================
   SHEETS
   ============================================================ */
function openSheet(html, setup){
  $("sheetBody").innerHTML = html;
  $("scrim").classList.add("on");
  $("sheet").classList.add("on");
  if (setup) setup();
}
function closeSheet(){ $("scrim").classList.remove("on"); $("sheet").classList.remove("on"); }
$("scrim").onclick = () => {};   // gated: tapping outside never skips a required field

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

