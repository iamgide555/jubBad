# Player Roster Dashboard Implementation Plan

Status: Implemented and merged (`797d182`, 2026-09-18). Archived 2026-09-21.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a host a page per group (`/g/:groupCode/players`) to view and inline-edit each player's name/age/email/phone, with a rank/rating/win-rate column set — host-only, never reachable by an anonymous or non-owning caller.

**Architecture:** Add three nullable columns to `Player`. Two new `GroupsController` routes, neither `@Public()`, so the existing global `OwnershipGuard` (matches on `:code` under `/groups/`) scopes both to the group's owner with no guard changes: `GET /groups/:code/players/manage` (full contact info + rating/winRate, computed group-wide in one pass) and `PUT /groups/:code/players/:playerId` (update one player). The existing `@Public() GET /groups/:code/players` (id/name/aliases only) is untouched, which is what keeps contact info off the public, no-login player-stats path. A new Angular page mirrors `admin.ts`'s inline-edit-per-row pattern, reached via a link added to `group-entry.html`.

**Tech Stack:** NestJS + Prisma + class-validator (server), Angular 22 standalone components + signals + `FormsModule` (web), Vitest (both).

**Spec:** `docs/archive/specs/2026-09-18-player-roster-dashboard-design.md`

## Global Constraints

- New server routes are never `@Public()` — contact info must never be reachable without the host's session cookie (spec: "Data model" / "API" sections).
- `PUT /groups/:code/players/:playerId` is a full replace: the client always submits all four fields; a field left out of the JSON body clears that column to `null` server-side. There is no partial-patch semantics to preserve.
- Rank/Rating/Win% columns are display-only — never editable, never sent in the update PUT body.
- Age: optional int 0–120. Email: optional, RFC-shape via `class-validator`'s `IsEmail`. Phone: optional, `^[0-9+\- ]{6,20}$`. Validated both client (component) and server (DTO) — server is the source of truth.
- Server tests run with `cd server && npx vitest run <file> --no-file-parallelism` is unnecessary (the project's `vitest.config.ts` already sets `fileParallelism: false`); just `cd server && npx vitest run <file>`.
- Web tests run with `cd web && npx ng test --watch=false`.
- Follow existing i18n convention: every user-facing string gets `i18n="@@playerRoster.<key>"` (new pages use their own prefix — see `admin.*`, `entry.*` for precedent).

---

## File Structure

- Modify: `server/prisma/schema.prisma` — add `age`, `email`, `phone` to `Player`.
- Create: `server/prisma/migrations/20260918120000_add_player_contact_info/migration.sql`
- Create: `server/src/groups/dto/update-player.dto.ts`
- Modify: `server/src/groups/groups.service.ts` — add `listPlayersManage`, `updatePlayer`.
- Modify: `server/src/groups/groups.controller.ts` — add the two routes.
- Modify: `server/src/groups/groups.controller.spec.ts` — new route tests.
- Create: `server/src/groups/list-players-manage.spec.ts` — ranking/win-rate computation tests.
- Modify: `web/src/app/core/roster.service.ts` — add `getPlayersManage`, `updatePlayer`, `ManagedPlayer` interface.
- Modify: `web/src/app/core/roster.service.spec.ts` — tests for the two new methods.
- Create: `web/src/app/pages/player-roster/player-roster.ts`
- Create: `web/src/app/pages/player-roster/player-roster.html`
- Create: `web/src/app/pages/player-roster/player-roster.css`
- Create: `web/src/app/pages/player-roster/player-roster.spec.ts`
- Modify: `web/src/app/app.routes.ts` — register the route.
- Modify: `web/src/app/pages/group-entry/group-entry.html` — link to the new page.
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts` — assert the link exists.

---

### Task 1: Data model — `Player` contact fields

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/20260918120000_add_player_contact_info/migration.sql`

**Interfaces:**
- Produces: `Player.age: number | null`, `Player.email: string | null`, `Player.phone: string | null` on the Prisma client, consumed by Task 3/4.

- [ ] **Step 1: Edit the schema**

In `server/prisma/schema.prisma`, change the `Player` model (currently):

```prisma
model Player {
  id      String @id @default(cuid())
  groupId String
  name    String
  aliases String // JSON-encoded string[]
  group   Group  @relation(fields: [groupId], references: [code])
  rosterEntries SessionRoster[]
  waitlistEntries Waitlist[]
}
```

to:

```prisma
model Player {
  id      String @id @default(cuid())
  groupId String
  name    String
  aliases String // JSON-encoded string[]
  age     Int?
  email   String?
  phone   String?
  group   Group  @relation(fields: [groupId], references: [code])
  rosterEntries SessionRoster[]
  waitlistEntries Waitlist[]
}
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260918120000_add_player_contact_info/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Player" ADD COLUMN "age" INTEGER;
ALTER TABLE "Player" ADD COLUMN "email" TEXT;
ALTER TABLE "Player" ADD COLUMN "phone" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd server && npx prisma generate`
Expected: completes with no errors; `node_modules/.prisma/client` now types `age`/`email`/`phone` on `Player`.

- [ ] **Step 4: Verify the migration applies cleanly**

Run: `cd server && npx vitest run src/groups/groups.controller.spec.ts`
Expected: PASS — the global test setup (`test/vitest-global-setup.ts`) runs `prisma migrate deploy` against a fresh temp DB before every run, so this proves the new migration file is valid and ordered correctly after the existing ones.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260918120000_add_player_contact_info
git commit -m "feat: add age/email/phone columns to Player"
```

---

### Task 2: `UpdatePlayerDto`

**Files:**
- Create: `server/src/groups/dto/update-player.dto.ts`

**Interfaces:**
- Produces: `class UpdatePlayerDto { name: string; age?: number; email?: string; phone?: string }`, consumed by Task 4 (service) and Task 5 (controller).

- [ ] **Step 1: Write the DTO**

```ts
import { IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdatePlayerDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age?: number;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Matches(/^[0-9+\- ]{6,20}$/)
  phone?: string;
}
```

This has no standalone test — like every other DTO in `server/src/**/dto/`, it is exercised through the controller integration tests in Task 5, which assert both the 200 success shape and the 400 validation-failure shape.

- [ ] **Step 2: Commit**

```bash
git add server/src/groups/dto/update-player.dto.ts
git commit -m "feat: add UpdatePlayerDto"
```

---

### Task 3: `GroupsService.listPlayersManage` — group-wide ranking

**Files:**
- Modify: `server/src/groups/groups.service.ts`
- Create: `server/src/groups/list-players-manage.spec.ts`

**Interfaces:**
- Consumes: `PairCount` (already declared at the top of `groups.service.ts`), `computeRatingTracks`/`STARTING_RATING` (already imported at the top of `groups.service.ts` from `'../../../engines/elo.ts'`), `this.finishedMatches(groupCode)` (existing private method, `groups.service.ts:129`).
- Produces: `GroupsService.listPlayersManage(code: string): Promise<{ id: string; name: string; aliases: string[]; age: number | null; email: string | null; phone: string | null; rating: number; singlesRating: number | null; winRate: number | null }[]>`, consumed by Task 5 (controller) and Task 6 (web `RosterService`, via the HTTP response shape).

- [ ] **Step 1: Write the failing test**

Create `server/src/groups/list-players-manage.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsService } from './groups.service.js';

describe('GroupsService.listPlayersManage', () => {
  let service: GroupsService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupsService],
    }).compile();
    service = moduleRef.get(GroupsService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('returns contact info untouched and null rating stats for a player with no matches', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Solo', aliases: '[]' },
    });

    const rows = await service.listPlayersManage(code);

    expect(rows).toEqual([
      {
        id: player.id,
        name: 'Solo',
        aliases: [],
        age: null,
        email: null,
        phone: null,
        rating: 1200,
        singlesRating: null,
        winRate: null,
      },
    ]);
  });

  it('carries age/email/phone through, and computes rating/winRate from match history', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, foe] = await Promise.all([
      prisma.player.create({
        data: {
          groupId: code,
          name: 'Me',
          aliases: '[]',
          age: 30,
          email: 'me@example.test',
          phone: '0812345678',
        },
      }),
      prisma.player.create({ data: { groupId: code, name: 'Foe', aliases: '[]' } }),
    ]);
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    // Singles match, Me beats Foe.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id]),
        teamB: JSON.stringify([foe.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    const rows = await service.listPlayersManage(code);
    const meRow = rows.find((r) => r.id === me.id)!;
    const foeRow = rows.find((r) => r.id === foe.id)!;

    expect(meRow.age).toBe(30);
    expect(meRow.email).toBe('me@example.test');
    expect(meRow.phone).toBe('0812345678');
    expect(meRow.winRate).toBe(1);
    expect(meRow.singlesRating).not.toBeNull();
    expect(meRow.rating).toBe(1200); // never played doubles

    expect(foeRow.age).toBeNull();
    expect(foeRow.winRate).toBe(0);
    expect(foeRow.singlesRating).not.toBeNull();
  });

  it('treats an abandoned (no-winner) match as played but not decisive for winRate', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, foe] = await Promise.all([
      prisma.player.create({ data: { groupId: code, name: 'Me', aliases: '[]' } }),
      prisma.player.create({ data: { groupId: code, name: 'Foe', aliases: '[]' } }),
    ]);
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id]),
        teamB: JSON.stringify([foe.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        // no winner: abandoned
      },
    });

    const rows = await service.listPlayersManage(code);
    const meRow = rows.find((r) => r.id === me.id)!;
    expect(meRow.winRate).toBeNull();
    expect(meRow.singlesRating).toBeNull(); // computeRatingTracks only replays decisive matches
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/groups/list-players-manage.spec.ts`
Expected: FAIL with `service.listPlayersManage is not a function`.

- [ ] **Step 3: Implement `listPlayersManage`**

In `server/src/groups/groups.service.ts`, add this method (a good spot is directly after `listPlayers`, `groups.service.ts:96`):

```ts
  async listPlayersManage(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    const matches = await this.finishedMatches(code);
    const decisiveMatches = matches.filter(
      (m): m is typeof m & { winner: 'A' | 'B' } => m.winner !== null
    );
    const ratings = computeRatingTracks(decisiveMatches);

    // Overall played/won/decisive per player, across both formats, in one
    // pass over every match — the group-wide equivalent of the per-player
    // tally playerStats builds for a single target player.
    const tally = new Map<string, PairCount>();
    const bump = (id: string, win: boolean, decisive: boolean) => {
      const row = tally.get(id) ?? { played: 0, won: 0, decisive: 0 };
      row.played += 1;
      if (decisive) row.decisive += 1;
      if (win) row.won += 1;
      tally.set(id, row);
    };
    for (const match of matches) {
      const decisive = match.winner !== null;
      for (const id of match.teamA) bump(id, match.winner === 'A', decisive);
      for (const id of match.teamB) bump(id, match.winner === 'B', decisive);
    }

    return players.map((p) => {
      const row = tally.get(p.id);
      return {
        id: p.id,
        name: p.name,
        aliases: JSON.parse(p.aliases) as string[],
        age: p.age,
        email: p.email,
        phone: p.phone,
        rating: Math.round(ratings.doubles.get(p.id) ?? STARTING_RATING),
        singlesRating: ratings.singles.has(p.id) ? Math.round(ratings.singles.get(p.id)!) : null,
        winRate: !row || row.decisive === 0 ? null : row.won / row.decisive,
      };
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/groups/list-players-manage.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/groups/groups.service.ts server/src/groups/list-players-manage.spec.ts
git commit -m "feat: add GroupsService.listPlayersManage with group-wide rating/winRate"
```

---

### Task 4: `GroupsService.updatePlayer`

**Files:**
- Modify: `server/src/groups/groups.service.ts`

**Interfaces:**
- Consumes: `UpdatePlayerDto` (Task 2).
- Produces: `GroupsService.updatePlayer(code: string, playerId: string, dto: UpdatePlayerDto): Promise<{ id: string; name: string; aliases: string[]; age: number | null; email: string | null; phone: string | null }>`, consumed by Task 5 (controller). Throws `NotFoundException` when `playerId` does not belong to the group at `code`.

- [ ] **Step 1: Implement it directly (exercised by Task 5's controller tests, not a standalone unit test — same pattern as `update()` at `groups.service.ts:79`, which also has no isolated test)**

Add to `server/src/groups/groups.service.ts`, directly after the new `listPlayersManage`:

```ts
  async updatePlayer(code: string, playerId: string, dto: UpdatePlayerDto) {
    const player = await this.prisma.player.findFirst({ where: { id: playerId, groupId: code } });
    if (!player) throw new NotFoundException();

    const updated = await this.prisma.player.update({
      where: { id: playerId },
      data: {
        name: dto.name,
        age: dto.age ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
      },
    });
    return {
      id: updated.id,
      name: updated.name,
      aliases: JSON.parse(updated.aliases) as string[],
      age: updated.age,
      email: updated.email,
      phone: updated.phone,
    };
  }
```

Add the import at the top of the file, alongside the existing DTO imports:

```ts
import type { UpdatePlayerDto } from './dto/update-player.dto.js';
```

- [ ] **Step 2: Commit**

```bash
git add server/src/groups/groups.service.ts
git commit -m "feat: add GroupsService.updatePlayer"
```

(Verification happens in Task 5, since this method has no route to reach it yet — committing here keeps each commit buildable without a dangling unused-export lint issue, and Task 5's tests cover both methods together.)

---

### Task 5: Wire the two routes + controller tests

**Files:**
- Modify: `server/src/groups/groups.controller.ts`
- Modify: `server/src/groups/groups.controller.spec.ts`

**Interfaces:**
- Consumes: `GroupsService.listPlayersManage`, `GroupsService.updatePlayer` (Tasks 3–4), `UpdatePlayerDto` (Task 2).
- Produces: `GET /groups/:code/players/manage` (200 → array), `PUT /groups/:code/players/:playerId` (200 → updated player, 400 → validation error, 404 → unknown/foreign player), both scoped by the existing `OwnershipGuard` (no guard changes — see the spec's "API" section for why).

- [ ] **Step 1: Write the failing tests**

Append to `server/src/groups/groups.controller.spec.ts` (inside the existing `describe('GroupsController', ...)` block, before its closing `});`):

```ts
  describe('GET players/manage', () => {
    it('returns contact info and rating stats for every player in the group', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({
        data: { groupId: code, name: 'Me', aliases: '[]', age: 30, email: 'me@example.test', phone: '0812345678' },
      });

      try {
        const res = await request(server).get(`/groups/${code}/players/manage`).expect(200);
        expect(res.body).toEqual([
          {
            id: player.id,
            name: 'Me',
            aliases: [],
            age: 30,
            email: 'me@example.test',
            phone: '0812345678',
            rating: 1200,
            singlesRating: null,
            winRate: null,
          },
        ]);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('404s for a group that does not exist', async () => {
      await request(server).get(`/groups/${randomUUID()}/players/manage`).expect(404);
    });
  });

  describe('PUT players/:playerId', () => {
    it('updates name/age/email/phone', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        const res = await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'New', age: 25, email: 'new@example.test', phone: '0899999999' })
          .expect(200);
        expect(res.body).toMatchObject({
          id: player.id,
          name: 'New',
          age: 25,
          email: 'new@example.test',
          phone: '0899999999',
        });
        const stored = await prisma.player.findUnique({ where: { id: player.id } });
        expect(stored?.name).toBe('New');
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('clears age/email/phone to null when the request omits them', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({
        data: { groupId: code, name: 'Old', aliases: '[]', age: 40, email: 'x@example.test', phone: '0811111111' },
      });

      try {
        await request(server).put(`/groups/${code}/players/${player.id}`).send({ name: 'Old' }).expect(200);
        const stored = await prisma.player.findUnique({ where: { id: player.id } });
        expect(stored?.age).toBeNull();
        expect(stored?.email).toBeNull();
        expect(stored?.phone).toBeNull();
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('rejects an invalid email with 400', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'Old', email: 'not-an-email' })
          .expect(400);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('rejects an out-of-range age with 400', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'Old', age: 200 })
          .expect(400);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('404s for a player that belongs to a different group', async () => {
      const code = randomUUID();
      const otherCode = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      await prisma.group.create({ data: { code: otherCode, name: 'Other' } });
      const foreign = await prisma.player.create({ data: { groupId: otherCode, name: 'Foreign', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${foreign.id}`)
          .send({ name: 'Hacked' })
          .expect(404);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: { in: [code, otherCode] } } });
        await prisma.group.deleteMany({ where: { code: { in: [code, otherCode] } } });
      }
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/groups/groups.controller.spec.ts`
Expected: FAIL with 404s (routes not wired yet).

- [ ] **Step 3: Wire the routes**

In `server/src/groups/groups.controller.ts`, add the import:

```ts
import { UpdatePlayerDto } from './dto/update-player.dto.js';
```

Add these two routes (a good spot is directly after `listPlayers`, `groups.controller.ts:44`):

```ts
  /**
   * Gated (unlike the @Public() listPlayers above): full contact info, so
   * this must never be reachable without the host's session cookie.
   */
  @Get(':code/players/manage')
  listPlayersManage(@Param('code') code: string) {
    return this.groupsService.listPlayersManage(code);
  }

  @Put(':code/players/:playerId')
  updatePlayer(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: UpdatePlayerDto
  ) {
    return this.groupsService.updatePlayer(code, playerId, dto);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/groups/groups.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the auth boundary spec to confirm the new routes stay behind auth with no changes needed there**

Run: `cd server && npx vitest run src/auth/auth.boundary.spec.ts`
Expected: PASS. This file walks every declared route on the real router (`declaredRoutes()`, `auth.boundary.spec.ts:56`) and asserts anything not in its `PUBLIC_ROUTES` list refuses an anonymous caller (401) and a non-owning caller (404) — the two new routes are picked up automatically since neither is `@Public()`. If this fails, stop and re-check that neither new route accidentally got `@Public()`.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add server/src/groups/groups.controller.ts server/src/groups/groups.controller.spec.ts
git commit -m "feat: add players/manage and player update routes"
```

---

### Task 6: `RosterService` web methods

**Files:**
- Modify: `web/src/app/core/roster.service.ts`
- Modify: `web/src/app/core/roster.service.spec.ts`

**Interfaces:**
- Produces: `export interface ManagedPlayer { id: string; name: string; aliases: string[]; age: number | null; email: string | null; phone: string | null; rating: number; singlesRating: number | null; winRate: number | null }`, `RosterService.getPlayersManage(groupCode: string): Observable<ManagedPlayer[]>`, `RosterService.updatePlayer(groupCode: string, playerId: string, patch: { name: string; age?: number; email?: string; phone?: string }): Observable<{ id: string; name: string; aliases: string[]; age: number | null; email: string | null; phone: string | null }>`. Both consumed by Task 7 (`PlayerRoster` component).

- [ ] **Step 1: Write the failing tests**

Append to `web/src/app/core/roster.service.spec.ts` (before the closing `});`):

```ts
  it('getPlayersManage requests GET /groups/:code/players/manage', () => {
    let result: unknown;
    service.getPlayersManage('group1').subscribe((p) => (result = p));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/players/manage`);
    expect(req.request.method).toBe('GET');
    const body = [
      {
        id: 'p1',
        name: 'ตั้ม',
        aliases: [],
        age: 30,
        email: 'tam@example.test',
        phone: '0812345678',
        rating: 1200,
        singlesRating: null,
        winRate: null,
      },
    ];
    req.flush(body);

    expect(result).toEqual(body);
  });

  it('updatePlayer sends PUT /groups/:code/players/:playerId with the given fields', () => {
    let result: unknown;
    service.updatePlayer('group1', 'p1', { name: 'ตั้ม', age: 31 }).subscribe((p) => (result = p));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/players/p1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'ตั้ม', age: 31 });
    const body = { id: 'p1', name: 'ตั้ม', aliases: [], age: 31, email: null, phone: null };
    req.flush(body);

    expect(result).toEqual(body);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx ng test --watch=false`
Expected: FAIL with `service.getPlayersManage is not a function`.

- [ ] **Step 3: Implement the service methods**

In `web/src/app/core/roster.service.ts`, add the interface near the top (after `ParseRosterResponse`):

```ts
export interface ManagedPlayer {
  id: string;
  name: string;
  aliases: string[];
  age: number | null;
  email: string | null;
  phone: string | null;
  rating: number;
  singlesRating: number | null;
  winRate: number | null;
}

export interface UpdatePlayerRequest {
  name: string;
  age?: number;
  email?: string;
  phone?: string;
}
```

Add these two methods to the `RosterService` class, after `getPlayers`:

```ts
  getPlayersManage(groupCode: string) {
    return this.http.get<ManagedPlayer[]>(`${this.base}/groups/${groupCode}/players/manage`);
  }

  updatePlayer(groupCode: string, playerId: string, patch: UpdatePlayerRequest) {
    return this.http.put<{
      id: string;
      name: string;
      aliases: string[];
      age: number | null;
      email: string | null;
      phone: string | null;
    }>(`${this.base}/groups/${groupCode}/players/${playerId}`, patch);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx ng test --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/roster.service.ts web/src/app/core/roster.service.spec.ts
git commit -m "feat: add RosterService.getPlayersManage and updatePlayer"
```

---

### Task 7: `PlayerRoster` component logic

**Files:**
- Create: `web/src/app/pages/player-roster/player-roster.ts`

**Interfaces:**
- Consumes: `RosterService.getPlayersManage`, `RosterService.updatePlayer`, `ManagedPlayer` (Task 6).
- Produces: `class PlayerRoster` with public members used by the template in Task 8: `groupCode: string`, `players: Signal<ManagedPlayer[]>`, `loaded: Signal<boolean>`, `loadError: Signal<boolean>`, `sortKey: Signal<'rating' | 'singlesRating' | 'winRate'>`, `sortedPlayers: Signal<ManagedPlayer[]>`, `setSortKey(key): void`, `editingId: Signal<string | null>`, `editName/editAge/editEmail/editPhone: Signal<string>`, `editError: Signal<string | null>`, `editBusy: Signal<boolean>`, `startEdit(player): void`, `cancelEdit(): void`, `saveEdit(player): Promise<void>`.

- [ ] **Step 1: Write the component**

```ts
import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RosterService, type ManagedPlayer } from '../../core/roster.service';

type SortKey = 'rating' | 'singlesRating' | 'winRate';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\- ]{6,20}$/;

@Component({
  selector: 'app-player-roster',
  imports: [FormsModule, RouterLink, DecimalPipe],
  templateUrl: './player-roster.html',
  styleUrl: './player-roster.css',
})
export class PlayerRoster {
  private readonly rosterService = inject(RosterService);

  readonly groupCode: string;
  readonly players = signal<ManagedPlayer[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);

  // Rank always reflects whichever metric is currently sorted, not a fixed
  // column — see the design spec's "Frontend" section.
  readonly sortKey = signal<SortKey>('rating');

  readonly sortedPlayers = computed(() => {
    const key = this.sortKey();
    return [...this.players()].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // nulls sort last regardless of metric
      if (bv === null) return -1;
      return bv - av; // descending
    });
  });

  constructor(route: ActivatedRoute) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const players = await firstValueFrom(this.rosterService.getPlayersManage(this.groupCode));
      this.players.set(players);
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  setSortKey(key: SortKey): void {
    this.sortKey.set(key);
  }

  // ---- inline edit ----

  readonly editingId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editAge = signal('');
  readonly editEmail = signal('');
  readonly editPhone = signal('');
  readonly editError = signal<string | null>(null);
  readonly editBusy = signal(false);

  startEdit(player: ManagedPlayer): void {
    this.editingId.set(player.id);
    this.editName.set(player.name);
    this.editAge.set(player.age === null ? '' : String(player.age));
    this.editEmail.set(player.email ?? '');
    this.editPhone.set(player.phone ?? '');
    this.editError.set(null);
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  /** Client-side mirror of UpdatePlayerDto's rules — the server is the source of truth. */
  private validate(): string | null {
    if (!this.editName().trim()) return $localize`:@@playerRoster.errNoName:กรุณาใส่ชื่อ`;
    const age = this.editAge().trim();
    if (age) {
      const n = Number(age);
      if (!Number.isInteger(n) || n < 0 || n > 120) {
        return $localize`:@@playerRoster.errBadAge:อายุต้องเป็นตัวเลข 0-120`;
      }
    }
    const email = this.editEmail().trim();
    if (email && !EMAIL_RE.test(email)) {
      return $localize`:@@playerRoster.errBadEmail:รูปแบบอีเมลไม่ถูกต้อง`;
    }
    const phone = this.editPhone().trim();
    if (phone && !PHONE_RE.test(phone)) {
      return $localize`:@@playerRoster.errBadPhone:รูปแบบเบอร์โทรไม่ถูกต้อง`;
    }
    return null;
  }

  async saveEdit(player: ManagedPlayer): Promise<void> {
    const error = this.validate();
    if (error) {
      this.editError.set(error);
      return;
    }

    this.editBusy.set(true);
    this.editError.set(null);
    try {
      const age = this.editAge().trim();
      const email = this.editEmail().trim();
      const phone = this.editPhone().trim();
      const updated = await firstValueFrom(
        this.rosterService.updatePlayer(this.groupCode, player.id, {
          name: this.editName().trim(),
          age: age ? Number(age) : undefined,
          email: email || undefined,
          phone: phone || undefined,
        })
      );
      this.players.update((list) =>
        list.map((p) => (p.id === player.id ? { ...p, ...updated } : p))
      );
      this.editingId.set(null);
    } catch {
      this.editError.set($localize`:@@playerRoster.saveFailed:บันทึกไม่สำเร็จ`);
    } finally {
      this.editBusy.set(false);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/app/pages/player-roster/player-roster.ts
git commit -m "feat: add PlayerRoster component logic"
```

(No test run yet — `styleUrl`/`templateUrl` point at files Task 8 creates next; the component won't compile standalone until then. Tests for this logic live in Task 9, once the template exists to drive them through.)

---

### Task 8: `PlayerRoster` template + styles

**Files:**
- Create: `web/src/app/pages/player-roster/player-roster.html`
- Create: `web/src/app/pages/player-roster/player-roster.css`

**Interfaces:**
- Consumes: every public member of `PlayerRoster` listed in Task 7.

- [ ] **Step 1: Write the template**

```html
<div class="page player-roster">
  <p><a [routerLink]="['/g', groupCode]" i18n="@@playerRoster.back">← กลับ</a></p>
  <h1 i18n="@@playerRoster.title">ผู้เล่นในก๊วน</h1>

  @if (!loaded()) {
    <p class="muted" i18n="@@playerRoster.loading">กำลังโหลด…</p>
  } @else if (loadError()) {
    <p class="error" role="alert" i18n="@@playerRoster.loadFailed">โหลดข้อมูลไม่สำเร็จ</p>
  } @else {
    <table class="roster-table">
      <thead>
        <tr>
          <th i18n="@@playerRoster.colName">ชื่อ</th>
          <th i18n="@@playerRoster.colAge">อายุ</th>
          <th i18n="@@playerRoster.colEmail">อีเมล</th>
          <th i18n="@@playerRoster.colPhone">เบอร์โทร</th>
          <th></th>
          <th>
            <button type="button" class="ghost sort-head" [class.active]="sortKey() === 'rating'" (click)="setSortKey('rating')">
              <ng-container i18n="@@playerRoster.colRatingDoubles">เรตติ้งคู่</ng-container>
            </button>
          </th>
          <th>
            <button type="button" class="ghost sort-head" [class.active]="sortKey() === 'singlesRating'" (click)="setSortKey('singlesRating')">
              <ng-container i18n="@@playerRoster.colRatingSingles">เรตติ้งเดี่ยว</ng-container>
            </button>
          </th>
          <th>
            <button type="button" class="ghost sort-head" [class.active]="sortKey() === 'winRate'" (click)="setSortKey('winRate')">
              <ng-container i18n="@@playerRoster.colWinRate">อัตราชนะ</ng-container>
            </button>
          </th>
          <th i18n="@@playerRoster.colRank">อันดับ</th>
        </tr>
      </thead>
      <tbody>
        @for (player of sortedPlayers(); track player.id; let i = $index) {
          <tr>
            @if (editingId() === player.id) {
              <td>
                <input type="text" [ngModel]="editName()" (ngModelChange)="editName.set($event)" name="editName-{{ player.id }}" />
              </td>
              <td>
                <input type="number" min="0" max="120" [ngModel]="editAge()" (ngModelChange)="editAge.set($event)" name="editAge-{{ player.id }}" />
              </td>
              <td>
                <input type="email" [ngModel]="editEmail()" (ngModelChange)="editEmail.set($event)" name="editEmail-{{ player.id }}" />
              </td>
              <td>
                <input type="tel" [ngModel]="editPhone()" (ngModelChange)="editPhone.set($event)" name="editPhone-{{ player.id }}" />
              </td>
              <td class="roster-actions" colspan="5">
                @if (editError()) {
                  <p class="error" role="alert">{{ editError() }}</p>
                }
                <button type="button" [disabled]="editBusy()" (click)="saveEdit(player)" i18n="@@playerRoster.save">บันทึก</button>
                <button type="button" class="ghost" (click)="cancelEdit()" i18n="@@playerRoster.cancel">ยกเลิก</button>
              </td>
            } @else {
              <td>{{ player.name }}</td>
              <td>{{ player.age ?? '—' }}</td>
              <td>{{ player.email ?? '—' }}</td>
              <td>{{ player.phone ?? '—' }}</td>
              <td>
                <button type="button" class="ghost" (click)="startEdit(player)" i18n="@@playerRoster.edit">แก้ไข</button>
              </td>
              <td class="tabular">{{ player.rating }}</td>
              <td class="tabular">{{ player.singlesRating ?? '—' }}</td>
              <td class="tabular">
                @if (player.winRate === null) {
                  —
                } @else {
                  {{ player.winRate * 100 | number: '1.0-0' }}%
                }
              </td>
              <td class="tabular">{{ i + 1 }}</td>
            }
          </tr>
        }
      </tbody>
    </table>
  }
</div>
```

(The template's `| number` pipe above is `DecimalPipe`, already imported and registered on `PlayerRoster` in Task 7.)

- [ ] **Step 2: Write the styles**

```css
/* Wider than the default .page column (32rem) — this page is a table, which
   needs the room, same reasoning as admin.css's .admin override. */
.player-roster {
  max-width: 64rem;
}

.roster-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: var(--space-2);
}

.roster-table th,
.roster-table td {
  text-align: left;
  padding: var(--space-1);
  border-bottom: 1px solid var(--court-line);
  vertical-align: top;
}

.roster-table th {
  color: var(--ink-soft);
  font-weight: 600;
  font-size: var(--text-sm);
}

.sort-head {
  padding: 0;
  font: inherit;
  color: inherit;
}

.sort-head.active {
  color: var(--accent-ink);
  font-weight: 700;
}

.roster-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

@media (max-width: 700px) {
  .roster-table {
    display: block;
    overflow-x: auto;
    white-space: nowrap;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/app/pages/player-roster/player-roster.html web/src/app/pages/player-roster/player-roster.css web/src/app/pages/player-roster/player-roster.ts
git commit -m "feat: add PlayerRoster template and styles"
```

---

### Task 9: Register the route + `PlayerRoster` spec

**Files:**
- Modify: `web/src/app/app.routes.ts`
- Create: `web/src/app/pages/player-roster/player-roster.spec.ts`

**Interfaces:**
- Consumes: `PlayerRoster` (Tasks 7–8), `adminGuard` (`web/src/app/core/admin.guard.ts`).

- [ ] **Step 1: Register the route**

In `web/src/app/app.routes.ts`, add this entry before the existing `'g/:groupCode'` route (matching the file's own convention: "Before 'g/:groupCode' so the deeper path wins the match" — see the comment on the `'g/:groupCode/p/:playerId'` entry just above it):

```ts
  {
    // Before 'g/:groupCode' so the deeper path wins the match.
    // Guarded: full contact info, host-only — never @Public() on the server.
    path: 'g/:groupCode/players',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/player-roster/player-roster').then((m) => m.PlayerRoster),
  },
```

- [ ] **Step 2: Write the component spec**

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { PlayerRoster } from './player-roster';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

const PLAYERS = [
  {
    id: 'p1',
    name: 'ตั้ม',
    aliases: [],
    age: 30,
    email: 'tam@example.test',
    phone: '0812345678',
    rating: 1250,
    singlesRating: null,
    winRate: 0.5,
  },
  {
    id: 'p2',
    name: 'มด',
    aliases: [],
    age: null,
    email: null,
    phone: null,
    rating: 1180,
    singlesRating: 1300,
    winRate: null,
  },
];

describe('PlayerRoster', () => {
  let component: PlayerRoster;
  let fixture: ComponentFixture<PlayerRoster>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlayerRoster],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PlayerRoster);
    component = fixture.componentInstance;

    httpMock.expectOne(`${B}/groups/group1/players/manage`).flush(PLAYERS);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => httpMock.verify());

  it('loads and lists players', () => {
    expect(component.players()).toEqual(PLAYERS);
  });

  it('sorts by doubles rating descending by default', () => {
    expect(component.sortedPlayers().map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('sorts nulls last when switching to singlesRating', () => {
    component.setSortKey('singlesRating');
    // p2 has a singlesRating (1300), p1's is null and must sort last.
    expect(component.sortedPlayers().map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('starts an edit prefilled with the player row, submitting an update', async () => {
    component.startEdit(PLAYERS[0]);
    expect(component.editName()).toBe('ตั้ม');
    expect(component.editAge()).toBe('30');

    component.editName.set('ตั้ม2');
    const savePromise = component.saveEdit(PLAYERS[0]);

    const req = httpMock.expectOne(`${B}/groups/group1/players/p1`);
    expect(req.request.body).toEqual({
      name: 'ตั้ม2',
      age: 30,
      email: 'tam@example.test',
      phone: '0812345678',
    });
    req.flush({ id: 'p1', name: 'ตั้ม2', aliases: [], age: 30, email: 'tam@example.test', phone: '0812345678' });
    await savePromise;

    expect(component.editingId()).toBeNull();
    expect(component.players().find((p) => p.id === 'p1')?.name).toBe('ตั้ม2');
  });

  it('rejects an out-of-range age client-side without calling the server', async () => {
    component.startEdit(PLAYERS[0]);
    component.editAge.set('999');
    await component.saveEdit(PLAYERS[0]);

    expect(component.editError()).toBeTruthy();
    httpMock.expectNone(`${B}/groups/group1/players/p1`);
  });

  it('cancelEdit clears the editing state', () => {
    component.startEdit(PLAYERS[0]);
    component.cancelEdit();
    expect(component.editingId()).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd web && npx ng test --watch=false`
Expected: PASS (all `PlayerRoster` tests, no regressions elsewhere).

- [ ] **Step 4: Commit**

```bash
git add web/src/app/app.routes.ts web/src/app/pages/player-roster/player-roster.spec.ts
git commit -m "feat: register /g/:groupCode/players route"
```

---

### Task 10: Link from `GroupEntry`

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `component.groupCode` (already exists on `GroupEntry`, `group-entry.ts:19`).

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/pages/group-entry/group-entry.spec.ts` (before the closing `});`):

```ts
  it('links to the player roster page', () => {
    const links = [...fixture.nativeElement.querySelectorAll('a')] as HTMLAnchorElement[];
    const manage = links.find((a) => a.getAttribute('href') === '/g/group1/players');
    expect(manage).toBeTruthy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx ng test --watch=false`
Expected: FAIL — no such link yet.

- [ ] **Step 3: Add the link**

In `web/src/app/pages/group-entry/group-entry.html`, add a line right before the existing "จัดการก๊วน" (manage group) toggle button (around line 53–54):

```html
    <p><a [routerLink]="['/g', groupCode, 'players']" i18n="@@entry.managePlayers">จัดการผู้เล่น →</a></p>

    <hr class="rule" />
    <button type="button" class="ghost" (click)="showDanger.set(!showDanger())" i18n="@@entry.manageGroup">จัดการก๊วน</button>
```

(This replaces only the two lines immediately preceding the existing `<button ... i18n="@@entry.manageGroup">` — the `<hr class="rule" />` and button lines stay exactly as they are; only the new `<p>` line is inserted above them.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx ng test --watch=false`
Expected: PASS, no regressions in the rest of `group-entry.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry/group-entry.html web/src/app/pages/group-entry/group-entry.spec.ts
git commit -m "feat: link to player roster page from group entry"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite from the repo root**

Run: `npm test`
Expected: PASS — `test:engines`, `server` (`vitest run`), and `web` (`ng test`) all green, no regressions.

- [ ] **Step 2: Manually verify in the running app**

Start the server (`cd server && npm run start:dev`) and the web app (`cd web && npm start`), log in as a host, open an existing group's `/g/:groupCode`, click "จัดการผู้เล่น →", confirm the table loads, edit a player's age/email/phone and save, confirm the row updates, click a rating/win% column header and confirm the sort order and rank column change together.

No commit for this task — it is a checkpoint, not a code change.

---

## Implementation Notes (post-merge)

Tasks 1–10 landed one commit each as planned (`a23c76d` through `64de21a`),
merged in `797d182`. Three follow-up fixes changed the page after merge, and
two of them depart from this plan and its spec:

- **Contact columns are no longer shown in the row view** (`9380fe3`).
  Age, email and phone appear only as inputs while a row is being edited. The
  collapsed row is ลำดับ, ชื่อ, เรตติ้งคู่, เรตติ้งเดี่ยว, อัตราชนะ, then the edit
  button. The spec's table-columns list describes the earlier layout.
- **An in-progress edit is guarded against navigation** (`9a62d47`, `199986e`).
  Other rows' edit buttons and the back link are disabled while a row is being
  edited. A `CanDeactivate` route guard (`web/src/app/core/can-deactivate.guard.ts`)
  and a `beforeunload` handler cover what the disabled link could not: browser
  back, swipe-back, a typed URL, reload and tab close. The plan had no guard
  at all.
- Accessibility pass in the same fix (`9a62d47`): `aria-sort` on the three
  sortable headers, `scope="col"` on every header, and an sr-only label on the
  actions column. The active sort header changed from `--accent-ink` to `--ink`,
  because the accent color is reserved for "act now".

The checkboxes above were left unticked during the build; the commits are the
record of what was done. Task 11's manual check is not recorded anywhere.
