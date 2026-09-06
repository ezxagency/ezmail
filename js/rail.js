/* ============================================================
   THE LEFT RAIL — the icon nav that replaces the hamburger.

   It does NOT keep its own list of pages. It is built from the
   drawer's own items, and re-read from them every time the route
   or the identity changes, so "which pages does this person get"
   is answered in exactly one place: the role gating in
   js/auth.js, which already toggles .hidden on those items.
   A second list here would be a second gate, and two gates that
   disagree is the failure this codebase keeps paying for.

   That is also the answer to the six-icon comp: the rail carries
   whatever the drawer carries. Work is staff-visible today, so it
   gets a seat rather than quietly becoming unreachable, and
   Organization appears for the people who already had it.
   ============================================================ */

/* The comp's rail is capitals, and a nav label has to survive a 116px
   column. "Daily Mission" does not; "Mission" does. Anything not named
   here falls back to the first word of the drawer's own label, so a page
   added later appears in the rail without being registered twice. */
const RL_LABELS = {
  "": "Home", mission: "Mission", history: "History", campaigns: "Links",
  team: "Team", workflow: "Flows", work: "Work", org: "Org"
};

const RL_OUT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>';

let rlShelled = false, rlBuilt = false;

function rlLabelFor(a){
  const route = a.dataset.route || "";
  if (RL_LABELS[route]) return RL_LABELS[route];
  const txt = a.querySelector(".drawer-txt");
  const first = txt ? (txt.childNodes[0].textContent || "").trim() : route;
  return first.split(" ")[0] || "Page";
}

/* The rail's own furniture: the badge, the empty items column, and the
   avatar and sign-out pinned to the bottom. Built once. */
function rlShell(){
  const rail = $("rail");
  if (!rail || rlShelled) return;
  rlShelled = true;
  rail.innerHTML =
    '<a class="rail-badge" href="#/" aria-label="Dashboard"><span>EZ</span></a>'
    + '<nav class="rail-items" aria-label="Pages"></nav>'
    + '<div class="rail-foot">'
    +   '<button type="button" class="rail-av" id="railAvatar" aria-label="Profile">·</button>'
    +   '<button type="button" class="rail-out" id="railSignOut" aria-label="Sign out" title="Sign out">'
    +     RL_OUT_SVG + '</button>'
    + '</div>';
  $("railAvatar").onclick = () => { if (typeof showProfile === "function") showProfile(); };
  $("railSignOut").onclick = () => { if (auth) auth.signOut(); };
}

function rlBuild(){
  const rail = $("rail");
  if (!rail || rlBuilt) return;
  const items = [...document.querySelectorAll(".drawer-item")];
  if (!items.length) return;
  rail.querySelector(".rail-items").innerHTML = items.map(a => {
    const route = a.dataset.route || "";
    const ico = a.querySelector(".drawer-ico");
    return '<a class="rail-item" href="' + esc(a.getAttribute("href")) + '"'
      + ' data-route="' + esc(route) + '">'
      + '<i class="rail-mark" aria-hidden="true"></i>'
      + '<span class="rail-ico">' + (ico ? ico.innerHTML : "") + '</span>'
      + '<span class="rail-txt">' + esc(rlLabelFor(a)) + '</span>'
      + '</a>';
  }).join("");
  rlBuilt = true;
}

/* Re-read, never re-decide. Everything below copies state that something
   else already owns: .hidden from the role gating, .active from
   applyRoute(), the avatar from updateDrawerIdentity(). */
function rlSync(){
  const rail = $("rail");
  if (!rail) return;
  rlShell();
  rlBuild();
  document.querySelectorAll(".drawer-item").forEach(a => {
    const mine = rail.querySelector('.rail-item[data-route="' + (a.dataset.route || "") + '"]');
    if (!mine) return;
    mine.classList.toggle("hidden", a.classList.contains("hidden"));
    mine.classList.toggle("is-on", a.classList.contains("active"));
  });
  const src = $("drawerAvatar"), av = $("railAvatar");
  if (src && av){
    av.classList.toggle("has-photo", src.classList.contains("has-photo"));
    av.style.backgroundImage = src.style.backgroundImage;
    av.textContent = src.textContent;
    av.title = ($("drawerName") ? $("drawerName").textContent : "") || "Profile";
  }
}
