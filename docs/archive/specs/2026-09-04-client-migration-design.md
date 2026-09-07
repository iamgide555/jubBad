# Client Migration Design

## Goal

Migrate the Angular app (`web/`) off `localStorage` to call the real
NestJS API (§8.3, built) — the last piece of §8.1's server-side-engine
decision. `parser.ts`/`fuzzy-match.ts`/`pairing.ts` stop running in the
browser; every read/write that used to hit `localStorage` becomes an
HTTP call.

## Server-side gap found while designing this

`GET /sessions/:code`'s court derivation (`SessionsService.getSession`)
doesn't include the `Pairing` row's `id` in pending/active court
entries. `POST /sessions/:code/pairings/:id/confirm` and `/finish` need
that id — and a page load (not just the moment right after a `propose`
call in the same session) has to be able to act on an existing
pending/active court. Adding `pairingId: string` to those two court
variants is a small, additive fix to the already-shipped API layer,
not a scope-creep addition — without it, confirm/finish are simply
unreachable after a page refresh.

## Decisions

### 1. Data fetching — Angular `httpResource()`

Every GET-backed read (`session`, `group`, `players`) becomes an
`httpResource()` instead of a synchronous service call inside
`computed()` (which cannot make an HTTP call). `.value()` reads the
data reactively, `.reload()` maps directly onto the app's existing
`[↻ refresh]` button UX (already decided in §7.3/§8.3 — manual
refresh, no websockets/polling). Chosen over hand-rolled
`HttpClient.get().subscribe()` + signal wiring for less boilerplate
per call site and built-in loading/error state.

### 2. Error handling — minimal

Reuse the existing `pasteError`-style inline-message pattern only
where a failure would otherwise leave the user stuck with zero
feedback (parse failing, confirm-roster failing). No new error-UI
system, no toasts — matches the user's own "backend first, UX later"
sequencing decided earlier this session; deeper error UX belongs to
that later pass, not this migration.

### 3. API reachability — absolute base URL + CORS

`web/src/environments/environment.ts` holds `apiBaseUrl` (e.g.
`http://localhost:3000`); `server/src/main.ts` adds `app.enableCors()`.
Chosen over an Angular dev-server proxy: simpler, standard for two
separately-run local dev servers, and (unlike a proxy) still works
once `web/` is served as a static production build rather than through
`ng serve`.

### 4. Model changes

`Session` (`web/src/app/core/session.model.ts`) gains
`courts: CourtState[]` — the API returns roster, waitlist, and court
state in one `GET /sessions/:code` payload, so there's no reason for
`LiveSessionService` to track courts as a second, separately-fetched
piece of state the way it did against `localStorage`
(`live:${sessionCode}`). `CourtState`'s `pending`/`active` variants
(`web/src/app/core/live-session.model.ts`) gain `pairingId: string`,
per the server-side gap above.

### 5. Service redesign

- **`RosterService`** becomes a thin `HttpClient` wrapper.
  `getGroup`/`getSession`/`getPlayers` return `Observable`s (feeding
  `httpResource()` at call sites). `saveGroup(group)` →
  `renameGroup(code, name)` (`PUT /groups/:code`, body `{name}` only —
  the API computes `lastSessionCode`, the client never writes it).
  `createSession(session)` → `createSession(dto)` where `dto` carries
  `groupCode`/`date`/`venue`/`courtCount`/`rawImportText`/
  `rosterReviews`/`waitlistReviews` (matching `POST /sessions`'s body
  exactly — the *resolved* roster/waitlist id arrays the old signature
  took no longer exist; resolution now happens server-side), returning
  `Observable<{code: string}>`. **`savePlayers` is deleted** — no
  client-side player mutation survives the migration; player
  creation/alias-confirmation happens atomically inside `POST
  /sessions` now.
- **`LiveSessionService`** shrinks to a thin action wrapper around one
  `httpResource<Session>`. `courts`, `waitingPlayerIds` become
  `computed()`s reading `sessionResource.value()`.
  `proposeMatch`/`confirmMatch`/`finishMatch` become `async` methods:
  POST the action via `RosterService`-style HTTP call, then
  `sessionResource.reload()`. `proposeMatch` still returns whether it
  succeeded (now `Promise<boolean>`), same contract `CourtPanel`
  already depends on.

### 6. Component changes

- **`GroupEntry`**: `parse()` and `confirmRoster()` become `async`,
  calling `POST /groups/:code/parse` and `POST /sessions`
  respectively. The players list used for fuzzy-suggestion name
  display (`playerName()`) comes from a `players` `httpResource()`
  fetched right after a successful parse response (the group is
  guaranteed to exist by then, since `/parse` upserts it). The
  pre-parse validation (group name required, roster non-empty) stays
  client-side and synchronous exactly as built — only the parts that
  depend on the parser's *output* move into the response handler.
- **`SessionDashboard`/`SessionDisplay`**: their `computed()`s switch
  from synchronous `RosterService` calls to reading `httpResource()`
  values — a `session` resource, and a `players` resource whose URL is
  computed from `session.value()?.groupCode` (an `httpResource()` that
  returns `undefined` for its URL doesn't fetch — exactly the
  "wait for session to load first" dependency this needs).
- **`CourtPanel`**: smallest change of any component — still reads
  `liveSession.courts()[courtNumber() - 1]` and calls the same three
  methods (`startOrReshuffle`/`confirm`/`finish`), which are now
  `async` under the hood but keep the same call sites (`(click)`
  handlers don't care whether the handler returns `void` or
  `Promise<void>`).

### 7. Testing

`provideHttpClientTesting()` + `HttpTestingController` — Angular's
standard pattern for testing the HTTP boundary. This is the closest
analog to this session's "real dependency, not a mock" bias available
inside an Angular unit test: there's no live NestJS server reachable
from `web/`'s test runner (unlike the NestJS+Prisma tests, which hit a
real SQLite db because a real db *is* available in that process), so
`HttpTestingController` — asserting the exact request was made and
supplying the exact response — is the correct boundary to test at,
not a stand-in for mocking business logic.

Every spec touching a migrated service or component needs rework for
the async round-trip — this was called out as unavoidable cost back in
§8.6 ("every call site and its tests need updating"), not new scope.

## Non-goals

- Any new error-UX system beyond the minimal inline-message reuse
  (Decision 2).
- UI/UX visual polish — explicitly deferred to a separate pass per the
  user's own "backend first, UX later" sequencing.
- A real deployment/hosting story for either app — `apiBaseUrl` and
  CORS are configured for local dev only.
- Offline support / localStorage-as-cache — full cutover, not a hybrid
  (unambiguous from "migrate the Angular services off localStorage").
