/* ============================================================
   PREMIUM GESTURES
   The physical layer premium.css dresses: tab swiping, a bottom sheet
   you can actually pull closed by its handle, swipe-to-delete on
   personal tasks, and a whisper of haptics where a thing commits.
   Everything is touch-gated (pointerType) so the mouse keeps its own
   manners, and everything degrades to the existing taps and buttons.
   ============================================================ */

// one short pulse when something COMMITS (tab change, delete, dismiss) -
// never on mere movement. Silently a no-op where unsupported (iOS, desktop).
function buzz(ms){ try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

/* ---------- swipe between Clocks / Focus / Personal ----------
   The clock zone is the tab strip's body; a horizontal flick anywhere on
   it moves one tab in that direction. Horizontal dominance is required
   (1.5x) so normal page scrolling never changes tabs by accident. */
(function premiumTabSwipe(){
  const zone = document.querySelector(".clock");
  if (!zone) return;
  const ORDER = ["clocks", "focus", "personal"];
  const current = () =>
    $("modePersonal") && $("modePersonal").classList.contains("is-on") ? "personal"
    : $("modeFocus").classList.contains("is-on") ? "focus" : "clocks";
  let sx = 0, sy = 0, live = false;
  zone.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    live = true; sx = e.clientX; sy = e.clientY;
  });
  zone.addEventListener("pointerup", e => {
    if (!live) return;
    live = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) < 56 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    const next = ORDER[ORDER.indexOf(current()) + (dx < 0 ? 1 : -1)];
    if (next){ buzz(10); setAppMode(next); }
  });
  zone.addEventListener("pointercancel", () => { live = false; });
})();

/* ---------- the sheet's grab handle drags for real ----------
   Pull past the threshold and let go: the sheet leaves from wherever
   your finger left it. Short pulls spring back. A must-answer sheet
   (dismissible:false) rides along but always springs back. */
(function premiumSheetDrag(){
  const sheet = $("sheet");
  const grab = sheet && sheet.querySelector(".grab");
  if (!grab) return;
  let sy = 0, dy = 0, live = false;
  grab.addEventListener("pointerdown", e => {
    live = true; sy = e.clientY; dy = 0;
    sheet.classList.add("is-dragging");
    try { grab.setPointerCapture(e.pointerId); } catch (err) {}
  });
  grab.addEventListener("pointermove", e => {
    if (!live) return;
    dy = Math.max(0, e.clientY - sy);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!live) return;
    live = false;
    sheet.classList.remove("is-dragging");
    if (dy > 110 && sheetDismissible){
      buzz(8);
      // clear the inline transform in the same frame .on drops, so the
      // slide-out transition starts from the finger's last position
      requestAnimationFrame(() => { sheet.style.transform = ""; closeSheet(); });
    } else {
      sheet.style.transform = "";   // spring back via the class transition
    }
  };
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
})();

/* ---------- swipe a personal task away ----------
   The row follows the finger once the gesture reads as horizontal;
   past the threshold it flies off and deletes (same animated exit the
   x button uses), short drags snap back. Buttons inside the row keep
   their own taps - a swipe starting on one is ignored. */
(function premiumTaskSwipe(){
  const list = $("ptList");
  if (!list) return;
  let row = null, sx = 0, sy = 0, dx = 0, engaged = false, pid = null;
  list.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    const r = e.target.closest(".pt-row");
    if (!r || r.classList.contains("is-leaving") || e.target.closest("button")) return;
    row = r; sx = e.clientX; sy = e.clientY; dx = 0; engaged = false; pid = e.pointerId;
  });
  list.addEventListener("pointermove", e => {
    if (!row || e.pointerId !== pid) return;
    dx = e.clientX - sx;
    const dyv = e.clientY - sy;
    if (!engaged){
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dyv)){
        engaged = true;
        row.classList.add("is-swiping");
        try { list.setPointerCapture(pid); } catch (err) {}
      } else if (Math.abs(dyv) > 12){ row = null; return; }   // it's a scroll
    }
    if (engaged) row.style.transform = `translateX(${dx}px)`;
  });
  const end = e => {
    if (!row || e.pointerId !== pid) return;
    const r = row; row = null;
    r.classList.remove("is-swiping");
    r.style.transform = "";
    if (engaged && Math.abs(dx) > 88){
      buzz(12);
      ptRemoveAnimated(r, dx < 0 ? "fly-left" : "fly-right");
    }
  };
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
})();
