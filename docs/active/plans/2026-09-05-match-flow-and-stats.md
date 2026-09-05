# Match Flow and Player Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three match-flow features to jubBad: winner-button finish (with optional scores), a per-player played/won stats table, and a targeted 1-for-1 player swap on pending courts.

**Architecture:** Server changes live entirely in `server/src/sessions/` (one Nest module, no new modules needed) plus one Prisma migration adding `Pairing.winner`. Client changes extend the existing `LiveSessionService` and `CourtPanel`, plus one new standalone `StatsTable` component. No new subsystems — same request/response and JSON-encoded-team-array conventions used throughout this module today.

**Tech Stack:** NestJS + Prisma (`better-sqlite3` adapter) on the server, Angular (standalone components, signals, `httpResource`) on the client. Server tests: Vitest + Supertest against the real dev SQLite DB (cleaned up per-test via `finally`). Client tests: Angular `TestBed` + `HttpTestingController`.

**Spec:** `docs/active/specs/2026-09-05-match-flow-and-stats-design.md`

## Global Constraints

- DTOs validated via a global `ValidationPipe({ whitelist: true, transform: true })` (`server/src/main.ts:9`) — every new/changed DTO field needs a `class-validator` decorator or it's silently stripped/rejected.
- No relational player↔pairing link exists — `teamA`/`teamB` are JSON-encoded `[string, string]` strings on `Pairing`. All aggregation happens in JS after `JSON.parse`, matching every existing method in `sessions.service.ts`.
- Server tests hit the real `server/prisma/dev.db` through `PrismaService` — every test must clean up its own rows in a `finally` block (existing convention throughout `sessions.controller.spec.ts`).
- Client components are standalone (no `NgModule`); follow the existing signal + `httpResource` patterns already used in `LiveSessionService`, `CourtPanel`, and `SessionDashboard`.

---

### Task 1: Winner-button finish — schema + server

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/<timestamp>_add_pairing_winner/migration.sql` (generated, not hand-written)
- Modify: `server/src/sessions/dto/finish-pairing.dto.ts`
- Modify: `server/src/sessions/sessions.service.ts` (`finishPairing`, unchanged signature, new field written)
- Modify: `server/src/sessions/sessions.controller.spec.ts` (existing finish test + new winner-storage test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Pairing.winner: string | null` column. `FinishPairingDto` now requires `winner: 'A' | 'B'` alongside existing optional `scoreA`/`scoreB`. `POST /sessions/:code/pairings/:id/finish` response includes `winner` in the returned row (Prisma returns full row already — no serialization change needed).

- [ ] **Step 1: Add `winner` to the Prisma schema**

Edit `server/prisma/schema.prisma`, in `model Pairing`:

```prisma
model Pairing {
  id          String    @id @default(cuid())
  sessionId   String
  courtNumber Int
  matchNumber Int
  teamA       String
  teamB       String
  scoreA      Int?
  scoreB      Int?
  winner      String?
  confirmedAt DateTime?
  endedAt     DateTime?
  session     Session   @relation(fields: [sessionId], references: [code])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run from `server/`:

```bash
npx prisma migrate dev --name add_pairing_winner
```

Expected: creates `server/prisma/migrations/<timestamp>_add_pairing_winner/migration.sql` containing `ALTER TABLE "Pairing" ADD COLUMN "winner" TEXT;`, applies it to `dev.db`, regenerates the Prisma client.

- [ ] **Step 3: Write the failing tests**

In `server/src/sessions/sessions.controller.spec.ts`, update the existing `'confirms then finishes a pairing'` test's finish call and assertions:

```ts
      const finishRes = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ scoreA: 21, scoreB: 15, winner: 'A' })
        .expect(201);
      expect(finishRes.body.endedAt).not.toBeNull();
      expect(finishRes.body.scoreA).toBe(21);
      expect(finishRes.body.scoreB).toBe(15);
      expect(finishRes.body.winner).toBe('A');
```

Add a new test in the same file, after that one:

```ts
  it('finishes a pairing with a winner but no scores', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ winner: 'B' })
        .expect(201);
      expect(res.body.winner).toBe('B');
      expect(res.body.scoreA).toBeNull();
      expect(res.body.scoreB).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects finish when winner is missing', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ scoreA: 21, scoreB: 15 })
        .expect(400);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: FAIL — the updated finish test fails on `winner` being `undefined`/missing validation; the new "missing winner" test fails because the DTO doesn't yet reject it (currently 201, expected 400).

- [ ] **Step 5: Add `winner` to `FinishPairingDto`**

Edit `server/src/sessions/dto/finish-pairing.dto.ts`:

```ts
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class FinishPairingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  scoreA!: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  scoreB!: number | null;

  @IsIn(['A', 'B'])
  winner!: 'A' | 'B';
}
```

No change needed in `sessions.service.ts` — `finishPairing` already spreads `dto` fields (`scoreA: dto.scoreA, scoreB: dto.scoreB`) into the Prisma update; add `winner: dto.winner` there:

```ts
  async finishPairing(id: string, dto: FinishPairingDto) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) throw new NotFoundException();
    return this.prisma.pairing.update({
      where: { id },
      data: { endedAt: new Date(), scoreA: dto.scoreA, scoreB: dto.scoreB, winner: dto.winner },
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations server/src/sessions/dto/finish-pairing.dto.ts server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat: require winner on finish, store it on Pairing"
```

---

### Task 2: Winner-button finish — client UI

**Files:**
- Modify: `web/src/app/core/live-session.service.ts` (`finishMatch`)
- Modify: `web/src/app/core/live-session.service.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` (`finish`)
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.html` (active-court buttons)
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`

**Interfaces:**
- Consumes: `POST /sessions/:code/pairings/:id/finish` now requires `winner` in the body (Task 1).
- Produces: `LiveSessionService.finishMatch(pairingId: string, scoreA: number | null, scoreB: number | null, winner: 'A' | 'B'): Promise<void>`. `CourtPanel.finish(winner: 'A' | 'B'): Promise<void>` (was `finish(): Promise<void>` with no arg).

- [ ] **Step 1: Write the failing service test**

In `web/src/app/core/live-session.service.spec.ts`, replace the existing `'finishMatch posts scores to the finish endpoint and reloads'` test:

```ts
  it('finishMatch posts scores and winner to the finish endpoint and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.finishMatch('pair1', 21, 15, 'A');
    const finishReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/finish`
    );
    expect(finishReq.request.method).toBe('POST');
    expect(finishReq.request.body).toEqual({ scoreA: 21, scoreB: 15, winner: 'A' });
    finishReq.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    await promise;
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/core/live-session.service.spec.ts`
Expected: FAIL — `finishMatch` doesn't accept a 4th argument yet (TS compile error) or the posted body lacks `winner`.

- [ ] **Step 3: Update `finishMatch`**

Edit `web/src/app/core/live-session.service.ts`:

```ts
  async finishMatch(
    pairingId: string,
    scoreA: number | null,
    scoreB: number | null,
    winner: 'A' | 'B'
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/finish`, {
        scoreA,
        scoreB,
        winner,
      })
    );
    this.sessionResource.reload();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/core/live-session.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the failing component test**

In `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`, replace the `'shows a "Finish match" control once active'` test and add a click test:

```ts
  it('shows named winner buttons once active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม & เบส won');
    expect(text).toContain('ปอม & ไม้ won');
  });

  it('clicking a winner button finishes with that winner and current scores', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const scoreInputs = (fixture.nativeElement as HTMLElement).querySelectorAll('input[type="number"]');
    (scoreInputs[0] as HTMLInputElement).value = '21';
    (scoreInputs[0] as HTMLInputElement).dispatchEvent(new Event('input'));
    (scoreInputs[1] as HTMLInputElement).value = '15';
    (scoreInputs[1] as HTMLInputElement).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const winButton = Array.from(buttons).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    winButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/finish`);
    expect(req.request.body).toEqual({ scoreA: 21, scoreB: 15, winner: 'A' });
    req.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
Expected: FAIL — template still renders a single "Finish match" button; `finish()` takes no argument.

- [ ] **Step 7: Update `CourtPanel` component and template**

Edit `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`, replace `finish`:

```ts
  protected async finish(winner: 'A' | 'B'): Promise<void> {
    const c = this.court();
    if (c.status !== 'active') return;
    await this.liveSession.finishMatch(c.pairingId, this.scoreA(), this.scoreB(), winner);
    this.scoreA.set(null);
    this.scoreB.set(null);
  }
```

Edit `web/src/app/pages/session-dashboard/court-panel/court-panel.html`, replace the active-case button:

```html
      @case ('active') {
        @if (c.status === 'active') {
          @let aNames = teamNames(c.teamA);
          @let bNames = teamNames(c.teamB);
          <p class="matchup">{{ aNames[0] }} &amp; {{ aNames[1] }} <span class="vs">vs</span> {{ bNames[0] }} &amp; {{ bNames[1] }}</p>
        }
        <div class="score-row">
          <input type="number" min="0" [ngModel]="scoreA()" (ngModelChange)="scoreA.set($event)" placeholder="0" />
          <span class="score-sep">–</span>
          <input type="number" min="0" [ngModel]="scoreB()" (ngModelChange)="scoreB.set($event)" placeholder="0" />
        </div>
        @if (c.status === 'active') {
          @let aNames = teamNames(c.teamA);
          @let bNames = teamNames(c.teamB);
          <div class="button-row">
            <button type="button" (click)="finish('A')">{{ aNames[0] }} &amp; {{ aNames[1] }} won</button>
            <button type="button" (click)="finish('B')">{{ bNames[0] }} &amp; {{ bNames[1] }} won</button>
          </div>
        }
      }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts web/src/app/pages/session-dashboard/court-panel/court-panel.ts web/src/app/pages/session-dashboard/court-panel/court-panel.html web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts
git commit -m "feat: replace finish-match score entry with named winner buttons"
```

---

### Task 3: Player stats — server endpoint

**Files:**
- Modify: `server/src/sessions/sessions.controller.ts` (new `GET :code/stats` route)
- Modify: `server/src/sessions/sessions.service.ts` (new `getStats` method)
- Modify: `server/src/sessions/sessions.controller.spec.ts` (new tests)

**Interfaces:**
- Consumes: `Pairing.winner` (Task 1), existing `Player`/`Session`/`Pairing` Prisma models.
- Produces: `GET /sessions/:code/stats?scope=session|all` → `{ playerId: string; name: string; played: number; won: number }[]`, sorted by `played` descending. `SessionsService.getStats(code: string, scope: 'session' | 'all')`.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/sessions/sessions.controller.spec.ts`:

```ts
  it('GET /sessions/:code/stats aggregates played/won for the current session', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        endedAt: new Date(),
        winner: 'A',
      },
    });
    // Legacy row: finished before winner existed.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([players[0].id, players[2].id]),
        teamB: JSON.stringify([players[1].id, players[3].id]),
        endedAt: new Date(),
        winner: null,
      },
    });
    // Unfinished — must not count.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 3,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .get(`/sessions/${sessionCode}/stats`)
        .expect(200);
      const byId = new Map(res.body.map((r: { playerId: string }) => [r.playerId, r]));
      expect(byId.get(players[0].id)).toEqual({
        playerId: players[0].id,
        name: 'A',
        played: 2,
        won: 1,
      });
      expect(byId.get(players[2].id)).toEqual({
        playerId: players[2].id,
        name: 'C',
        played: 2,
        won: 0,
      });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code/stats?scope=all includes ended sessions in the same group', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const currentSessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: oldSessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    await prisma.session.create({
      data: { code: currentSessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: oldSessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        endedAt: new Date(),
        winner: 'B',
      },
    });

    try {
      const sessionScoped = await request(app.getHttpServer())
        .get(`/sessions/${currentSessionCode}/stats`)
        .expect(200);
      expect(sessionScoped.body).toEqual([]);

      const allTime = await request(app.getHttpServer())
        .get(`/sessions/${currentSessionCode}/stats?scope=all`)
        .expect(200);
      const byId = new Map(allTime.body.map((r: { playerId: string }) => [r.playerId, r]));
      expect(byId.get(players[2].id).won).toBe(1);
      expect(byId.get(players[0].id).won).toBe(0);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: oldSessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code/stats 404s for an unknown session', async () => {
    await request(app.getHttpServer()).get(`/sessions/${randomUUID()}/stats`).expect(404);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Add `getStats` to `sessions.service.ts`**

```ts
  async getStats(code: string, scope: 'session' | 'all') {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException();

    const pairings = await this.prisma.pairing.findMany({
      where:
        scope === 'all'
          ? { session: { groupId: session.groupId }, endedAt: { not: null } }
          : { sessionId: code, endedAt: { not: null } },
    });

    const played = new Map<string, number>();
    const won = new Map<string, number>();
    for (const p of pairings) {
      const teamA = JSON.parse(p.teamA) as [string, string];
      const teamB = JSON.parse(p.teamB) as [string, string];
      for (const id of [...teamA, ...teamB]) {
        played.set(id, (played.get(id) ?? 0) + 1);
      }
      if (p.winner === 'A' || p.winner === 'B') {
        const winningTeam = p.winner === 'A' ? teamA : teamB;
        for (const id of winningTeam) {
          won.set(id, (won.get(id) ?? 0) + 1);
        }
      }
    }

    const players = await this.prisma.player.findMany({
      where: { id: { in: [...played.keys()] } },
    });
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    return [...played.entries()]
      .map(([playerId, count]) => ({
        playerId,
        name: nameById.get(playerId) ?? 'Unknown',
        played: count,
        won: won.get(playerId) ?? 0,
      }))
      .sort((a, b) => b.played - a.played);
  }
```

- [ ] **Step 4: Add the route to `sessions.controller.ts`**

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
```

```ts
  @Get(':code/stats')
  getStats(@Param('code') code: string, @Query('scope') scope?: string) {
    return this.sessionsService.getStats(code, scope === 'all' ? 'all' : 'session');
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/sessions.controller.ts server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat: add per-player played/won stats endpoint"
```

---

### Task 4: Player stats — client UI

**Files:**
- Create: `web/src/app/core/stats.model.ts`
- Create: `web/src/app/pages/session-dashboard/stats-table/stats-table.ts`
- Create: `web/src/app/pages/session-dashboard/stats-table/stats-table.html`
- Create: `web/src/app/pages/session-dashboard/stats-table/stats-table.css`
- Create: `web/src/app/pages/session-dashboard/stats-table/stats-table.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` (import + wire `sessionCode`)
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.html` (render `<app-stats-table>`)

**Interfaces:**
- Consumes: `GET /sessions/:code/stats?scope=session|all` (Task 3).
- Produces: standalone `StatsTable` component, selector `app-stats-table`, required input `sessionCode: string`.

- [ ] **Step 1: Define the model**

Create `web/src/app/core/stats.model.ts`:

```ts
export interface PlayerStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
}
```

- [ ] **Step 2: Write the failing component test**

Create `web/src/app/pages/session-dashboard/stats-table/stats-table.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatsTable } from './stats-table';
import { environment } from '../../../../environments/environment';

const B = environment.apiBaseUrl;

describe('StatsTable', () => {
  let fixture: ComponentFixture<StatsTable>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StatsTable],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StatsTable);
    fixture.componentRef.setInput('sessionCode', 'sess1');
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('defaults to session scope and renders rows', async () => {
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1/stats?scope=session`)
      .flush([{ playerId: 'p1', name: 'Alice', played: 3, won: 2 }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Alice');
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('switches to all-time scope on toggle click', async () => {
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const allTimeButton = Array.from(buttons).find(
      (b) => b.textContent === 'All-time'
    ) as HTMLButtonElement;
    allTimeButton.click();
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=all`).flush([]);
    await fixture.whenStable();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/stats-table/stats-table.spec.ts`
Expected: FAIL — `stats-table.ts` doesn't exist yet.

- [ ] **Step 4: Implement the component**

Create `web/src/app/pages/session-dashboard/stats-table/stats-table.ts`:

```ts
import { Component, computed, input, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import type { PlayerStat } from '../../../core/stats.model';

@Component({
  selector: 'app-stats-table',
  templateUrl: './stats-table.html',
  styleUrl: './stats-table.css',
})
export class StatsTable {
  readonly sessionCode = input.required<string>();
  protected readonly scope = signal<'session' | 'all'>('session');

  private readonly statsResource = httpResource<PlayerStat[]>(
    () => `${environment.apiBaseUrl}/sessions/${this.sessionCode()}/stats?scope=${this.scope()}`
  );

  protected readonly stats = computed<PlayerStat[]>(() => {
    if (this.statsResource.error()) return [];
    return this.statsResource.value() ?? [];
  });

  protected setScope(scope: 'session' | 'all'): void {
    this.scope.set(scope);
  }
}
```

Create `web/src/app/pages/session-dashboard/stats-table/stats-table.html`:

```html
<div class="stats-table">
  <div class="scope-toggle">
    <button type="button" [class.active]="scope() === 'session'" (click)="setScope('session')">
      This session
    </button>
    <button type="button" [class.active]="scope() === 'all'" (click)="setScope('all')">
      All-time
    </button>
  </div>
  <table>
    <thead>
      <tr>
        <th>Player</th>
        <th>Played</th>
        <th>Won</th>
      </tr>
    </thead>
    <tbody>
      @for (row of stats(); track row.playerId) {
        <tr>
          <td>{{ row.name }}</td>
          <td>{{ row.played }}</td>
          <td>{{ row.won }}</td>
        </tr>
      }
    </tbody>
  </table>
</div>
```

Create `web/src/app/pages/session-dashboard/stats-table/stats-table.css`:

```css
.stats-table {
  margin-top: var(--space-2);
}

.scope-toggle {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-1);
}

.scope-toggle button.active {
  background: var(--accent);
  color: var(--surface);
}

.stats-table table {
  width: 100%;
  border-collapse: collapse;
}

.stats-table th,
.stats-table td {
  text-align: left;
  padding: var(--space-1);
  border-bottom: 1px solid var(--rule);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/stats-table/stats-table.spec.ts`
Expected: PASS

- [ ] **Step 6: Wire `StatsTable` into `SessionDashboard`**

Edit `web/src/app/pages/session-dashboard/session-dashboard.ts`:

```ts
import { CourtPanel } from './court-panel/court-panel';
import { StatsTable } from './stats-table/stats-table';
```

```ts
@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel, StatsTable],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
```

Edit `web/src/app/pages/session-dashboard/session-dashboard.html`, insert before the "End session" block:

```html
    <hr class="rule" />
    <app-stats-table [sessionCode]="session()!.code" />

    @if (!ended()) {
```

(replacing the existing `@if (!ended()) {` line — the preceding `<hr class="rule" />` that used to lead directly into it stays where it is, just above the new `<app-stats-table>`.)

- [ ] **Step 7: Commit**

```bash
git add web/src/app/core/stats.model.ts web/src/app/pages/session-dashboard/stats-table web/src/app/pages/session-dashboard/session-dashboard.ts web/src/app/pages/session-dashboard/session-dashboard.html
git commit -m "feat: add player stats table to session dashboard"
```

---

### Task 5: Targeted player swap — server endpoint

**Files:**
- Create: `server/src/sessions/dto/swap-player.dto.ts`
- Modify: `server/src/sessions/sessions.service.ts` (new `swapPlayer` method)
- Modify: `server/src/sessions/sessions.controller.ts` (new route)
- Modify: `server/src/sessions/sessions.controller.spec.ts` (new tests)

**Interfaces:**
- Consumes: `deriveHistory` from `server/src/sessions/derive-history.ts` (existing), `Pairing`/`SessionRoster` Prisma models.
- Produces: `POST /sessions/:code/pairings/:id/swap { playerId: string }` →
  `{ ok: true; pairing: { id: string; courtNumber: number; matchNumber: number; teamA: [string, string]; teamB: [string, string] } } | { ok: false; reason: 'no-substitute' }`, 409 if the pairing is already confirmed/ended, 404 if the pairing or `playerId` isn't found.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/sessions/sessions.controller.spec.ts`:

```ts
  it('swaps one player on a pending pairing for a waiting substitute, leaving the other 3 untouched', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairing.teamA).toEqual([players[4].id, players[1].id]);
      expect(res.body.pairing.teamB).toEqual([players[2].id, players[3].id]);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(JSON.parse(row.teamA)).toEqual([players[4].id, players[1].id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reports no-substitute when nobody is waiting to swap in', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(201);
      expect(res.body).toEqual({ ok: false, reason: 'no-substitute' });

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(JSON.parse(row.teamA)).toEqual([players[0].id, players[1].id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects swapping a pairing that is already confirmed', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(409);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Create the DTO**

Create `server/src/sessions/dto/swap-player.dto.ts`:

```ts
import { IsString } from 'class-validator';

export class SwapPlayerDto {
  @IsString()
  playerId!: string;
}
```

- [ ] **Step 4: Add `swapPlayer` to `sessions.service.ts`**

```ts
import type { SwapPlayerDto } from './dto/swap-player.dto.js';
```

```ts
  async swapPlayer(pairingId: string, dto: SwapPlayerDto) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id: pairingId } });
    if (!pairing) throw new NotFoundException();
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) {
      throw new ConflictException('Only a pending pairing can be swapped.');
    }

    const teamA = JSON.parse(pairing.teamA) as [string, string];
    const teamB = JSON.parse(pairing.teamB) as [string, string];
    const currentFour = new Set([...teamA, ...teamB]);
    if (!currentFour.has(dto.playerId)) throw new NotFoundException('Player is not in this pairing.');

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: pairing.sessionId },
    });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: pairing.sessionId, endedAt: null, id: { not: pairingId } },
    });
    const reserved = new Set<string>();
    for (const p of nonEnded) {
      const [a1, a2] = JSON.parse(p.teamA) as [string, string];
      const [b1, b2] = JSON.parse(p.teamB) as [string, string];
      reserved.add(a1);
      reserved.add(a2);
      reserved.add(b1);
      reserved.add(b2);
    }
    const pool = rosterPlayerIds.filter((id) => !reserved.has(id) && !currentFour.has(id));
    if (pool.length === 0) {
      return { ok: false as const, reason: 'no-substitute' as const };
    }

    const confirmed = await this.prisma.pairing.findMany({
      where: { sessionId: pairing.sessionId, confirmedAt: { not: null } },
    });
    const history = deriveHistory(
      confirmed.map((p) => ({
        teamA: JSON.parse(p.teamA) as [string, string],
        teamB: JSON.parse(p.teamB) as [string, string],
      }))
    );
    const substitute = [...pool].sort(
      (a, b) =>
        (history.gamesPlayedThisSession.get(a) ?? 0) - (history.gamesPlayedThisSession.get(b) ?? 0)
    )[0];

    const isTeamA = teamA.includes(dto.playerId);
    const newTeamA: [string, string] = isTeamA
      ? [
          teamA[0] === dto.playerId ? substitute : teamA[0],
          teamA[1] === dto.playerId ? substitute : teamA[1],
        ]
      : teamA;
    const newTeamB: [string, string] = !isTeamA
      ? [
          teamB[0] === dto.playerId ? substitute : teamB[0],
          teamB[1] === dto.playerId ? substitute : teamB[1],
        ]
      : teamB;

    const updated = await this.prisma.pairing.update({
      where: { id: pairingId },
      data: { teamA: JSON.stringify(newTeamA), teamB: JSON.stringify(newTeamB) },
    });

    return {
      ok: true as const,
      pairing: {
        id: updated.id,
        courtNumber: updated.courtNumber,
        matchNumber: updated.matchNumber,
        teamA: newTeamA,
        teamB: newTeamB,
      },
    };
  }
```

(`deriveHistory` is already imported at the top of this file for `propose()`; no new import needed there.)

- [ ] **Step 5: Add the route to `sessions.controller.ts`**

```ts
import { SwapPlayerDto } from './dto/swap-player.dto.js';
```

```ts
  @Post(':code/pairings/:id/swap')
  swapPlayer(@Param('id') id: string, @Body() dto: SwapPlayerDto) {
    return this.sessionsService.swapPlayer(id, dto);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/sessions/dto/swap-player.dto.ts server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat: add targeted 1-for-1 player swap on pending pairings"
```

---

### Task 6: Targeted player swap — client UI

**Files:**
- Modify: `web/src/app/core/live-session.service.ts` (`swapPlayer`)
- Modify: `web/src/app/core/live-session.service.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` (`swap`, `noSubstitute`)
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.html` (pending-court name buttons)
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`

**Interfaces:**
- Consumes: `POST /sessions/:code/pairings/:id/swap { playerId }` (Task 5).
- Produces: `LiveSessionService.swapPlayer(pairingId: string, playerId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing service test**

Add to `web/src/app/core/live-session.service.spec.ts`:

```ts
  it('swapPlayer posts the playerId to the swap endpoint, reloads, and returns ok', async () => {
    await flushSession(baseSession());

    const promise = service.swapPlayer('pair1', 'p1');
    const swapReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/swap`
    );
    expect(swapReq.request.method).toBe('POST');
    expect(swapReq.request.body).toEqual({ playerId: 'p1' });
    swapReq.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toBe(true);
  });

  it('swapPlayer returns false when no substitute is available', async () => {
    await flushSession(baseSession());

    const promise = service.swapPlayer('pair1', 'p1');
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/core/live-session.service.spec.ts`
Expected: FAIL — `swapPlayer` doesn't exist.

- [ ] **Step 3: Add `swapPlayer` to `live-session.service.ts`**

```ts
interface SwapResponse {
  ok: boolean;
  reason?: string;
}
```

```ts
  async swapPlayer(pairingId: string, playerId: string): Promise<boolean> {
    const response = await firstValueFrom(
      this.http.post<SwapResponse>(
        `${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/swap`,
        { playerId }
      )
    );
    this.sessionResource.reload();
    return response.ok;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/core/live-session.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the failing component tests**

Add to `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`:

```ts
  it('tapping a player name on a pending court swaps them out', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`);
    expect(req.request.body).toEqual({ playerId: 'p1' });
    req.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
  });

  it('shows a hint when swap reports no substitute available', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No one waiting to sub in');
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
Expected: FAIL — no `button.name-tap` elements exist yet, `swap()` undefined.

- [ ] **Step 7: Update `CourtPanel` component and template**

Edit `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`, add alongside `notEnoughPlayers`:

```ts
  readonly noSubstitute = signal(false);
```

and add the method (near `confirm`/`finish`):

```ts
  protected async swap(pairingId: string, playerId: string): Promise<void> {
    const ok = await this.liveSession.swapPlayer(pairingId, playerId);
    this.noSubstitute.set(!ok);
  }
```

Edit `web/src/app/pages/session-dashboard/court-panel/court-panel.html`, replace the pending-case matchup paragraph:

```html
      @case ('pending') {
        @if (c.status === 'pending') {
          @let aNames = teamNames(c.teamA);
          @let bNames = teamNames(c.teamB);
          <p class="matchup">
            <button type="button" class="name-tap" (click)="swap(c.pairingId, c.teamA[0])">{{ aNames[0] }}</button>
            &amp;
            <button type="button" class="name-tap" (click)="swap(c.pairingId, c.teamA[1])">{{ aNames[1] }}</button>
            <span class="vs">vs</span>
            <button type="button" class="name-tap" (click)="swap(c.pairingId, c.teamB[0])">{{ bNames[0] }}</button>
            &amp;
            <button type="button" class="name-tap" (click)="swap(c.pairingId, c.teamB[1])">{{ bNames[1] }}</button>
          </p>
          @if (noSubstitute()) {
            <p class="hint">No one waiting to sub in.</p>
          }
        }
        <div class="button-row">
          <button type="button" class="ghost" (click)="startOrReshuffle()">Reshuffle</button>
          <button type="button" (click)="confirm()">Confirm</button>
        </div>
      }
```

Add a small style hook in `web/src/app/pages/session-dashboard/court-panel/court-panel.css` so tapped names read as tappable, not as plain buttons inline in a sentence:

```css
.name-tap {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  text-decoration: underline dotted;
  cursor: pointer;
  color: inherit;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts web/src/app/pages/session-dashboard/court-panel/court-panel.ts web/src/app/pages/session-dashboard/court-panel/court-panel.html web/src/app/pages/session-dashboard/court-panel/court-panel.css web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts
git commit -m "feat: tap a player's name on a pending court to swap in a substitute"
```

---

## Manual verification (after all tasks)

Run both dev servers and, per this project's UI-testing convention, exercise all three features by hand before calling this done:

1. `cd server && npm run start:dev`, `cd web && npm start` (or the project's usual dual-server launch).
2. Create a session with ≥5 players, start a match, tap one pending player's name → confirm the other 3 stay and a 5th player fills the gap. Try it again with no one waiting → confirm the "No one waiting to sub in" hint appears and nothing changes.
3. Confirm a match, click a named winner button with scores blank → match finishes, winner stored. Repeat with scores filled in.
4. Open the stats table → confirm it defaults to "This session" and toggling to "All-time" changes the numbers once more than one session exists for the group.
