# EZ Clock In — working notes

A static, no-build shift tracker for Ez Agency, served as-is from GitHub
Pages at `ezclockn.com`. Firebase (Auth + Firestore) is the only backend.
Read `README.md` for the feature tour and the file-by-file map; this file
is the stuff that bites you if you don't know it.

## Hard rules

These are enforced by `tests/repo-guards.test.mjs` — CI fails if you break
one, so you don't have to remember them.

1. **`timeclock-v2.html` is a byte-for-byte copy of `index.html`.** After
   editing the HTML: `cp index.html timeclock-v2.html`. Two files, one app.
2. **Every local `css/`/`js/` reference carries the same `?v=N`.** Bump N
   on *any* css/js change. A missed bump serves fresh HTML with stale
   cached JS — the exact bug the convention exists to prevent.
3. **`ADMIN_EMAILS` / `ASSIGNER_EMAILS` in `js/config.js` must match
   `isDesignatedAdminEmail()` / `isAssignerEmail()` in `firestore.rules`.**
   See "Two gates" below for why this one matters most.
4. **No bundler, no framework, no npm at runtime.** Edit, refresh, push.
   `tests/` and `functions/` are the only places with dependencies, and
   `functions/` is server code that never ships to a browser.
5. **`functions/shared/*.js` are byte-for-byte copies of `js/*.js`.**
   Cloud Functions deploys only its own directory, so the pure engine is
   copied in beside it. After editing either: `cp js/<f> functions/shared/`.
   A drifted copy means the client and the server enforce different
   rules — and the client is the one you can see.

## Two gates, one truth

Authorization is enforced twice, and the two halves are separate files:

- `js/config.js` gates the **UI** — which buttons render.
- `firestore.rules` gates the **database** — what the server will accept.

Hiding a button is not security. If you remove someone's access, change
both, or they keep full access to anything they can reach with a direct
Firestore call. Guard 3 above fails the build if the two lists disagree.

**`ADMIN_EMAILS` is not "owns this organization".** It means "works for
the company that runs this platform" — a different thing, and conflating
them is what once left a customer unable to reach the page managing their
own org. Ownership is an org role (`orgIsOwner()`), which is data. The
email list stays for Ez Agency's own legacy pages and nothing else.

## Three roles, two doors

`users/{uid}.role` is about **Ez Agency's own team**, and it decides which
door a signup came through:

- `admin` / `worker` — Ez Agency staff. `isTeam()` in the rules, which
  guards the pre-tenancy data: blueprints, runs, nodeRuns, clientReviews.
- `member` — a customer running their own organization here. Deliberately
  **not** in `isTeam()`: none of that legacy data is org-scoped, so a
  member who counted as team would read another company's work. A member's
  access is their org membership and nothing besides.
- `pending` — signed up, waiting on approval. Reaches nothing.

An invite's `kind` picks the door: `team` (the original — a hire who lands
in the approval queue) or `founder` (a member, who approves with nobody and
goes straight to creating their org). Invites minted before founder links
existed carry no `kind` at all, and `inviteKind()` defaults them to `team`
so every one of them still works.

## Load order is the architecture

`js/` files are **classic scripts sharing one global scope** — no modules,
no imports. The `<script>` order in `index.html` *is* the dependency graph:
`config.js` defines `CONFIG`, `S`, `Store`, `$`, `esc` and the time helpers
that everything downstream assumes already exist. Same for `css/` — the
order is the cascade. Never shuffle either. `premium.css` and `premium.js`
load last on purpose: they standardize motion over everything before them.

One consequence bites harder than it looks: **a `const` at the top of any
`js/` file is a global**. A local-looking one-letter helper (`S`, `F`, `R`)
silently collides with something already there — `S` is the live shift
state — and the file that loses is whichever loads second. Prefix helpers
that only serve one file (`pkField`, `orgTypeKeyFor`). The jsdom suite
catches this, because it loads the real files into one scope the way the
browser does.

## The shift invariant

`S.shift` holds `segs` (task segments) and `breaks`. The invariant, stated
in `js/config.js` and relied on throughout:

> While ACTIVE, exactly one open seg. While ON_BREAK, none.
> Therefore `sum(segs) === net working time`, always.

Anything that opens or closes a segment must preserve this. `taskClockMs()`
deliberately does *not* sum every segment — that would just reproduce the
shift clock digit for digit and the second ring would say nothing.

## Testing

```
cd tests
npm ci          # once
npm test        # 385 assertions, node + jsdom, seconds
npm run test:rules   # 248 rules assertions (needs Java + firebase-tools)
npm run test:all     # both
```

`npm test` covers the workflow engine, effects, templates, versioning, the
builder handshake, the permission grammar, the item engine, automations,
the template packs, the repo guards, and — in jsdom, with the real files
loaded into one shared global scope exactly as `index.html` arranges
them — the generated UI. That last suite exists because the pure ones
prove what the engine DECIDES and cannot prove that a control the app
draws is a control the app can read back; that round trip only exists in
a document. It earns its keep: it is what caught `js/packs.js` declaring
a helper called `S` on top of the live shift state.

`packs.test.mjs` is the odd one out and worth understanding. It validates
every pack in `js/packs.js` against the REAL engines, and then proves the
validator actually refuses things — because a validator that always says
yes would pass the first half and mean nothing.
`test:rules` runs the full allow/deny matrix against the Firestore
emulator across six actor types — admin, assigner, worker, pending
stranger, unverified signup, and the unauthenticated client-link holder —
plus the tenancy matrix, where the property under test is that no role
reaches through an org boundary. All 633 pass as of this writing — a
failure is a real regression, not a flake.

## Deploys

- **App**: GitHub Pages serves the repo directly. Push to `main` ships it.
  There is no build step to wait for — only the browser cache, which is
  what rule 2 is about.
- **Firestore rules + indexes**: `.github/workflows/deploy-rules.yml` ships
  them on any push to `main` that touches `firestore.rules` or
  `firestore.indexes.json` — but only after the 248-assertion suite passes
  against the edited rules. Never paste rules into the Firebase console by
  hand; the console and the repo drift apart the moment you do, and the
  repo is the version that gets tested.

## Keys in `js/config.js`

The Firebase `apiKey` and the EmailJS `publicKey` are **meant** to be
public — they identify the project, they don't authorize anything. What
actually protects them is elsewhere and must stay in place:

- Firestore rules (in this repo, tested) are what stop unauthorized reads
  and writes. The API key is not a secret and never was.
- EmailJS quota is protected by the domain allowlist in
  EmailJS → Account → Security, not by hiding the key.

A real secret — a service account, a private key — must never land in this
repo. Those belong in GitHub Actions secrets.
