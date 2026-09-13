# EZ Clock In

A static, no-build shift tracker for Ez Agency: clock in/out with per-task
segments, a live team view with task assignment, WhatsApp shift reports, Excel exports, email verification and
summaries, and a personal Pomodoro focus mode (plus a private Personal
task-list mode). Firebase (Auth + Firestore) is the only backend;
everything else is hand-rolled vanilla HTML/CSS/JS served as-is (GitHub
Pages).

## Layout

```
index.html          app shell: login, dashboard, drawer, feature pages
timeclock-v2.html   synced copy of index.html (keep identical)
reset-password.html standalone password-reset landing page

css/  loaded in order; the order IS the cascade, never shuffle it
  base.css          design tokens, reset
  dashboard.css     app shell, band, rings, punch card, panes, dock
  drawer.css        hamburger + off-canvas drawer
  pages.css         buttons, full-page shells, stat tiles, history rows
  sheets.css        bottom sheet, forms, chips, shared dropdown primitives
  assign.css        the assign composer (command bar + sentence) + its launchers
  tables.css        responsive tables, today's work, toast
  responsive.css    landscape + desktop grid + height tiers
  pomodoro.css      focus mode, the 12 theme veils, settings controls
  personal.css      Personal mode's private task list
  org.css           the Organization page: roster rows + the permission grid
  work.css          the Work page: type tabs, status controls, generated form
  scrubber.css      the shift bar under the clocks (redesign)
  deck.css          the assigned deck, one card at a time (redesign)
  week.css          this week's hours and streak under the wordmark (redesign)
  rail.css          the left icon rail that replaces the hamburger (redesign)
  hero.css          "pick up where you left off" chips (redesign)
  started.css       the started stack's landscape cards (redesign)
  v6.css            the redesign's ground and layout, all under body.ui-next
  ios.css           the iOS layer over the redesign: glass, tints, motion, shape
  admin.css         Admin mode: the Admin/Me switch in the rail and the admin home
  login.css         Shift Card login screen (legacy palette)
  premium.css       motion/gesture polish layer, loaded last on purpose

js/   classic scripts sharing one global scope; loaded in order
  config.js         CONFIG, Firebase init, Firestore-backed Store, state, utils
  clock.js          the segment arithmetic (task time by itemId) - pure
  permissions.js    resource:action:scope grammar - pure, no DOM, no Firestore
  item-engine.js    the universal work object: types, values, facets, commit()
  items.js          its Firestore glue - deliberately dumb, decides nothing
  migrate.js        the shapes assignments (and old campaigns) take as Items (pure)
  automation.js     trigger/condition/action over the event log (pure)
  packs.js          an industry as data: 8 starter packs + their validator (pure)
  handoff.js        a linear track compiled to a real blueprint (pure)
  flow.js           the Flow builder page: one kind of work as one picture
  rating.js         reviews: the math (integer tenths), the rubric, what a review is, the board (pure)
  reviews.js        submit / decide / resubmit (transactions), the sheets, the Reviews page, the watch
  work.js           the Work page: every control generated from the ItemType
  org.js            the Organization page: tenancy, the roster, the roles editor
  render.js         dashboard render loop, rings, per-second tick
  scrubber.js       the shift bar: sbPlan() pure, sbRender() draws it
  deck.js           the assigned deck: dkPick() pure, the stack and its physics
  week.js           this week's hours, seven day bars, the streak (from S.history)
  hero.js           the last real work this person did, as chips
  started.js        this shift's started tasks as landscape cards: stPlan() pure, the stack scrolls
  admin.js          Admin mode: who gets the switch, what each view holds, the admin home
  rail.js           the icon rail, built from the drawer's own items
  ui.js             sheet + toast + chip primitives
  shift.js          clock-in/switch/pause/out flows, reports, Excel export
  email.js          writes to the Firestore mail collection for the Trigger Email extension
  nav.js            drawer, hash router, Mission + History pages
  boot.js           per-login session boot and teardown
  team.js           team page, assignment log, team pane, team Excel export
  assign.js         the assign composer, my-tasks watcher, notifications
  notify.js         directory + in-app notifications, @mention autocomplete
  auth.js           role resolution, sign-in/out wiring, login UI, email verification
  personal.js       Personal mode's private per-account task list
  pomodoro.js       focus timer engine, Web Audio soundscapes, settings
  workflow-engine.js the blueprint/run engine - pure, shared with handoff tracks
  premium.js        tab-swipe, sheet drag-to-close, swipe-to-delete, haptics

assets/             images (marble backgrounds, logo)
design/             reference comps
```

## Email summaries (one-time setup)

"Email my summary" builds the HTML in the browser and sends it through
**EmailJS** — free tier (200 emails/month), no credit card, made for
static sites. Setup (~10 minutes):

1. Create a free account at emailjs.com.
2. **Email Services → Add New Service → Gmail** (sign in with the agency
   Gmail). Note the **Service ID**.
3. **Email Templates → Create New Template**. Set:
   - *To Email*: `{{to_email}}`
   - *Subject*: `{{subject}}`
   - *Content*: switch the editor to code view and put exactly `{{{content}}}`
     (three braces — that passes the app's HTML through unescaped).
   Save and note the **Template ID**.
4. **Account → General**: copy the **Public Key**. Then under
   **Account → Security**, restrict usage to your domain so nobody else
   can spend your quota (the public key is meant to be visible in code).
5. Paste all three into `CONFIG.emailjs` at the top of `js/config.js`,
   bump the `?v=` in both HTML files, push.

Fallback: if `CONFIG.emailjs` is left empty, the app instead writes to the
Firestore `mail` collection for the **Trigger Email** extension (requires
the Blaze plan; rules for it are in `firestore.rules`). Until either route
is configured, requests fail with an honest toast.

Roles: employees can only email their own summary to their own address;
admins can additionally email any member's summary (to the member or to
themselves) from the Team page, and keep the raw Excel exports.

## Conventions

- Every `css/`/`js/` reference in the HTML carries the same `?v=N`;
  bump N on any css/js change so fresh HTML never pairs with a stale cache.
- `timeclock-v2.html` is a byte-for-byte copy of `index.html` — re-copy it
  after editing (`cp index.html timeclock-v2.html`).
- `ADMIN_EMAILS`/`ASSIGNER_EMAILS` in `js/config.js` must match
  `isDesignatedAdminEmail()`/`isAssignerEmail()` in `firestore.rules` —
  the first gates the buttons, the second gates the database.
- No bundler, no framework, no npm: edit, refresh, push.

All four are enforced by `tests/repo-guards.test.mjs`, so CI catches a
slip before it ships rather than after.

## Tests

```
cd tests
npm ci               # once
npm test             # 643 assertions, node + jsdom, seconds
npm run test:rules   # 304 rules assertions (needs Java + firebase-tools)
npm run test:all     # both
```

CI runs all of it on every push (`.github/workflows/ci.yml`).

## Deploying

The app itself needs no deploy step — GitHub Pages serves the repo, so a
push to `main` is the release.

Firestore **rules and indexes** deploy themselves:
`.github/workflows/deploy-rules.yml` ships them on any push to `main` that
touches `firestore.rules` or `firestore.indexes.json`, and only after the
304-assertion suite passes against the edited rules. It needs a
`FIREBASE_SERVICE_ACCOUNT` secret (Settings → Secrets and variables →
Actions); without it the workflow verifies the rules and skips the deploy
with a warning instead of failing.

Don't paste rules into the Firebase console by hand — the console and the
repo drift the moment you do, and the repo is the copy that gets tested.
