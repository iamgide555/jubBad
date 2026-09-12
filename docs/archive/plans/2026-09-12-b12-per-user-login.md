# B12 — Per-user login, group ownership, admin console

## Context

`docs/2026-09-05-review-and-v2-backlog.md` lists B12 as the only open item. It
is **accepted work, not a deferral** (owner decision, 2026-09-08), sequenced
last because it touches the layer every route passes through.

What exists today: a single shared `ADMIN_TOKEN`. `AdminGuard` is registered as
a global `APP_GUARD` so every route is closed unless marked `@Public()`, and
`auth.boundary.spec.ts` proves that by walking the router Express actually
built. A login screen already exists at `/login`. So "anyone with the link can
edit" is already closed.

What is missing is **identity**, and B12 names three consequences:

- the token is one shared secret — everyone holding it has equal power,
  including deleting a group
- it grants access to every group; there is no concept of owning one
- revocation is all-or-nothing — changing the token signs out every device

This plan closes all three, and adds the admin console the owner asked for.

**Gate (unchanged, from B12's entry): do not start until the deployed build has
run real sessions** — manual swap under a thumb on a phone, backup/restore
against the real database, and the partner metric once pairs cross five games.
Authentication touches every route, so a fault in it looks like a fault in
everything.

## Decisions taken

| Question | Decision |
| --- | --- |
| Groups per user | Many. One user owns many groups; a group has exactly one owner. |
| Co-hosts | No. Managing a group means logging in as its creator. |
| Roles | Two: `admin` (sees and manages everything) and `host` (own groups only). |
| Delete a user who owns groups | Allowed, but never implicit. The admin page flags the owned groups and the admin decides each one — reassign or delete. A group's history is never destroyed as a side effect of removing a person. |
| Backfill existing groups | Assign to the bootstrap admin on first boot, reassign from the admin page afterwards. |
| First admin | Seeded from env vars on boot if no admin exists. No public route ever creates one. |
| Password reset | Admin clicks reset → one-time URL → delivered by hand over LINE. No SMTP. |
| Forgot password | Host raises a request from the login page; it appears as a pending item in the admin console, which the admin turns into a reset URL. No automated delivery. |

## Execution

**Workspace:** a git worktree on branch `worktree-per-user-auth`, matching the
convention every merge in this repo's history already follows. `main` stays
checked out and runnable in the original directory throughout — it is what runs
the owner's Tuesday sessions, and a half-finished auth rewrite must never be
the only thing on disk.

**The gate still holds.** Building this on a branch is not deploying it. Do not
merge to `main` until the currently deployed build has run real sessions (see
Context). The branch can sit finished and unmerged; that is the intended state.

Six phases, each ending with the **full suite green** and one commit. No stop
for review between them — the branch is reviewed as a whole — but the green
suite is a hard gate, not a goal: a phase that cannot get there stops and
reports rather than carrying a red suite forward.

**Phase 1 — schema and primitives.** The migration (`User`, `PasswordReset`,
`PasswordResetRequest`, nullable `Group.ownerId`), `auth/password.ts` with its
spec, and `prisma-roundtrip.spec.ts` extended to the new models. Nothing is
wired to a route; `ADMIN_TOKEN` is still in charge and the suite is untouched.

**Phase 2 — credentials.** `SESSION_SECRET` and the secreted `cookieParser` in
`main.ts` *and every spec that builds its own app*; `bootstrap.service.ts`;
`AdminGuard` → `AuthGuard` resolving the signed cookie to a user; login by
email and password; the throttle keyed by IP and email; `ADMIN_TOKEN` removed.
Then rework every existing spec to seed a user and log in — the bulk of the
mechanical work in the whole change.

**Deliberately no ownership yet.** At the end of this phase any authenticated
user still sees everything, exactly as today. Only the credential has changed.
Splitting this from phase 3 is what makes a failure legible: "login broke" and
"visibility broke" are different phases rather than one undifferentiated commit.

**Phase 3 — ownership.** `OwnershipGuard`, the create-or-own path through
`GroupsService.parse`, the `listGroups` filter, the `createSession` check, and
the ownership dimension on `auth.boundary.spec.ts`. This is the phase that can
break group creation outright, so verification 4b runs here and not at the end.

**Phase 4 — reset and forgot.** `PasswordReset` issue-and-consume,
`POST /auth/forgot`, the pruning pass, and the reset-password page.

**Phase 5 — admin console.** The `/admin` module and page: users, the
delete-user disposition flow, owner reassignment, and the reset-request queue.

**Phase 6 — documentation.** `docs/overview.md`, B12 marked done in
`docs/2026-09-05-review-and-v2-backlog.md`, `dockerDeploy.md`. Last because it
describes what was built, but not optional — see the Documentation section.

## Schema

Three changes, one migration.

**`User`** — new.

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  role         String   @default("host")   // 'admin' | 'host'
  disabled     Boolean  @default(false)
  /// Bumped on disable, password change and password reset. The cookie carries
  /// the version it was issued at; a mismatch is a 401. This is what makes
  /// revocation per-user instead of all-or-nothing — without it a disabled
  /// user's phone keeps working for the cookie's full 30 days.
  tokenVersion Int      @default(0)
  createdAt    DateTime @default(now())
  groups       Group[]
  resets       PasswordReset[]
}
```

**`PasswordReset`** — new. Stores the token **hashed**, for the same reason the
password is: the raw value travels through a LINE chat and stays in scrollback.

```prisma
model PasswordReset {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique   // sha256 of the raw token
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**`PasswordResetRequest`** — new. A locked-out host has no cookie and no way to
reach anyone in-app, so this is the one place an unauthenticated visitor may
write. Keep it deliberately inert: it records that *someone* asked, and grants
nothing.

```prisma
model PasswordResetRequest {
  id          String    @id @default(cuid())
  /// The email as typed, NOT a User relation. The request is recorded whether
  /// or not the address matches an account — see the enumeration note below.
  email       String
  createdAt   DateTime  @default(now())
  handledAt   DateTime?
  /// The admin's id as a plain string, not a relation — deliberately. This is
  /// an audit trail, and it has to keep meaning something after that admin's
  /// account is deleted.
  handledBy   String?
}
```

**`Group.ownerId`** — added as **nullable**, deliberately. The migration cannot
create the admin user, because password hashing happens in application code. So
the column arrives nullable and boot-time bootstrap fills it; after the first
boot nothing is null. Document that reasoning in the schema comment — a future
reader will otherwise "fix" it to `NOT NULL` and break a fresh deploy.

Migration name: `server/prisma/migrations/<ts>_add_users_and_group_owner`.

## Throttling

`LoginThrottle` is keyed by IP alone, which was right for one shared secret:
there was one credential, so slowing down each source was the whole defence.

Per-user accounts change the shape of the attack. The target is now a
particular email, and an attacker with a pool of addresses gets a fresh budget
per source against the same account. **Key the throttle by IP *and* by email**,
failing if either bucket is exhausted, and apply the same to `/auth/forgot`.

Keep the existing 429 handling — `auth.service.ts` already distinguishes it so
the form says "wait a moment" rather than repeating "wrong password" at someone
whose password is right. That distinction matters more now, because with a real
password a host will assume they mistyped and keep trying.

## Password hashing

Use **`node:crypto.scrypt`** — no new dependency, no native build in the
Docker image. Fits a repo whose engines deliberately carry zero npm deps.

New `server/src/auth/password.ts`: `hashPassword(plain)` →
`scrypt$N$r$p$<salt>$<hash>`, and `verifyPassword(plain, stored)` comparing
with `timingSafeEqual`. Mirror the reasoning already written in
`admin.guard.ts`'s `matchesToken` — including the length guard, since
`timingSafeEqual` throws on mismatched buffers and would turn a failed login
into a 500.

## Session cookie

Today `auth.controller.ts` puts the raw shared token in the cookie. Replace
with a **signed** cookie carrying `userId:tokenVersion`.

`cookie-parser` is already a dependency and supports this — `app.use(
cookieParser(SESSION_SECRET))`, `res.cookie(..., { signed: true })`,
`req.signedCookies`. No JWT library, no hand-rolled HMAC.

Keep everything already reasoned about in `cookieOptions()`: `httpOnly`,
`sameSite: 'lax'` (which is what makes a CSRF token unnecessary), `secure` in
production only, 30-day `maxAge`.

New env var `SESSION_SECRET`, required at boot by the same pattern as
`requireAdminToken()` in `auth.module.ts` — throw rather than degrade, because
an app that boots with the door open is invisible in production.

**The secret has to reach every app instance, tests included.** `main.ts:31`
calls `cookieParser()` with no argument today, and so does every spec that
builds its own Nest app (`auth.boundary.spec.ts`, both controller specs). A
signed cookie read through an unsecreted `cookieParser` does not throw — it
silently yields `undefined`, so every guarded request 401s and the failure
looks like broken auth rather than missing wiring. Change all of them together,
and add one assertion that a tampered cookie value is rejected, so the signing
is proven to be on rather than assumed.

`ADMIN_TOKEN` is **removed**, along with `matchesToken`'s use in the login
path. Update `server/.env.example`, `docker-compose.yml`, and the deploy doc.

## Guards

Two global guards, in order.

**1. `AdminGuard` → rename to `AuthGuard`.** Still default-deny on `@Public()`.
Now it resolves the signed cookie to a `User`, refuses if `disabled` or if
`tokenVersion` does not match, and attaches the user to the request.

**2. `OwnershipGuard`** — new, the substantive work. Also default-deny: for any
route that is not `@Public()`, not under `/auth`, and not under `/admin`, it
must resolve a group and check `ownerId === user.id`. A route it cannot resolve
is **refused**, not waved through — same philosophy that makes the current
boundary provable.

Resolution:

- `/groups/:code/*` → the code is a group code.
- `/sessions/:code/*` → session → `groupId` → `ownerId`. One extra query; cache
  it on the request so a handler that also loads the session does not pay twice.
- `POST /sessions` → the group comes from the body, so the check happens in
  `SessionsService.create` rather than the guard. Mark it explicitly.
- `role === 'admin'` passes everything.

### Group creation — the case that breaks if this is missed

**A naive ownership check makes it impossible to ever create a group again.**
Group codes are minted **client-side** (`landing.ts:64`,
`crypto.randomUUID().slice(0, 8)`) and the group is brought into existence by
`GroupsService.parse`, which **upserts** (`groups.service.ts:328-333`). So the
first request against a new code is aimed at a group that does not exist yet —
which an ownership guard resolves to nothing and refuses.

`POST /groups/:code/parse` is therefore the **create-or-own** point, and needs
the same explicit treatment as `POST /sessions`:

- group does not exist → create it with `ownerId = <caller>`
- group exists → normal ownership check

Two routes on the same path are affected the same way, because `/g/:code` loads
them before the group exists: `GET /groups/:code/sessions` and
`PUT /groups/:code` (rename), both called from group-entry. A missing group on
those must read as *empty and claimable*, not as *refused* — otherwise the new
group page dead-ends before the host has pasted anything.

This also closes the squatting question: after the bootstrap backfill every
existing group has an owner, so an unowned code is by definition a code nobody
has used, and claiming one is exactly what creating a group means.

Cover it in `delete-user.spec.ts`'s sibling — a fresh code is creatable by any
host, and the group that results is owned by them and invisible to the other.

**Refuse with 404, not 403.** A 403 confirms that a group code exists, which
is exactly what an 8-hex-char code should not confirm. Replace the comment in
`admin.guard.ts` that says this app has no concept of "signed in and still may
not do this" — it will, and the reason it answers 404 anyway is worth writing
down where that comment currently sits.

### Per-request cost

Today's `AdminGuard` does **zero queries** — it is a constant-time string
compare. After this it is a `User` lookup (to check `disabled` and
`tokenVersion`) plus, for session routes, a session→group lookup. Two queries
added to every guarded request, on a dashboard that polls.

Mitigate, in this order: resolve each once per request and cache on the request
object; select only the columns the guards need rather than whole rows; and
skip the session lookup entirely when `role === 'admin'`, which short-circuits
before it.

Flagging it because `docs/2026-09-11-performance-plan.md` (T2, T3) is
simultaneously about *reducing* per-request work. The two plans touch the same
request path and both add migrations — whichever lands second rebases, and the
baseline measurements in that plan's T1 should be retaken after this lands
rather than compared across it.

### Service-layer changes

- `GroupsService.listGroups` (`groups.service.ts:32`) currently returns every
  group. It takes the caller and filters on `ownerId`, with `admin` seeing all.
  This is the endpoint the backlog already calls out as "the only endpoint in
  the app that can enumerate groups", so it is the one whose filter matters most.
- `GroupsService.deleteGroup` (`groups.service.ts:306`) is already a single
  `$transaction` in dependency order; the admin delete-user flow composes it
  rather than reimplementing the ordering.
- `SessionsService.createSession` gains the ownership check on `dto.groupCode`.

## Admin console

Server: new `server/src/admin/` module, every route requiring `role: 'admin'`.

| Route | Purpose |
| --- | --- |
| `GET /admin/users` | list, with group counts |
| `POST /admin/users` | create (email + initial password) |
| `PUT /admin/users/:id` | edit email / role |
| `POST /admin/users/:id/disabled` | enable/disable — bumps `tokenVersion` |
| `DELETE /admin/users/:id` | takes a disposition for **every** owned group (see below) |
| `POST /admin/users/:id/reset` | mint a one-time reset URL, return it once |
| `GET /admin/groups` | every group with its owner |
| `POST /admin/groups/:code/owner` | reassign |

Take the idempotent-state shape already used by
`POST /sessions/:code/roster/:playerId/active` (desired state, not a flip) for
enable/disable, for the same reason: two taps in flight must not cancel out.

### Deleting a user who owns groups

Deleting a person must not decide the fate of a badminton group by default —
but it must not dead-end either. So the admin decides, explicitly, per group.

`GET /admin/users` returns each user's owned groups, and the users table
**flags** anyone who owns any — visible before the admin ever clicks delete,
which is the point: the consequence is on screen, not behind a confirmation.

`DELETE /admin/users/:id` takes a body naming a disposition for each:

```jsonc
{ "groups": {
    "<groupCode>": { "action": "reassign", "toUserId": "..." },
    "<groupCode>": { "action": "delete" }
} }
```

- Every owned group must appear, and the set must match the server's own list.
  A missing or unknown code is a 400 — a group must never be disposed of by
  omission, and a stale admin tab must not act on a list that has since changed.
- `delete` reuses `GroupsService.deleteGroup`, which already removes a group
  and all its sessions and matches in one transaction.
- The whole thing — every reassign, every group delete, the user row — runs in
  **one `$transaction`**. A half-deleted user with two of four groups gone is
  the worst possible outcome here.
- A user owning nothing needs no body.

The UI is a two-step dialog: click delete → the owned groups are listed, each
with reassign-to (a user picker) or delete; confirm is disabled until every
group has a choice. Group delete keeps the type-the-name guard already used on
`/g/:code`, since that is still the irreversible action.

**Reset token:** `randomBytes(32).toString('base64url')`, stored as its SHA-256,
**1 hour** expiry, single use, and consuming it bumps `tokenVersion` so the old
devices sign out. Short expiry matters because the URL lives in a LINE chat
forever.

`POST /auth/reset/:token` is `@Public()` — a locked-out user has no cookie.

### Forgot password

`POST /auth/forgot` — `@Public()`, takes an email, records a
`PasswordResetRequest`. Three rules, none optional:

- **Always answer the same** — "if that account exists, the admin has been
  notified" — whether or not the address matches a user, and with no timing
  difference. Otherwise this becomes an account-enumeration oracle, which is
  worse than the problem it solves.
- **Throttled**, reusing `LoginThrottle`. It is the only unauthenticated
  write in the app; without a limit it is a free way to fill the table.
- **Grants nothing.** It does not mint a token, does not touch `tokenVersion`,
  does not confirm the account. The only thing that produces a reset URL is an
  admin clicking `POST /admin/users/:id/reset`.

Admin side: `GET /admin/reset-requests` lists unhandled requests newest first,
and the admin page shows a count badge. Acting on one — clicking through to
that user's reset — stamps `handledAt`/`handledBy`. A request whose email
matches no account still shows, marked as such: a host who typos their own
address is a real event and silently discarding it leaves both sides waiting.

Prune handled requests older than 30 days on boot, beside the bootstrap step,
so the table cannot grow without bound. Prune spent and expired `PasswordReset`
rows in the same pass — an unused token that has expired is dead weight, and a
used one is a record of nothing.

## Bootstrap

New `server/src/auth/bootstrap.service.ts`, `onModuleInit`:

1. If any `role: 'admin'` user exists → do nothing. Idempotent across restarts.
2. Otherwise create one from `ADMIN_EMAIL` + `ADMIN_PASSWORD`, throwing if
   either is unset (same reasoning as `requireAdminToken`).
3. `UPDATE Group SET ownerId = <admin.id> WHERE ownerId IS NULL` — this is the
   backfill, and it also catches any orphan a future bug creates.

Step 3 runs on every boot, not only the first, which is why the nullable column
is safe rather than sloppy.

## Web

- **`pages/login`** — token field becomes email + password, plus a
  **ลืมรหัสผ่าน?** link opening an email field that posts to `/auth/forgot`.
  The confirmation must be worded so it does not reveal whether the account
  exists, and must say the reset arrives by hand — a host who expects an email
  will sit waiting for one that never comes.
- **`pages/landing`** — already calls `GET /groups`; that endpoint now returns
  only the caller's groups, so the page needs copy for the empty state and an
  admin-only link to `/admin`.
- **`pages/reset-password`** — new, route `reset/:token`, **unguarded**.
- **`pages/admin`** — new, guarded plus a role check. Users table with the
  actions above; reset shows the generated URL with a copy button (reuse the
  clipboard-failure handling already written for A8's "คัดลอกเป็นข้อความ").
  A pending-reset-requests section with a count badge sits at the top, since it
  is the one part of this page that is time-sensitive.
- **`core/auth.service.ts`** — `me()` now returns `{ authenticated, role,
  email }`; add a `roleGuard` beside the existing `admin.guard.ts`.
- **`app.routes.ts`** — its header comment says every added route must decide
  guarded vs public and stay in step with `auth.boundary.spec.ts`. Two routes
  are being added; honour it.
- **i18n** — Thai is the source locale served at `/`, English at `/en/`. Every
  new string needs both.

## Tests

The load-bearing one: **extend `auth.boundary.spec.ts` with an ownership
dimension.** It currently walks the real router asserting every non-public
route 401s an anonymous caller. Add a second walk with two hosts — user B,
authenticated, must get 404 on every non-public route belonging to user A's
group. That keeps the property the file was built for: a route added later is
closed by default and *provably* so, whether or not anyone wrote a test for it.

Also:

- `password.spec.ts` — round-trip, wrong password, malformed stored hash.
- `bootstrap.spec.ts` — creates on empty DB, no-ops on second boot, backfills
  null owners.
- `token-version.spec.ts` — disabling a user 401s a cookie issued before it.
- `password-reset.spec.ts` — single use, expiry, unknown token, and that
  consuming one invalidates existing cookies.
- `forgot-password.spec.ts` — the response body and status are **identical**
  for a known and an unknown email; the request grants no token and does not
  change `tokenVersion`; repeated calls hit the throttle. The enumeration test
  is the one that matters — it is the failure that looks like success.
- `admin.spec.ts` — a `host` gets 404 on every `/admin` route.
- `delete-user.spec.ts` — the disposition contract, which is where the real
  risk is: an incomplete body deletes nothing; an unknown or stale group code
  deletes nothing; a mixed reassign-and-delete run leaves the reassigned groups
  intact under their new owner and the deleted ones fully gone; and a failure
  partway through rolls the whole thing back, user row included.
- `prisma-roundtrip.spec.ts` — extend to the three new models, since it is the
  file that catches a schema and client that have drifted apart.
- Existing specs override the `ADMIN_TOKEN` provider; they all need reworking
  to seed a user and log in instead. Expect this to touch most server specs —
  it is the bulk of the mechanical work.

## Documentation

Not optional, and not a tidy-up at the end. A15 in the backlog records a fix
that was silently reverted and stayed invisible for a day precisely because
`overview.md` still described the intended behaviour — docs that are right
while the code is wrong survive review longest. The inverse is what this change
would create.

Stale the moment this ships, all in `docs/overview.md`:

- **line 38** — "Shared admin authentication, not player accounts … one
  venue-admin token" → per-user accounts with group ownership.
- **line 42** — the whole "No per-group host role" risk entry. It is resolved,
  not mitigated; rewrite it as a decision with its reasoning, the way the
  export-and-delete risk was rewritten when auth closed it.
- **line 44** — "Export and delete require the shared admin token", including
  the sentence about revocation being all-or-nothing.
- **line 52** and **lines 390-398** — both describe B12 as planned work.

Also: mark **B12 done** in `docs/2026-09-05-review-and-v2-backlog.md`, and
update `dockerDeploy.md` for the changed environment variables.

## Deploy

- `server/.env.example` and `server/.env` (compose reads it via `env_file`, and
  it is gitignored): drop `ADMIN_TOKEN`, add `SESSION_SECRET`, `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`.
- `ADMIN_PASSWORD` is read **only when no admin exists**, so it is inert after
  the first boot. Change the password from `/admin` once signed in and drop the
  variable; leaving a working password in a file on the box is the kind of
  thing that is still there a year later.
- **Back up the database before migrating**: `npm run db:backup`, which takes a
  consistent snapshot through SQLite's online backup API while the API keeps
  serving. This migration adds a column to `Group` and is not undone by
  re-running.
- Deploy order: migrate → boot (bootstrap seeds admin, backfills owners) →
  verify the landing page lists the existing groups → reassign each to its real
  host from `/admin`.
- **Rollback**, written down before it is needed: this is the auth layer, and
  the realistic failure is discovering it on a Tuesday evening with people
  waiting on court. Previous image + restored snapshot, in that order — the old
  image cannot read a migrated database's `Group` rows any worse than it reads
  the snapshot, but it will not boot without `ADMIN_TOKEN`, so keep that value
  until the new build has run a full session. Do not deploy this on a session
  day.

## Verification

1. `npm test` at the repo root — runs engines, server and web (the root scripts
   added in A12). Baseline before starting is 230 passing; nothing may regress.
2. `npm --prefix server run build && npm --prefix web run build` clean.
3. Against a scratch database: boot with no admin → admin exists, existing
   groups owned by it. Boot again → unchanged.
4. Two browsers, two host accounts: A's group URL pasted into B's browser
   returns not-found, not a login prompt and not the group.
4b. **Create a group end to end as a plain host** — landing → new group →
   paste a roster → start a session. This is the path a naive ownership check
   breaks completely, and it is not covered by any existing test.
5. Venue display, session summary and player stat card all still open with **no
   cookie at all** — these are the routes players use and they must not close.
6. Disable a user in `/admin` while their other tab is open → next action 401s
   and bounces to `/login`.
7. Reset flow end to end: generate URL, open in a private window, set password,
   confirm the old cookie is dead and the URL cannot be reused.
8. Forgot-password round trip: request from the login page with a real address
   and with a nonsense one — the screen says the same thing both times — then
   confirm both land in the admin console and clicking through produces a
   working reset URL.
9. Delete a host owning two groups, reassigning one and deleting the other:
   the reassigned group opens under its new owner with its match history
   intact, the deleted one is gone, and no orphan group is left behind.
