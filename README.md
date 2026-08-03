# EZ Clock In

A static, no-build shift tracker for Ez Agency: clock in/out with per-task
segments, a live team view with task assignment, a campaigns baton-pass
pipeline, WhatsApp shift reports, Excel exports, email verification and
summaries, and a personal Pomodoro focus mode (plus a private Personal
task-list mode). Firebase (Auth + Firestore) is the only backend;
everything else is hand-rolled vanilla HTML/CSS/JS served as-is (GitHub
Pages).

## Layout

```
index.html          app shell: login, dashboard, drawer, feature pages
timeclock-v2.html   synced copy of index.html (keep identical)
reset-password.html standalone password-reset landing page
client-review.html  unauthenticated public page for a client to review a campaign link

css/  loaded in order; the order IS the cascade, never shuffle it
  base.css          design tokens, reset
  dashboard.css     app shell, band, rings, punch card, panes, dock
  drawer.css        hamburger + off-canvas drawer
  pages.css         buttons, full-page shells, stat tiles, history rows
  sheets.css        bottom sheet, forms, chips, assign flow
  tables.css        responsive tables, today's work, toast
  responsive.css    landscape + desktop grid + height tiers
  pomodoro.css      focus mode, the 12 theme veils, settings controls
  personal.css      Personal mode's private task list
  campaigns.css     campaigns baton-pass pipeline page + its sheets
  login.css         Shift Card login screen (legacy palette)
  premium.css       motion/gesture polish layer, loaded last on purpose

js/   classic scripts sharing one global scope; loaded in order
  config.js         CONFIG, Firebase init, Firestore-backed Store, state, utils
  render.js         dashboard render loop, rings, per-second tick
  ui.js             sheet + toast + chip primitives
  shift.js          clock-in/switch/pause/out flows, reports, Excel export
  email.js          writes to the Firestore mail collection for the Trigger Email extension
  nav.js            drawer, hash router, Mission + History pages
  boot.js           per-login session boot and teardown
  team.js           team page, assignment log, team pane, team Excel export
  assign.js         staged assign flow, my-tasks watcher, notifications
  notify.js         directory + in-app notifications, @mention autocomplete
  campaigns.js      campaigns baton-pass pipeline: stages, approvals, client links
  auth.js           role resolution, sign-in/out wiring, login UI, email verification
  personal.js       Personal mode's private per-account task list
  pomodoro.js       focus timer engine, Web Audio soundscapes, settings
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
- No bundler, no framework, no npm: edit, refresh, push.
