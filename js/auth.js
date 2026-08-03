const genVerifyCode = () => String(Math.floor(100000 + Math.random() * 900000));

async function resolveRole(user){
  const ref = db.collection("users").doc(user.uid);
  let doc = await ref.get();
  const shouldBeAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
  if (!doc.exists) {
    // new signups wait for admin approval; designated admin emails skip it
    const role = shouldBeAdmin ? "admin" : "pending";
    // Google already proved they own the address; a password signup could
    // have typed anyone's email into that form, so that one earns its own
    // proof before admin approval even gets a look at it
    const isPasswordAcct = user.providerData.some(p => p.providerId === "password");
    const base = { email: user.email, role, createdAt: Date.now(), emailVerified: !isPasswordAcct };
    if (isPasswordAcct){
      base.verifyCode = genVerifyCode();
      base.verifyCodeAt = Date.now();
    }
    await ref.set(base);
    if (isPasswordAcct) queueVerifyCodeEmail(user.email, base.verifyCode).catch(e => console.error(e));
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
  canAssignTasks = isAdmin || ASSIGNER_EMAILS.includes((user.email || "").toLowerCase());
  $("drawerAssign").classList.toggle("hidden", !canAssignTasks);
  $("drawerTeam").classList.toggle("hidden", !isAdmin);
  $("drawerSummary").classList.toggle("hidden", !isAdmin);
  $("adminAccessBtn").classList.toggle("hidden", !isAdmin);
  // quick-assign icons follow the same permission as the Assign page
  $("bandAssignBtn").classList.toggle("hidden", !canAssignTasks);
  $("cardAssignBtn").classList.toggle("hidden", !canAssignTasks);
  $("teamPanelAssignBtn").classList.toggle("hidden", !canAssignTasks);
  // everyone on desktop gets the two-pane shell; the role only decides
  // what the third column holds
  $("appScreen").classList.add("panes");
  $("appScreen").classList.toggle("has-team", isAdmin);
  $("teamPanel").classList.toggle("hidden", !isAdmin);
  if (isAdmin) { watchCompletionNotifications(); loadTeamPane(); }
  Store.setUser(user.uid, user.email);
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
        if (d.role === "pending") screen("pending");
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
      assignLogRows = null; assignLogBox = null;
      hxTeamRows = null; teamPageDocs = null;
      teamMonthSel = null; notifDir = null;
      $("bandSignOut").classList.add("hidden");
      $("adminAccessBtn").classList.add("hidden");
      $("bandAssignBtn").classList.add("hidden");
      $("cardAssignBtn").classList.add("hidden");
      $("teamPanelAssignBtn").classList.add("hidden");
      $("drawerAssign").classList.add("hidden");
      $("drawerTeam").classList.add("hidden");
      $("drawerSummary").classList.add("hidden");
      closeDrawer();
      // a sheet open at forced sign-out (token revoked, account disabled)
      // would otherwise float the old account's data over the login screen
      sheetDismissible = true;
      closeSheet();
      // the next person to sign in starts on the dashboard, not wherever
      // the previous session happened to be parked
      Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.add("hidden"));
      if (location.hash && location.hash !== "#/") location.replace("#/");
      $("appScreen").classList.remove("panes", "has-team", "has-tasks", "side-open");
      $("teamPanel").classList.add("hidden");
      teamPaneRows = null; teamPendingCount = 0;
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
      $("loginErr").textContent = "Signed in, but couldn't load your account. Check Firestore rules.";
      $("loginErr").classList.remove("hidden");
    }
  });

  let loginMode = "signin";
  function setLoginMode(mode){
    loginMode = mode;
    const isSignup = mode === "signup";
    $("confirmWrap").classList.toggle("hidden", !isSignup);
    $("loginBtnText").textContent = isSignup ? "Create account" : "Sign in";
    $("loginHint").textContent = isSignup ? "Set up your login — you'll use this every time." : "Sign in to clock in and out.";
    $("switchHint").textContent = isSignup ? "Already have an account?" : "New here?";
    $("modeToggle").textContent = isSignup ? "Sign in" : "Create an account";
    $("loginErr").classList.add("hidden");
  }
  $("modeToggle").onclick = () => setLoginMode(loginMode === "signin" ? "signup" : "signin");

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
        if (pass.length < 6) throw new Error("Password must be at least 6 characters.");
        if (pass !== $("loginPass2").value) throw new Error("Passwords don't match.");
        await auth.createUserWithEmailAndPassword(email, pass);
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

