# Prisma Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite + Prisma to `server/` — schema, first migration, generated typed client — and prove the client actually persists and reads back every model correctly, including the JSON-encoded array columns. No API endpoints yet.

**Architecture:** Five models (`Group`, `Player`, `Session`, `SessionRoster`, `Waitlist`, `Pairing`) per the design spec. Arrays (`Player.aliases`, `Pairing.teamA`/`teamB`) are JSON-encoded `String` columns — SQLite/Prisma has no array column type, and nothing here needs to query into individual elements. `Group`/`Session` use their existing `code` string as primary key (no separate internal id). `Session.rosterPlayerIds` becomes an explicit `SessionRoster` join table, symmetric with the existing `Waitlist` design. `Group.lastSessionCode` is dropped — derivable via a query, not stored.

**Tech Stack:** Prisma 7.10.0 (schema + migrate + generated client — pinned, see Global Constraints), `@prisma/client` 7.10.0, `@prisma/adapter-better-sqlite3` 7.10.0 (Prisma 7 requires an explicit driver adapter at runtime, even for SQLite), SQLite (`server/prisma/dev.db`, gitignored), Vitest (existing).

**Spec:** `docs/superpowers/specs/2026-09-04-prisma-schema-design.md`

## Global Constraints

- Run all commands with `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` prefixed — this machine's default `node` (22.22.2) is below the Angular/Nest toolchain's floor; the pinned nvm version is required.
- All commands run from `server/` unless noted otherwise.
- `server/prisma/dev.db` and `server/prisma/dev.db-journal` are build artifacts (the local SQLite file) — gitignored, never committed. `server/prisma/migrations/` IS committed — it's the schema's history.
- `server/.env` (holds `DATABASE_URL`) is gitignored; `server/.env.example` (same var, placeholder value) is committed so a fresh clone knows what to create.
- **Pin `prisma` and `@prisma/client` to `7.10.0` explicitly.** Confirmed live: the `prisma` package's npm `latest` dist-tag currently points to an `8.0.0-rc` pre-release with a completely different CLI (no `migrate`/`generate`/`validate` — a "Developer Platform" CLI with `orm`/`migration`/`db` subcommands instead). `@prisma/client`'s `latest` tag, separately, is the stable `7.10.0`. An unpinned `npm install prisma @prisma/client` installs mismatched majors. Always install with explicit `@7.10.0` on both.
- **Prisma 7 removed `datasource.url` from `schema.prisma` entirely.** Connection config for the CLI (`migrate`, `generate`, etc.) now lives in a `server/prisma7.config.ts` file (the CLI's own generated name for this version, not `prisma.config.ts`) that imports `dotenv/config` and calls `defineConfig({ schema, migrations, datasource: { url: process.env['DATABASE_URL'] } })`. The CLI auto-loads this config file by its filename — no extra flag needed.
- **`PrismaClient` requires an explicit driver adapter at runtime, even for SQLite** — `new PrismaClient()` with no arguments throws `PrismaClientInitializationError: ... A driver adapter is required`. Use `@prisma/adapter-better-sqlite3`: `new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }) })`. Note the adapter class is exported as `PrismaBetterSqlite3` (lowercase `ql3`), not `PrismaBetterSQLite3`.
- **`file:./dev.db` in `DATABASE_URL` resolves relative to `process.cwd()`, not `schema.prisma`'s directory** — the driver adapter is a generic SQLite driver, not Prisma-schema-aware, so it resolves the path the way any Node file access would. Running `prisma migrate dev` from `server/` with `DATABASE_URL="file:./dev.db"` puts the database at `server/dev.db`, not `server/prisma/dev.db`. Use `file:./prisma/dev.db` explicitly so the db file lands next to `prisma/migrations/` as intended.
- The Prisma CLI (`migrate`, `generate`, `validate`, etc.) loads env vars via `server/prisma7.config.ts`'s own `import 'dotenv/config'` — not automatically from `.env` on its own in this version. Vitest does **not** auto-load `.env` either; Task 2 handles that explicitly via `dotenv` in `vitest.config.ts`.
- This plan must not regress the NestJS scaffold's cross-boundary engine import (`docs/superpowers/plans/2026-09-04-nestjs-scaffold.md`, Task 2) — the full `npm test` and `npx nest build` must stay green throughout.

---

## File Structure

- Create: `server/prisma/schema.prisma` — the five models, no `datasource.url` (Prisma 7).
- Create: `server/prisma7.config.ts` — CLI connection config (schema path, migrations path, `DATABASE_URL`).
- Create: `server/.env` — `DATABASE_URL`, gitignored.
- Create: `server/.env.example` — same var, placeholder, committed.
- Modify: `server/.gitignore` — add `.env`, `prisma/dev.db`, `prisma/dev.db-journal`.
- Modify: `server/package.json` — `prisma@7.10.0` (dev dep), `@prisma/client@7.10.0` (dep), `@prisma/adapter-better-sqlite3@7.10.0` (dep), `dotenv` (dev dep).
- Modify: `server/vitest.config.ts` — load `.env` into `process.env` before tests run.
- Create: `server/src/prisma-roundtrip.spec.ts` — the round-trip proof.
- Create (generated, not hand-written): `server/prisma/migrations/<timestamp>_init/migration.sql`.

---

### Task 1: Prisma schema, env files, and dependencies

**Files:**
- Create: `server/prisma/schema.prisma`
- Create: `server/prisma7.config.ts`
- Create: `server/.env`
- Create: `server/.env.example`
- Modify: `server/.gitignore`
- Modify: `server/package.json`

**Interfaces:**
- Produces: a syntactically valid `schema.prisma` with five models (`Group`, `Player`, `Session`, `SessionRoster`, `Waitlist`, `Pairing`) that Task 2 migrates and generates a client from.

- [ ] **Step 1: Install dependencies**

Pin explicitly — see Global Constraints on why the unpinned `latest` tag is wrong here.

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm install @prisma/client@7.10.0 @prisma/adapter-better-sqlite3@7.10.0
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm install -D prisma@7.10.0 dotenv
```

- [ ] **Step 2: Write the schema**

Create `server/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "sqlite"
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

- [ ] **Step 3: Write `prisma7.config.ts`**

Create `server/prisma7.config.ts`:

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
```

- [ ] **Step 4: Write the env files**

Create `server/.env`:

```
DATABASE_URL="file:./prisma/dev.db"
```

Create `server/.env.example`:

```
DATABASE_URL="file:./prisma/dev.db"
```

Note the explicit `prisma/` prefix — `file:./dev.db` resolves relative to `process.cwd()` (wherever the command is run from), not the schema's directory, and would put the db file at `server/dev.db` instead of alongside `prisma/migrations/`.

- [ ] **Step 5: Update `.gitignore`**

Modify `server/.gitignore`, append:

```
.env
prisma/dev.db
prisma/dev.db-journal
```

- [ ] **Step 6: Verify the schema is valid**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx prisma validate
```

Expected: `Loaded Prisma config from prisma7.config.ts.` then `The schema at prisma/schema.prisma is valid 🚀`. This only checks syntax/relations — it does not create a database or a client; that's Task 2.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma7.config.ts server/.env.example server/.gitignore server/package.json server/package-lock.json
git commit -m "chore: add Prisma schema for Group/Player/Session/Pairing"
```

(`server/.env` is gitignored — do not add it.)

---

### Task 2: Round-trip proof (TDD)

**Files:**
- Modify: `server/vitest.config.ts`
- Create: `server/src/prisma-roundtrip.spec.ts`
- Create (generated): `server/prisma/migrations/<timestamp>_init/migration.sql`

**Interfaces:**
- Consumes: `schema.prisma` from Task 1.
- Produces: a running SQLite database matching the schema, and a generated `@prisma/client` the (future, separate-plan) API layer imports from.

- [ ] **Step 1: Load `.env` into vitest**

Modify `server/vitest.config.ts`:

```ts
import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `server/src/prisma-roundtrip.spec.ts`:

```ts
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

describe('Prisma schema round-trip', () => {
  it('persists and reads back every model, including JSON-encoded array columns', async () => {
    const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const group = await prisma.group.create({
        data: { code: 'test-group', name: 'Test Group' },
      });

      const player = await prisma.player.create({
        data: {
          groupId: group.code,
          name: 'Alice',
          aliases: JSON.stringify(['Al', 'Ally']),
        },
      });

      const session = await prisma.session.create({
        data: {
          code: 'test-session',
          groupId: group.code,
          date: '2026-09-04',
          venue: 'Court A',
          courtCount: 2,
          rawImportText: '1. Alice',
        },
      });

      await prisma.sessionRoster.create({
        data: { sessionId: session.code, playerId: player.id },
      });

      const pairing = await prisma.pairing.create({
        data: {
          sessionId: session.code,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([player.id, player.id]),
          teamB: JSON.stringify([player.id, player.id]),
        },
      });

      const readBackPlayer = await prisma.player.findUniqueOrThrow({
        where: { id: player.id },
      });
      const readBackPairing = await prisma.pairing.findUniqueOrThrow({
        where: { id: pairing.id },
      });
      const roster = await prisma.sessionRoster.findMany({
        where: { sessionId: session.code },
      });

      expect(JSON.parse(readBackPlayer.aliases)).toEqual(['Al', 'Ally']);
      expect(JSON.parse(readBackPairing.teamA)).toEqual([player.id, player.id]);
      expect(JSON.parse(readBackPairing.teamB)).toEqual([player.id, player.id]);
      expect(roster.map((r) => r.playerId)).toEqual([player.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: 'test-session' } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: 'test-session' } });
      await prisma.session.deleteMany({ where: { code: 'test-session' } });
      await prisma.player.deleteMany({ where: { groupId: 'test-group' } });
      await prisma.group.deleteMany({ where: { code: 'test-group' } });
      await prisma.$disconnect();
    }
  });
});
```

The `finally` block deletes everything the test created — the test uses fixed codes (`test-group`/`test-session`) so re-running it without cleanup would fail on the unique `code` constraint the second time.

- [ ] **Step 3: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: FAIL — `server/src/prisma-roundtrip.spec.ts` fails the whole suite with `Error: Cannot find module '.prisma/client/default'` (no migration has been applied and no client output exists yet). The other two spec files still pass; only this new one fails.

- [ ] **Step 4: Migrate and generate**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx prisma migrate dev --name init
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx prisma generate
```

Expected: `migrate dev` creates `server/prisma/dev.db` and writes `server/prisma/migrations/<timestamp>_init/migration.sql` (six `CREATE TABLE` statements — five models plus the two `@@unique` indexes on `SessionRoster`/`Waitlist`). It does not reliably auto-run `generate` in this version — run `generate` explicitly as its own step regardless of what `migrate dev`'s own output claims, and confirm the `✔ Generated Prisma Client ... to ./node_modules/@prisma/client` line.

- [ ] **Step 5: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: `Test Files  3 passed (3)`, `Tests  3 passed (3)` (the two from the scaffold plan, plus this one).

- [ ] **Step 6: Confirm no regression in the scaffold's build proof**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
```

Expected: PASS, same as the scaffold plan's Task 2 — this schema/client addition must not break the cross-boundary engine import. Delete `server/dist` afterward (build artifact, not committed) and check `git status` at the repo root before committing — the scaffold plan's Task 2 found a stale-`tsbuildinfo` hazard that can transiently pollute the repo root here too.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/migrations server/src/prisma-roundtrip.spec.ts server/vitest.config.ts
git commit -m "feat: prove Prisma schema round-trips every model via generated client"
```

(`server/prisma/dev.db` is gitignored — do not add it.)

---

## Post-implementation

Update `PROJECT.md`:
- §9 checklist: check off `DB schema created (Group, Player, Session, Pairing, Waitlist)` under Infra.
- Note in §8.4 that the schema is built and the round-trip is proven, including the three representation decisions (JSON columns, `SessionRoster` join table, derived `lastSessionCode`) and a pointer to the design spec. Note that the API layer (§8.3) is the next plan.
