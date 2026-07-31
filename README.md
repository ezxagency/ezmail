# EZ Clock In

A static, no-build shift tracker for Ez Agency: clock in/out with per-task
segments, a live team view with task assignment, WhatsApp shift reports,
Excel exports, and a personal Pomodoro focus mode. Firebase (Auth +
Firestore) is the only backend; everything else is hand-rolled vanilla
HTML/CSS/JS served as-is (GitHub Pages).

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
  sheets.css        bottom sheet, forms, chips, assign flow
  tables.css        responsive tables, today's work, toast
  responsive.css    landscape + desktop grid + height tiers
  pomodoro.css      focus mode, the 12 theme veils, settings controls
  login.css         Shift Card login screen (legacy palette)

js/   classic scripts sharing one global scope; loaded in order
  config.js         CONFIG, Firebase init, Firestore-backed Store, state, utils
  render.js         dashboard render loop, rings, per-second tick
  ui.js             sheet + toast + chip primitives
  shift.js          clock-in/switch/pause/out flows, reports, Excel export
  nav.js            drawer, hash router, Mission + History pages
  boot.js           per-login session boot and teardown
  team.js           team page, assignment log, team pane, team Excel export
  assign.js         staged assign flow, my-tasks watcher, notifications
  auth.js           role resolution, sign-in/out wiring, login UI
  pomodoro.js       focus timer engine, Web Audio soundscapes, settings

assets/             images (marble backgrounds, logo)
design/             reference comps
```

## Conventions

- Every `css/`/`js/` reference in the HTML carries the same `?v=N`;
  bump N on any css/js change so fresh HTML never pairs with a stale cache.
- `timeclock-v2.html` is a byte-for-byte copy of `index.html` — re-copy it
  after editing (`cp index.html timeclock-v2.html`).
- No bundler, no framework, no npm: edit, refresh, push.
