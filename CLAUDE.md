# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JubBad — a badminton court-pairing/session-running app for Thai casual groups ("ก๊วน"). A host pastes a roster copied from LINE, the app fuzzy-matches names against known players, and runs the night: each court proposes a fair pairing, the host confirms it, plays, and records the winner. UI is Thai-primary (`th` source locale) with English as a second locale.

**Read `docs/overview.md` before making any change to the engines, the session lifecycle, or pairing/rating behavior.** It documents the *why* behind nearly every non-obvious rule in this codebase (why fuzzy match never auto-merges, why courts rotate independently instead of in rounds, why history is all-time but games-played is per-session, the auto-confirm timer, undo semantics, etc.) — re-deriving it from the code alone will miss the reasoning and risks reversing a deliberate decision. `docs/2026-09-21-feature-review-and-roadmap.md` records what is still open; `docs/archive/` holds historical plans/specs, not current state.

## Stack and layout

```
engines/     Pure, dependency-free TypeScript. No framework, no npm deps.
             parser.ts        LINE roster message -> structured data
             fuzzy-match.ts   parsed names -> known Player records
             pairing.ts       roster + history -> court assignments
             elo.ts           win/loss Elo, replayed over confirmed match history
             waiting.ts       shared wait-time calculation (engine + API + both screens)
             Tested with node:test, run via `npm run test:engines`.

server/      NestJS + Prisma + SQLite. Imports engines/ by relative path
             (this is why tsconfig.build.json widens rootDir to the repo
             root, and why nest-cli.json/start:prod use the resulting
             dist/server/src/ path instead of the usual dist/src/).
             The engines run server-side so the server can serialize
             decisions — see "Why the engines run on the server" in
             docs/overview.md. Serialization itself is
             server/src/sessions/session-lock.ts (in-process; a
             single-container deployment).
             Modules: auth, admin, groups, sessions, users, prisma.

web/         Angular (standalone components, signals). Talks to the API
             only — no business logic, no localStorage state.
```

Data model source of truth is `server/prisma/schema.prisma` (Group, User, Player, Session, SessionRoster, Waitlist, Pairing, PasswordReset(Request), SessionCreation). Two shapes worth knowing going in: array fields (`Player.aliases`, `Pairing.teamA`/`teamB`) are JSON-encoded string columns (SQLite has no array type), and a court's status (`idle`/`pending`/`active`) is always *derived* from `Pairing` rows, never stored.

## Commands

Root (`npm test` runs all three suites — engines, server, web):
```
npm test                    # engines + server + web
npm run test:engines        # engines only (node:test)
```

Engines — single test file:
```
node --experimental-strip-types --test engines/pairing.test.ts
```

Server (run from `server/`):
```
npm run start:dev           # nest start --watch
npm test                    # vitest run (*.spec.ts)
npm run test:watch          # vitest watch mode
npm run test:e2e            # vitest run --config ./vitest.config.e2e.ts (*.e2e-spec.ts)
npm run test:cov
npm run lint                # oxlint src/ test/ scripts/
npm run format               # prettier --write
npm run db:backup           # online SQLite backup (safe under WAL, unlike a file copy)
npm run db:restore
```

Server — single test file/case (vitest):
```
npx vitest run src/sessions/sessions.service.spec.ts
npx vitest run -t "test name substring"
```

**Server tests run with `fileParallelism: false`** — every spec opens its own connection to the same dev.db, and running spec files in parallel reproduces `SQLITE_BUSY`/Prisma timeout flakiness (see the comment in `server/vitest.config.ts`). Don't re-enable parallelism to "speed up" tests.

Web (run from `web/`):
```
npm start                   # ng serve
npm run build
npm test                    # ng test (Angular's vitest-based unit-test builder)
```

## Engines: rules that aren't obvious from the code

These are load-bearing product decisions, not incidental implementation choices — don't "fix" them without reading the relevant section of `docs/overview.md` first:

- **Fuzzy match never auto-links.** Only an exact match auto-links a pasted name to a known player; a fuzzy hit is always a suggestion the host must tap to confirm. A missed prompt just creates a duplicate player (recoverable); an unwanted auto-merge cannot be undone.
- **Partner/opponent history is all-time across sessions; games-played (for sit-out rotation) is session-only.**
- **Repeat-partner avoidance is primary, opponent balancing is a secondary tiebreak** — compared lexicographically, not by a fixed weight ratio (a prior 10:1 weighting couldn't actually guarantee the priority).
- **Courts rotate independently** — there is no shared "round" object; whoever finishes first gets the next match.
- **History updates only on confirm, never on propose.** This is what makes free reshuffling, resting a player, and undo all compose correctly without extra engine bookkeeping.
- **Bad input to the engines fails loudly** (throws on duplicate/empty player id, fractional/negative court count, invalid history counts) rather than coping — a swallowed corruption used to surface as a misleading "not enough players" to the host.
- Exhaustive search up to 8 players on court; local search (random-restart steepest-descent) above that, continuously checked against exhaustive results in `engines/pairing-quality.test.ts` so the engine can't silently regress even while unit tests stay green.

## Session lifecycle (server + web)

Each court: **idle** → propose → **pending** (free reshuffling, tap-swap) → confirm → **active** → finish (records winner or "no result") → idle again. A pending match with every seat filled auto-confirms after 60s of inactivity (any edit resets the timer). Undo reverses the most recent step on one court and refuses if the players involved already started elsewhere.

Three routes, access split is fixed:
- `/g/:groupCode` — group entry (admin-guarded)
- `/s/:sessionCode` — session dashboard, the host's phone (admin-guarded)
- `/s/:sessionCode/display` — read-only big-text venue-screen view, refreshes every 30s, shows only active courts (public)

Plus public read-only player profile and session summary pages.

Auth: per-user host login (email + password, signed server-side session cookie), not per-player accounts and not a shared admin token. `AuthGuard` + `OwnershipGuard` — an owner-mismatch on a group refuses with 404, never 403, so as not to confirm the resource exists. An admin role bypasses ownership.

## Working against a plan/spec doc

Roadmap and plan docs (e.g. `docs/2026-09-21-feature-review-and-roadmap.md`, `docs/superpowers/specs/*`) track items as `- [ ]` / `- [x]` checklist entries. When you finish implementing an item from one of these docs:

1. Flip its checkbox to `- [x]` (and update any "done" note the doc's convention uses, e.g. `— done`) in the same change.
2. If that finishes the *entire* doc (every checklist item done, nothing left open), move the file into `docs/archive/plans/` or `docs/archive/specs/` (matching its kind) rather than leaving a fully-done doc live in `docs/`.

Don't archive a doc that still has open items just because the item you touched is done.

## Product context

See `PRODUCT.md` for full detail. Key constraints worth carrying into any UI or API work: bilingual (Thai + English, no typeface may drop Thai coverage), no accounts/ceremony beyond host login, dashboard is used one-handed courtside (existing 44px tap targets), and the display route must stay legible at a distance on a shared screen — it is not just a smaller dashboard.
