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
   The `tests/` directory is the only place with dependencies.

## Two gates, one truth

Authorization is enforced twice, and the two halves are separate files:

- `js/config.js` gates the **UI** — which buttons render.
- `firestore.rules` gates the **database** — what the server will accept.

Hiding a button is not security. If you remove someone's access, change
both, or they keep full access to anything they can reach with a direct
Firestore call. Guard 3 above fails the build if the two lists disagree.

## Load order is the architecture

`js/` files are **classic scripts sharing one global scope** — no modules,
no imports. The `<script>` order in `index.html` *is* the dependency graph:
`config.js` defines `CONFIG`, `S`, `Store`, `$`, `esc` and the time helpers
that everything downstream assumes already exist. Same for `css/` — the
order is the cascade. Never shuffle either. `premium.css` and `premium.js`
load last on purpose: they standardize motion over everything before them.

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
npm test        # 143 assertions, pure node, seconds
npm run test:rules   # 195 rules assertions (needs Java + firebase-tools)
npm run test:all     # both
```

`npm test` covers the workflow engine, effects, templates, versioning, the
builder handshake, the permission grammar, and the repo guards.
`test:rules` runs the full allow/deny matrix against the Firestore
emulator across six actor types — admin, assigner, worker, pending
stranger, unverified signup, and the unauthenticated client-link holder —
plus the tenancy matrix, where the property under test is that no role
reaches through an org boundary. All 338 pass as of this writing — a
failure is a real regression, not a flake.

## Deploys

- **App**: GitHub Pages serves the repo directly. Push to `main` ships it.
  There is no build step to wait for — only the browser cache, which is
  what rule 2 is about.
- **Firestore rules + indexes**: `.github/workflows/deploy-rules.yml` ships
  them on any push to `main` that touches `firestore.rules` or
  `firestore.indexes.json` — but only after the 119-assertion suite passes
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
