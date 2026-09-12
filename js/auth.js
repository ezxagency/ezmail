const genVerifyCode = () => String(Math.floor(100000 + Math.random() * 900000));

/* ---------- invite-only signup ----------
   The token rides the link (?invite=...) and localStorage, so a refresh
   mid-signup doesn't lose it. firestore.rules enforces the gate for
   real: a pending users doc can only be created naming a live, unused
   invite - without the link, an auth login can exist but can never
   become a member. */
let inviteToken = null;
try {
  const q = new URLSearchParams(location.search).get("invite");
  if (q){ inviteToken = q; localStorage.setItem("ez-invite", q); }
  else inviteToken = localStorage.getItem("ez-invite") || null;
} catch (e) {}
let signupInfo = { name: "", phone: "" };   // typed on the signup form, read at doc-create

function notifyAdminsNewSignup(name, email){
  db.collection("notifications").add({
    toRole: "admin", kind: "signup", read: false, createdAt: Date.now(),
    msg: (name || email || "Someone") + " verified their email — approve them in Team (role, schedule, pay)"
  }).catch(e => console.error(e));
}

async function resolveRole(user){
  const ref = db.collection("users").doc(user.uid);
  let doc = await ref.get();
  const shouldBeAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
  if (!doc.exists) {
    /* WHICH DOOR did they come through? The link decides, and it has to be
       read before anything is written, because it picks which of two
       different accounts this is:

         team    -> a pending Ez Agency hire, waiting on approval (as ever)
         founder -> a member: somebody who runs their OWN organization here,
                    approves with nobody, and lands on creating it

       A member is deliberately not a "worker". isTeam() in firestore.rules
       guards Ez Agency's own pre-tenancy data - blueprints, runs, client
       reviews - none of which is org-scoped, so a customer counted as team
       would be reading another company's work. Their access is their org
       membership and nothing besides. */
    let linkKind = "team";
    if (!shouldBeAdmin && inviteToken) {
      try {
        const inv = await db.collection("invites").doc(inviteToken).get();
        if (inv.exists) linkKind = (inv.data() || {}).kind || "team";
      } catch (e) { console.error(e); }   // unreadable link: treat as an ordinary one
    }
    const role = shouldBeAdmin ? "admin" : (linkKind === "founder" ? "member" : "pending");
    const invited = role === "pending" || role === "member";
    // fail with words, not a permission error - the rules would refuse
    // an inviteless create anyway
    if (invited && !inviteToken) throw new Error("INVITE_REQUIRED");
    // Google already proved they own the address; a password signup could
    // have typed anyone's email into that form, so that one earns its own
    // proof before admin approval even gets a look at it
    const isPasswordAcct = user.providerData.some(p => p.providerId === "password");
    const base = { email: user.email, role, createdAt: Date.now(), emailVerified: !isPasswordAcct };
    if (invited){
      base.invite = inviteToken;
      base.name = signupInfo.name || user.displayName || "";
      base.phone = signupInfo.phone || "";
    }
    if (isPasswordAcct){
      base.verifyCode = genVerifyCode();
      base.verifyCodeAt = Date.now();
    }
    try {
      await ref.set(base);
    } catch (err) {
      // the one way this create fails with rules deployed: the invite was
      // already burned or revoked
      throw new Error(err && err.code === "permission-denied" ? "INVITE_USED" : (err && err.message) || "create-failed");
    }
    if (invited){
      // one link, one account: burn the invite and forget the token
      db.collection("invites").doc(base.invite).update({
        usedBy: user.uid, usedAt: Date.now(),
        usedEmail: user.email || "", usedName: base.name || ""
      }).catch(e => console.error(e));
      try { localStorage.removeItem("ez-invite"); } catch (e) {}
      inviteToken = null;
      // Google accounts skip the verify screen, so their "new member" bell
      // rings now; password accounts ring it after the code checks out.
      // Only a pending hire needs approving, so only that rings it - a
      // founder is nobody here's to approve.
      if (!isPasswordAcct && role === "pending") notifyAdminsNewSignup(base.name, user.email);
    }
    // queueAppEmail never throws - it answers { ok } - so a .catch here
    // caught nothing and a failed first send landed the person on "enter
    // the code from your email" with no email and no message
    if (isPasswordAcct) queueVerifyCodeEmail(user.email, base.verifyCode)
      .then(ok => { if (!ok) toast("Couldn't send the code — tap Resend"); });
    doc = await ref.get();
  } else if (shouldBeAdmin && doc.data().role !== "admin") {
    // an existing account whose email was just added to ADMIN_EMAILS -
    // upgrade it on this login instead of requiring a manual DB edit
    await ref.update({ role: "admin" });
    doc = await ref.get();
  } else if (!shouldBeAdmin && doc.data().role === "admin") {
    // the mirror case: email was removed from ADMIN_EMAILS - drop back
    // to a regular worker, not pending (they were already approved)
    await ref.update({ role: "worker" });
    doc = await ref.get();
  }
  return doc.data();
}

/* Past the pending/verify gates: the real app shell, same for a returning
   worker/admin and a just-verified fresh one. Split out so both paths land
   here instead of duplicating the setup. */
function enterFullApp(user, role){
  isAdmin = role === "admin";
  isMember = role === "member";
  canAssignTasks = isAdmin || ASSIGNER_EMAILS.includes((user.email || "").toLowerCase());
  // everyone on desktop gets the two-pane shell; the role only decides
  // what the third column holds
  $("appScreen").classList.add("panes");
  if (isAdmin) { watchCompletionNotifications(); loadTeamPane(); }
  Store.setUser(user.uid, user.email);
  /* What the screen holds - which drawer items, which launchers, which
     third column, and on the new dashboard which of the two VIEWS - is
     decided in one place, js/admin.js. Organization belongs to whoever
     has one to run (the Ez Agency admin, and every member), NOT to
     ADMIN_EMAILS: that list means "works for the company that runs this
     platform", a different thing from "owns this organization", and
     conflating the two once left a customer unable to reach the page that
     manages their own org. amApply() keeps that rule. */
  amApply();
  pomoLoadFor(user.uid);   // this account's own focus timer, no one else's
  ptLoadFor(user.uid);     // ...and their own personal task list
  screen("app");
  startWorkerApp();
}

/* The gate between "account created" and "waiting on admin approval": a
   6-digit code was emailed at signup, and it has to come back correct
   before the pending screen (or, for a designated admin email, the app
   itself) ever shows. Resend regenerates and re-sends; signing out lets
   someone bail and try a different email address entirely. */
const VERIFY_EXPIRY_MS = 15 * 60000;
let verifyResendAt = 0;
let verifyResendUid = null;   // whose timestamp verifyResendAt is
function openVerifyScreen(user, info){
  // a different account on this device starts with a clean throttle -
  // otherwise account B's resend could be blocked by account A's timer
  if (verifyResendUid !== user.uid){ verifyResendAt = 0; verifyResendUid = user.uid; }
  screen("verify");
  $("verifyEmail").textContent = user.email;
  $("verifyErr").classList.add("hidden");
  $("verifyCodeInput").value = "";
  $("verifyCodeInput").focus();

  const showErr = msg => { $("verifyErr").textContent = msg; $("verifyErr").classList.remove("hidden"); };

  $("verifyForm").onsubmit = async (e) => {
    e.preventDefault();
    const val = $("verifyCodeInput").value.trim();
    $("verifyErr").classList.add("hidden");
    if (!/^\d{6}$/.test(val)) { showErr("Enter the 6-digit code from your email."); return; }
    const btn = $("verifySubmit");
    btn.disabled = true;
    try {
      const ref = db.collection("users").doc(user.uid);
      const d = (await ref.get()).data();
      if (!d.verifyCode || !d.verifyCodeAt || Date.now() - d.verifyCodeAt > VERIFY_EXPIRY_MS) {
        showErr("That code expired — send a new one.");
      } else if (val !== d.verifyCode) {
        showErr("That code doesn't match — check your email and try again.");
      } else {
        await ref.update({ emailVerified: true });
        toast("Email verified");
        if (d.role === "pending"){
          // the proof is in: NOW the admin's bell rings about a real person
          notifyAdminsNewSignup(d.name || "", user.email);
          screen("pending");
        }
        else enterFullApp(user, d.role);
        return;
      }
    } catch (e2) {
      console.error(e2);
      showErr("Couldn't check that code — try again.");
    } finally {
      btn.disabled = false;
    }
  };

  $("verifyResend").onclick = async () => {
    const now = Date.now();
    if (now - verifyResendAt < 30000) { toast("Wait a few seconds before resending"); return; }
    verifyResendAt = now;
    const code = genVerifyCode();
    try {
      await db.collection("users").doc(user.uid).update({ verifyCode: code, verifyCodeAt: Date.now() });
      const ok = await queueVerifyCodeEmail(user.email, code);
      toast(ok ? "Code resent to " + user.email : "Couldn't send the email — check the mail extension setup");
    } catch (e2) {
      console.error(e2);
      toast("Couldn't resend — try again");
    }
  };

  $("verifySignOut").onclick = () => auth.signOut();
}

if (!FB_READY){
  screen("login");
  $("loginErr").textContent = "Firebase isn't configured yet — paste your project's config into firebaseConfig near the top of the script.";
  $("loginErr").classList.remove("hidden");
  $("loginBtn").disabled = true;
} else {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      endSession();
      screen("login");
      workerStarted = false;
      isAdmin = false;
      canAssignTasks = false;
      S = { worker:"", status:"IDLE", shift:null, history:[], lastReport:null };
      // drop the signed-out uid too, so a stray save() can never write the
      // blank state above over the previous user's stored shift history
      Store.setUser(null, null);
      isMember = false;
      assignRows = null; assignLogBox = null;
      teamHistoryRows = null; teamPageDocs = null;
      notifDir = null;
      // the org, its roles and the caches built from it belong to the
      // account that just left. Kept, the next sign-in on this device
      // answered "which org, which role" with the previous person's -
      // and the client's permission grants with it
      orgInvalidate(); orgWhyNone = null;
      itemsTaskTypeCache = null; itemsAutomationsCache = null;
      wkTypes = null; wkRows = []; wkOrphans = [];
      $("bandSignOut").classList.add("hidden");
      $("adminAccessBtn").classList.add("hidden");
      $("assignLaunch").classList.add("hidden");
      $("cardAssignBtn").classList.add("hidden");
      $("teamPanelAssignBtn").classList.add("hidden");
      $("drawerTeam").classList.add("hidden");
      $("drawerOrg").classList.add("hidden");
      $("drawerHistory").classList.remove("hidden");   // visible-by-default; only admin hides it
      closeDrawer();
      // a sheet open at forced sign-out (token revoked, account disabled)
      // would otherwise float the old account's data over the login screen
      sheetDismissible = true;
      closeSheet();
      closeComposer();
      // the next person to sign in starts on the dashboard, not wherever
      // the previous session happened to be parked
      Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.add("hidden"));
      if (location.hash && location.hash !== "#/") location.replace("#/");
      $("appScreen").classList.remove("panes", "has-team", "has-tasks", "side-open");
      $("teamPanel").classList.add("hidden");
      amReset();
      teamPendingCount = 0;
      // park the departing account's focus timer and personal list, and
      // reset to neutral - the next sign-in loads its own, so nothing
      // leaks across accounts sharing this device. ptUnload FIRST: it
      // clears ptUid, so pomoUnload's reset to the clocks tab can't
      // overwrite this account's remembered tab choice
      ptUnload();
      pomoUnload();
      return;
    }
    try {
      const info = await resolveRole(user);
      // a fresh password signup that hasn't entered its emailed code yet -
      // strictly false, so grandfathered accounts (the field never existed)
      // sail straight past this and Google accounts (already true) do too
      if (info.emailVerified === false) { openVerifyScreen(user, info); }
      else if (info.role === "pending") { screen("pending"); }
      else { enterFullApp(user, info.role); }
    } catch (e) {
      console.error(e);
      const m = String((e && e.message) || "");
      if (m === "INVITE_REQUIRED" || m === "INVITE_USED"){
        // the auth login exists but membership was refused - sign it out so
        // they can come back through a working link and try again
        await auth.signOut().catch(() => {});
        $("loginErr").textContent = m === "INVITE_REQUIRED"
          ? "Creating an account needs an invite link — open the one your admin sent you, then sign in again from it."
          : "That invite link was already used, revoked, or expired (links last 24 hours) — ask your admin for a fresh one, then sign in again from it.";
        $("loginErr").classList.remove("hidden");
        return;
      }
      $("loginErr").textContent = "Signed in, but couldn't load your account. Check Firestore rules.";
      $("loginErr").classList.remove("hidden");
    }
  });

  let loginMode = "signin";
  function setLoginMode(mode){
    loginMode = mode;
    const isSignup = mode === "signup";
    $("confirmWrap").classList.toggle("hidden", !isSignup);
    $("signupNameWrap").classList.toggle("hidden", !isSignup);
    $("signupPhoneWrap").classList.toggle("hidden", !isSignup);
    $("loginBtnText").textContent = isSignup ? "Create account" : "Sign in";
    $("loginHint").textContent = isSignup
      ? (inviteToken ? "You're invited — set up your login." : "Creating an account needs an invite link from your admin.")
      : "Sign in to clock in and out.";
    $("switchHint").textContent = isSignup ? "Already have an account?" : "New here?";
    $("modeToggle").textContent = isSignup ? "Sign in" : "Create an account";
    $("loginErr").classList.add("hidden");
  }
  $("modeToggle").onclick = () => setLoginMode(loginMode === "signin" ? "signup" : "signin");
  // arriving through an invite link lands straight on the signup form
  if (inviteToken) setLoginMode("signup");

  const AUTH_ERRORS = {
    "auth/email-already-in-use": "That email already has an account — sign in instead.",
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Wrong password.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/quota-exceeded": "Too many emails sent today — try again tomorrow, or ask your admin to check the Firebase project's email quota.",
    "auth/too-many-requests": "Too many attempts — wait a bit before trying again."
  };
  const persistence = () => $("keepSignedIn").checked
    ? firebase.auth.Auth.Persistence.LOCAL
    : firebase.auth.Auth.Persistence.SESSION;

  async function doLogin(){
    const email = $("loginEmail").value.trim();
    const pass = $("loginPass").value;
    $("loginErr").classList.add("hidden");
    if (!email || !pass) return;
    try {
      await auth.setPersistence(persistence());
      if (loginMode === "signup") {
        if (!inviteToken) throw new Error("Creating an account needs an invite link — open the one your admin sent you.");
        const nm = $("signupName").value.trim();
        if (!nm) throw new Error("Enter your name.");
        if (pass.length < 6) throw new Error("Password must be at least 6 characters.");
        if (pass !== $("loginPass2").value) throw new Error("Passwords don't match.");
        signupInfo = { name: nm, phone: $("signupPhone").value.trim() };
        try {
          await auth.createUserWithEmailAndPassword(email, pass);
        } catch (err) {
          // the half-made-account trap: an earlier attempt created the
          // LOGIN but membership never followed (no invite, rules not yet
          // deployed...). If the password matches, signing in finishes
          // what signup started - resolveRole builds the membership with
          // the invite riding this page. A wrong password surfaces as its
          // own error, same as a plain sign-in.
          if (err && err.code === "auth/email-already-in-use"){
            try {
              await auth.signInWithEmailAndPassword(email, pass);
            } catch (err2) {
              // the login from that earlier attempt has a DIFFERENT
              // password - "wrong email or password" in a signup form
              // reads as nonsense, so say what actually happened
              if (err2 && (err2.code === "auth/wrong-password" || err2.code === "auth/invalid-credential"))
                throw new Error("This email started an account before and has a password from that attempt — type that first password, or tap Forgot? to reset it, then create the account again from this link.");
              throw err2;
            }
          } else {
            throw err;
          }
        }
      } else {
        await auth.signInWithEmailAndPassword(email, pass);
      }
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Something went wrong — try again.";
      $("loginErr").classList.remove("hidden");
    }
  }
  $("loginBtn").onclick = doLogin;
  $("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  $("googleSignIn").onclick = async () => {
    $("loginErr").classList.add("hidden");
    try {
      await auth.setPersistence(persistence());
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Google sign-in failed — try again.";
      $("loginErr").classList.remove("hidden");
    }
  };

  $("forgotPassword").onclick = async () => {
    const email = $("loginEmail").value.trim();
    $("loginErr").classList.add("hidden");
    if (!email) {
      $("loginErr").textContent = "Enter your email above first, then tap Forgot password.";
      $("loginErr").classList.remove("hidden");
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      toast("Password reset email sent");
    } catch (e) {
      $("loginErr").textContent = AUTH_ERRORS[e.code] || e.message || "Couldn't send reset email — try again.";
      $("loginErr").classList.remove("hidden");
    }
  };
  $("pendingSignOut").onclick = () => auth.signOut();
}

