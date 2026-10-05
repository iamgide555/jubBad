> **Archived 2026-10-05.** Shipped and deployed. The checklist below was not ticked as the work went, so the boxes are left as written rather than checked retroactively; `docs/overview.md` is the source of truth for current behaviour.

# Group Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each group one public, token-keyed dashboard (session list linking to existing summaries, plus participation-only standings) that the host shares once instead of pasting a summary after every session.

**Architecture:** A nullable unique `Group.shareToken` is the credential. Three owner-guarded routes (`GET/POST/DELETE /groups/:code/share`) manage it; one `@Public()` route (`GET /dashboards/:token`) serves a read model built from confirmed `Pairing` rows by two pure builders. The web app adds a lazy public page at `/d/:token` and a lazily-loaded share panel on the group entry page.

**Tech Stack:** NestJS + Prisma 7 + SQLite + vitest (server); Angular 22 standalone components, signals, `httpResource`, `$localize` (web).

**Spec:** `docs/archive/specs/2026-10-02-group-dashboard-design.md`

## Global Constraints

- Branch `feat/group-dashboard`; never commit to `main` (it runs real weekly sessions).
- Public response contains NO player id, rating, level, win/loss, contact data. Standings fields are exactly `name`, `sessionsAttended`, `gamesPlayed`.
- Sessions list: newest first, at most 30; an ended session with no confirmed match is omitted; a live session is always listed.
- Only `confirmedAt != null` pairings count (a proposed match has not happened).
- Owner-mismatch on the share routes is a 404, never a 403 (existing `OwnershipGuard`); a missing group on those routes is also 404 (the guard lets an unclaimed code through, the service must refuse it).
- Server tests run with `fileParallelism: false`; do not change that.
- Web: Thai-primary (`$localize` / `i18n="@@id"`), English added by hand to `web/src/locale/messages.en.xlf` (`messages.xlf` is stale and is not touched). Translatable strings carry no interpolation: put numbers in their own element beside a unit label, like `entry.matches` does.
- No typeface may drop Thai coverage; page must work at phone width (opened from LINE).
- The dashboard has NO link to `/g/:groupCode/p/:playerId` and no host-view link.
- `server/src/auth/auth.boundary.spec.ts` and `web/src/app/app.routes.spec.ts` must agree on the new public route.
- Before deploying (not part of this plan): check for undeployed migrations before rebuilding the home server.

## Review Focus

Inputs and conditions the spec implies but no happy-path test covers, most likely first. Each has a test in the task that owns the code.

1. Two hosts' (or one double-tap) racing `POST /share` must yield one token, not two (Task 1, `group-share.spec.ts`).
2. Revoke then re-share must kill the old link and mint a different token (Task 1).
3. A custom-mode draft pairing with a null seat and `confirmedAt = null` must not crash or count (Task 2, `group-dashboard.spec.ts`).
4. A pairing naming a player id that no longer exists (deleted player) must be skipped, not crash (Task 2, `dashboard-standings.spec.ts`).
5. Group with zero sessions, a live session with no matches yet, an ended never-played session, and more than 30 sessions (Task 2 server; Task 3 empty state).

---

### Task 1: Share token (schema, service, routes)

**Files:**
- Modify: `server/prisma/schema.prisma` (Group model)
- Create: `server/prisma/migrations/20261002100000_group_share_token/migration.sql`
- Create: `server/src/groups/group-share.service.ts`
- Create: `server/src/groups/group-share.spec.ts`
- Create: `server/src/groups/group-share.controller.spec.ts`
- Modify: `server/src/groups/groups.controller.ts`
- Modify: `server/src/groups/groups.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (`../prisma/prisma.service.js`).
- Produces: `newShareToken(): string`; `GroupShareService` with `get(code): Promise<{ token: string | null }>`, `enable(code): Promise<{ token: string | null }>`, `disable(code): Promise<{ token: null }>` (all throw `NotFoundException` for an unknown group). Routes `GET|POST|DELETE /groups/:code/share`. `Group.shareToken` Prisma field (used by Task 2).

- [ ] **Step 1: Add the column to the schema**

In `server/prisma/schema.prisma`, inside `model Group`, after the `levelLadderRevision` line add:

```prisma
  /// Credential for the group's public dashboard (/d/:token). Null = not
  /// shared. Random and revocable on purpose: a group code is chosen by the
  /// host, so it is guessable and cannot gate a public page. See
  /// docs/archive/specs/2026-10-02-group-dashboard-design.md.
  shareToken          String? @unique
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20261002100000_group_share_token/migration.sql`:

```sql
-- Public group dashboard credential. Plain ADD COLUMN + index, not a table
-- redefine: a redefine of "Group" would drop any column another migration
-- added to it.
ALTER TABLE "Group" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "Group_shareToken_key" ON "Group"("shareToken");
```

- [ ] **Step 3: Regenerate the client**

Run: `cd server && npx prisma generate`
Expected: "Generated Prisma Client". (Tests build their DB from the migration folder, so `migrate deploy` happens in the vitest global setup.)

- [ ] **Step 4: Write the failing service tests**

Create `server/src/groups/group-share.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupShareService, newShareToken } from './group-share.service.js';

describe('newShareToken', () => {
  it('is 22 URL-safe characters (128 bits) and different every time', () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });
});

describe('GroupShareService', () => {
  let service: GroupShareService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupShareService],
    }).compile();
    service = moduleRef.get(GroupShareService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  async function makeGroup() {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'Share' } });
    return code;
  }

  it('reports no token for a group that was never shared', async () => {
    const code = await makeGroup();
    expect(await service.get(code)).toEqual({ token: null });
  });

  it('refuses a group that does not exist', async () => {
    const code = randomUUID();
    await expect(service.get(code)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.enable(code)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disable(code)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enable creates a token, and a second enable returns the same one', async () => {
    const code = await makeGroup();
    const first = await service.enable(code);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await service.enable(code)).toEqual(first);
    expect(await service.get(code)).toEqual(first);
  });

  it('racing enables mint exactly one token', async () => {
    const code = await makeGroup();
    const results = await Promise.all(Array.from({ length: 6 }, () => service.enable(code)));
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
  });

  it('disable clears the token; sharing again mints a different one', async () => {
    const code = await makeGroup();
    const { token: old } = await service.enable(code);
    expect(await service.disable(code)).toEqual({ token: null });
    expect(await service.get(code)).toEqual({ token: null });
    const { token: fresh } = await service.enable(code);
    expect(fresh).not.toBe(old);
  });

  it('tokens are unique across groups', async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    expect((await service.enable(a)).token).not.toBe((await service.enable(b)).token);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd server && npx vitest run src/groups/group-share.spec.ts`
Expected: FAIL, cannot resolve `./group-share.service.js`.

- [ ] **Step 6: Implement the service**

Create `server/src/groups/group-share.service.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** 16 random bytes as base64url: 22 URL-safe characters, 128 bits. */
export function newShareToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Owns the group's public-dashboard credential. Every method refuses an
 * unknown group itself: OwnershipGuard deliberately lets a code with no group
 * through (that is how a new group gets claimed), so the guard cannot be the
 * thing that 404s here.
 */
@Injectable()
export class GroupShareService {
  constructor(private readonly prisma: PrismaService) {}

  async get(code: string): Promise<{ token: string | null }> {
    const group = await this.prisma.group.findUnique({
      where: { code },
      select: { shareToken: true },
    });
    if (!group) throw new NotFoundException();
    return { token: group.shareToken };
  }

  /**
   * Idempotent. The write only matches a group that has no token yet, and
   * SQLite serializes writers, so of any number of racing calls exactly one
   * mints a token and the rest re-read it. That is what keeps a double-tap
   * from rotating the link the host already pinned in LINE.
   */
  async enable(code: string): Promise<{ token: string | null }> {
    await this.prisma.group.updateMany({
      where: { code, shareToken: null },
      data: { shareToken: newShareToken() },
    });
    return this.get(code);
  }

  async disable(code: string): Promise<{ token: null }> {
    const { count } = await this.prisma.group.updateMany({
      where: { code },
      data: { shareToken: null },
    });
    if (count === 0) throw new NotFoundException();
    return { token: null };
  }
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `cd server && npx vitest run src/groups/group-share.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Write the failing route test**

Create `server/src/groups/group-share.controller.spec.ts` (same stand-in-caller setup as `groups.controller.spec.ts`; ownership and anonymous refusal are proven by `auth.boundary.spec.ts` in Task 2):

```ts
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

describe('group share routes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const admin = await prisma.user.create({
      data: { email: `share-ctrl-${randomUUID()}@example.test`, passwordHash: 'test', role: 'admin' },
    });
    adminId = admin.id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: adminId, role: 'admin' };
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('walks the lifecycle: none -> share -> same on re-share -> stop', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Lifecycle' } });
    try {
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });

      const created = await request(server).post(`/groups/${code}/share`).expect(201);
      expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const again = await request(server).post(`/groups/${code}/share`).expect(201);
      expect(again.body).toEqual(created.body);
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual(created.body);

      expect((await request(server).delete(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });
      expect((await request(server).get(`/groups/${code}/share`).expect(200)).body).toEqual({ token: null });
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('404s all three verbs for a group that does not exist', async () => {
    const code = randomUUID();
    await request(server).get(`/groups/${code}/share`).expect(404);
    await request(server).post(`/groups/${code}/share`).expect(404);
    await request(server).delete(`/groups/${code}/share`).expect(404);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `cd server && npx vitest run src/groups/group-share.controller.spec.ts`
Expected: FAIL, the routes return 404 for the lifecycle test (not registered).

- [ ] **Step 10: Wire the routes and module**

In `server/src/groups/groups.controller.ts` add the import and constructor parameter:

```ts
import { GroupShareService } from './group-share.service.js';
```

Change the constructor to:

```ts
  constructor(
    private readonly groupsService: GroupsService,
    private readonly groupLevels: GroupLevelsService,
    private readonly groupShare: GroupShareService
  ) {}
```

Add these routes directly after `saveLevels` (before the `list()` doc comment):

```ts
  /**
   * Owner-only (no @Public): whether this group's public dashboard is shared.
   * The dashboard itself is GET /dashboards/:token (DashboardsController).
   */
  @Get(':code/share')
  getShare(@Param('code') code: string) {
    return this.groupShare.get(code);
  }

  /** Idempotent: sharing twice returns the same token, never rotates it. */
  @Post(':code/share')
  enableShare(@Param('code') code: string) {
    return this.groupShare.enable(code);
  }

  /** Stop sharing: the old link 404s immediately. */
  @Delete(':code/share')
  disableShare(@Param('code') code: string) {
    return this.groupShare.disable(code);
  }
```

In `server/src/groups/groups.module.ts` add `GroupShareService` to the import list and to `providers`:

```ts
import { GroupShareService } from './group-share.service.js';
// ...
  providers: [GroupsService, GroupLevelsService, GroupShareService],
```

- [ ] **Step 11: Run both specs and the groups suite**

Run: `cd server && npx vitest run src/groups`
Expected: PASS (all groups specs, including the new two).

- [ ] **Step 12: Commit**

```bash
git add server/prisma server/src/groups
git commit -m "feat(server): per-group share token and owner routes

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 2: Public dashboard read model and route

**Files:**
- Create: `server/src/groups/dashboard-standings.ts`
- Create: `server/src/groups/dashboard-standings.spec.ts`
- Create: `server/src/groups/group-dashboard.service.ts`
- Create: `server/src/groups/group-dashboard.spec.ts`
- Create: `server/src/groups/dashboards.controller.ts`
- Modify: `server/src/groups/groups.module.ts`
- Modify: `server/src/auth/auth.boundary.spec.ts`

**Interfaces:**
- Consumes: `Group.shareToken` (Task 1); `teamPlayers(pairing)` from `../sessions/pairing-teams.js` (returns `string[]`, throws `CorruptPairingError` on a corrupt row).
- Produces:
  - `DashboardMatch { sessionCode: string; playerIds: string[] }`
  - `StandingRow { name: string; sessionsAttended: number; gamesPlayed: number }`
  - `DashboardSession { code: string; date: string | null; createdAt: string; venue: string | null; playerCount: number; matchCount: number; live: boolean }`
  - `buildStandings(matches: DashboardMatch[], names: ReadonlyMap<string, string>): StandingRow[]`
  - `buildSessionList(sessions: DashboardSessionInput[], matches: DashboardMatch[]): DashboardSession[]`, `DASHBOARD_SESSION_LIMIT = 30`
  - `GroupDashboardService.get(token): Promise<{ groupName: string | null; lastSessionDate: string | null; sessions: DashboardSession[]; standings: StandingRow[] }>` (404 on unknown/revoked token)
  - Route `GET /dashboards/:token` (`@Public()`).

- [ ] **Step 1: Write the failing builder tests**

Create `server/src/groups/dashboard-standings.spec.ts`:

```ts
import {
  DASHBOARD_SESSION_LIMIT,
  buildSessionList,
  buildStandings,
  type DashboardMatch,
} from './dashboard-standings.js';

const names = new Map([
  ['a', 'Ann'],
  ['b', 'Ben'],
  ['c', 'Cat'],
  ['d', 'Dan'],
]);

describe('buildStandings', () => {
  it('ranks by sessions attended, then games played, then name', () => {
    const matches: DashboardMatch[] = [
      { sessionCode: 's1', playerIds: ['a', 'b', 'c', 'd'] },
      { sessionCode: 's1', playerIds: ['a', 'b', 'c', 'd'] },
      { sessionCode: 's2', playerIds: ['a', 'b'] },
      { sessionCode: 's2', playerIds: ['a', 'c'] },
    ];
    // a: 2 sessions/4 games; b: 2/3; c: 2/3; d: 1/2.
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 2, gamesPlayed: 4 },
      { name: 'Ben', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Cat', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Dan', sessionsAttended: 1, gamesPlayed: 2 },
    ]);
  });

  it('counts a session once however many games a player had in it', () => {
    const matches: DashboardMatch[] = [
      { sessionCode: 's1', playerIds: ['a'] },
      { sessionCode: 's1', playerIds: ['a'] },
      { sessionCode: 's1', playerIds: ['a'] },
    ];
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 1, gamesPlayed: 3 },
    ]);
  });

  it('skips a player id that no longer exists instead of crashing', () => {
    const matches: DashboardMatch[] = [{ sessionCode: 's1', playerIds: ['a', 'deleted'] }];
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 1, gamesPlayed: 1 },
    ]);
  });

  it('returns nothing for no matches', () => {
    expect(buildStandings([], names)).toEqual([]);
  });

  it('exposes exactly name, sessionsAttended and gamesPlayed', () => {
    const [row] = buildStandings([{ sessionCode: 's1', playerIds: ['a'] }], names);
    expect(Object.keys(row).sort()).toEqual(['gamesPlayed', 'name', 'sessionsAttended']);
  });
});

describe('buildSessionList', () => {
  const at = (iso: string) => new Date(iso);
  const base = { date: null, venue: null };

  it('counts matches and distinct players per session from confirmed matches', () => {
    const list = buildSessionList(
      [{ code: 's1', ...base, createdAt: at('2026-09-01'), endedAt: at('2026-09-01') }],
      [
        { sessionCode: 's1', playerIds: ['a', 'b'] },
        { sessionCode: 's1', playerIds: ['a', 'c'] },
      ]
    );
    expect(list).toEqual([
      {
        code: 's1',
        date: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        venue: null,
        playerCount: 3,
        matchCount: 2,
        live: false,
      },
    ]);
  });

  it('drops an ended session nobody played but keeps a live one with no matches yet', () => {
    const list = buildSessionList(
      [
        { code: 'live', ...base, createdAt: at('2026-09-03'), endedAt: null },
        { code: 'never', ...base, createdAt: at('2026-09-02'), endedAt: at('2026-09-02') },
        { code: 'played', ...base, createdAt: at('2026-09-01'), endedAt: at('2026-09-01') },
      ],
      [{ sessionCode: 'played', playerIds: ['a', 'b'] }]
    );
    expect(list.map((s) => [s.code, s.live])).toEqual([
      ['live', true],
      ['played', false],
    ]);
  });

  it('keeps the input order (newest first) and stops at the limit', () => {
    const sessions = Array.from({ length: DASHBOARD_SESSION_LIMIT + 2 }, (_, i) => ({
      code: `s${i}`,
      ...base,
      createdAt: at('2026-09-01'),
      endedAt: at('2026-09-01'),
    }));
    const matches = sessions.map((s) => ({ sessionCode: s.code, playerIds: ['a'] }));
    const list = buildSessionList(sessions, matches);
    expect(list).toHaveLength(DASHBOARD_SESSION_LIMIT);
    expect(list[0].code).toBe('s0');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/groups/dashboard-standings.spec.ts`
Expected: FAIL, cannot resolve `./dashboard-standings.js`.

- [ ] **Step 3: Implement the builders**

Create `server/src/groups/dashboard-standings.ts`:

```ts
/**
 * Pure read-model builders for the public group dashboard. Kept free of
 * Prisma so the ranking rules are testable without a database.
 *
 * Deliberately participation-only: no rating, level or win/loss, and no
 * player id leaves this file. A public ranked skill list would put the
 * weakest players in front of the whole chat (docs/overview.md, Ratings).
 */

export const DASHBOARD_SESSION_LIMIT = 30;

/** One confirmed match: the session it belongs to and everyone on court. */
export interface DashboardMatch {
  sessionCode: string;
  playerIds: string[];
}

export interface StandingRow {
  name: string;
  sessionsAttended: number;
  gamesPlayed: number;
}

export interface DashboardSessionInput {
  code: string;
  date: string | null;
  venue: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface DashboardSession {
  code: string;
  date: string | null;
  createdAt: string;
  venue: string | null;
  playerCount: number;
  matchCount: number;
  live: boolean;
}

/**
 * All-time, over confirmed matches only. "Attended" means in at least one
 * confirmed match that session, so a rostered no-show does not count. A
 * player id with no name (the player was deleted) is skipped.
 */
export function buildStandings(
  matches: DashboardMatch[],
  names: ReadonlyMap<string, string>
): StandingRow[] {
  const games = new Map<string, number>();
  const sessions = new Map<string, Set<string>>();
  for (const match of matches) {
    for (const id of match.playerIds) {
      games.set(id, (games.get(id) ?? 0) + 1);
      const seen = sessions.get(id) ?? new Set<string>();
      seen.add(match.sessionCode);
      sessions.set(id, seen);
    }
  }

  const rows: StandingRow[] = [];
  for (const [id, gamesPlayed] of games) {
    const name = names.get(id);
    if (name === undefined) continue;
    rows.push({ name, sessionsAttended: sessions.get(id)!.size, gamesPlayed });
  }
  return rows.sort(
    (a, b) =>
      b.sessionsAttended - a.sessionsAttended ||
      b.gamesPlayed - a.gamesPlayed ||
      a.name.localeCompare(b.name)
  );
}

/**
 * `sessions` must already be newest first. An ended session with no confirmed
 * match (created, never played) is dropped: it has nothing to show. A live
 * session is always kept, even before its first match is confirmed.
 */
export function buildSessionList(
  sessions: DashboardSessionInput[],
  matches: DashboardMatch[]
): DashboardSession[] {
  const matchCount = new Map<string, number>();
  const players = new Map<string, Set<string>>();
  for (const match of matches) {
    matchCount.set(match.sessionCode, (matchCount.get(match.sessionCode) ?? 0) + 1);
    const seen = players.get(match.sessionCode) ?? new Set<string>();
    for (const id of match.playerIds) seen.add(id);
    players.set(match.sessionCode, seen);
  }

  const list: DashboardSession[] = [];
  for (const s of sessions) {
    const live = s.endedAt === null;
    const count = matchCount.get(s.code) ?? 0;
    if (!live && count === 0) continue;
    list.push({
      code: s.code,
      date: s.date,
      createdAt: s.createdAt.toISOString(),
      venue: s.venue,
      playerCount: players.get(s.code)?.size ?? 0,
      matchCount: count,
      live,
    });
    if (list.length === DASHBOARD_SESSION_LIMIT) break;
  }
  return list;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run src/groups/dashboard-standings.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing service tests**

Create `server/src/groups/group-dashboard.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupDashboardService } from './group-dashboard.service.js';
import { DASHBOARD_SESSION_LIMIT } from './dashboard-standings.js';

describe('GroupDashboardService', () => {
  let service: GroupDashboardService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupDashboardService],
    }).compile();
    service = moduleRef.get(GroupDashboardService);
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

  async function makeGroup(name: string | null = 'Dash') {
    const code = randomUUID();
    const token = randomUUID().replace(/-/g, '').slice(0, 22);
    codes.push(code);
    await prisma.group.create({ data: { code, name, shareToken: token } });
    return { code, token };
  }

  const makePlayer = (groupId: string, name: string) =>
    prisma.player.create({ data: { groupId, name, aliases: '[]' } }).then((p) => p.id);

  const makeSession = (
    groupId: string,
    over: { date?: string; venue?: string; createdAt?: Date; ended?: boolean } = {}
  ) => {
    const code = randomUUID().slice(0, 8);
    return prisma.session
      .create({
        data: {
          code,
          groupId,
          rawImportText: '',
          date: over.date ?? null,
          venue: over.venue ?? null,
          createdAt: over.createdAt ?? new Date(),
          endedAt: over.ended === false ? null : new Date(),
        },
      })
      .then(() => code);
  };

  let matchNumber = 0;
  const addMatch = (
    sessionId: string,
    teamA: (string | null)[],
    teamB: (string | null)[],
    confirmed = true
  ) =>
    prisma.pairing.create({
      data: {
        sessionId,
        courtNumber: 1,
        matchNumber: ++matchNumber,
        teamA: JSON.stringify(teamA),
        teamB: JSON.stringify(teamB),
        confirmedAt: confirmed ? new Date() : null,
      },
    });

  it('404s an unknown token', async () => {
    await expect(service.get('nope-nope-nope-nope-no')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s once the token is revoked, and once the group is gone', async () => {
    const { code, token } = await makeGroup();
    await expect(service.get(token)).resolves.toBeDefined();

    await prisma.group.update({ where: { code }, data: { shareToken: null } });
    await expect(service.get(token)).rejects.toBeInstanceOf(NotFoundException);

    await prisma.group.update({ where: { code }, data: { shareToken: token } });
    await prisma.group.delete({ where: { code } });
    await expect(service.get(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns empty lists for a group with no sessions', async () => {
    const { token } = await makeGroup('Empty');
    expect(await service.get(token)).toEqual({
      groupName: 'Empty',
      lastSessionDate: null,
      sessions: [],
      standings: [],
    });
  });

  it('builds sessions and participation standings from confirmed matches', async () => {
    const { code, token } = await makeGroup();
    const [a, b, c, d] = await Promise.all(
      ['Ann', 'Ben', 'Cat', 'Dan'].map((n) => makePlayer(code, n))
    );
    const older = await makeSession(code, { date: '2026-09-01', createdAt: new Date('2026-09-01') });
    const newer = await makeSession(code, {
      date: '2026-09-08',
      venue: 'Gym',
      createdAt: new Date('2026-09-08'),
    });
    await addMatch(older, [a, b], [c, d]);
    await addMatch(newer, [a, b], [c, d]);
    await addMatch(newer, [a, c], [b, d]);

    const dash = await service.get(token);
    expect(dash.lastSessionDate).toBe('2026-09-08');
    expect(dash.sessions.map((s) => [s.code, s.matchCount, s.playerCount, s.live])).toEqual([
      [newer, 2, 4, false],
      [older, 1, 4, false],
    ]);
    expect(dash.sessions[0].venue).toBe('Gym');
    expect(dash.standings).toEqual([
      { name: 'Ann', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Ben', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Cat', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Dan', sessionsAttended: 2, gamesPlayed: 3 },
    ]);
  });

  it('ignores a proposed match, including a custom-mode draft with an empty seat', async () => {
    const { code, token } = await makeGroup();
    const [a, b] = await Promise.all(['Ann', 'Ben'].map((n) => makePlayer(code, n)));
    const s = await makeSession(code, { ended: false });
    await addMatch(s, [a, null], [b, null], false);
    const dash = await service.get(token);
    expect(dash.standings).toEqual([]);
    expect(dash.sessions).toEqual([expect.objectContaining({ code: s, matchCount: 0, live: true })]);
  });

  it('omits an ended session nobody played but lists a live one', async () => {
    const { code, token } = await makeGroup();
    await makeSession(code, { ended: true });
    const live = await makeSession(code, { ended: false });
    const dash = await service.get(token);
    expect(dash.sessions.map((s) => [s.code, s.live])).toEqual([[live, true]]);
  });

  it('lists only the newest 30 sessions', async () => {
    const { code, token } = await makeGroup();
    const a = await makePlayer(code, 'Ann');
    for (let i = 0; i < DASHBOARD_SESSION_LIMIT + 2; i++) {
      const s = await makeSession(code, { createdAt: new Date(2026, 0, 1 + i) });
      await addMatch(s, [a], [a]);
    }
    const dash = await service.get(token);
    expect(dash.sessions).toHaveLength(DASHBOARD_SESSION_LIMIT);
    expect(dash.standings[0].sessionsAttended).toBe(DASHBOARD_SESSION_LIMIT + 2);
  });

  it('leaks no player id, rating, level or contact data', async () => {
    const { code, token } = await makeGroup();
    const a = await prisma.player.create({
      data: { groupId: code, name: 'Ann', aliases: '[]', email: 'ann@example.test', phone: '0812345678', level: 'B' },
    });
    const s = await makeSession(code);
    await addMatch(s, [a.id], [a.id]);
    const dash = await service.get(token);
    const json = JSON.stringify(dash);
    expect(json).not.toContain(a.id);
    expect(json).not.toContain('ann@example.test');
    expect(json).not.toContain('0812345678');
    expect(json).not.toMatch(/rating|level|winRate/i);
    expect(Object.keys(dash).sort()).toEqual(['groupName', 'lastSessionDate', 'sessions', 'standings']);
    expect(Object.keys(dash.sessions[0]).sort()).toEqual([
      'code', 'createdAt', 'date', 'live', 'matchCount', 'playerCount', 'venue',
    ]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server && npx vitest run src/groups/group-dashboard.spec.ts`
Expected: FAIL, cannot resolve `./group-dashboard.service.js`.

- [ ] **Step 7: Implement the service and controller**

Create `server/src/groups/group-dashboard.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { teamPlayers } from '../sessions/pairing-teams.js';
import {
  buildSessionList,
  buildStandings,
  type DashboardMatch,
  type DashboardSession,
  type StandingRow,
} from './dashboard-standings.js';

export interface GroupDashboard {
  groupName: string | null;
  lastSessionDate: string | null;
  sessions: DashboardSession[];
  standings: StandingRow[];
}

/**
 * The read model behind the public /d/:token page. Keyed by the group's
 * revocable share token, never the group code (host-chosen, guessable). Only
 * confirmed pairings are read, so a draft with an empty seat never reaches
 * teamPlayers.
 */
@Injectable()
export class GroupDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(token: string): Promise<GroupDashboard> {
    const group = await this.prisma.group.findUnique({
      where: { shareToken: token },
      select: { code: true, name: true },
    });
    if (!group) throw new NotFoundException();

    const [sessions, pairings, players] = await Promise.all([
      this.prisma.session.findMany({
        where: { groupId: group.code },
        orderBy: { createdAt: 'desc' },
        select: { code: true, date: true, venue: true, createdAt: true, endedAt: true },
      }),
      this.prisma.pairing.findMany({
        where: { session: { groupId: group.code }, confirmedAt: { not: null } },
        select: { sessionId: true, teamA: true, teamB: true },
      }),
      this.prisma.player.findMany({
        where: { groupId: group.code },
        select: { id: true, name: true },
      }),
    ]);

    const matches: DashboardMatch[] = pairings.map((p) => ({
      sessionCode: p.sessionId,
      playerIds: teamPlayers(p),
    }));
    const list = buildSessionList(sessions, matches);

    return {
      groupName: group.name,
      lastSessionDate: list[0]?.date ?? null,
      sessions: list,
      standings: buildStandings(matches, new Map(players.map((p) => [p.id, p.name]))),
    };
  }
}
```

Create `server/src/groups/dashboards.controller.ts`:

```ts
import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { GroupDashboardService } from './group-dashboard.service.js';

@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboard: GroupDashboardService) {}

  /**
   * Public: the page a host pins in LINE. The unguessable share token is the
   * credential (same trust model as the session summary link); revoking it
   * 404s this at once. Read-only and participation-only by construction — see
   * dashboard-standings.ts.
   */
  @Public()
  @Get(':token')
  get(@Param('token') token: string) {
    return this.dashboard.get(token);
  }
}
```

In `server/src/groups/groups.module.ts` register them:

```ts
import { DashboardsController } from './dashboards.controller.js';
import { GroupDashboardService } from './group-dashboard.service.js';
// ...
  controllers: [GroupsController, DashboardsController],
  providers: [GroupsService, GroupLevelsService, GroupShareService, GroupDashboardService],
```

- [ ] **Step 8: Run the service spec**

Run: `cd server && npx vitest run src/groups/group-dashboard.spec.ts src/groups/dashboard-standings.spec.ts`
Expected: PASS.

- [ ] **Step 9: Update the boundary spec (route list, resolved param, owner flow)**

In `server/src/auth/auth.boundary.spec.ts`:

1. Add to `PUBLIC_ROUTES` (after the summary entry):

```ts
  {
    method: 'get',
    path: (c: Ctx) => `/dashboards/${c.shareToken}`,
    why: 'group dashboard link, shared by the host',
  },
```

2. Add `shareToken: string;` to `interface Ctx`.

3. In `beforeAll`, create the group with a token and put it in ctx:

```ts
    const groupCode = randomUUID();
    const shareToken = randomUUID().replace(/-/g, '').slice(0, 22);
    await prisma.group.create({
      data: { code: groupCode, name: 'Boundary', ownerId: userId, shareToken },
    });
```

and `ctx = { groupCode, sessionCode, playerId: player.id, shareToken };`

4. In BOTH `.replace(':code', code)` chains (the anonymous walk and the ownership walk) append `.replace(':token', ctx.shareToken)` so the new route resolves and is then skipped as a known public path instead of being silently skipped as "unresolved".

5. Add this test before `describe('ownership boundary', ...)`:

```ts
  it('lets the owning host share and stop sharing the dashboard', async () => {
    const login = await request(server)
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];
    const share = `/groups/${ctx.groupCode}/share`;

    try {
      await request(server).delete(share).set('Cookie', cookie).expect(200);
      await request(server).get(`/dashboards/${ctx.shareToken}`).expect(404);
      expect((await request(server).get(share).set('Cookie', cookie).expect(200)).body).toEqual({
        token: null,
      });

      const created = await request(server).post(share).set('Cookie', cookie).expect(201);
      const token = created.body.token as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect((await request(server).post(share).set('Cookie', cookie).expect(201)).body.token).toBe(token);

      // Anonymous: the whole point of the link.
      const shown = await request(server).get(`/dashboards/${token}`).expect(200);
      expect(shown.body.groupName).toBe('Boundary');

      await request(server).delete(share).set('Cookie', cookie).expect(200);
      await request(server).get(`/dashboards/${token}`).expect(404);
    } finally {
      // The ownership walks below resolve ctx.shareToken; put it back.
      await prisma.group.update({ where: { code: ctx.groupCode }, data: { shareToken: ctx.shareToken } });
    }
  });
```

- [ ] **Step 10: Run the boundary spec and the whole server suite**

Run: `cd server && npx vitest run src/auth/auth.boundary.spec.ts && npm test && npm run lint`
Expected: PASS everywhere. The anonymous walk now reports `GET/POST/DELETE /groups/<code>/share -> 401` as refused and the ownership walk reports them as 404 for a second host; if either lists a share route as leaked, the routes lost their guard and Task 1 is wrong.

- [ ] **Step 11: Commit**

```bash
git add server/src
git commit -m "feat(server): public group dashboard read model

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 3: Public dashboard page (web)

**Files:**
- Create: `web/src/app/core/dashboard.model.ts`
- Create: `web/src/app/pages/group-dashboard/group-dashboard.ts`
- Create: `web/src/app/pages/group-dashboard/group-dashboard.html`
- Create: `web/src/app/pages/group-dashboard/group-dashboard.css`
- Create: `web/src/app/pages/group-dashboard/group-dashboard.spec.ts`
- Modify: `web/src/app/app.routes.ts`
- Modify: `web/src/app/app.routes.spec.ts`
- Modify: `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: `GET /dashboards/:token` payload (Task 2) — `{ groupName: string | null; lastSessionDate: string | null; sessions: DashboardSession[]; standings: DashboardStanding[] }`.
- Produces: `Dashboard`, `DashboardSession`, `DashboardStanding` types; component `GroupDashboard`; route `d/:token` (unguarded).

- [ ] **Step 1: Write the model**

Create `web/src/app/core/dashboard.model.ts`:

```ts
/** Public group dashboard payload — GET /dashboards/:token. No player ids, ratings or levels exist in it. */
export interface DashboardSession {
  code: string;
  date: string | null;
  /** ISO timestamp; the label when `date` is null. */
  createdAt: string;
  venue: string | null;
  playerCount: number;
  matchCount: number;
  /** Not ended yet. */
  live: boolean;
}

export interface DashboardStanding {
  name: string;
  sessionsAttended: number;
  gamesPlayed: number;
}

export interface Dashboard {
  groupName: string | null;
  lastSessionDate: string | null;
  sessions: DashboardSession[];
  standings: DashboardStanding[];
}
```

- [ ] **Step 2: Write the failing page tests**

Create `web/src/app/pages/group-dashboard/group-dashboard.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { GroupDashboard } from './group-dashboard';
import { environment } from '../../../environments/environment';
import type { Dashboard } from '../../core/dashboard.model';

const B = environment.apiBaseUrl;

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    groupName: 'ก๊วนวันพฤหัส',
    lastSessionDate: '2026-09-24',
    sessions: [
      { code: 'live1', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z', venue: 'ยิมกลาง', playerCount: 8, matchCount: 3, live: true },
      { code: 'old1', date: '2026-09-24', createdAt: '2026-09-24T10:00:00.000Z', venue: null, playerCount: 12, matchCount: 9, live: false },
      { code: 'nodate', date: null, createdAt: '2026-09-17T10:00:00.000Z', venue: null, playerCount: 4, matchCount: 2, live: false },
    ],
    standings: [
      { name: 'ตั้ม', sessionsAttended: 3, gamesPlayed: 14 },
      { name: 'เบส', sessionsAttended: 2, gamesPlayed: 9 },
    ],
    ...over,
  };
}

describe('GroupDashboard', () => {
  let fixture: ComponentFixture<GroupDashboard>;
  let httpMock: HttpTestingController;

  async function load(body: Dashboard | null) {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok1' }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupDashboard);
    fixture.detectChanges();
    const req = httpMock.expectOne(`${B}/dashboards/tok1`);
    if (body) req.flush(body);
    else req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
  }

  afterEach(() => httpMock.verify());

  const el = () => fixture.nativeElement as HTMLElement;
  const hrefs = () => Array.from(el().querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('shows the group name and the last session date', async () => {
    await load(dashboard());
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนวันพฤหัส');
    expect(el().textContent).toContain('2026-09-24');
  });

  it('links each past session to its existing summary page', async () => {
    await load(dashboard());
    expect(hrefs()).toContain('/s/old1/summary');
    expect(hrefs()).toContain('/s/nodate/summary');
  });

  it('marks a live session and links it to the public venue display', async () => {
    await load(dashboard());
    expect(hrefs()).toContain('/s/live1/display');
    expect(el().querySelectorAll('.live-tag')).toHaveLength(1);
  });

  it('falls back to the created date when a session has no date', async () => {
    await load(dashboard());
    expect(el().textContent).toContain('2026-09-17');
  });

  it('lists standings in the order the server sent, with plain-text names', async () => {
    await load(dashboard());
    const rows = Array.from(el().querySelectorAll('tbody tr')).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('ตั้ม');
    expect(rows[1]).toContain('เบส');
    // Names are not links: this page must never lead to a player card.
    expect(hrefs().some((h) => h?.includes('/p/'))).toBe(false);
    expect(hrefs().some((h) => h?.startsWith('/g/'))).toBe(false);
  });

  it('shows an empty state when the group has never played', async () => {
    await load(dashboard({ sessions: [], standings: [], lastSessionDate: null }));
    expect(el().querySelector('.empty')).not.toBeNull();
    expect(el().querySelector('table')).toBeNull();
  });

  it('says the link is unavailable on a 404, without revealing why', async () => {
    await load(null);
    expect(el().querySelector('.not-found')).not.toBeNull();
    expect(el().querySelector('h1')).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd web && npx ng test --watch=false --include='src/app/pages/group-dashboard/group-dashboard.spec.ts'`
Expected: FAIL, cannot resolve `./group-dashboard`.

- [ ] **Step 4: Implement the component**

Create `web/src/app/pages/group-dashboard/group-dashboard.ts`:

```ts
import { Component, computed, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import type { Dashboard, DashboardSession } from '../../core/dashboard.model';

/**
 * The page a host pins in LINE: past sessions (each links to the existing,
 * already-public summary) and participation-only standings. Public and
 * keyed by an unguessable token. Deliberately has no link to a player card or
 * to the host's screens — see docs/overview.md, "Group dashboard".
 */
@Component({
  selector: 'app-group-dashboard',
  imports: [RouterLink],
  templateUrl: './group-dashboard.html',
  styleUrl: './group-dashboard.css',
})
export class GroupDashboard {
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token') ?? '';

  private readonly resource = httpResource<Dashboard>(
    () => `${environment.apiBaseUrl}/dashboards/${encodeURIComponent(this.token)}`
  );

  protected readonly dashboard = computed<Dashboard | undefined>(() =>
    this.resource.error() ? undefined : this.resource.value()
  );
  protected readonly notFound = computed(() => this.resource.error() !== undefined);

  /** `date` is free text from the roster header and may be absent; the created day is the honest fallback. */
  protected dateLabel(s: DashboardSession): string {
    return s.date ?? s.createdAt.slice(0, 10);
  }
}
```

Create `web/src/app/pages/group-dashboard/group-dashboard.html`:

```html
@if (dashboard(); as d) {
  <div class="page group-dashboard">
    <h1>
      @if (d.groupName) {
        {{ d.groupName }}
      } @else {
        <ng-container i18n="@@dashboard.unnamed">ก๊วนแบด</ng-container>
      }
    </h1>
    @if (d.lastSessionDate) {
      <p class="muted">
        <ng-container i18n="@@dashboard.lastPlayed">เล่นล่าสุด</ng-container>
        {{ d.lastSessionDate }}
      </p>
    }

    @if (d.sessions.length === 0) {
      <p class="empty muted" i18n="@@dashboard.empty">ยังไม่มีก๊วนที่เล่น</p>
    } @else {
      <section aria-labelledby="dash-sessions">
        <h2 id="dash-sessions" class="label" i18n="@@dashboard.sessions">ก๊วนที่ผ่านมา</h2>
        <ul class="session-list">
          @for (s of d.sessions; track s.code) {
            <li>
              <a [routerLink]="['/s', s.code, 'summary']">{{ dateLabel(s) }}</a>
              @if (s.venue) { <span class="muted">· {{ s.venue }}</span> }
              <span class="muted">· {{ s.playerCount }} <ng-container i18n="@@dashboard.people">คน</ng-container></span>
              <span class="muted">· {{ s.matchCount }} <ng-container i18n="@@dashboard.matches">แมตช์</ng-container></span>
              @if (s.live) {
                <a class="live-tag" [routerLink]="['/s', s.code, 'display']" i18n="@@dashboard.live">กำลังเล่น</a>
              }
            </li>
          }
        </ul>
      </section>

      <section aria-labelledby="dash-standings">
        <h2 id="dash-standings" class="label" i18n="@@dashboard.standings">ผู้เล่นที่มาบ่อย</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col" i18n="@@dashboard.colName">ชื่อ</th>
                <th scope="col" i18n="@@dashboard.colSessions">มา (ครั้ง)</th>
                <th scope="col" i18n="@@dashboard.colGames">เล่น (เกม)</th>
              </tr>
            </thead>
            <tbody>
              @for (p of d.standings; track $index) {
                <tr>
                  <td>{{ p.name }}</td>
                  <td>{{ p.sessionsAttended }}</td>
                  <td>{{ p.gamesPlayed }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  </div>
} @else if (notFound()) {
  <div class="page not-found">
    <h1 i18n="@@dashboard.notFoundTitle">ไม่พบหน้านี้</h1>
    <p class="muted" i18n="@@dashboard.notFoundHint">ลิงก์อาจถูกปิดแล้ว ขอลิงก์ใหม่จากเจ้าของก๊วน</p>
  </div>
}
```

Create `web/src/app/pages/group-dashboard/group-dashboard.css` (reuse the summary table treatment; mobile-first):

```css
.group-dashboard {
  display: grid;
  gap: var(--space-2);
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.session-list li {
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--rule);
  /* Long Thai venue names wrap instead of pushing the page sideways. */
  overflow-wrap: anywhere;
}

.live-tag {
  margin-left: var(--space-1);
  font-size: var(--text-xs);
  font-weight: 600;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

th,
td {
  text-align: left;
  padding: var(--space-1);
  border-bottom: 1px solid var(--rule);
  overflow-wrap: anywhere;
}

th {
  font-family: var(--font-text);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--ink-soft);
}

td:not(:first-child),
th:not(:first-child) {
  text-align: right;
}
```

- [ ] **Step 5: Run the page tests**

Run: `cd web && npx ng test --watch=false --include='src/app/pages/group-dashboard/group-dashboard.spec.ts'`
Expected: PASS (7 tests).

- [ ] **Step 6: Add the route and its spec**

In `web/src/app/app.routes.ts`, insert before the `g/:groupCode/p/:playerId` route:

```ts
  {
    // Unguarded: the group dashboard a host pins in LINE. The unguessable
    // share token in the URL is the credential (same trust model as the
    // summary link); its data endpoint is @Public() on the server to match.
    path: 'd/:token',
    loadComponent: () =>
      import('./pages/group-dashboard/group-dashboard').then((m) => m.GroupDashboard),
  },
```

In `web/src/app/app.routes.spec.ts` add the import `import { GroupDashboard } from './pages/group-dashboard/group-dashboard';` and, in a describe that shows how the other unguarded routes are tested (look at how `/s/:sessionCode/display` is asserted when signed out and mirror it exactly), add:

```ts
    it('/d/:token resolves to GroupDashboard without signing in', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/d/tok123', GroupDashboard)).toBeInstanceOf(GroupDashboard);
    });
```

Put it in the signed-OUT block (`configure(false)`), since the point is that no guard intercepts it.

- [ ] **Step 7: Add the English translations**

In `web/src/locale/messages.en.xlf`, before `</body>`, add one `trans-unit` per id, following the existing layout:

```xml
      <trans-unit id="dashboard.unnamed" datatype="html">
        <source>ก๊วนแบด</source>
        <target>Badminton group</target>
      </trans-unit>
      <trans-unit id="dashboard.lastPlayed" datatype="html">
        <source>เล่นล่าสุด</source>
        <target>Last played</target>
      </trans-unit>
      <trans-unit id="dashboard.empty" datatype="html">
        <source>ยังไม่มีก๊วนที่เล่น</source>
        <target>No sessions played yet</target>
      </trans-unit>
      <trans-unit id="dashboard.sessions" datatype="html">
        <source>ก๊วนที่ผ่านมา</source>
        <target>Past sessions</target>
      </trans-unit>
      <trans-unit id="dashboard.people" datatype="html">
        <source>คน</source>
        <target>players</target>
      </trans-unit>
      <trans-unit id="dashboard.matches" datatype="html">
        <source>แมตช์</source>
        <target>matches</target>
      </trans-unit>
      <trans-unit id="dashboard.live" datatype="html">
        <source>กำลังเล่น</source>
        <target>Playing now</target>
      </trans-unit>
      <trans-unit id="dashboard.standings" datatype="html">
        <source>ผู้เล่นที่มาบ่อย</source>
        <target>Regular players</target>
      </trans-unit>
      <trans-unit id="dashboard.colName" datatype="html">
        <source>ชื่อ</source>
        <target>Name</target>
      </trans-unit>
      <trans-unit id="dashboard.colSessions" datatype="html">
        <source>มา (ครั้ง)</source>
        <target>Sessions</target>
      </trans-unit>
      <trans-unit id="dashboard.colGames" datatype="html">
        <source>เล่น (เกม)</source>
        <target>Games</target>
      </trans-unit>
      <trans-unit id="dashboard.notFoundTitle" datatype="html">
        <source>ไม่พบหน้านี้</source>
        <target>Page not found</target>
      </trans-unit>
      <trans-unit id="dashboard.notFoundHint" datatype="html">
        <source>ลิงก์อาจถูกปิดแล้ว ขอลิงก์ใหม่จากเจ้าของก๊วน</source>
        <target>The link may have been turned off. Ask the group owner for a new one.</target>
      </trans-unit>
```

- [ ] **Step 8: Verify the whole web suite and the localized build**

Run: `cd web && npm test && npx ng build`
Expected: tests PASS; build succeeds for both locales with no "missing translation" warning for any `dashboard.*` id. A missing id means a typo between the template and the xlf.

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat(web): public group dashboard page at /d/:token

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 4: Host share panel on the group page (web)

**Files:**
- Create: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.ts`
- Create: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.html`
- Create: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.css`
- Create: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`
- Modify: `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: `GET|POST|DELETE /groups/:code/share` returning `{ token: string | null }` (Task 1); `absoluteUrl`, `copyToClipboard` from `web/src/app/core/share-link.ts`.
- Produces: `ShareDashboardPanel` (selector `app-share-dashboard-panel`, input `groupCode: string`). It loads only when rendered, so the group page stays quiet until the host opens it (existing `group-entry.spec.ts` assertions about outgoing requests must not change).

- [ ] **Step 1: Write the failing panel tests**

Create `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShareDashboardPanel } from './share-dashboard-panel';
import { environment } from '../../../environments/environment';

const URL = `${environment.apiBaseUrl}/groups/g1/share`;

describe('ShareDashboardPanel', () => {
  let fixture: ComponentFixture<ShareDashboardPanel>;
  let httpMock: HttpTestingController;

  const tick = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (name: string) => el().querySelector<HTMLButtonElement>(`[data-${name}]`);

  async function open(initial: { token: string | null } | 'missing') {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShareDashboardPanel);
    fixture.componentRef.setInput('groupCode', 'g1');
    fixture.detectChanges();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('GET');
    if (initial === 'missing') req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    else req.flush(initial);
    await tick();
  }

  afterEach(() => httpMock.verify());

  it('offers to share when nothing is shared yet', async () => {
    await open({ token: null });
    expect(button('share')).not.toBeNull();
    expect(el().querySelector('[data-link]')).toBeNull();
  });

  it('says it is unavailable for a group that does not exist yet', async () => {
    await open('missing');
    expect(button('share')).toBeNull();
    expect(el().querySelector('[data-unavailable]')).not.toBeNull();
  });

  it('creates the link, then shows it with copy and stop controls', async () => {
    await open({ token: null });
    button('share')!.click();
    const post = httpMock.expectOne(URL);
    expect(post.request.method).toBe('POST');
    post.flush({ token: 'tok123' });
    await tick();
    const input = el().querySelector<HTMLInputElement>('[data-link]')!;
    expect(input.value).toMatch(/\/d\/tok123$/);
    expect(input.readOnly).toBe(true);
    expect(button('copy')).not.toBeNull();
    expect(button('stop')).not.toBeNull();
  });

  it('copies the link and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open({ token: 'tok123' });
    button('copy')!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/d\/tok123$/));
    expect(el().querySelector('[data-copied]')).not.toBeNull();
  });

  it('tells the host to copy by hand when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    await open({ token: 'tok123' });
    button('copy')!.click();
    await tick();
    expect(el().querySelector('[data-copy-failed]')).not.toBeNull();
    expect(el().querySelector('[data-copied]')).toBeNull();
  });

  it('asks for confirmation before stopping, then clears the link', async () => {
    await open({ token: 'tok123' });
    button('stop')!.click();
    fixture.detectChanges();
    httpMock.expectNone(URL); // first tap only asks
    expect(button('confirm-stop')).not.toBeNull();

    button('confirm-stop')!.click();
    const del = httpMock.expectOne(URL);
    expect(del.request.method).toBe('DELETE');
    del.flush({ token: null });
    await tick();
    expect(el().querySelector('[data-link]')).toBeNull();
    expect(button('share')).not.toBeNull();
  });

  it('lets the host back out of stopping', async () => {
    await open({ token: 'tok123' });
    button('stop')!.click();
    fixture.detectChanges();
    button('cancel-stop')!.click();
    fixture.detectChanges();
    expect(button('confirm-stop')).toBeNull();
    expect(el().querySelector('[data-link]')).not.toBeNull();
  });

  it('shows an error and keeps the old state when sharing fails', async () => {
    await open({ token: null });
    button('share')!.click();
    httpMock.expectOne(URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await tick();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    expect(button('share')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx ng test --watch=false --include='src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts'`
Expected: FAIL, cannot resolve `./share-dashboard-panel`.

- [ ] **Step 3: Implement the panel**

Create `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.ts`:

```ts
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, type Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';

interface ShareState {
  token: string | null;
}

/**
 * Host-only controls for the group's public dashboard link. Loads when it is
 * rendered (the group page only renders it once the host opens it), so the
 * page makes no extra request until asked.
 *
 * Stopping the share breaks the link already pinned in LINE, so it takes a
 * second, explicit tap.
 */
@Component({
  selector: 'app-share-dashboard-panel',
  templateUrl: './share-dashboard-panel.html',
  styleUrl: './share-dashboard-panel.css',
})
export class ShareDashboardPanel implements OnInit {
  readonly groupCode = input.required<string>();

  private readonly http = inject(HttpClient);

  /** undefined = still loading; null = not shared. */
  protected readonly token = signal<string | null | undefined>(undefined);
  protected readonly unavailable = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);
  protected readonly confirmingStop = signal(false);

  protected readonly link = computed(() => {
    const t = this.token();
    return t ? absoluteUrl(`/d/${t}`) : null;
  });

  private endpoint(): string {
    return `${environment.apiBaseUrl}/groups/${encodeURIComponent(this.groupCode())}/share`;
  }

  async ngOnInit(): Promise<void> {
    try {
      const state = await firstValueFrom(this.http.get<ShareState>(this.endpoint()));
      this.token.set(state.token);
    } catch {
      // A group that has not been created yet has nothing to share.
      this.unavailable.set(true);
    }
  }

  protected async share(): Promise<void> {
    await this.change(() => this.http.post<ShareState>(this.endpoint(), {}), $localize`:@@share.shareFailed:สร้างลิงก์ไม่สำเร็จ ลองอีกครั้ง`);
  }

  protected async stop(): Promise<void> {
    await this.change(() => this.http.delete<ShareState>(this.endpoint()), $localize`:@@share.stopFailed:หยุดแชร์ไม่สำเร็จ ลองอีกครั้ง`);
  }

  protected async copy(): Promise<void> {
    const link = this.link();
    if (!link) return;
    const ok = await copyToClipboard(link);
    this.copied.set(ok);
    this.copyFailed.set(!ok);
  }

  private async change(call: () => Observable<ShareState>, failure: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.copied.set(false);
    this.copyFailed.set(false);
    try {
      const state = await firstValueFrom(call());
      this.token.set(state.token);
      this.confirmingStop.set(false);
    } catch {
      this.error.set(failure);
    } finally {
      this.busy.set(false);
    }
  }
}
```

Create `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.html`:

```html
<div class="share-panel">
  @if (unavailable()) {
    <p class="muted" data-unavailable i18n="@@share.unavailable">ใช้ได้หลังสร้างก๊วนครั้งแรก</p>
  } @else if (token() === null) {
    <p class="muted" i18n="@@share.hint">สร้างลิงก์หน้าสรุปของก๊วนนี้ ปักไว้ในไลน์ครั้งเดียว สมาชิกเปิดดูเองได้ ไม่ต้องคัดลอกสรุปทุกครั้ง</p>
    <button type="button" data-share [disabled]="busy()" (click)="share()" i18n="@@share.create">สร้างลิงก์</button>
  } @else if (link(); as url) {
    <label class="share-link">
      <span class="muted" i18n="@@share.linkLabel">ลิงก์หน้าสรุปก๊วน</span>
      <input type="text" data-link readonly [value]="url" (focus)="$any($event.target).select()" />
    </label>
    <div class="share-actions">
      <button type="button" data-copy (click)="copy()" i18n="@@share.copy">คัดลอกลิงก์</button>
      @if (!confirmingStop()) {
        <button type="button" class="ghost" data-stop [disabled]="busy()" (click)="confirmingStop.set(true)" i18n="@@share.stop">หยุดแชร์</button>
      }
    </div>
    @if (copied()) {
      <p class="muted" role="status" data-copied i18n="@@share.copied">คัดลอกแล้ว</p>
    }
    @if (copyFailed()) {
      <p class="muted" role="status" data-copy-failed i18n="@@share.copyFailed">คัดลอกไม่สำเร็จ กดที่ช่องลิงก์แล้วคัดลอกเอง</p>
    }
    @if (confirmingStop()) {
      <div class="share-confirm">
        <p i18n="@@share.stopWarning">ลิงก์ที่ปักไว้ในไลน์จะเปิดไม่ได้ทันที ถ้าสร้างใหม่ ลิงก์จะเปลี่ยน</p>
        <button type="button" class="danger" data-confirm-stop [disabled]="busy()" (click)="stop()" i18n="@@share.confirmStop">ยืนยันหยุดแชร์</button>
        <button type="button" class="ghost" data-cancel-stop (click)="confirmingStop.set(false)" i18n="@@share.cancelStop">ยกเลิก</button>
      </div>
    }
  }
  @if (error()) {
    <p class="error" role="alert">{{ error() }}</p>
  }
</div>
```

Create `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.css`:

```css
.share-panel {
  display: grid;
  gap: var(--space-1);
}

.share-link {
  display: grid;
  gap: var(--space-1);
}

.share-link input {
  width: 100%;
}

.share-actions,
.share-confirm {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.share-confirm p {
  flex-basis: 100%;
  margin: 0;
}
```

- [ ] **Step 4: Run the panel tests**

Run: `cd web && npx ng test --watch=false --include='src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts'`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing group-entry test**

In `web/src/app/pages/group-entry/group-entry.spec.ts`, find an existing describe that renders the `paste` state with an `HttpTestingController` (the one that already tests the "ตั้งค่าขั้นสูง" advanced toggle is the template; copy its setup and its helper that flushes the initial `getGroup`/`listSessions` requests). Add:

```ts
  it('renders the share panel only after the host opens it', async () => {
    // (use the same setup/flush helper as the advanced-settings toggle test above)
    expect(host.querySelector('app-share-dashboard-panel')).toBeNull();
    httpMock.expectNone(`${B}/groups/group1/share`);

    host.querySelector<HTMLButtonElement>('[data-share-toggle]')!.click();
    fixture.detectChanges();

    expect(host.querySelector('app-share-dashboard-panel')).not.toBeNull();
    httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: null });
  });
```

Match the variable names (`host`, `httpMock`, `fixture`, `B`) to the surrounding tests when pasting; do not invent new helpers.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd web && npx ng test --watch=false --include='src/app/pages/group-entry/group-entry.spec.ts'`
Expected: FAIL on the new test only (no `[data-share-toggle]`).

- [ ] **Step 7: Embed the panel**

In `web/src/app/pages/group-entry/group-entry.ts`: add `import { ShareDashboardPanel } from '../../shared/share-dashboard-panel/share-dashboard-panel';`, append `ShareDashboardPanel` to the component's `imports` array, and next to `readonly showAdvanced = signal(false);` add:

```ts
  readonly showShare = signal(false);
```

In `web/src/app/pages/group-entry/group-entry.html`, inside `.group-actions` add a third button before the existing two, then render the panel between the actions row and the `@if (showAdvanced())` block:

```html
      <button type="button" class="ghost" data-share-toggle [attr.aria-expanded]="showShare()" (click)="showShare.set(!showShare())" i18n="@@entry.shareDashboard">ลิงก์หน้าสรุปก๊วน</button>
```

```html
    @if (showShare()) {
      <app-share-dashboard-panel [groupCode]="groupCode" />
    }
```

- [ ] **Step 8: Add the English translations**

Append to `web/src/locale/messages.en.xlf` (before `</body>`):

```xml
      <trans-unit id="entry.shareDashboard" datatype="html">
        <source>ลิงก์หน้าสรุปก๊วน</source>
        <target>Group summary link</target>
      </trans-unit>
      <trans-unit id="share.unavailable" datatype="html">
        <source>ใช้ได้หลังสร้างก๊วนครั้งแรก</source>
        <target>Available after the group is created</target>
      </trans-unit>
      <trans-unit id="share.hint" datatype="html">
        <source>สร้างลิงก์หน้าสรุปของก๊วนนี้ ปักไว้ในไลน์ครั้งเดียว สมาชิกเปิดดูเองได้ ไม่ต้องคัดลอกสรุปทุกครั้ง</source>
        <target>Create a link to this group's summary page. Pin it in LINE once and members can open it themselves, with no pasting after each session.</target>
      </trans-unit>
      <trans-unit id="share.create" datatype="html">
        <source>สร้างลิงก์</source>
        <target>Create link</target>
      </trans-unit>
      <trans-unit id="share.linkLabel" datatype="html">
        <source>ลิงก์หน้าสรุปก๊วน</source>
        <target>Group summary link</target>
      </trans-unit>
      <trans-unit id="share.copy" datatype="html">
        <source>คัดลอกลิงก์</source>
        <target>Copy link</target>
      </trans-unit>
      <trans-unit id="share.stop" datatype="html">
        <source>หยุดแชร์</source>
        <target>Stop sharing</target>
      </trans-unit>
      <trans-unit id="share.copied" datatype="html">
        <source>คัดลอกแล้ว</source>
        <target>Copied</target>
      </trans-unit>
      <trans-unit id="share.copyFailed" datatype="html">
        <source>คัดลอกไม่สำเร็จ กดที่ช่องลิงก์แล้วคัดลอกเอง</source>
        <target>Couldn't copy. Tap the link field and copy it yourself.</target>
      </trans-unit>
      <trans-unit id="share.stopWarning" datatype="html">
        <source>ลิงก์ที่ปักไว้ในไลน์จะเปิดไม่ได้ทันที ถ้าสร้างใหม่ ลิงก์จะเปลี่ยน</source>
        <target>The link pinned in LINE stops working immediately. If you create one again, the link will be different.</target>
      </trans-unit>
      <trans-unit id="share.confirmStop" datatype="html">
        <source>ยืนยันหยุดแชร์</source>
        <target>Confirm stop sharing</target>
      </trans-unit>
      <trans-unit id="share.cancelStop" datatype="html">
        <source>ยกเลิก</source>
        <target>Cancel</target>
      </trans-unit>
      <trans-unit id="share.shareFailed" datatype="html">
        <source>สร้างลิงก์ไม่สำเร็จ ลองอีกครั้ง</source>
        <target>Couldn't create the link. Try again.</target>
      </trans-unit>
      <trans-unit id="share.stopFailed" datatype="html">
        <source>หยุดแชร์ไม่สำเร็จ ลองอีกครั้ง</source>
        <target>Couldn't stop sharing. Try again.</target>
      </trans-unit>
```

- [ ] **Step 9: Verify web tests and the localized build**

Run: `cd web && npm test && npx ng build`
Expected: PASS; both locales build with no missing-translation warnings for `entry.shareDashboard` or `share.*`.

- [ ] **Step 10: Commit**

```bash
git add web/src
git commit -m "feat(web): host share panel for the group dashboard link

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 5: Docs and full verification

**Files:**
- Modify: `docs/overview.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the overview section**

Append a new section to `docs/overview.md` (place it after the session-summary/bill material, before any trailing appendix; match the surrounding heading level):

```markdown
### Group dashboard

Each group can publish one public page, `/d/:token`: past sessions (each
linking to its existing summary) and all-time participation standings. The
host creates the link once from the group page and pins it in LINE, so the
summary no longer has to be pasted after every session.

**The credential is a random `Group.shareToken`, not the group code.** A group
code is chosen by the host ("pailin-thu") and is guessable; a public page keyed
by it would expose any group's history to anyone who guessed the code. The token
is created on demand, is idempotent (sharing twice returns the same link, so a
double-tap cannot break the pinned one) and revocable (stopping the share 404s
the link at once; sharing again mints a different token). Deleting the group
deletes the token with it.

**Standings are participation-only: sessions attended, then games played.**
No rating, level or win/loss appears and names do not link to the player card.
A public ranked skill list would put the weakest players in front of the whole
chat; levels are host-only for the same reason (see Ratings). "Attended" means
in at least one *confirmed* match that session, so a rostered no-show does not
count, and a proposed match counts for nothing, the same rule as the archive.
Standings are all-time, consistent with partner history; a recent-window toggle
is deliberately not built until members ask for it.

The session list shows the newest 30. An ended session nobody played is left
out; a live one is always shown and links to the public venue display.
```

- [ ] **Step 2: Update the route list in CLAUDE.md**

In `CLAUDE.md`, under "Three routes, access split is fixed", change the lead-in to four and add:

```markdown
- `/d/:token` — group dashboard, public, keyed by the group's revocable share token (never the group code); participation-only, no ratings and no links to player cards
```

(Change "Three routes" to "Four routes" in that sentence.)

- [ ] **Step 3: Full verification**

Run: `npm test` from the repo root, then `cd server && npm run lint`, then `cd web && npx ng build`.
Expected: engines, server and web suites all PASS; lint clean; build succeeds for both locales.

- [ ] **Step 4: Check the migration applies to a copy of the real data shape**

Run: `cd server && DATABASE_URL="file:$CLAUDE_JOB_DIR/tmp/migrate-check.db" npx prisma migrate deploy`
Expected: every migration applies, including `20261002100000_group_share_token`, on a fresh file. (Do NOT run it against `dev.db` or the home server; deployment is a separate, confirmed step.)

- [ ] **Step 5: Commit**

```bash
git add docs/overview.md CLAUDE.md
git commit -m "docs: document the group dashboard and its two decisions

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```
