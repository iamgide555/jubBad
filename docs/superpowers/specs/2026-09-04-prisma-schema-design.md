# Prisma Schema Design

## Goal

Add the real database layer to `server/` (SQLite + Prisma, decided in
`PROJECT.md` §8.4) so the four entities from §5/§8.2 (`Group`,
`Player`, `Session`, `Pairing`, plus `Waitlist`) have a concrete,
migratable schema and a generated, typed Prisma client the API layer
(§8.3, a separate later plan) can build on.

This is schema + migration + client setup only. Out of scope: the API
endpoints that use this client (§8.3), and migrating the Angular
services off `localStorage` (§8.6) — both come after.

## Why now

`PROJECT.md` §8.2/§8.4 already decided SQLite + Prisma and sketched
the four tables, but left three concrete representation questions
unresolved — SQLite/Prisma has no native array column, and the client
models (`Player.aliases: string[]`, `Session.rosterPlayerIds: string[]`
/`waitlistPlayerIds: string[]`, `Pairing.teamA/teamB: [string, string]`)
all use arrays. Resolved below.

## Decisions

### 1. Arrays → JSON columns

`Player.aliases`, `Pairing.teamA`, `Pairing.teamB` are stored as plain
`String` columns holding JSON-encoded arrays (`'["a","b"]'`), not flat
scalar FK columns or a join table. Nothing in this app queries into
individual array elements at the SQL level (e.g. "find all matches
player X was in" isn't a feature yet), so the relational cost of
normalizing them buys nothing right now. App code does
`JSON.parse`/`JSON.stringify` manually at the Prisma boundary — Prisma
doesn't do this for plain SQLite `String` columns.

### 2. Session roster → explicit join table

`Session.rosterPlayerIds` becomes a `SessionRoster` join table
(`sessionId`, `playerId`), symmetric with the `Waitlist` table §5
already specified (which additionally carries `position`). This gives
real FK integrity and an easy "who's in session X" query, at the cost
of one more table than a JSON column would need.

### 3. `Group.lastSessionCode` → derived, not stored

Dropped from the schema entirely. The client model
(`web/src/app/core/group.model.ts`) stores it explicitly, set whenever
a session is confirmed — but in a real DB it's redundant with
`Session.groupId` + `Session.createdAt`: "the most recent `Session`
row for this group" is one query
(`groupId = X ORDER BY createdAt DESC LIMIT 1`), and keeping a second
copy of that fact is a value that could drift out of sync with the
real rows if a bug ever wrote one without the other. Resolving
"resume last session" becomes an API-layer query (§8.3), not a schema
field.

### 4. `Group`/`Session` primary key = their existing `code`

No separate internal `id` alongside `code`. The app already treats
`code` as the sole identifier everywhere it matters — URL routes
(`/g/:groupCode`, `/s/:sessionCode`), `localStorage` keys — and nothing
client-side ever needs a second, non-public id. `Player` and the join
tables still get a generated `cuid()` id since they have no natural
public identifier.

## Schema

`server/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Group {
  code      String    @id
  name      String?
  createdAt DateTime  @default(now())
  players   Player[]
  sessions  Session[]
}

model Player {
  id      String @id @default(cuid())
  groupId String
  name    String
  aliases String // JSON-encoded string[]
  group   Group  @relation(fields: [groupId], references: [code])
}

model Session {
  code          String          @id
  groupId       String
  date          String?
  venue         String?
  courtCount    Int?
  rawImportText String
  createdAt     DateTime        @default(now())
  group         Group           @relation(fields: [groupId], references: [code])
  roster        SessionRoster[]
  waitlist      Waitlist[]
  pairings      Pairing[]
}

model SessionRoster {
  id        String  @id @default(cuid())
  sessionId String
  playerId  String
  session   Session @relation(fields: [sessionId], references: [code])

  @@unique([sessionId, playerId])
}

model Waitlist {
  id        String  @id @default(cuid())
  sessionId String
  playerId  String
  position  Int
  session   Session @relation(fields: [sessionId], references: [code])

  @@unique([sessionId, playerId])
}

model Pairing {
  id          String    @id @default(cuid())
  sessionId   String
  courtNumber Int
  matchNumber Int
  teamA       String // JSON-encoded [playerId, playerId]
  teamB       String // JSON-encoded [playerId, playerId]
  scoreA      Int?
  scoreB      Int?
  confirmedAt DateTime?
  endedAt     DateTime?
  session     Session   @relation(fields: [sessionId], references: [code])
}
```

Note: no explicit FK from `Player`/`SessionRoster`/`Waitlist`/`Pairing`
rows to a specific `Player.id` is enforced *at the SQLite level* for
the JSON-encoded id lists (`teamA`/`teamB`) — SQLite/Prisma can't put a
foreign key constraint inside a JSON string. Referential integrity for
those specific ids is an application-level concern (the engine layer
already only ever produces ids that came from a real `Player` query),
not a gap introduced by this schema.

## Setup

- `server/prisma/schema.prisma` as above.
- `server/.env` (gitignored) with `DATABASE_URL="file:./dev.db"`;
  `server/.env.example` committed with the same placeholder so a fresh
  clone knows what to create.
- `server/prisma/dev.db` (and Prisma's `dev.db-journal`) gitignored —
  a local SQLite file is a build artifact, not source.
- Migrations tracked normally in `server/prisma/migrations/` (these
  ARE committed — they're the schema's history, not a build artifact).
- `@prisma/client` + `prisma` (dev dep) added to `server/package.json`;
  `npx prisma generate` produces the typed client into
  `node_modules/@prisma/client` (default location, not customized).

## Verification approach

Empirical, matching this project's established discipline (every claim
about tool behavior gets run, not assumed) — this plan proves the
schema and generated client actually work, not just that
`prisma migrate dev` exits 0:

1. `npx prisma migrate dev --name init` creates the SQLite file and the
   first migration; confirm the migration SQL matches the schema above
   (five `CREATE TABLE` statements).
2. `npx prisma generate` succeeds and the generated client's types
   include all five models.
3. A small script (kept as a real Vitest test, not a throwaway) does a
   full round-trip through the generated client: create a `Group`,
   create a `Player` on it with a JSON-encoded `aliases` array, create
   a `Session`, add that player to `SessionRoster`, create a `Pairing`
   with JSON-encoded `teamA`/`teamB`, then read every row back and
   confirm `JSON.parse` on the JSON columns returns the original
   arrays. This is the step that actually proves decision #1 (JSON
   columns) works end-to-end, not just that the column accepts a
   string.
4. Confirm `npm test` (the full `server/` suite, including this new
   test) and `npx nest build` both still pass — this schema/client
   addition must not regress the Task 2 cross-boundary engine import
   proof from the scaffold plan.

## Non-goals

- API endpoints that use this client (§8.3) — separate plan.
- Migrating `RosterService`/`LiveSessionService` off `localStorage`
  (§8.6) — separate plan, comes after the API layer exists.
- Seed data / fixtures — not needed yet, nothing consumes this DB
  outside the round-trip test above until the API layer lands.
