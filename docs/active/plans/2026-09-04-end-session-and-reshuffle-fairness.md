# End Session + Reshuffle Fairness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix reshuffle repeating the exact same team-split (root-caused: with 4 available players there are only 3 possible splits, and with no partner history yet they score equally, so the search picks near-randomly and can repeat what it just showed). Add an explicit "end session" action so hosts have a real closing state instead of a session that just stops being visited.

**Architecture:** The reshuffle fix is a pure addition to `pairing.ts`'s existing 200-trial scoring search — a large penalty for reproducing a given split — wired through `SessionsService.propose()`, entirely transparent to the client (same `proposeMatch()` call for both a fresh propose and a reshuffle). End session is a new nullable `Session.endedAt` column, a new `POST /sessions/:code/end` endpoint that blocks while any court is unfinished, and client read/write wiring in `LiveSessionService`/`SessionDashboard`/`CourtPanel`/`SessionDisplay`.

**Tech Stack:** No new dependencies — same NestJS/Prisma/Angular stack already in place.

**Spec:** `docs/active/specs/2026-09-04-end-session-and-reshuffle-fairness-design.md`

## Global Constraints

- Run server commands with `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` prefixed, from `server/`. Run Angular commands the same way from `web/`. Run the root-level engine's own `node:test` suite (`pairing.test.ts`) with `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" node --experimental-strip-types --test pairing.test.ts` from the repo root.
- A candidate "matches" `avoidSplit` when its two partner pairs (`pairKey(teamA[0], teamA[1])` and `pairKey(teamB[0], teamB[1])`) are the *same set* as `avoidSplit`'s — team-label order (`teamA` vs `teamB`) doesn't matter, only who's actually paired with whom.
- `avoidSplit` only ever applies when `usableCourts === 1` (the only case `SessionsService.propose()` ever calls `generateRound` with) — don't generalize to multi-court avoidance; nothing needs it and the spec explicitly scoped this to the single-court reshuffle case.
- Delete `server/dist`/`web/dist` and check `git status` at the repo root before any commit in this plan, per the build-artifact-pollution hazard found in earlier plans.

---

## File Structure

- Modify: `pairing.ts`, `pairing.test.ts` (Task 1).
- Modify: `server/src/sessions/sessions.service.ts`, `server/src/sessions/sessions.controller.spec.ts` (Task 2).
- Modify: `server/prisma/schema.prisma`, `server/src/sessions/sessions.service.ts`, `server/src/sessions/sessions.controller.ts`, `server/src/sessions/sessions.controller.spec.ts` (Task 3). Create (generated): `server/prisma/migrations/<timestamp>_add_session_ended_at/migration.sql`.
- Modify: `web/src/app/core/session.model.ts`, `web/src/app/core/live-session.service.ts`, `web/src/app/core/live-session.service.spec.ts` (Task 4a).
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`, `.html`, `.spec.ts` (Task 4b).
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`, `.html`, `.spec.ts` (Task 4c).
- Modify: `web/src/app/pages/session-display/session-display.ts`, `.html`, `.spec.ts` (Task 4d).

---

### Task 1: `pairing.ts` — avoid reproducing a given split

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Produces: `generateRound(roster, courtCount, history, random?, avoidSplit?)` — the new 5th parameter. Task 2 (`SessionsService.propose`) is the sole caller that passes it.

- [ ] **Step 1: Write the failing test**

Add to `pairing.test.ts`, after the `'generateRound picks the lowest-scoring arrangement...'` test:

```ts
test('generateRound avoids reproducing the exact split passed as avoidSplit', () => {
  const history: MatchHistory = {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
  };
  const roster = ['tam', 'base', 'pom', 'mai'];

  const first = generateRound(roster, 1, history, makeSeededRandom(1));
  const avoidSplit = first.courts[0];

  const second = generateRound(roster, 1, history, makeSeededRandom(1), avoidSplit);

  const keysOf = (c: { teamA: [string, string]; teamB: [string, string] }) =>
    [pairKey(c.teamA[0], c.teamA[1]), pairKey(c.teamB[0], c.teamB[1])].sort();

  assert.notDeepEqual(keysOf(second.courts[0]), keysOf(first.courts[0]));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" node --experimental-strip-types --test pairing.test.ts
```

Expected: FAIL — `generateRound` doesn't accept a 5th argument yet, so passing `avoidSplit` has no effect and `second` will usually reproduce `first`'s split (same seeded random sequence, no penalty to steer away).

- [ ] **Step 3: Add the `avoidSplit` parameter**

Modify `pairing.ts` — add a constant near `PARTNER_WEIGHT`/`OPPONENT_WEIGHT`:

```ts
const AVOID_SPLIT_PENALTY = 1000;
```

Modify `generateRound`'s signature and body:

```ts
export function generateRound(
  roster: PlayerId[],
  courtCount: number,
  history: MatchHistory,
  random: () => number = Math.random,
  avoidSplit?: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }
): RoundResult {
  const { playing, sittingOut } = selectSittingOut(
    roster,
    courtCount,
    history.gamesPlayedThisSession,
    random
  );

  const usableCourts = Math.min(courtCount, Math.floor(playing.length / 4));

  if (usableCourts === 0) {
    return { courts: [], sittingOut };
  }

  const avoidKeys =
    avoidSplit && usableCourts === 1
      ? new Set([
          pairKey(avoidSplit.teamA[0], avoidSplit.teamA[1]),
          pairKey(avoidSplit.teamB[0], avoidSplit.teamB[1]),
        ])
      : null;

  let best: CourtAssignment[] | null = null;
  let bestScore = Infinity;

  for (let trial = 0; trial < SEARCH_TRIALS; trial++) {
    const candidate = buildRandomArrangement(playing, usableCourts, random);
    let score = scoreArrangement(candidate, history.partnerCounts, history.opponentCounts);

    if (avoidKeys) {
      const [c] = candidate;
      const candidateKeys = new Set([
        pairKey(c.teamA[0], c.teamA[1]),
        pairKey(c.teamB[0], c.teamB[1]),
      ]);
      const isSameSplit =
        candidateKeys.size === avoidKeys.size &&
        [...candidateKeys].every((k) => avoidKeys.has(k));
      if (isSameSplit) score += AVOID_SPLIT_PENALTY;
    }

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { courts: best as CourtAssignment[], sittingOut };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" node --experimental-strip-types --test pairing.test.ts
```

Expected: PASS, all tests (this file has no other suites to break — `generateRound`'s other existing tests don't pass a 5th argument, so they're unaffected by the new optional parameter).

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: avoid reproducing the exact split on reshuffle"
```

---

### Task 2: Wire the fix into `propose`

**Files:**
- Modify: `server/src/sessions/sessions.service.ts`
- Modify: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes: `generateRound`'s new `avoidSplit` parameter (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `server/src/sessions/sessions.controller.spec.ts`, after the existing `'proposes a match, reshuffles in place...'` test:

```ts
  it('reshuffle never immediately repeats the same team split', async () => {
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

    try {
      let previousKeys: string[] | null = null;
      for (let i = 0; i < 20; i++) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        const keys = [[...teamA].sort().join('|'), [...teamB].sort().join('|')].sort();
        if (previousKeys) {
          expect(keys).not.toEqual(previousKeys);
        }
        previousKeys = keys;
      }
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: FAIL — intermittently at first (this reproduces the exact bug reported: with no `avoidSplit` wiring, reshuffle can and does repeat the immediately-previous split within 20 tries almost every run).

- [ ] **Step 3: Wire `avoidSplit` into `propose`**

Modify `server/src/sessions/sessions.service.ts`'s `propose` method — move the `existingPending` lookup earlier (it now needs to run *before* `generateRound`, not after) and pass its parsed split as `avoidSplit`:

```ts
  async propose(sessionCode: string, courtNumber: number) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw new NotFoundException();

    const roster = await this.prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });
    const reserved = new Set<string>();
    let existingPending: (typeof nonEnded)[number] | undefined;
    for (const p of nonEnded) {
      if (p.courtNumber === courtNumber) {
        if (p.confirmedAt === null) existingPending = p;
        continue;
      }
      const [a1, a2] = JSON.parse(p.teamA) as [string, string];
      const [b1, b2] = JSON.parse(p.teamB) as [string, string];
      reserved.add(a1);
      reserved.add(a2);
      reserved.add(b1);
      reserved.add(b2);
    }
    const available = rosterPlayerIds.filter((id) => !reserved.has(id));

    const confirmed = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: { not: null } },
    });
    const history = deriveHistory(
      confirmed.map((p) => ({
        teamA: JSON.parse(p.teamA) as [string, string],
        teamB: JSON.parse(p.teamB) as [string, string],
      }))
    );

    const avoidSplit = existingPending
      ? {
          teamA: JSON.parse(existingPending.teamA) as [string, string],
          teamB: JSON.parse(existingPending.teamB) as [string, string],
        }
      : undefined;

    const result = generateRound(available, 1, history, undefined, avoidSplit);
    if (result.courts.length === 0) {
      return { ok: false as const, reason: 'not-enough-players' as const };
    }
    const [proposed] = result.courts;
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    const pairing = existingPending
      ? await this.prisma.pairing.update({
          where: { id: existingPending.id },
          data: { teamA, teamB },
        })
      : await this.prisma.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber,
            matchNumber:
              (await this.prisma.pairing.count({
                where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
              })) + 1,
            teamA,
            teamB,
          },
        });

    return {
      ok: true as const,
      pairing: {
        id: pairing.id,
        courtNumber: pairing.courtNumber,
        matchNumber: pairing.matchNumber,
        teamA: proposed.teamA,
        teamB: proposed.teamB,
      },
    };
  }
```

Note what changed from the original: `existingPending` is now found by scanning `nonEnded` for this court's own row (rather than a separate `findFirst` query issued *after* `generateRound`) — this both saves a round-trip and, critically, makes the pending split available *before* the search runs, which is the whole point. An active (confirmed) court's own row is never a candidate here since `propose` is only ever called for idle/pending courts by the client, but the scan only treats it as `existingPending` when `confirmedAt === null` regardless — an already-active court would just have no `existingPending` set and `avoidSplit` stays undefined, matching prior behavior for that edge case.

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: PASS, full suite — including the existing `'proposes a match, reshuffles in place...'` test, which this change must not regress (reshuffle still updates the same pending row in place, `matchNumber` unchanged).

- [ ] **Step 5: Verify build, then commit**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
rm -rf dist
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat: pass the current pending split to propose's avoidSplit"
```

---

### Task 3: End session — schema, migration, API

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/sessions/sessions.service.ts`
- Modify: `server/src/sessions/sessions.controller.ts`
- Modify: `server/src/sessions/sessions.controller.spec.ts`
- Create (generated): `server/prisma/migrations/<timestamp>_add_session_ended_at/migration.sql`

**Interfaces:**
- Produces: `GET /sessions/:code` response gains `endedAt: string | null`; new `POST /sessions/:code/end` → `{ code, endedAt }` or 409. Task 4 depends on both.

- [ ] **Step 1: Add the schema field**

Modify `server/prisma/schema.prisma`'s `Session` model — add `endedAt` (placed after `createdAt`, matching `Pairing.endedAt`'s position relative to its own timestamps):

```prisma
model Session {
  code          String          @id
  groupId       String
  date          String?
  venue         String?
  courtCount    Int?
  rawImportText String
  createdAt     DateTime        @default(now())
  endedAt       DateTime?
  group         Group           @relation(fields: [groupId], references: [code])
  roster        SessionRoster[]
  waitlist      Waitlist[]
  pairings      Pairing[]
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
cd server
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx prisma migrate dev --name add_session_ended_at
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx prisma generate
```

Expected: creates `server/prisma/migrations/<timestamp>_add_session_ended_at/migration.sql` (one `ALTER TABLE "Session" ADD COLUMN "endedAt" DATETIME;`), applies it, regenerates the client.

- [ ] **Step 3: Write the failing tests**

Add to `server/src/sessions/sessions.controller.spec.ts`:

```ts
  it('GET /sessions/:code includes endedAt', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const res = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.endedAt).toBeNull();
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('ends a session with no unfinished courts', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/end`)
        .expect(201);
      expect(res.body.code).toBe(sessionCode);
      expect(res.body.endedAt).not.toBeNull();

      const getRes = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(getRes.body.endedAt).not.toBeNull();
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects ending a session with an unfinished court', async () => {
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
      },
    });

    try {
      const res = await request(app.getHttpServer()).post(`/sessions/${sessionCode}/end`).expect(409);
      expect(res.body.message).toContain('Finish all active courts');

      const getRes = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(getRes.body.endedAt).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: FAIL — `endedAt` isn't in the `GET` response yet, and `POST /sessions/:code/end` doesn't exist (404).

- [ ] **Step 5: Implement**

Modify `server/src/sessions/sessions.service.ts` — add `ConflictException` to the `@nestjs/common` import:

```ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
```

Add `endedAt: session.endedAt,` to `getSession`'s returned object (alongside the existing `code`/`groupCode`/etc. fields — insert after `courtCount`):

```ts
    return {
      code: session.code,
      groupCode: session.groupId,
      date: session.date,
      venue: session.venue,
      courtCount: session.courtCount,
      endedAt: session.endedAt,
      rosterPlayerIds: session.roster.map((r) => r.playerId),
      waitlistPlayerIds: session.waitlist.map((w) => w.playerId),
      courts,
    };
```

Add a new method, after `finishPairing`:

```ts
  async endSession(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException();

    const unfinished = await this.prisma.pairing.findFirst({
      where: { sessionId: code, endedAt: null },
    });
    if (unfinished) {
      throw new ConflictException('Finish all active courts before ending the session.');
    }

    const updated = await this.prisma.session.update({
      where: { code },
      data: { endedAt: new Date() },
    });
    return { code: updated.code, endedAt: updated.endedAt };
  }
```

Modify `server/src/sessions/sessions.controller.ts` — add the route, after `finishPairing`:

```ts
  @Post(':code/end')
  endSession(@Param('code') code: string) {
    return this.sessionsService.endSession(code);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: PASS, full suite.

- [ ] **Step 7: Verify build, then commit**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
rm -rf dist
git add server/prisma/schema.prisma server/prisma/migrations server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat: add Session.endedAt and POST /sessions/:code/end"
```

---

### Task 4: Client — end session UI

**Files:**
- Modify: `web/src/app/core/session.model.ts`
- Modify: `web/src/app/core/live-session.service.ts`, `.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`, `.html`, `.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`, `.html`, `.spec.ts`
- Modify: `web/src/app/pages/session-display/session-display.ts`, `.html`, `.spec.ts`

**Interfaces:**
- Produces: `LiveSessionService.endSession(): Promise<{ ok: true } | { ok: false; error: string }>` — consumed by `SessionDashboard`.
- `Session.endedAt: string | null` — read directly off `liveSession.sessionResource` by `CourtPanel` and `SessionDisplay` (no new `@Input` needed, both already inject `LiveSessionService`).

- [ ] **Step 1: Add `endedAt` to the `Session` model**

Modify `web/src/app/core/session.model.ts`:

```ts
import type { CourtState } from './live-session.model';

export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  endedAt: string | null;
  rawImportText: string;
  rosterPlayerIds: string[];
  waitlistPlayerIds: string[];
  courts: CourtState[];
}
```

- [ ] **Step 2: Write the failing test for `LiveSessionService.endSession`**

Add to `web/src/app/core/live-session.service.spec.ts` — first add `endedAt: null` to the `baseSession` helper's returned object (required now that `Session` includes it):

```ts
function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    endedAt: null,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}
```

Then add, after the `'refresh triggers a reload'` test:

```ts
  it('endSession posts to the end endpoint and reloads on success', async () => {
    await flushSession(baseSession());

    const promise = service.endSession();
    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`);
    expect(req.request.method).toBe('POST');
    req.flush({ code: 'sess1', endedAt: '2026-09-08T20:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(
      baseSession({ endedAt: '2026-09-08T20:00:00.000Z' })
    );

    expect(await promise).toEqual({ ok: true });
  });

  it('endSession surfaces the server error on failure without throwing', async () => {
    await flushSession(baseSession());

    const promise = service.endSession();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`).flush(
      { message: 'Finish all active courts before ending the session.' },
      { status: 409, statusText: 'Conflict' }
    );

    expect(await promise).toEqual({
      ok: false,
      error: 'Finish all active courts before ending the session.',
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd web && PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/live-session.service.spec.ts'
```

Expected: FAIL to compile — `Session` now requires `endedAt`, and `LiveSessionService` has no `endSession` method yet.

- [ ] **Step 4: Implement `LiveSessionService.endSession`**

Modify `web/src/app/core/live-session.service.ts` — add `HttpErrorResponse` to the `@angular/common/http` import:

```ts
import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
```

Add the method, after `finishMatch`:

```ts
  async endSession(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await firstValueFrom(
        this.http.post<{ code: string; endedAt: string }>(
          `${this.base}/sessions/${this.sessionCode}/end`,
          {}
        )
      );
      this.sessionResource.reload();
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse && typeof err.error?.message === 'string'
          ? err.error.message
          : 'Could not end the session.';
      return { ok: false, error: message };
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/live-session.service.spec.ts'
```

Expected: PASS.

- [ ] **Step 6: `SessionDashboard` — "End session" button**

Modify `web/src/app/pages/session-dashboard/session-dashboard.spec.ts` — add `endedAt: null` to that file's `baseSession` helper too (same reason as Step 2), then add, before the closing `});` of the `describe` block:

```ts
  it('End session button calls endSession and shows the server error on failure', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent === 'End session') as HTMLButtonElement;
    button.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/end`);
    req.flush(
      { message: 'Finish all active courts before ending the session.' },
      { status: 409, statusText: 'Conflict' }
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Finish all active courts before ending the session.');
  });
```

Run it to verify it fails (no "End session" button exists yet):

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-dashboard.spec.ts'
```

Modify `web/src/app/pages/session-dashboard/session-dashboard.ts` — add `signal` to the `@angular/core` import:

```ts
import { Component, computed, signal } from '@angular/core';
```

Add, after the `waitingNames` computed:

```ts
  readonly ended = computed(() => this.session()?.endedAt != null);
  readonly endSessionError = signal<string | null>(null);

  async endSession(): Promise<void> {
    this.endSessionError.set(null);
    const result = await this.liveSession.endSession();
    if (!result.ok) {
      this.endSessionError.set(result.error);
    }
  }
```

Modify `web/src/app/pages/session-dashboard/session-dashboard.html` — add before the closing `</div>` of `.dashboard` (after the `@if (waitlistNames().length > 0)` block):

```html
    @if (!ended()) {
      <hr class="rule" />
      <button type="button" (click)="endSession()">End session</button>
      @if (endSessionError()) {
        <p class="error">{{ endSessionError() }}</p>
      }
    } @else {
      <hr class="rule" />
      <p class="ended-notice">Session ended.</p>
    }
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-dashboard.spec.ts'
```

Expected: PASS.

- [ ] **Step 8: `CourtPanel` — read-only once ended**

Modify `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts` — add `endedAt: null` to its `baseSession` helper, then add a new test after the existing `'shows a "Finish match" control once active'` test:

```ts
  it('shows a plain ended state instead of controls once the session has ended', async () => {
    const { fixture } = await createPanel(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session ended');
    expect(text).not.toContain('Start next match');
  });
```

Run it to verify it fails:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/court-panel.spec.ts'
```

Modify `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` — add, after the `court` computed:

```ts
  protected readonly ended = computed(() => {
    if (this.liveSession.sessionResource.error()) return false;
    return this.liveSession.sessionResource.value()?.endedAt != null;
  });
```

Modify `web/src/app/pages/session-dashboard/court-panel/court-panel.html` — wrap the existing `@switch` in an ended check:

```html
<div class="court-panel">
  @let c = court();

  <div class="court-panel-head">
    <h4>Court {{ courtNumber() }}</h4>
    <span class="status-dot" [class]="c.status"></span>
  </div>

  @if (ended()) {
    <p class="matchup idle-label">Session ended</p>
  } @else {
    @switch (c.status) {
      @case ('idle') {
        <p class="matchup idle-label">Idle</p>
        <button type="button" (click)="startOrReshuffle()">Start next match</button>
        @if (notEnoughPlayers()) {
          <p class="hint">Not enough players waiting.</p>
        }
      }
      @case ('pending') {
        @if (c.status === 'pending') {
          @let aNames = teamNames(c.teamA);
          @let bNames = teamNames(c.teamB);
          <p class="matchup">{{ aNames[0] }} &amp; {{ aNames[1] }} <span class="vs">vs</span> {{ bNames[0] }} &amp; {{ bNames[1] }}</p>
        }
        <div class="button-row">
          <button type="button" class="ghost" (click)="startOrReshuffle()">Reshuffle</button>
          <button type="button" (click)="confirm()">Confirm</button>
        </div>
      }
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
        <button type="button" (click)="finish()">Finish match</button>
      }
    }
  }
</div>
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/court-panel.spec.ts'
```

Expected: PASS.

- [ ] **Step 10: `SessionDisplay` — ended state**

Modify `web/src/app/pages/session-display/session-display.spec.ts` — add `endedAt: null` to its `baseSession` helper, then add a new test after `'shows the pairing for an active court'`:

```ts
  it('shows a plain ended state instead of the live court grid once the session has ended', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({ endedAt: '2026-09-08T20:00:00.000Z' })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session ended');
  });
```

Run it to verify it fails:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-display.spec.ts'
```

Modify `web/src/app/pages/session-display/session-display.ts` — add, after `sessionExists`:

```ts
  readonly ended = computed(() => this.session()?.endedAt != null);
```

Modify `web/src/app/pages/session-display/session-display.html`:

```html
@if (sessionExists()) {
  <div class="page-dark display">
    <h1>{{ header() }}</h1>

    @if (ended()) {
      <p class="ended-notice">Session ended.</p>
    } @else {
      <div class="courts">
        @for (line of courtLines(); track line.courtNumber) {
          <div class="court-line" [class.playing]="line.text !== 'waiting'">
            <span class="court-number">{{ line.courtNumber }}</span>
            <p class="court-text">{{ line.text }}</p>
          </div>
        }
      </div>

      <hr class="rule" />

      <p class="waiting-line">รอคิว: {{ waitingNames().join(', ') }}</p>

      <button type="button" class="refresh" (click)="refresh()">↻ Refresh</button>
    }
  </div>
} @else {
  <div class="page-dark">
    <p>Session not found.</p>
  </div>
}
```

- [ ] **Step 11: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-display.spec.ts'
```

Expected: PASS.

- [ ] **Step 12: Full-suite verification, then commit**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng build
rm -rf dist
git add web/src/app/core/session.model.ts web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts web/src/app/pages/session-dashboard web/src/app/pages/session-display
git commit -m "feat: end session UI (dashboard action, court panel and display read-only states)"
```

---

## Post-implementation

Update `PROJECT.md`:
- §9 checklist: add an entry noting end session + reshuffle fairness were added, under Build order.
- §3 (v1 feature set) or wherever session lifecycle is described: note the session now has an explicit ended state.
