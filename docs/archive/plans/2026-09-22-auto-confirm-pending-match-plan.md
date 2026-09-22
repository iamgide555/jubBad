# Auto-Confirm a Pending Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A proposed match left untouched for 60s confirms itself, with its
timer backdated to read ~30s at the moment it starts, so a host who forgets
to tap ยืนยัน no longer loses the match's start time.

**Architecture:** A new nullable `Pairing.pendingSince` column records when a
pending match last changed. Every existing write to a pending match sets it;
undoing a confirm clears it. A new `SessionsService.autoConfirmDue()` method,
called every 5s by a small NestJS provider (`AutoConfirmScheduler`), confirms
any pending match whose `pendingSince` is ≥60s old and still eligible,
backdating `confirmedAt` to `pendingSince + 30s`. `GET /sessions/:code`
exposes the deadline as `autoStartAt` so the dashboard can show a countdown.

**Tech Stack:** NestJS + Prisma + SQLite (server), Angular + vitest (web). No
new dependencies — the sweep is a plain `setInterval`.

**Spec:** `docs/superpowers/specs/2026-09-22-auto-confirm-pending-match-design.md`

## Global Constraints

- Delay before auto-confirm: **60s** (`AUTO_CONFIRM_DELAY_MS`), counted from
  `pendingSince`.
- Backdated start: `confirmedAt = pendingSince + 30s` (`AUTO_CONFIRM_WALK_ON_MS`),
  never based on "now" — see spec §"Backdating (D5)".
- Sweep interval: **5s** (`AUTO_CONFIRM_SWEEP_MS`), independent of the 60s delay.
- Countdown shown **only** on the host dashboard (`court-panel`), never on
  the TV display (spec D2).
- Custom mode is included only once every seat on the court is filled (spec D3).
- Always on — no per-session or per-group switch (spec D4).
- No new server dependency (no `@nestjs/schedule`); plain `setInterval`,
  `unref()`'d, cleared in `onModuleDestroy`.
- Translation strings are added by hand to both
  `web/src/locale/messages.xlf` and `web/src/locale/messages.en.xlf` — there
  is no extract script in this repo.
- This plan carries a Prisma migration. Before deploying, back up
  (`docker compose exec -T api npm run db:backup`) per `dockerDeploy.md`,
  and check the pull's file list for any other undeployed migration — see
  `docs/superpowers/specs/2026-09-22-auto-confirm-pending-match-design.md` §9.

---

### Task 1: `Pairing.pendingSince` column

**Files:**
- Modify: `server/prisma/schema.prisma:162-183` (`Pairing` model)
- Create: `server/prisma/migrations/<timestamp>_add_pairing_pending_since/migration.sql` (generated)
- Modify: `server/src/prisma-roundtrip.spec.ts:39-61` (extend the existing pairing round-trip test)

**Interfaces:**
- Produces: `Pairing.pendingSince: Date | null` on the Prisma client, used by every later task.

- [ ] **Step 1: Write the failing assertion**

  In `server/src/prisma-roundtrip.spec.ts`, inside the first `it` block, add a
  `pendingSince` write to the existing `pairing` create call and a matching
  assertion next to the existing `teamA`/`teamB` ones:

  ```ts
  const pendingSince = new Date('2026-09-22T10:00:00.000Z');
  const pairing = await prisma.pairing.create({
    data: {
      sessionId: session.code,
      courtNumber: 1,
      matchNumber: 1,
      teamA: JSON.stringify([player.id, player.id]),
      teamB: JSON.stringify([player.id, player.id]),
      pendingSince,
    },
  });
  ```

  ```ts
  expect(readBackPairing.pendingSince?.toISOString()).toBe(pendingSince.toISOString());
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `npm --prefix server test -- prisma-roundtrip.spec.ts`
  Expected: FAIL — `Unknown argument 'pendingSince'` (the column doesn't exist yet).

- [ ] **Step 3: Add the column to the schema**

  In `server/prisma/schema.prisma`, inside `model Pairing`, right after `revision`:

  ```prisma
  revision    Int       @default(0)
  /// When this pending pairing last changed. The auto-confirm sweep counts
  /// 60s from here, and backdates `confirmedAt` to 30s after it — see
  /// docs/superpowers/specs/2026-09-22-auto-confirm-pending-match-design.md.
  /// Null means auto-confirm is off: a row from before this column existed,
  /// or one an undone confirm just cleared.
  pendingSince DateTime?
  confirmedAt DateTime?
  ```

- [ ] **Step 4: Generate the migration**

  Run: `cd server && npx prisma migrate dev --name add_pairing_pending_since`

  This writes `server/prisma/migrations/<timestamp>_add_pairing_pending_since/migration.sql`
  (a single `ALTER TABLE "Pairing" ADD COLUMN "pendingSince" DATETIME;`) and
  applies it to your local `dev.db`. It also regenerates the Prisma client,
  which is what step 2's error goes away with.

- [ ] **Step 5: Run the test again to confirm it passes**

  Run: `npm --prefix server test -- prisma-roundtrip.spec.ts`
  Expected: PASS (this also re-runs `prisma migrate deploy` against a fresh
  test database via `test/vitest-global-setup.ts`, proving the migration
  applies cleanly from scratch).

- [ ] **Step 6: Commit**

  ```bash
  git add server/prisma/schema.prisma server/prisma/migrations server/src/prisma-roundtrip.spec.ts
  git commit -m "feat(schema): add Pairing.pendingSince"
  ```

---

### Task 2: Set `pendingSince` on every pending-pairing write

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (see exact sites below)
- Create: `server/src/sessions/pending-since.spec.ts`

**Interfaces:**
- Consumes: `Pairing.pendingSince` (Task 1).
- Produces: every write path below now keeps `pendingSince` current; later
  tasks (`autoConfirmDue`, `getSession`) read it.

This task touches many small sites. Each is a one-line addition to an
existing Prisma write. Write the test file first (it will fail against the
current code), then make each site pass one at a time, running the whole
file after each edit.

- [ ] **Step 1: Write the failing test file**

  Create `server/src/sessions/pending-since.spec.ts`:

  ```ts
  import { randomUUID } from 'node:crypto';
  import { Test } from '@nestjs/testing';
  import { PrismaModule } from '../prisma/prisma.module.js';
  import { PrismaService } from '../prisma/prisma.service.js';
  import { SessionsModule } from './sessions.module.js';
  import { SessionsService } from './sessions.service.js';

  describe('Pairing.pendingSince is kept current', () => {
    let prisma: PrismaService;
    let service: SessionsService;

    async function fixture(names: string[], courtCount = 1, mode = 'variety') {
      const groupCode = randomUUID();
      const sessionCode = randomUUID().slice(0, 8);
      await prisma.group.create({ data: { code: groupCode } });
      const players = await Promise.all(
        names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
      );
      await prisma.session.create({
        data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '', mode },
      });
      await Promise.all(
        players.map((player) =>
          prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } })
        )
      );
      return { groupCode, sessionCode, players };
    }

    async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }

    async function backdate(pairingId: string, isoTime: string) {
      await prisma.pairing.update({ where: { id: pairingId }, data: { pendingSince: new Date(isoTime) } });
    }

    beforeAll(async () => {
      const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
      prisma = module.get(PrismaService);
      service = module.get(SessionsService);
    });

    it('propose sets it, and reshuffling on the same court bumps it forward', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const first = await service.propose(data.sessionCode, 1);
        if (!first.ok) throw new Error('expected ok');
        const firstRow = await prisma.pairing.findUniqueOrThrow({ where: { id: first.pairing.id } });
        expect(firstRow.pendingSince).not.toBeNull();

        await backdate(first.pairing.id, '2020-01-01T00:00:00.000Z');
        const reshuffled = await service.propose(data.sessionCode, 1);
        if (!reshuffled.ok) throw new Error('expected ok');
        const reshuffledRow = await prisma.pairing.findUniqueOrThrow({ where: { id: reshuffled.pairing.id } });
        expect(reshuffledRow.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
      } finally {
        await remove(data);
      }
    });

    it('fillIdleCourts sets it, in both variety and custom mode', async () => {
      const variety = await fixture(['A', 'B', 'C', 'D'], 1, 'variety');
      const custom = await fixture(['A', 'B', 'C', 'D'], 1, 'custom');
      try {
        await service.fillIdleCourts(variety.sessionCode);
        const varietyRow = await prisma.pairing.findFirstOrThrow({ where: { sessionId: variety.sessionCode } });
        expect(varietyRow.pendingSince).not.toBeNull();

        await service.fillIdleCourts(custom.sessionCode);
        const customRow = await prisma.pairing.findFirstOrThrow({ where: { sessionId: custom.sessionCode } });
        expect(customRow.pendingSince).not.toBeNull();
      } finally {
        await remove(variety);
        await remove(custom);
      }
    });

    it('swap (auto-pick and chosen-player) bumps it, on both rows in a cross-court trade', async () => {
      const data = await fixture(['A', 'B', 'C', 'D', 'E', 'F'], 2);
      try {
        const near = await service.propose(data.sessionCode, 1);
        const far = await service.propose(data.sessionCode, 2);
        if (!near.ok || !far.ok) throw new Error('expected ok');
        await backdate(near.pairing.id, '2020-01-01T00:00:00.000Z');
        await backdate(far.pairing.id, '2020-01-01T00:00:00.000Z');

        const nearOnCourt = near.pairing.teamA[0];
        const autoSwapped = await service.swapPlayer(data.sessionCode, near.pairing.id, {
          playerId: nearOnCourt,
          expectedRevision: near.pairing.revision,
        });
        expect(autoSwapped.ok).toBe(true);
        const nearRow = await prisma.pairing.findUniqueOrThrow({ where: { id: near.pairing.id } });
        expect(nearRow.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

        await backdate(near.pairing.id, '2020-01-01T00:00:00.000Z');
        const farOnCourt = far.pairing.teamA[0];
        const nearNowOnCourt = nearRow.pendingSince && JSON.parse(nearRow.teamA)[0];
        const traded = await service.swapPlayer(data.sessionCode, near.pairing.id, {
          playerId: nearNowOnCourt,
          withPlayerId: farOnCourt,
          expectedRevision: nearRow.revision,
        });
        expect(traded.ok).toBe(true);
        const nearAfterTrade = await prisma.pairing.findUniqueOrThrow({ where: { id: near.pairing.id } });
        const farAfterTrade = await prisma.pairing.findUniqueOrThrow({ where: { id: far.pairing.id } });
        expect(nearAfterTrade.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
        expect(farAfterTrade.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
      } finally {
        await remove(data);
      }
    });

    it('setSeat and autoPair bump it, in custom mode', async () => {
      const data = await fixture(['A', 'B', 'C', 'D'], 1, 'custom');
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');

        const seated = await service.setSeat(data.sessionCode, proposed.pairing.id, {
          team: 'A',
          index: 0,
          playerId: data.players[0].id,
          expectedRevision: proposed.pairing.revision,
        });
        expect(seated.ok).toBe(true);
        const afterSeat = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(afterSeat.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

        await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');
        const autoPaired = await service.autoPair(data.sessionCode, proposed.pairing.id, afterSeat.revision);
        expect(autoPaired.ok).toBe(true);
        const afterAutoPair = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(afterAutoPair.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
      } finally {
        await remove(data);
      }
    });

    it('resting or returning a seated player bumps it on their pending court', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');

        const onCourt = proposed.pairing.teamA[0];
        await service.setRosterActive(data.sessionCode, onCourt, { active: false });
        const afterRest = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(afterRest.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

        await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');
        await service.setRosterActive(data.sessionCode, onCourt, { active: true });
        const afterReturn = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(afterReturn.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
      } finally {
        await remove(data);
      }
    });

    it('undoing a confirm clears it, and the next edit sets it again', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await service.confirmPairing(data.sessionCode, proposed.pairing.id, proposed.pairing.revision);

        const undone = await service.undoLastOnCourt(data.sessionCode, 1);
        expect(undone).toEqual({ ok: true, undone: 'confirm' });
        const afterUndo = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(afterUndo.pendingSince).toBeNull();

        const reshuffled = await service.propose(data.sessionCode, 1);
        if (!reshuffled.ok) throw new Error('expected ok');
        const afterReshuffle = await prisma.pairing.findUniqueOrThrow({ where: { id: reshuffled.pairing.id } });
        expect(afterReshuffle.pendingSince).not.toBeNull();
      } finally {
        await remove(data);
      }
    });
  });
  ```

- [ ] **Step 2: Run it to confirm every case fails**

  Run: `npm --prefix server test -- pending-since.spec.ts`
  Expected: every `it` FAILs — `pendingSince` is `null` everywhere (no write
  site sets it yet), and the undo test fails because there is nothing to
  clear.

- [ ] **Step 3: `upsertPendingPairing` — propose and reshuffle**

  In `sessions.service.ts`, `upsertPendingPairing` (the update branch and the
  create branch):

  ```ts
      const updated = await this.prisma.pairing.updateMany({
        where: {
          id: existingPending.id,
          confirmedAt: null,
          endedAt: null,
          revision: existingPending.revision,
        },
        data: { teamA, teamB, revision: { increment: 1 } },
      });
  ```

  becomes:

  ```ts
      const updated = await this.prisma.pairing.updateMany({
        where: {
          id: existingPending.id,
          confirmedAt: null,
          endedAt: null,
          revision: existingPending.revision,
        },
        data: { teamA, teamB, pendingSince: new Date(), revision: { increment: 1 } },
      });
  ```

  and

  ```ts
    return this.prisma.pairing.create({
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
  ```

  becomes:

  ```ts
    return this.prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber,
        matchNumber:
          (await this.prisma.pairing.count({
            where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
          })) + 1,
        teamA,
        teamB,
        pendingSince: new Date(),
      },
    });
  ```

- [ ] **Step 4: `fillExclusively` — both the custom-mode and engine branches**

  Both `tx.pairing.create({ data: { sessionId: sessionCode, courtNumber, matchNumber, teamA: ..., teamB: ... } })`
  calls in `fillExclusively` (one in the `isCustomMode` branch, one after it)
  gain the same `pendingSince: new Date(),` line inside `data`.

- [ ] **Step 5: `swapPlayerExclusively` (auto-pick)**

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(newTeamA),
        teamB: JSON.stringify(newTeamB),
        revision: { increment: 1 },
      },
    });
  ```

  becomes:

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(newTeamA),
        teamB: JSON.stringify(newTeamB),
        pendingSince: new Date(),
        revision: { increment: 1 },
      },
    });
  ```

- [ ] **Step 6: `swapWithChosenPlayer` — both the near and far row**

  ```ts
      const near = await tx.pairing.updateMany({
        where: {
          id: pairing.id,
          confirmedAt: null,
          endedAt: null,
          revision: dto.expectedRevision ?? pairing.revision,
        },
        data: {
          teamA: JSON.stringify(newTeamA),
          teamB: JSON.stringify(newTeamB),
          revision: { increment: 1 },
        },
      });
  ```

  becomes:

  ```ts
      const near = await tx.pairing.updateMany({
        where: {
          id: pairing.id,
          confirmedAt: null,
          endedAt: null,
          revision: dto.expectedRevision ?? pairing.revision,
        },
        data: {
          teamA: JSON.stringify(newTeamA),
          teamB: JSON.stringify(newTeamB),
          pendingSince: new Date(),
          revision: { increment: 1 },
        },
      });
  ```

  and, right below it:

  ```ts
        const far = await tx.pairing.updateMany({
          where: { id: other.id, confirmedAt: null, endedAt: null, revision: other.revision },
          data: {
            teamA: JSON.stringify(replaceIn(other.teamA, incomingId, dto.playerId)),
            teamB: JSON.stringify(replaceIn(other.teamB, incomingId, dto.playerId)),
            revision: { increment: 1 },
          },
        });
  ```

  becomes:

  ```ts
        const far = await tx.pairing.updateMany({
          where: { id: other.id, confirmedAt: null, endedAt: null, revision: other.revision },
          data: {
            teamA: JSON.stringify(replaceIn(other.teamA, incomingId, dto.playerId)),
            teamB: JSON.stringify(replaceIn(other.teamB, incomingId, dto.playerId)),
            pendingSince: new Date(),
            revision: { increment: 1 },
          },
        });
  ```

- [ ] **Step 7: `setSeatExclusively`**

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: { ...column, revision: { increment: 1 } },
    });
  ```

  becomes:

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: { ...column, pendingSince: new Date(), revision: { increment: 1 } },
    });
  ```

  (The early return above it, for vacating an already-empty seat, stays
  untouched — nothing changed, so nothing should reset the countdown.)

- [ ] **Step 8: `autoPairExclusively`**

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(result.teamA),
        teamB: JSON.stringify(result.teamB),
        revision: { increment: 1 },
      },
    });
  ```

  becomes:

  ```ts
    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(result.teamA),
        teamB: JSON.stringify(result.teamB),
        pendingSince: new Date(),
        revision: { increment: 1 },
      },
    });
  ```

- [ ] **Step 9: `setRosterActiveExclusively` — reset on every pending court the player is seated on**

  Right after the existing roster write succeeds (after the `if (result.count !== 1) { throw this.conflict('ROSTER_STALE'); }` block, before the final `return`):

  ```ts
    const updated = await this.prisma.sessionRoster.findUniqueOrThrow({ where: { id: entry.id } });

    // Resting or returning a player doesn't rewrite the courts they're
    // seated on (see the module doc on `setRosterActiveExclusively`), but it
    // does change whether that court is eligible to auto-confirm — bringing
    // someone back who was resting for 10 minutes must not hand them an
    // auto-confirm backdated to before they returned.
    const openPairings = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: null, endedAt: null },
    });
    const affected = openPairings.filter((p) => this.playersOf(p).includes(playerId));
    if (affected.length > 0) {
      await this.prisma.pairing.updateMany({
        where: { id: { in: affected.map((p) => p.id) } },
        data: { pendingSince: new Date() },
      });
    }

    return { playerId: updated.playerId, active: updated.active };
  ```

  This replaces the existing two lines:

  ```ts
    const updated = await this.prisma.sessionRoster.findUniqueOrThrow({ where: { id: entry.id } });
    return { playerId: updated.playerId, active: updated.active };
  ```

- [ ] **Step 10: `undoExclusively` — clear it on undoing a confirm**

  ```ts
    const unconfirmed = await this.prisma.pairing.updateMany({
      where: { id: latest.id, confirmedAt: { not: null }, endedAt: null, revision: latest.revision },
      data: { confirmedAt: null, revision: { increment: 1 } },
    });
  ```

  becomes:

  ```ts
    const unconfirmed = await this.prisma.pairing.updateMany({
      where: { id: latest.id, confirmedAt: { not: null }, endedAt: null, revision: latest.revision },
      data: { confirmedAt: null, pendingSince: null, revision: { increment: 1 } },
    });
  ```

- [ ] **Step 11: Run the test file to confirm every case passes**

  Run: `npm --prefix server test -- pending-since.spec.ts`
  Expected: PASS, all 6 tests.

- [ ] **Step 12: Run the full server suite to confirm nothing else broke**

  Run: `npm --prefix server test`
  Expected: PASS. (Verified ahead of time: no existing test does a
  whole-object `toEqual` on a raw `Pairing` row or on a mutation endpoint's
  full response body, so adding `pendingSince` to those rows/responses does
  not require updating any other test's expectations.)

- [ ] **Step 13: Commit**

  ```bash
  git add server/src/sessions/sessions.service.ts server/src/sessions/pending-since.spec.ts
  git commit -m "feat(sessions): keep Pairing.pendingSince current on every pending edit"
  ```

---

### Task 3: `autoConfirmDue()` — the sweep's core logic

**Files:**
- Modify: `server/src/sessions/sessions.service.ts`
- Create: `server/src/sessions/auto-confirm-due.spec.ts`

**Interfaces:**
- Consumes: `Pairing.pendingSince` (Task 1), the fact that every pending edit
  keeps it current (Task 2).
- Produces: `SessionsService.AUTO_CONFIRM_DELAY_MS: number`,
  `SessionsService.AUTO_CONFIRM_WALK_ON_MS: number` (module-level exports),
  `SessionsService.autoConfirmDue(now?: Date): Promise<string[]>` — used by
  `AutoConfirmScheduler` in Task 5 and read by `getSession`'s
  `autoStartAtFor` in Task 4.

- [ ] **Step 1: Write the failing tests**

  Create `server/src/sessions/auto-confirm-due.spec.ts`:

  ```ts
  import { randomUUID } from 'node:crypto';
  import { Test } from '@nestjs/testing';
  import { PrismaModule } from '../prisma/prisma.module.js';
  import { PrismaService } from '../prisma/prisma.service.js';
  import { SessionsModule } from './sessions.module.js';
  import { AUTO_CONFIRM_DELAY_MS, AUTO_CONFIRM_WALK_ON_MS, SessionsService } from './sessions.service.js';

  describe('SessionsService.autoConfirmDue', () => {
    let prisma: PrismaService;
    let service: SessionsService;

    async function fixture(names: string[], courtCount = 1) {
      const groupCode = randomUUID();
      const sessionCode = randomUUID().slice(0, 8);
      await prisma.group.create({ data: { code: groupCode } });
      const players = await Promise.all(
        names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
      );
      await prisma.session.create({
        data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '' },
      });
      await Promise.all(
        players.map((player) =>
          prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } })
        )
      );
      return { groupCode, sessionCode, players };
    }

    async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }

    beforeAll(async () => {
      const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
      prisma = module.get(PrismaService);
      service = module.get(SessionsService);
    });

    it('confirms a match pending for exactly the delay, backdated by the walk-on offset, and leaves a fresher one alone', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        const pendingSince = new Date('2026-09-22T10:00:00.000Z');
        await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince } });

        const tooSoon = new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS - 1000);
        expect(await service.autoConfirmDue(tooSoon)).toEqual([]);
        expect(
          (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
        ).toBeNull();

        const dueAt = new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS);
        const confirmedIds = await service.autoConfirmDue(dueAt);
        expect(confirmedIds).toEqual([proposed.pairing.id]);

        const row = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        expect(row.confirmedAt?.toISOString()).toBe(
          new Date(pendingSince.getTime() + AUTO_CONFIRM_WALK_ON_MS).toISOString()
        );
        expect(row.revision).toBe(proposed.pairing.revision + 1);
      } finally {
        await remove(data);
      }
    });

    it('skips an empty seat, a resting player, and a null pendingSince, leaving each pending', async () => {
      const customData = await fixture(['A', 'B', 'C', 'D']);
      try {
        await prisma.session.update({ where: { code: customData.sessionCode }, data: { mode: 'custom' } });
        const draft = await service.propose(customData.sessionCode, 1);
        if (!draft.ok) throw new Error('expected ok');
        const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
        await prisma.pairing.update({
          where: { id: draft.pairing.id },
          data: { pendingSince: new Date(overdue.getTime() - AUTO_CONFIRM_DELAY_MS) },
        });
        await expect(service.autoConfirmDue(overdue)).resolves.not.toContain(draft.pairing.id);
        expect(
          (await prisma.pairing.findUniqueOrThrow({ where: { id: draft.pairing.id } })).confirmedAt
        ).toBeNull();
      } finally {
        await remove(customData);
      }

      const restingData = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(restingData.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await service.setRosterActive(restingData.sessionCode, proposed.pairing.teamA[0], { active: false });
        const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
        await prisma.pairing.update({
          where: { id: proposed.pairing.id },
          data: { pendingSince: new Date(overdue.getTime() - AUTO_CONFIRM_DELAY_MS) },
        });
        await expect(service.autoConfirmDue(overdue)).resolves.not.toContain(proposed.pairing.id);
        expect(
          (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
        ).toBeNull();
      } finally {
        await remove(restingData);
      }

      const untouchedData = await fixture(['A', 'B', 'C', 'D']);
      try {
        await prisma.pairing.create({
          data: {
            sessionId: untouchedData.sessionCode,
            courtNumber: 1,
            matchNumber: 1,
            teamA: JSON.stringify([untouchedData.players[0].id, untouchedData.players[1].id]),
            teamB: JSON.stringify([untouchedData.players[2].id, untouchedData.players[3].id]),
            // pendingSince left null on purpose — a row from before this column existed.
          },
        });
        const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
        expect(await service.autoConfirmDue(overdue)).toEqual([]);
      } finally {
        await remove(untouchedData);
      }
    });

    it('skips a row edited since the sweep read it, and never throws on a row deleted in the meantime', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        const dueAt = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
        await prisma.pairing.update({
          where: { id: proposed.pairing.id },
          data: { pendingSince: new Date(dueAt.getTime() - AUTO_CONFIRM_DELAY_MS) },
        });

        // Edited after the sweep would have read it: swap changes teamA and
        // bumps pendingSince to something newer than what a stale sweep read.
        const before = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
        await service.swapPlayer(data.sessionCode, proposed.pairing.id, {
          playerId: before.teamA && JSON.parse(before.teamA)[0],
          expectedRevision: before.revision,
        });
        await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince: before.pendingSince } });
        // pendingSince now matches the stale read again, but revision has moved on.
        expect(await service.autoConfirmDue(dueAt)).toEqual([]);
        expect(
          (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
        ).toBeNull();

        await prisma.pairing.delete({ where: { id: proposed.pairing.id } });
        await expect(service.autoConfirmDue(dueAt)).resolves.toEqual([]);
      } finally {
        await remove(data);
      }
    });
  });
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `npm --prefix server test -- auto-confirm-due.spec.ts`
  Expected: FAIL — `autoConfirmDue` and the two constants don't exist yet
  (TypeScript compile error / `service.autoConfirmDue is not a function`).

- [ ] **Step 3: Add the two constants**

  In `sessions.service.ts`, right after the `SessionMatch` interface and
  before `@Injectable()`:

  ```ts
  /** How long a pending match sits untouched before it confirms itself. */
  export const AUTO_CONFIRM_DELAY_MS = 60_000;

  /**
   * How far back of that moment the auto-confirm backdates `confirmedAt` —
   * an estimate of how long players take to read the lineup, check with the
   * host, and walk onto the court once it stops changing. Anchored to
   * `pendingSince` rather than to when the sweep actually runs, so a slow or
   * late sweep (a restart, a busy tick) never changes the recorded start
   * time — see the spec's "Backdating (D5)" section.
   */
  export const AUTO_CONFIRM_WALK_ON_MS = 30_000;
  ```

- [ ] **Step 4: Extract the shared confirm-eligibility check**

  In `sessions.service.ts`, replace the body of `confirmPairingExclusively`
  from the empty-seat comment through the `PLAYER_UNAVAILABLE` throw:

  ```ts
    // A custom-mode draft the host hasn't finished seating. Checked before
    // availability below: an incomplete team's `playersOf` would otherwise
    // silently answer "who's here" from a partial roster, and the more basic
    // fault — this isn't even a full match yet — deserves to surface first.
    // Everything downstream of confirm (deriveHistory, loadRatings, stats,
    // export's finishedMatches) relies on a confirmed row never having an
    // empty seat; this is the one place that guarantee is enforced.
    const empty = emptySeatCount(pairing);
    if (empty > 0) {
      throw this.conflict('PAIRING_INCOMPLETE', { emptySeats: empty });
    }

    // Availability is checked here, not when the player was rested. Resting
    // someone must never disturb a match already being played — they are on
    // court — but a *pending* proposal is only a suggestion, and confirming it
    // would put a player who has gone home onto a court. Checking at
    // confirmation covers both without the host having to remember which
    // courts had proposals open. The fix is a swap or a reshuffle, both of
    // which already draw only from active players.
    const players = this.playersOf(pairing);
    const unavailable = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, playerId: { in: players }, active: false },
      select: { playerId: true },
    });
    if (unavailable.length > 0) {
      throw this.conflict('PLAYER_UNAVAILABLE', {
        playerIds: unavailable.map((r) => r.playerId),
      });
    }
  ```

  with:

  ```ts
    const blocker = await this.pairingConfirmBlocker(sessionCode, pairing);
    if (blocker.blocked) {
      throw this.conflict(blocker.code, blocker.details);
    }
  ```

  Then add the new shared method just above `confirmPairingExclusively`:

  ```ts
  /**
   * Whether a pending pairing can be confirmed right now — shared by the
   * manual confirm endpoint (which throws the matching conflict) and the
   * auto-confirm sweep (which just leaves a blocked pairing pending). One
   * copy of these two checks is what stops the manual and automatic paths
   * from silently drifting apart.
   */
  private async pairingConfirmBlocker(
    sessionCode: string,
    pairing: { teamA: string; teamB: string }
  ): Promise<
    | { blocked: false }
    | { blocked: true; code: 'PAIRING_INCOMPLETE'; details: { emptySeats: number } }
    | { blocked: true; code: 'PLAYER_UNAVAILABLE'; details: { playerIds: string[] } }
  > {
    // A custom-mode draft the host hasn't finished seating. Checked before
    // availability below: an incomplete team's `playersOf` would otherwise
    // silently answer "who's here" from a partial roster, and the more basic
    // fault — this isn't even a full match yet — deserves to surface first.
    // Everything downstream of confirm (deriveHistory, loadRatings, stats,
    // export's finishedMatches) relies on a confirmed row never having an
    // empty seat; this is the one place that guarantee is enforced.
    const empty = emptySeatCount(pairing);
    if (empty > 0) {
      return { blocked: true, code: 'PAIRING_INCOMPLETE', details: { emptySeats: empty } };
    }

    // Availability is checked here, not when the player was rested. Resting
    // someone must never disturb a match already being played — they are on
    // court — but a *pending* proposal is only a suggestion, and confirming it
    // would put a player who has gone home onto a court. Checking at
    // confirmation covers both without the host having to remember which
    // courts had proposals open. The fix is a swap or a reshuffle, both of
    // which already draw only from active players.
    const players = this.playersOf(pairing);
    const unavailable = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, playerId: { in: players }, active: false },
      select: { playerId: true },
    });
    if (unavailable.length > 0) {
      return {
        blocked: true,
        code: 'PLAYER_UNAVAILABLE',
        details: { playerIds: unavailable.map((r) => r.playerId) },
      };
    }

    return { blocked: false };
  }
  ```

- [ ] **Step 5: Add `autoConfirmDue` and its per-row worker**

  Directly below `confirmPairingExclusively`:

  ```ts
  /**
   * Sweep entry point, called on a timer by `AutoConfirmScheduler`
   * (`auto-confirm.ts`) — see the spec's §3. Finds every pairing that has
   * sat pending for at least `AUTO_CONFIRM_DELAY_MS` and confirms each one
   * whose lineup is still eligible, one at a time, under that pairing's
   * session lock so it can never race a manual confirm or edit.
   *
   * `now` is a parameter, not `new Date()` inline, so tests can drive it
   * without waiting on a real clock. Returns the ids it confirmed.
   */
  async autoConfirmDue(now: Date = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - AUTO_CONFIRM_DELAY_MS);
    const due = await this.prisma.pairing.findMany({
      where: { confirmedAt: null, endedAt: null, pendingSince: { not: null, lte: cutoff } },
    });

    const confirmed: string[] = [];
    for (const row of due) {
      try {
        const ok = await this.lock.run(row.sessionId, () =>
          this.autoConfirmOneExclusively(row.id, row.revision, row.pendingSince)
        );
        if (ok) confirmed.push(row.id);
      } catch (error) {
        // One corrupt or unlucky row must never stop the rest of the sweep.
        console.error(`[auto-confirm] failed to confirm pairing ${row.id}`, error);
      }
    }
    return confirmed;
  }

  /**
   * Re-checks everything the outer query took on faith, now that it holds
   * the session lock: the row can have been confirmed, finished, edited, or
   * deleted (a group delete does not take this lock — see
   * `GroupsService.buildDeleteGroupOps`) in the gap between that query and
   * this write. `pendingSinceAtQuery` is compared by value rather than
   * trusted as still current, because an edit can rewrite `pendingSince` to
   * a new `Date` without this call noticing from `revision` alone twice in
   * the same tick.
   */
  private async autoConfirmOneExclusively(
    id: string,
    expectedRevision: number,
    pendingSinceAtQuery: Date | null
  ): Promise<boolean> {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) return false;
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) return false;
    if (pairing.revision !== expectedRevision) return false;
    if (
      pairing.pendingSince === null ||
      pendingSinceAtQuery === null ||
      pairing.pendingSince.getTime() !== pendingSinceAtQuery.getTime()
    ) {
      return false;
    }

    const blocker = await this.pairingConfirmBlocker(pairing.sessionId, pairing);
    if (blocker.blocked) return false;

    const confirmedAt = new Date(pairing.pendingSince.getTime() + AUTO_CONFIRM_WALK_ON_MS);
    const updated = await this.prisma.pairing.updateMany({
      where: { id, confirmedAt: null, endedAt: null, revision: expectedRevision },
      data: { confirmedAt, revision: { increment: 1 } },
    });
    return updated.count === 1;
  }
  ```

- [ ] **Step 6: Run the test file to confirm it passes**

  Run: `npm --prefix server test -- auto-confirm-due.spec.ts`
  Expected: PASS, all 3 tests.

- [ ] **Step 7: Run the full server suite**

  Run: `npm --prefix server test`
  Expected: PASS (the `confirmPairingExclusively` refactor is behavior-preserving).

- [ ] **Step 8: Commit**

  ```bash
  git add server/src/sessions/sessions.service.ts server/src/sessions/auto-confirm-due.spec.ts
  git commit -m "feat(sessions): add autoConfirmDue sweep"
  ```

---

### Task 4: `GET /sessions/:code` exposes `autoStartAt`

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`getSession`)
- Create: `server/src/sessions/get-session-auto-start-at.spec.ts`

**Interfaces:**
- Consumes: `AUTO_CONFIRM_DELAY_MS` (Task 3), `Pairing.pendingSince` (Task 1).
- Produces: a pending court in `getSession`'s response gains
  `autoStartAt: string | null`, consumed by the web app in Task 6.

- [ ] **Step 1: Write the failing tests**

  Create `server/src/sessions/get-session-auto-start-at.spec.ts`:

  ```ts
  import { randomUUID } from 'node:crypto';
  import { Test } from '@nestjs/testing';
  import { PrismaModule } from '../prisma/prisma.module.js';
  import { PrismaService } from '../prisma/prisma.service.js';
  import { SessionsModule } from './sessions.module.js';
  import { AUTO_CONFIRM_DELAY_MS, SessionsService } from './sessions.service.js';

  describe('getSession — pending court autoStartAt', () => {
    let prisma: PrismaService;
    let service: SessionsService;

    async function fixture(names: string[], mode = 'variety') {
      const groupCode = randomUUID();
      const sessionCode = randomUUID().slice(0, 8);
      await prisma.group.create({ data: { code: groupCode } });
      const players = await Promise.all(
        names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
      );
      await prisma.session.create({
        data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '', mode },
      });
      await Promise.all(
        players.map((player) =>
          prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } })
        )
      );
      return { groupCode, sessionCode, players };
    }

    async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }

    beforeAll(async () => {
      const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
      prisma = module.get(PrismaService);
      service = module.get(SessionsService);
    });

    it('is pendingSince + the delay once a fully-seated court has a pendingSince', async () => {
      const data = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(data.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        const pendingSince = new Date('2026-09-22T10:00:00.000Z');
        await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince } });

        const session = await service.getSession(data.sessionCode);
        const court = session.courts[0];
        expect(court.status).toBe('pending');
        if (court.status !== 'pending') return;
        expect(court.autoStartAt).toBe(new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS).toISOString());
      } finally {
        await remove(data);
      }
    });

    it('is null with no pendingSince, an empty seat, or a resting player on the court', async () => {
      const noPendingSince = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(noPendingSince.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince: null } });
        const session = await service.getSession(noPendingSince.sessionCode);
        const court = session.courts[0];
        expect(court.status).toBe('pending');
        if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
      } finally {
        await remove(noPendingSince);
      }

      const emptySeat = await fixture(['A', 'B', 'C', 'D'], 'custom');
      try {
        const draft = await service.propose(emptySeat.sessionCode, 1);
        if (!draft.ok) throw new Error('expected ok');
        await prisma.pairing.update({ where: { id: draft.pairing.id }, data: { pendingSince: new Date() } });
        const session = await service.getSession(emptySeat.sessionCode);
        const court = session.courts[0];
        expect(court.status).toBe('pending');
        if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
      } finally {
        await remove(emptySeat);
      }

      const resting = await fixture(['A', 'B', 'C', 'D']);
      try {
        const proposed = await service.propose(resting.sessionCode, 1);
        if (!proposed.ok) throw new Error('expected ok');
        await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince: new Date() } });
        await service.setRosterActive(resting.sessionCode, proposed.pairing.teamA[0], { active: false });
        const session = await service.getSession(resting.sessionCode);
        const court = session.courts[0];
        expect(court.status).toBe('pending');
        if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
      } finally {
        await remove(resting);
      }
    });
  });
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `npm --prefix server test -- get-session-auto-start-at.spec.ts`
  Expected: FAIL — `court.autoStartAt` is `undefined`.

- [ ] **Step 3: Add the field and its helper**

  In `sessions.service.ts`, add this private method right after `oneSeatOf`:

  ```ts
  /**
   * When a pending pairing will auto-confirm, or null when it won't: no
   * `pendingSince` yet (a row from before this column existed, or one an
   * undo just cleared), a seat still empty, or a seated player currently
   * resting. Mirrors `pairingConfirmBlocker`'s own skip conditions exactly,
   * so this is never shown counting down to a confirm the sweep is actually
   * going to refuse — checked here against the roster this call already
   * loaded, rather than by calling that async, DB-hitting method once per
   * court on every poll of this live-polled endpoint.
   */
  private autoStartAtFor(
    pairing: { teamA: string; teamB: string; pendingSince: Date | null },
    roster: { playerId: string; active: boolean }[]
  ): string | null {
    if (pairing.pendingSince === null) return null;
    if (emptySeatCount(pairing) > 0) return null;
    const restingIds = new Set(roster.filter((r) => !r.active).map((r) => r.playerId));
    if (this.playersOf(pairing).some((id) => restingIds.has(id))) return null;
    return new Date(pairing.pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS).toISOString();
  }
  ```

  Then, in `getSession`, change the pending branch of the courts map:

  ```ts
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            teamA,
            teamB,
          };
  ```

  to:

  ```ts
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            teamA,
            teamB,
            autoStartAt: this.autoStartAtFor(current, session.roster),
          };
  ```

- [ ] **Step 4: Run the test file to confirm it passes**

  Run: `npm --prefix server test -- get-session-auto-start-at.spec.ts`
  Expected: PASS, both tests.

- [ ] **Step 5: Run the full server suite**

  Run: `npm --prefix server test`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add server/src/sessions/sessions.service.ts server/src/sessions/get-session-auto-start-at.spec.ts
  git commit -m "feat(sessions): expose autoStartAt on a pending court"
  ```

---

### Task 5: The sweep's timer — `AutoConfirmScheduler`

**Files:**
- Create: `server/src/sessions/auto-confirm.ts`
- Create: `server/src/sessions/auto-confirm.spec.ts`
- Modify: `server/src/sessions/sessions.module.ts`
- Modify: `server/src/app.module.ts`

**Interfaces:**
- Consumes: `SessionsService.autoConfirmDue()` (Task 3).
- Produces: `AUTO_CONFIRM_SWEEP_MS: number`, `AutoConfirmScheduler`,
  `AutoConfirmModule` — wired into `AppModule` so the sweep actually runs in
  the deployed app.

- [ ] **Step 1: Write the failing scheduler test**

  Create `server/src/sessions/auto-confirm.spec.ts`:

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { AUTO_CONFIRM_SWEEP_MS, AutoConfirmScheduler } from './auto-confirm.js';
  import type { SessionsService } from './sessions.service.js';

  describe('AutoConfirmScheduler', () => {
    let calls: number;
    let concurrent: number;
    let maxConcurrent: number;
    let resolveFns: Array<() => void>;
    let fakeService: { autoConfirmDue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.useFakeTimers();
      calls = 0;
      concurrent = 0;
      maxConcurrent = 0;
      resolveFns = [];
      fakeService = {
        autoConfirmDue: vi.fn(() => {
          calls++;
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          return new Promise<string[]>((resolve) => {
            resolveFns.push(() => {
              concurrent--;
              resolve([]);
            });
          });
        }),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('ticks every AUTO_CONFIRM_SWEEP_MS and never overlaps a slow tick', async () => {
      const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
      scheduler.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      expect(calls).toBe(1);

      // The first call is still pending — a second tick must be skipped, not queued.
      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      expect(calls).toBe(1);

      resolveFns[0]();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      expect(calls).toBe(2);
      expect(maxConcurrent).toBe(1);

      scheduler.onModuleDestroy();
    });

    it('stops ticking after onModuleDestroy', async () => {
      const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
      scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      resolveFns[0]();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS * 3);
      expect(calls).toBe(1);
    });

    it('logs and keeps ticking when a sweep rejects', async () => {
      fakeService.autoConfirmDue.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const scheduler = new AutoConfirmScheduler(fakeService as unknown as SessionsService);
      scheduler.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      expect(errorSpy).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_SWEEP_MS);
      expect(fakeService.autoConfirmDue).toHaveBeenCalledTimes(2);

      scheduler.onModuleDestroy();
      errorSpy.mockRestore();
    });
  });
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `npm --prefix server test -- auto-confirm.spec.ts`
  Expected: FAIL — `./auto-confirm.js` does not exist.

- [ ] **Step 3: Create `auto-confirm.ts`**

  ```ts
  import { Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
  import { SessionsModule } from './sessions.module.js';
  import { SessionsService } from './sessions.service.js';

  /** How often the sweep looks for a pending match past its auto-confirm
   *  delay. Independent of `AUTO_CONFIRM_DELAY_MS` (sessions.service.ts) —
   *  this is how often to check, not how long to wait. */
  export const AUTO_CONFIRM_SWEEP_MS = 5_000;

  /**
   * Runs `SessionsService.autoConfirmDue` on a timer for the life of the
   * process — see the spec's §3. A plain `setInterval` rather than
   * `@nestjs/schedule`: one repeating timer does not need a scheduling
   * library.
   *
   * Kept out of `SessionsModule` on purpose: the session specs build their
   * test app from `SessionsModule` alone and share one test database per
   * run, and a background sweep inside those apps would race their own
   * pending-pairing fixtures, confirming a row a test is still mid-assertion
   * on. Only `AppModule` imports `AutoConfirmModule`, so only a full-app
   * boot (production, or the two specs that build one — see
   * `auth.boundary.spec.ts`, `admin.spec.ts`) gets the timer; those two
   * never leave a pending pairing sitting 60s old, so it's inert for them.
   */
  @Injectable()
  export class AutoConfirmScheduler implements OnApplicationBootstrap, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;

    constructor(private readonly sessions: SessionsService) {}

    onApplicationBootstrap(): void {
      this.timer = setInterval(() => void this.tick(), AUTO_CONFIRM_SWEEP_MS);
      // Never holds the process — or a test run's event loop — open on its own.
      this.timer.unref();
    }

    onModuleDestroy(): void {
      if (this.timer) clearInterval(this.timer);
    }

    /** Skips a tick already in flight rather than overlapping it — a slow
     *  sweep shrinks toward one-at-a-time, never stacks. */
    private async tick(): Promise<void> {
      if (this.running) return;
      this.running = true;
      try {
        await this.sessions.autoConfirmDue();
      } catch (error) {
        console.error('[auto-confirm] sweep failed', error);
      } finally {
        this.running = false;
      }
    }
  }

  @Module({
    imports: [SessionsModule],
    providers: [AutoConfirmScheduler],
  })
  export class AutoConfirmModule {}
  ```

- [ ] **Step 4: Run the test file to confirm it passes**

  Run: `npm --prefix server test -- auto-confirm.spec.ts`
  Expected: PASS, all 3 tests.

- [ ] **Step 5: Export `SessionsService` from `SessionsModule`**

  In `server/src/sessions/sessions.module.ts`:

  ```ts
  @Module({
    controllers: [SessionsController],
    providers: [SessionsService],
  })
  export class SessionsModule {}
  ```

  becomes:

  ```ts
  @Module({
    controllers: [SessionsController],
    providers: [SessionsService],
    exports: [SessionsService],
  })
  export class SessionsModule {}
  ```

- [ ] **Step 6: Wire `AutoConfirmModule` into `AppModule`**

  In `server/src/app.module.ts`, add the import:

  ```ts
  import { SessionsModule } from './sessions/sessions.module.js';
  ```

  becomes:

  ```ts
  import { SessionsModule } from './sessions/sessions.module.js';
  import { AutoConfirmModule } from './sessions/auto-confirm.js';
  ```

  and:

  ```ts
  @Module({
    imports: [AuthModule, PrismaModule, GroupsModule, SessionsModule, AdminModule],
  ```

  becomes:

  ```ts
  @Module({
    imports: [AuthModule, PrismaModule, GroupsModule, SessionsModule, AutoConfirmModule, AdminModule],
  ```

- [ ] **Step 7: Run the full server suite**

  Run: `npm --prefix server test`
  Expected: PASS. This boots `AppModule` (via `auth.boundary.spec.ts` and
  `admin.spec.ts`), which now starts and stops the scheduler — confirming it
  doesn't hang those test processes.

- [ ] **Step 8: Manual smoke check**

  Run: `cd server && npm run start:dev`, then in another terminal create a
  session, roster and propose a match through the API (or the web app once
  Task 7 is done), and watch the server log — after ~65s with no edits, the
  next `GET /sessions/:code` should show that court `active`. Stop the dev
  server after (`Ctrl-C`); no cleanup needed since this only touches the
  local dev database.

- [ ] **Step 9: Commit**

  ```bash
  git add server/src/sessions/auto-confirm.ts server/src/sessions/auto-confirm.spec.ts \
    server/src/sessions/sessions.module.ts server/src/app.module.ts
  git commit -m "feat(sessions): run the auto-confirm sweep every 5s"
  ```

---

### Task 6: Web `CourtState` model — add `autoStartAt`

**Files:**
- Modify: `web/src/app/core/live-session.model.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts` (17 fixtures)
- Modify: `web/src/app/core/live-session.service.spec.ts` (2 fixtures)
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts` (2 fixtures)
- Modify: `web/src/app/pages/session-display/session-display.spec.ts` (1 fixture)

**Interfaces:**
- Consumes: the `autoStartAt` field `GET /sessions/:code` now returns (Task 4).
- Produces: `CourtState`'s `'pending'` variant gains
  `autoStartAt: string | null`, used by `court-panel` in Task 7.

This task is mechanical (no new behavior — it just makes the type match the
real API response and fixes every fixture the compiler then flags) and is
verified by typechecking and the existing suite staying green, not by a new
test.

- [ ] **Step 1: Add the field to `CourtState`**

  In `web/src/app/core/live-session.model.ts`:

  ```ts
  export type CourtState =
    | { status: 'idle'; format: CourtFormat }
    | { status: 'pending'; pairingId: string; format: CourtFormat; teamA: Seat[]; teamB: Seat[] }
    | {
  ```

  becomes:

  ```ts
  export type CourtState =
    | { status: 'idle'; format: CourtFormat }
    | {
        status: 'pending';
        pairingId: string;
        format: CourtFormat;
        teamA: Seat[];
        teamB: Seat[];
        /** ISO timestamp of when this match auto-confirms if nobody touches
         *  it, or null when it won't (no `pendingSince` yet, a seat still
         *  empty, or a seated player currently resting). */
        autoStartAt: string | null;
      }
    | {
  ```

- [ ] **Step 2: Run the web build to see every fixture the compiler now flags**

  Run: `npm --prefix web run build`
  Expected: FAIL — a `TS2741`/`TS2322` "missing property `autoStartAt`"
  error at every pending `CourtState` object literal in the four spec files
  above (22 in total).

- [ ] **Step 3: Add `autoStartAt: null` to every plain-object pending fixture**

  All but one of the 22 sites are the exact literal
  `teamA: [...], teamB: [...] }` closing a pending court object (verified by
  inspection — every one is `status: 'pending', pairingId: 'pair1', format: '…', teamA: […], teamB: […] }`
  with nothing else inside the object). Run, from the repo root:

  ```bash
  cd web && for f in \
    src/app/pages/session-dashboard/court-panel/court-panel.spec.ts \
    src/app/core/live-session.service.spec.ts \
    src/app/pages/session-dashboard/session-dashboard.spec.ts \
    src/app/pages/session-display/session-display.spec.ts; do
    sed -i '' -E "s/(teamA: \[[^]]*\], teamB: \[[^]]*\]) \}/\1, autoStartAt: null }/g" "$f"
  done
  ```

- [ ] **Step 4: Fix the one remaining site by hand**

  `court-panel.spec.ts` has one pending fixture built from variables rather
  than array literals (`teamA: ['p1', 'p2', 'p3']; teamB: ...` computed
  above it, then `{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA, teamB }`).
  Find that line (`grep -n "teamA, teamB }" src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`)
  and change it to:

  ```ts
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA, teamB, autoStartAt: null }],
  ```

- [ ] **Step 5: Run the build again to confirm it's clean**

  Run: `npm --prefix web run build`
  Expected: PASS, no type errors.

- [ ] **Step 6: Run the web suite**

  Run: `npm --prefix web test`
  Expected: PASS — every existing test still passes with `autoStartAt: null`
  (none of them exercise auto-confirm behavior yet; Task 7 adds tests that
  set it to a real timestamp).

- [ ] **Step 7: Commit**

  ```bash
  git add web/src/app/core/live-session.model.ts \
    web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts \
    web/src/app/core/live-session.service.spec.ts \
    web/src/app/pages/session-dashboard/session-dashboard.spec.ts \
    web/src/app/pages/session-display/session-display.spec.ts
  git commit -m "feat(web): add autoStartAt to CourtState"
  ```

---

### Task 7: Dashboard countdown

**Files:**
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.html`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
- Modify: `web/src/locale/messages.xlf`
- Modify: `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: `CourtState`'s `autoStartAt` (Task 6), `ClockService.now()`,
  `LiveSessionService.serverSkewMs()` / `refresh()` (both already exist).
- Produces: no new public interface — this is the leaf UI task.

- [ ] **Step 1: Write the failing tests**

  In `court-panel.spec.ts`, add a new `describe` block (put it near the
  other pending-court tests, after the existing `describe`/`it`s that cover
  the pending state — match the file's existing `createPanel`/`baseSession`
  helpers rather than redefining them):

  ```ts
  describe('auto-start countdown', () => {
    it('shows the remaining time and hides at idle/active', async () => {
      const now = new Date('2026-09-22T12:00:00.000Z').getTime();
      const autoStartAt = new Date(now + 42_000).toISOString();
      const { fixture, clockNow } = await createPanel(
        baseSession({
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt },
          ],
        })
      );
      clockNow.set(now);
      fixture.detectChanges();

      const hint = fixture.nativeElement.querySelector('.auto-start-hint');
      expect(hint?.textContent).toContain('42');
    });

    it('reads "starting" once the countdown reaches zero', async () => {
      const now = new Date('2026-09-22T12:00:00.000Z').getTime();
      const autoStartAt = new Date(now).toISOString();
      const { fixture, clockNow } = await createPanel(
        baseSession({
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt },
          ],
        })
      );
      clockNow.set(now);
      fixture.detectChanges();

      const hint = fixture.nativeElement.querySelector('.auto-start-hint');
      expect(hint?.textContent).toContain('กำลังเริ่ม');
    });

    it('shows nothing when autoStartAt is null', async () => {
      const { fixture } = await createPanel(
        baseSession({
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
          ],
        })
      );
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.auto-start-hint')).toBeNull();
    });

    it('refreshes the session once, about 6s past the deadline', async () => {
      const now = new Date('2026-09-22T12:00:00.000Z').getTime();
      const autoStartAt = new Date(now - 5_000).toISOString();
      const { fixture, clockNow, liveSession } = await createPanel(
        baseSession({
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt },
          ],
        })
      );
      const refreshSpy = vi.spyOn(liveSession, 'refresh');
      clockNow.set(now);
      fixture.detectChanges();
      expect(refreshSpy).not.toHaveBeenCalled();

      clockNow.set(now + 2_000);
      fixture.detectChanges();
      expect(refreshSpy).toHaveBeenCalledOnce();

      clockNow.set(now + 3_000);
      fixture.detectChanges();
      expect(refreshSpy).toHaveBeenCalledOnce();
    });
  });
  ```

  Check the top of `court-panel.spec.ts` for exactly what `createPanel`
  returns (`fixture`, `clockNow`, and whether it exposes the injected
  `LiveSessionService` instance as `liveSession` or similar) and adjust the
  destructured names in the four tests above to match — the file's own
  helper is the source of truth, not this plan.

- [ ] **Step 2: Run it to confirm it fails**

  Run: `npm --prefix web test -- court-panel.spec.ts`
  Expected: FAIL — `.auto-start-hint` doesn't exist, `refresh` is never called.

- [ ] **Step 3: Add the countdown computed values and the refresh effect**

  In `court-panel.ts`, add `effect` to the existing `@angular/core` import:

  ```ts
  import { Component, computed, inject, input, signal } from '@angular/core';
  ```

  becomes:

  ```ts
  import { Component, computed, effect, inject, input, signal } from '@angular/core';
  ```

  Add these computed values and the field right after `restingInProposal`
  (which is the other "pending-only, resolved from `court()`" computed the
  file already has):

  ```ts
    /** Seconds until this pending court auto-confirms, or null when it isn't
     *  going to (see CourtState.autoStartAt). Not clamped to 0 — negative
     *  means overdue, which `refreshOnceOverdue` below uses to know when to
     *  ask the server for the now-active court. */
    protected readonly autoStartSecondsRemaining = computed<number | null>(() => {
      const c = this.court();
      if (c.status !== 'pending' || c.autoStartAt === null) return null;
      const deadline = new Date(c.autoStartAt).getTime();
      const now = this.clock.now() - this.liveSession.serverSkewMs();
      return Math.round((deadline - now) / 1000);
    });

    protected readonly autoStartLabel = computed<string | null>(() => {
      const seconds = this.autoStartSecondsRemaining();
      if (seconds === null) return null;
      if (seconds <= 0) return $localize`:@@court.autoStarting:กำลังเริ่ม…`;
      return $localize`:@@court.autoStartIn:เริ่มอัตโนมัติใน ${seconds}:seconds: วิ`;
    });

    /** Guards the one-shot refresh below against firing again on every tick
     *  once past the deadline — reset implicitly by comparing against the
     *  current `autoStartAt`, which changes whenever a fresh proposal or
     *  edit gives this court a new deadline. */
    private refreshedForAutoStartAt: string | null = null;
  ```

  Then, at the end of the constructor (after `protected liveSession: LiveSessionService`
  is injected — the constructor currently has no body; add one):

  ```ts
    constructor(protected liveSession: LiveSessionService) {}
  ```

  becomes:

  ```ts
    constructor(protected liveSession: LiveSessionService) {
      // About 6s past the deadline — comfortably after the 5s sweep interval
      // — ask the server once for the now-active court, rather than waiting
      // for the dashboard's ordinary 30s poll.
      effect(() => {
        const c = this.court();
        if (c.status !== 'pending' || c.autoStartAt === null) return;
        const seconds = this.autoStartSecondsRemaining();
        if (seconds !== null && seconds <= -6 && this.refreshedForAutoStartAt !== c.autoStartAt) {
          this.refreshedForAutoStartAt = c.autoStartAt;
          this.liveSession.refresh();
        }
      });
    }
  ```

- [ ] **Step 4: Add the hint to the template**

  In `court-panel.html`, inside the `@case ('pending')` block, right before
  the `<div class="button-row">`:

  ```html
          @if (emptySeatCount() > 0) {
            <p class="hint" role="status" i18n="@@court.seatsEmpty">ยังมีที่ว่าง {{ emptySeatCount() }} ที่</p>
          }
          <div class="button-row">
  ```

  becomes:

  ```html
          @if (emptySeatCount() > 0) {
            <p class="hint" role="status" i18n="@@court.seatsEmpty">ยังมีที่ว่าง {{ emptySeatCount() }} ที่</p>
          }
          @if (autoStartLabel(); as label) {
            <p class="hint auto-start-hint" role="status">{{ label }}</p>
          }
          <div class="button-row">
  ```

- [ ] **Step 5: Add the two translation units**

  In `web/src/locale/messages.xlf`, add two `trans-unit`s next to the
  existing `court.confirm` one (same `context-group`/`context` shape, this
  file's source language — copy the surrounding unit's structure exactly):

  ```xml
  <trans-unit id="court.autoStartIn" datatype="html">
    <source>เริ่มอัตโนมัติใน <x id="INTERPOLATION" equiv-text="seconds"/> วิ</source>
    <context-group purpose="location">
      <context context-type="sourcefile">src/app/pages/session-dashboard/court-panel/court-panel.ts</context>
      <context context-type="linenumber">1</context>
    </context-group>
  </trans-unit>
  <trans-unit id="court.autoStarting" datatype="html">
    <source>กำลังเริ่ม…</source>
    <context-group purpose="location">
      <context context-type="sourcefile">src/app/pages/session-dashboard/court-panel/court-panel.ts</context>
      <context context-type="linenumber">1</context>
    </context-group>
  </trans-unit>
  ```

  In `web/src/locale/messages.en.xlf`, add the matching pair with English
  `target`s, following the file's existing `<source>…</source><target>…</target>`
  pattern (see `court.confirm`'s entry for the exact shape):

  ```xml
  <trans-unit id="court.autoStartIn" datatype="html">
    <source>เริ่มอัตโนมัติใน <x id="INTERPOLATION" equiv-text="seconds"/> วิ</source><target>Auto-starts in <x id="INTERPOLATION" equiv-text="seconds"/>s</target>
    <context-group purpose="location">
      <context context-type="sourcefile">src/app/pages/session-dashboard/court-panel/court-panel.ts</context>
      <context context-type="linenumber">1</context>
    </context-group>
  </trans-unit>
  <trans-unit id="court.autoStarting" datatype="html">
    <source>กำลังเริ่ม…</source><target>Starting…</target>
    <context-group purpose="location">
      <context context-type="sourcefile">src/app/pages/session-dashboard/court-panel/court-panel.ts</context>
      <context context-type="linenumber">1</context>
    </context-group>
  </trans-unit>
  ```

- [ ] **Step 6: Run the test file to confirm it passes**

  Run: `npm --prefix web test -- court-panel.spec.ts`
  Expected: PASS, including the 4 new tests.

- [ ] **Step 7: Run the full web suite and the build**

  Run: `npm --prefix web test && npm --prefix web run build`
  Expected: both PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add web/src/app/pages/session-dashboard/court-panel/court-panel.ts \
    web/src/app/pages/session-dashboard/court-panel/court-panel.html \
    web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts \
    web/src/locale/messages.xlf web/src/locale/messages.en.xlf
  git commit -m "feat(dashboard): show an auto-start countdown on a pending court"
  ```

---

### Task 8: Docs

**Files:**
- Modify: `docs/overview.md`

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Add the paragraph**

  In `docs/overview.md`, right after the court-lifecycle paragraph:

  ```
  Each court runs its own lifecycle — **idle** → *Start next match* proposes a
  pairing → **pending**, where reshuffling is free and unlimited and a single
  player can be tapped to swap in a substitute → *Confirm* → **active**, then
  *Finish* records the winner (or "No result") and frees the court.
  ```

  add:

  ```
  **A pending match nobody confirms starts itself after 60 seconds.** Every
  edit — reshuffle, swap, a seat filled or cleared, a player rested or
  brought back — resets that window, so a host still setting up the court
  never gets cut off, and it only fires once every seat is filled and nobody
  on it is resting. The confirm it produces is backdated to 30 seconds after
  the match last changed, an estimate of when players actually walked on,
  rather than to the moment the window closes — so the live timer doesn't
  start a full minute behind. Undoing an auto-confirm turns it off for that
  match; editing the lineup again turns it back on.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add docs/overview.md
  git commit -m "docs: describe auto-confirm for a pending match"
  ```

---

## Self-Review Notes

- **Spec coverage:** every numbered item in the design spec (§1 data, §2
  `pendingSince` writes, §3 sweep + backdating, §4 API, §5 dashboard UI, §6
  edge cases, §7 testing, §8 files, §9 deploy) has a task above. §9 (backup
  before deploy) is a deploy-time step, not a code change — called out in
  Global Constraints rather than as its own task.
- **Type consistency:** `AUTO_CONFIRM_DELAY_MS`/`AUTO_CONFIRM_WALK_ON_MS`
  (Task 3) and `AUTO_CONFIRM_SWEEP_MS` (Task 5) are named and exported
  consistently everywhere they're used. `pairingConfirmBlocker`'s return
  shape (Task 3) is used identically by both its callers. `autoStartAtFor`
  (Task 4) and the web `CourtState.autoStartAt` (Task 6) agree on
  `string | null`.
- **Verified, not assumed:** Task 2's step 12 and the note under it rely on
  having actually grepped every `toEqual`/`toMatchObject` in
  `sessions.controller.spec.ts` against a raw `Pairing` row or a mutation
  endpoint's full body — there are none, so no test outside the two new spec
  files needs updating for the new column appearing in API responses.
