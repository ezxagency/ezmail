async function resolveRole(user){
  const ref = db.collection("users").doc(user.uid);
  let doc = await ref.get();
  const shouldBeAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
  if (!doc.exists) {
    // new signups wait for admin approval; designated admin emails skip it
    const role = shouldBeAdmin ? "admin" : "pending";
    await ref.set({ email: user.email, role, createdAt: Date.now() });
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
  return doc.data().role;
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
      hxTeamRows = null; teamPageDocs = null; teamPaneDocs = null;
      teamMonthSel = null; notifDir = null;
      $("bandSignOut").classList.add("hidden");
      $("adminAccessBtn").classList.add("hidden");
      $("bandAssignBtn").classList.add("hidden");
      $("cardAssignBtn").classList.add("hidden");
      $("teamPanelAssignBtn").classList.add("hidden");
      $("drawerAssign").classList.add("hidden");
      $("drawerTeam").classList.add("hidden");
      closeDrawer();
      // the next person to sign in starts on the dashboard, not wherever
      // the previous session happened to be parked
      Object.keys(PAGE_IDS).forEach(k => $(PAGE_IDS[k]).classList.add("hidden"));
      if (location.hash && location.hash !== "#/") location.replace("#/");
      $("appScreen").classList.remove("panes", "has-team", "has-tasks", "side-open");
      $("teamPanel").classList.add("hidden");
      teamPaneRows = null; teamPendingCount = 0;
      // park the departing account's focus timer and reset to neutral -
      // the next sign-in loads its own, so sessions never leak across accounts
      pomoUnload();
      return;
    }
    try {
      const role = await resolveRole(user);
      if (role === "pending") { screen("pending"); }
      else {
        isAdmin = role === "admin";
        canAssignTasks = isAdmin || ASSIGNER_EMAILS.includes((user.email || "").toLowerCase());
        $("drawerAssign").classList.toggle("hidden", !canAssignTasks);
        $("drawerTeam").classList.toggle("hidden", !isAdmin);
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
        screen("app");
        startWorkerApp();
      }
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

