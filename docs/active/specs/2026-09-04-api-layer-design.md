# API Layer Design

## Goal

Build the NestJS API surface sketched at "shape only" in `PROJECT.md`
§8.3, backed by the Prisma schema/client from
`docs/active/specs/2026-09-04-prisma-schema-design.md`. This is
the layer that runs `parser.ts`/`fuzzy-match.ts`/`pairing.ts`
server-side (§8.1's decision) and persists through Prisma. Out of
scope: migrating the Angular services off `localStorage` to call this
API (§8.6) — separate plan, comes after this one.

## Module structure

`server/src/`:

- `prisma/` — `PrismaService`, a NestJS injectable wrapping
  `PrismaClient` with the `@prisma/adapter-better-sqlite3` driver
  adapter (already required at runtime, decided in the schema plan).
  Connects `OnModuleInit`, disconnects `OnModuleDestroy`. Exported
  from a global `PrismaModule` so `GroupsModule`/`SessionsModule`
  don't each need to re-import it.
- `groups/` — `GroupsController`, `GroupsService`, DTOs.
- `sessions/` — `SessionsController`, `SessionsService`, DTOs.

Validation via `class-validator` + `class-transformer` with a global
`ValidationPipe` (`{ whitelist: true, transform: true }`) — NestJS's
standard pairing, and matches this project's established preference
for explicit/typed over decorator-heavy magic (§8.4) in the sense that
invalid requests get rejected at the boundary with a clear 400, not
silently accepted and failing deeper in.

Both engine-calling endpoints (`/groups/:code/parse`,
`/sessions/:code/courts/:n/propose`) import `parser.ts`/
`fuzzy-match.ts`/`pairing.ts` by the same relative-path pattern the
NestJS scaffold plan already proved works
(`docs/active/plans/2026-09-04-nestjs-scaffold.md`).

## Decisions

### 1. Group creation — implicit upsert on `/parse`

No separate "create group" endpoint. `POST /groups/:code/parse`
creates the `Group` row if it doesn't exist yet (`upsert` by `code`),
using the `groupName` the host typed. Matches how the client already
treats "the code exists" as the only real signal — no extra round-trip
between Landing generating a code and the host's first paste.

**`/parse` never renames an existing group.** If `Group` already
exists, the provided `groupName` is ignored for the upsert (`update: {}`
with no `name` change) — only used on `create`. A returning host with a
different string in the group-name field can't accidentally overwrite
an established group's name. Renaming stays an explicit `PUT
/groups/:code`.

### 2. `propose` failure — 200 with a discriminated body

`POST /sessions/:code/courts/:n/propose` returns `{ ok: true, pairing }`
or `{ ok: false, reason: 'not-enough-players' }`, both HTTP 200. "Not
enough players available right now" is a normal, expected game-state
outcome (the client already handles it today via `proposeMatch():
boolean`), not an error condition — a 4xx status would conflate the
two and NestJS's default exception body isn't shaped to carry a
structured reason the client branches on.

### 3. Confirm/finish — two explicit action endpoints

`POST /sessions/:code/pairings/:id/confirm` (no body, sets
`confirmedAt`) and `POST /sessions/:code/pairings/:id/finish` (body
`{scoreA, scoreB}`, sets `endedAt`+scores), replacing §8.3's original
single overloaded `PATCH`. Each has one fixed request shape — no
branching on which fields are present to infer intent — and matches
`CourtPanel` already calling two distinct client methods
(`confirmMatch`/`finishMatch`).

### 4. `lastSessionCode` — computed field on `GET /groups/:code`

Not a stored column (decided in the schema plan). `GroupsService`
resolves it via a query — latest `Session` row for this `groupId`,
ordered by `createdAt` desc — and includes it in the response as
`lastSessionCode: string | null`. Client code barely changes: it still
just reads `group.lastSessionCode` from the response, same as it read
it from the `localStorage`-backed model today.

### 5. Review/decision resolution stays split the same way it is today

`POST /groups/:code/parse` returns match data only — `rosterReviews`/
`waitlistReviews` as `{inputName, match}[]` (`RosterNameMatch[]` from
`fuzzy-match.ts`, not the client's `NameReview[]` which adds a
`decision` field). Toggling accept/reject stays purely client-side UI
state over the fetched `/parse` result — no server round-trip needed
until submit, exactly as §8.3 already said. `POST /sessions` receives
the full `NameReview`-shaped array back (`inputName`+`match`+
`decision`, echoing what `/parse` returned plus the host's toggles)
and resolves it server-side against the real `Player` table — the same
logic `web/src/app/core/roster-review.ts`'s `resolveReviews` already
implements client-side today (confirm alias / create new player),
moved to run against Prisma instead of a local array.

### 6. Pairing history stays session-scoped

`propose`'s history (repeat-partner/opponent avoidance) is built from
this session's own confirmed `Pairing` rows only — not all-time across
every session in the group. Matches the client's current
`deriveHistory` behavior (`web/src/app/core/history-derivation.ts`,
which only ever sees the current session's `MatchRecord[]`). Widening
to cross-session history is a real, separate design decision — not
pulled into this plan's scope.

## Endpoints

```
GET   /groups/:code
      → { code, name, lastSessionCode }  [data]
      404 if the group doesn't exist (only /parse creates one)

PUT   /groups/:code
      ← { name: string }
      → { code, name }  [data]

GET   /groups/:code/players
      → Player[]  ({id, name, aliases: string[]})  [data]
      404 if the group doesn't exist

POST  /groups/:code/parse
      ← { groupName: string, rawText: string }
      upserts Group (name set only on create, see Decision 1)
      → { header: { isoDate: string|null, venue: string|null,
                     courtCount: number|null },
          rosterReviews: RosterNameMatch[],
          waitlistReviews: RosterNameMatch[],
          warnings: string[],
          unrecognizedLines: string[] }  [engine]

POST  /sessions
      ← { groupCode: string, date: string|null, venue: string|null,
          courtCount: number|null, rawImportText: string,
          rosterReviews: NameReviewDto[],
          waitlistReviews: NameReviewDto[] }
        (NameReviewDto = { inputName: string, match: NameMatchDto,
         decision: 'accept'|'reject-new' })
      resolves reviews against this group's real Player table
      (creates new Players / confirms aliases — see Decision 5),
      generates the session code (crypto.randomUUID().slice(0,8),
      same pattern as Group codes), creates Session + SessionRoster +
      Waitlist rows
      → { code: string }  [engine + data]

GET   /sessions/:code
      → { code, groupCode, date, venue, courtCount,
          rosterPlayerIds: string[], waitlistPlayerIds: string[],
          courts: CourtStateDto[] }  [data]
      404 if not found
      courts derived per §8.2's lifecycle rule: idle/pending/active
      from each court's latest non-ended Pairing row

POST  /sessions/:code/courts/:n/propose
      → { ok: true, pairing: { id, courtNumber, matchNumber,
                                teamA: [string,string],
                                teamB: [string,string] } }
        | { ok: false, reason: 'not-enough-players' }  [engine]
      see Decision 2 (response shape) and Decision 6 (history scope)

POST  /sessions/:code/pairings/:id/confirm
      sets confirmedAt = now()
      → updated Pairing  [data]

POST  /sessions/:code/pairings/:id/finish
      ← { scoreA: number|null, scoreB: number|null }
      sets endedAt = now()
      → updated Pairing  [data]
```

## Non-goals

- Migrating `RosterService`/`LiveSessionService`/`GroupEntry`/
  `CourtPanel`/`SessionDisplay` off `localStorage` to actually call
  this API (§8.6) — separate plan, comes after this one and after
  manual verification that the endpoints work.
- Cross-session pairing history (Decision 6).
- Authentication/authorization — unchanged from §5's "no user auth"
  decision; anyone with a group/session code can read/write it, same
  as the current `localStorage` model's implicit trust.
- Websockets/polling — unchanged from §8.3's existing "manual refresh
  only" decision.
