# C2 Walk-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host add someone who is not on the pasted roster to a session that is already running, without ending it — reusing an existing player or creating a new one — and give that walk-in the same fair rotation credit a returning player already gets.

**Architecture:** One new server route, `POST /sessions/:code/roster`, backed by a new `SessionsService.addWalkIn`. It reuses the group-ownership guard, the session lock, and — critically — the exact rotation-credit arithmetic `setRosterActiveExclusively` already uses for a returning player, extracted into one shared helper (`rotationCredit`) so the two paths can never drift apart. On the web side, a new host-only dialog (`AddWalkInDialog`, modeled on the existing `ShuttleDetailsDialog`) reuses the roster review's own `searchCandidates` to search existing group players client-side, offers "add as new" when nothing matches, and hands the choice to the dashboard, which makes the actual call.

This directly closes the gap `overview.md` and the roadmap doc both name: "there is no route that adds a player to a running session." It also reopens a state the codebase's own history (`docs/archive/plans/2026-09-05-review-and-v2-backlog.md`, entry A15) explicitly says used to be unreachable — a session with an active roster row on zero games while others are ahead. B14 (same roadmap doc) exists specifically to keep that state safe: **any roster row this feature creates must carry the same `gamesOffset` credit a re-activation gets**, or the walk-in wins every rotation draw until they catch up.

**Tech Stack:** NestJS + Prisma (server), Angular 22 signals/`httpResource` (web), Vitest for both (`node --experimental-strip-types --test` is engines-only; server and web use `ng test`/Vitest via `npm test`).

**Spec:** `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section "C2. Add a walk-in to a running session". Cross-reference: `docs/archive/plans/2026-09-05-review-and-v2-backlog.md`, entries A15 and B14 (returning-player credit reasoning this feature must preserve).

**Scope note:** The spec's UI bullet "a new player can be given a level chip (C1)" is **not** implemented here — C1 (skill levels) has not shipped yet and `Player` has no `level` field. This plan implements C2 exactly as it stands without C1; the level chip is C1's job to add later.

## Global Constraints

- `SessionsController` routes take `code` from the URL and a DTO from the body; `OwnershipGuard` (global, `server/src/auth/ownership.guard.ts`) already covers any `/sessions/:code/*` path with no per-route wiring needed.
- Every mutating `SessionsService` method that touches session state runs through `this.lock.run(sessionCode, () => ...Exclusively(...))` — see `setRosterActive`/`setRosterActiveExclusively` for the pattern.
- Error responses are `new NotFoundException({ code })` / `new ConflictException({ code })` / `new BadRequestException({ code })` via the service's existing `notFound`/`conflict`/`badRequest` helpers — never prose.
- `Player.aliases` is a JSON-encoded `string[]` stored as a plain string column; a newly created player always gets `aliases: '[]'`.
- `SessionRoster` defaults: `active` defaults `true`, `gamesOffset` defaults `0`, `activatedAt` is nullable (set explicitly only when someone becomes active).
- Server tests live in `server/src/sessions/sessions.controller.spec.ts` (already the home for every other session route's integration tests) and follow its established per-test inline seed + `try/finally` cleanup style — no shared seeding helper exists, so don't introduce one.
- Web components that only emit and own no HTTP (like `ShuttleDetailsDialog`) keep that shape; `AddWalkInDialog` follows the same rule — the dashboard makes the actual `POST`.
- jsdom's `HTMLDialogElement` has no working `showModal`/`close` — any spec that opens a `<dialog>` needs the shim already established in `shuttle-details-dialog.spec.ts`.

---

## Task 1: Extract `rotationCredit` — pure refactor, no behavior change

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`setRosterActiveExclusively`, around line 1829)
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Produces: `private rotationCredit(gamesPlayedThisSession: Map<string, number>, activeOtherIds: string[], ownId: string, currentOffset: number): number` on `SessionsService`. Used by `setRosterActiveExclusively` (this task) and `addWalkInExclusively` (Task 2).

This task changes no observable behavior — it only proves the extraction is faithful before anything new is built on top of it. The existing controller spec already exercises `setRosterActiveExclusively`'s credit math indirectly (e.g. "brings a rested player back into the pool when reactivated"); this task adds one more test that pins the exact number.

- [ ] **Step 1: Write the failing test**

```ts
// add to server/src/sessions/sessions.controller.spec.ts, near the other
// roster-active tests (after the "brings a rested player back..." test)
it('credits a returning player up to the highest active games-played count', async () => {
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

  try {
    // Rest E immediately, then have A, B, C, D each finish 2 confirmed matches
    // (one court, doubles) before E returns.
    await request(server)
      .post(`/sessions/${sessionCode}/roster/${players[4].id}/active`)
      .send({ active: false })
      .expect(201);

    for (let i = 0; i < 2; i++) {
      const proposed = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      const pairingId = proposed.body.pairing.id;
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/confirm`)
        .send({ expectedRevision: proposed.body.pairing.revision })
        .expect(201);
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/finish`)
        .send({ scoreA: null, scoreB: null, winner: null })
        .expect(201);
    }

    await request(server)
      .post(`/sessions/${sessionCode}/roster/${players[4].id}/active`)
      .send({ active: true })
      .expect(201);

    const entry = await prisma.sessionRoster.findUniqueOrThrow({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId: players[4].id } },
    });
    // A..D each played 2 games; E played 0 before returning, so E's credit
    // must bring them level: highest (2) - own (0) + currentOffset (0) = 2.
    expect(entry.gamesOffset).toBe(2);
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run the test to verify it passes against the CURRENT (pre-refactor) code**

Run: `npm --prefix server test -- sessions.controller.spec.ts -t "credits a returning player"`
Expected: PASS. This locks in today's behavior as a number before touching the implementation, so the refactor in Step 3 has something concrete to be checked against.

- [ ] **Step 3: Extract the helper and use it in `setRosterActiveExclusively`**

In `server/src/sessions/sessions.service.ts`, add the helper near `setRosterActiveExclusively` (e.g. directly above it):

```ts
/**
 * Rotation-fairness credit for a player who is (re)joining the active pool
 * mid-session: brings them level with whoever is furthest ahead so they
 * queue alongside everyone else instead of winning every draw until they
 * catch up. `Math.max` with `currentOffset` so this can only ever add
 * credit, never take it away — toggling someone off and back on, or a
 * walk-in joining, must never lower a player into a free turn.
 *
 * Shared by `setRosterActiveExclusively` (a returning player) and
 * `addWalkInExclusively` (someone joining for the first time tonight) — see
 * B14 in docs/archive/plans/2026-09-05-review-and-v2-backlog.md for why
 * both paths must use identical arithmetic.
 */
private rotationCredit(
  gamesPlayedThisSession: Map<string, number>,
  activeOtherIds: string[],
  ownId: string,
  currentOffset: number
): number {
  const highest = activeOtherIds.reduce(
    (max, id) => Math.max(max, gamesPlayedThisSession.get(id) ?? 0),
    0
  );
  const own = gamesPlayedThisSession.get(ownId) ?? 0;
  return Math.max(currentOffset, highest - own + currentOffset);
}
```

Then replace the inline calculation inside `setRosterActiveExclusively` (currently):

```ts
    let gamesOffset = entry.gamesOffset;
    if (dto.active && !entry.active) {
      const history = await this.loadHistory(session.groupId, sessionCode);
      const others = await this.prisma.sessionRoster.findMany({
        where: { sessionId: sessionCode, active: true, playerId: { not: playerId } },
        select: { playerId: true },
      });
      const highest = others.reduce(
        (max, o) => Math.max(max, history.gamesPlayedThisSession.get(o.playerId) ?? 0),
        0
      );
      const own = history.gamesPlayedThisSession.get(playerId) ?? 0;
      gamesOffset = Math.max(entry.gamesOffset, highest - own + entry.gamesOffset);
    }
```

with:

```ts
    let gamesOffset = entry.gamesOffset;
    if (dto.active && !entry.active) {
      const history = await this.loadHistory(session.groupId, sessionCode);
      const others = await this.prisma.sessionRoster.findMany({
        where: { sessionId: sessionCode, active: true, playerId: { not: playerId } },
        select: { playerId: true },
      });
      gamesOffset = this.rotationCredit(
        history.gamesPlayedThisSession,
        others.map((o) => o.playerId),
        playerId,
        entry.gamesOffset
      );
    }
```

- [ ] **Step 4: Run the full sessions test suite to verify nothing changed**

Run: `npm --prefix server test -- sessions.controller.spec.ts`
Expected: PASS, including the new "credits a returning player..." test still reporting `gamesOffset: 2` and every pre-existing roster-active test (`leaves a resting player out...`, `brings a rested player back...`, `lets a match already under way play out...`) unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "refactor(sessions): extract rotationCredit, shared by re-activation and the coming walk-in"
```

---

## Task 2: `addWalkIn` — existing-player path, DTO, route

**Files:**
- Create: `server/src/sessions/dto/add-walk-in.dto.ts`
- Modify: `server/src/sessions/sessions.service.ts`
- Modify: `server/src/sessions/sessions.controller.ts`
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Produces: `AddWalkInDto { playerId?: string; name?: string }`; `SessionsService.addWalkIn(sessionCode: string, dto: AddWalkInDto): Promise<{ playerId: string }>`; route `POST /sessions/:code/roster`.
- Consumes: `rotationCredit` (Task 1), `this.loadHistory`, `this.lock`, `this.notFound`/`this.conflict`/`this.badRequest`.

This step covers only the `playerId` branch (an existing player) plus the shared validation and refusal paths (`SESSION_ENDED`, `ROSTER_DUPLICATE`, unknown/other-group player 404). The `name` branch (new player) is Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/sessions/dto/add-walk-in.dto.ts does not exist yet, so this
// whole block fails to compile/run until Step 3. Add near the other roster
// tests in server/src/sessions/sessions.controller.spec.ts.

describe('POST /sessions/:code/roster (walk-in)', () => {
  it('adds an existing player to the roster', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    const walkIn = await prisma.player.create({
      data: { groupId: groupCode, name: 'Walk-in', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/roster`)
        .send({ playerId: walkIn.id })
        .expect(201);
      expect(res.body).toEqual({ playerId: walkIn.id });

      const entry = await prisma.sessionRoster.findUniqueOrThrow({
        where: { sessionId_playerId: { sessionId: sessionCode, playerId: walkIn.id } },
      });
      expect(entry.active).toBe(true);
      expect(entry.activatedAt).not.toBeNull();

      const session = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(session.body.rosterPlayerIds).toContain(walkIn.id);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('refuses with 409 SESSION_ENDED once the session has ended', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const walkIn = await prisma.player.create({
      data: { groupId: groupCode, name: 'Walk-in', aliases: '[]' },
    });
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/roster`)
        .send({ playerId: walkIn.id })
        .expect(409);
      expect(res.body.code).toBe('SESSION_ENDED');
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('refuses with 409 ROSTER_DUPLICATE for a player already on the roster, including a resting one', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: groupCode, name: 'A', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.sessionRoster.create({
      data: { sessionId: sessionCode, playerId: player.id, active: false },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/roster`)
        .send({ playerId: player.id })
        .expect(409);
      expect(res.body.code).toBe('ROSTER_DUPLICATE');
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('refuses with 404 for a player belonging to another group', async () => {
    const groupCode = randomUUID();
    const otherGroupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.group.create({ data: { code: otherGroupCode, name: 'Other' } });
    const otherPlayer = await prisma.player.create({
      data: { groupId: otherGroupCode, name: 'Stranger', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster`)
        .send({ playerId: otherPlayer.id })
        .expect(404);
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: { in: [groupCode, otherGroupCode] } } });
      await prisma.group.deleteMany({ where: { code: { in: [groupCode, otherGroupCode] } } });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- sessions.controller.spec.ts -t "walk-in"`
Expected: FAIL — `Cannot find module './dto/add-walk-in.dto.js'` / 404 "Cannot POST /sessions/.../roster".

- [ ] **Step 3: Create the DTO**

```ts
// server/src/sessions/dto/add-walk-in.dto.ts
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Exactly one of `playerId` (an existing group player) or `name` (create a
 * new one) — class-validator has no built-in XOR, so SessionsService.addWalkIn
 * enforces that and throws ROSTER_ADD_INVALID_INPUT if neither or both arrive.
 */
export class AddWalkInDto {
  @IsOptional()
  @IsString()
  playerId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;
}
```

- [ ] **Step 4: Add `addWalkIn`/`addWalkInExclusively` to `SessionsService`**

Add near `setRosterActive`/`setRosterActiveExclusively`:

```ts
addWalkIn(sessionCode: string, dto: AddWalkInDto) {
  return this.lock.run(sessionCode, () => this.addWalkInExclusively(sessionCode, dto));
}

/**
 * Adds someone who is not on tonight's pasted roster to a session already
 * under way — either an existing group player (`playerId`) or a brand-new
 * one (`name`). Must credit `gamesOffset` exactly like a returning player
 * (`rotationCredit`, shared with `setRosterActiveExclusively`) or the
 * walk-in wins every rotation draw until they catch up — see B14 in
 * docs/archive/plans/2026-09-05-review-and-v2-backlog.md.
 *
 * Deliberately does not touch the Waitlist table (a walk-in who happens to
 * be on tonight's waitlist just gets a second, independent roster row; the
 * waitlist row stays as a record) or any open Pairing (a brand-new roster
 * row cannot already be seated on a court, so there is nothing to rewrite —
 * unlike setRosterActiveExclusively's resting/returning path).
 */
private async addWalkInExclusively(sessionCode: string, dto: AddWalkInDto) {
  if (Boolean(dto.playerId) === Boolean(dto.name)) {
    throw this.badRequest('ROSTER_ADD_INVALID_INPUT');
  }

  const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
  if (!session) throw this.notFound('SESSION_NOT_FOUND');
  if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

  let playerId: string;
  if (dto.playerId) {
    const player = await this.prisma.player.findUnique({ where: { id: dto.playerId } });
    if (!player || player.groupId !== session.groupId) {
      throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
    }
    playerId = player.id;
  } else {
    playerId = randomUUID();
    await this.prisma.player.create({
      data: { id: playerId, groupId: session.groupId, name: dto.name!, aliases: '[]' },
    });
  }

  const existing = await this.prisma.sessionRoster.findUnique({
    where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
  });
  if (existing) throw this.conflict('ROSTER_DUPLICATE');

  const history = await this.loadHistory(session.groupId, sessionCode);
  const others = await this.prisma.sessionRoster.findMany({
    where: { sessionId: sessionCode, active: true },
    select: { playerId: true },
  });
  const gamesOffset = this.rotationCredit(
    history.gamesPlayedThisSession,
    others.map((o) => o.playerId),
    playerId,
    0
  );

  await this.prisma.sessionRoster.create({
    data: { sessionId: sessionCode, playerId, active: true, gamesOffset, activatedAt: new Date() },
  });

  return { playerId };
}
```

Add the import at the top of `sessions.service.ts`, alongside the other `dto` type imports:

```ts
import type { AddWalkInDto } from './dto/add-walk-in.dto.js';
```

- [ ] **Step 5: Add the controller route**

In `server/src/sessions/sessions.controller.ts`, add the import:

```ts
import { AddWalkInDto } from './dto/add-walk-in.dto.js';
```

and the route, next to `setRosterActive`:

```ts
@Post(':code/roster')
addWalkIn(@Param('code') code: string, @Body() dto: AddWalkInDto) {
  return this.sessionsService.addWalkIn(code, dto);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix server test -- sessions.controller.spec.ts -t "walk-in"`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full server test suite**

Run: `npm --prefix server test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add server/src/sessions/dto/add-walk-in.dto.ts server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat(sessions): POST /sessions/:code/roster adds an existing player as a walk-in"
```

---

## Task 3: `addWalkIn` — new-player path and input validation

**Files:**
- Modify: `server/src/sessions/sessions.controller.spec.ts`

The `name` branch and the "exactly one" validation were already written in Task 2's implementation (`addWalkInExclusively` handles both). This task adds the tests Task 2 skipped, closing the gap.

- [ ] **Step 1: Write the failing tests**

```ts
// add inside the same describe('POST /sessions/:code/roster (walk-in)', ...) block
it('creates a new player when given a name', async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  await prisma.session.create({
    data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
  });

  try {
    const res = await request(server)
      .post(`/sessions/${sessionCode}/roster`)
      .send({ name: 'สมชาย' })
      .expect(201);
    const playerId = res.body.playerId as string;
    expect(typeof playerId).toBe('string');

    const player = await prisma.player.findUniqueOrThrow({ where: { id: playerId } });
    expect(player.groupId).toBe(groupCode);
    expect(player.name).toBe('สมชาย');
    expect(JSON.parse(player.aliases)).toEqual([]);

    const entry = await prisma.sessionRoster.findUniqueOrThrow({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
    });
    expect(entry.active).toBe(true);
  } finally {
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});

it('refuses with 400 when both playerId and name are given', async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const player = await prisma.player.create({
    data: { groupId: groupCode, name: 'A', aliases: '[]' },
  });
  await prisma.session.create({
    data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
  });

  try {
    const res = await request(server)
      .post(`/sessions/${sessionCode}/roster`)
      .send({ playerId: player.id, name: 'สมชาย' })
      .expect(400);
    expect(res.body.code).toBe('ROSTER_ADD_INVALID_INPUT');
  } finally {
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});

it('refuses with 400 when neither playerId nor name are given', async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  await prisma.session.create({
    data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
  });

  try {
    const res = await request(server).post(`/sessions/${sessionCode}/roster`).send({}).expect(400);
    expect(res.body.code).toBe('ROSTER_ADD_INVALID_INPUT');
  } finally {
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `npm --prefix server test -- sessions.controller.spec.ts -t "walk-in"`
Expected: PASS (7 tests total in this describe block — Task 2's 4 plus these 3). No implementation change needed; Task 2's `addWalkInExclusively` already handles both branches. If any of these three fail, the bug is in Task 2's implementation, not a missing feature — fix it there before moving on.

- [ ] **Step 3: Commit**

```bash
git add server/src/sessions/sessions.controller.spec.ts
git commit -m "test(sessions): cover the new-player walk-in path and exactly-one-of validation"
```

---

## Task 4: Rotation-credit correctness and the two "must not touch" edge cases

**Files:**
- Modify: `server/src/sessions/sessions.controller.spec.ts`

Covers the spec's remaining test requirements: the walk-in's offset equals the highest active count and they don't win the next draw; a waitlist row is untouched; an open pairing is untouched.

- [ ] **Step 1: Write the failing tests**

```ts
// add inside the same describe('POST /sessions/:code/roster (walk-in)', ...) block
it("credits the walk-in to the highest active games-played count, so they don't win the next draw", async () => {
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
    // A, B, C, D each finish 3 confirmed matches on the one court.
    for (let i = 0; i < 3; i++) {
      const proposed = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      const pairingId = proposed.body.pairing.id;
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/confirm`)
        .send({ expectedRevision: proposed.body.pairing.revision })
        .expect(201);
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/finish`)
        .send({ scoreA: null, scoreB: null, winner: null })
        .expect(201);
    }

    const res = await request(server)
      .post(`/sessions/${sessionCode}/roster`)
      .send({ name: 'Walk-in' })
      .expect(201);
    const walkInId = res.body.playerId as string;

    const entry = await prisma.sessionRoster.findUniqueOrThrow({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId: walkInId } },
    });
    expect(entry.gamesOffset).toBe(3);

    // With only 1 court and 5 active players (A-D on 3, walk-in on an
    // effective 3 via the offset), someone must sit out every round, and it
    // must never be the walk-in winning a place over a 3-games player would
    // be a tie, not a win — assert they are never left playing while an
    // untouched A-D-level player sits, across enough draws to be conclusive.
    let walkInEverSatOut = false;
    for (let i = 0; i < 40 && !walkInEverSatOut; i++) {
      const proposed = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      const onCourt = [...proposed.body.pairing.teamA, ...proposed.body.pairing.teamB];
      if (!onCourt.includes(walkInId)) walkInEverSatOut = true;
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    }
    expect(walkInEverSatOut).toBe(true);
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});

it("leaves tonight's waitlist row untouched when the same player is added as a walk-in", async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const player = await prisma.player.create({
    data: { groupId: groupCode, name: 'A', aliases: '[]' },
  });
  await prisma.session.create({
    data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
  });
  await prisma.waitlist.create({ data: { sessionId: sessionCode, playerId: player.id, position: 0 } });

  try {
    await request(server)
      .post(`/sessions/${sessionCode}/roster`)
      .send({ playerId: player.id })
      .expect(201);

    const waitlistEntry = await prisma.waitlist.findFirst({
      where: { sessionId: sessionCode, playerId: player.id },
    });
    expect(waitlistEntry).not.toBeNull();
  } finally {
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.waitlist.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});

it('never rewrites an existing open pairing when a walk-in is added', async () => {
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
      pendingSince: new Date(),
    },
  });

  try {
    await request(server).post(`/sessions/${sessionCode}/roster`).send({ name: 'Walk-in' }).expect(201);

    const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(JSON.parse(row.teamA)).toEqual([players[0].id, players[1].id]);
    expect(JSON.parse(row.teamB)).toEqual([players[2].id, players[3].id]);
    expect(row.confirmedAt).toBeNull();
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `npm --prefix server test -- sessions.controller.spec.ts -t "walk-in"`
Expected: PASS (10 tests total in the describe block). No implementation change expected — these confirm behavior Task 2 already produces by construction. If the credit test fails, re-check Task 2 Step 4's `addWalkInExclusively` against Task 1's `rotationCredit` call shape.

- [ ] **Step 3: Run the full server suite**

Run: `npm --prefix server test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/sessions/sessions.controller.spec.ts
git commit -m "test(sessions): pin walk-in rotation credit and the waitlist/pairing no-touch guarantees"
```

---

## Task 5: `LiveSessionService.addWalkIn` and the `ROSTER_DUPLICATE` message

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Test: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces: `LiveSessionService.addWalkIn(input: { playerId: string } | { name: string }): Promise<ActionResult>`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/app/core/live-session.service.spec.ts`, alongside the other action tests (e.g. right after `deprioritizeWaiting posts to the roster endpoint...`). This file's established pattern is: `await flushSession(baseSession())` in `beforeEach`'s scope, call the service method, assert on the outgoing request, flush it, then (for a success path) flush the automatic session reload:

```ts
it('addWalkIn posts an existing player and reloads the session', async () => {
  await flushSession(baseSession());

  const promise = service.addWalkIn({ playerId: 'p9' });
  const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/roster`);
  expect(req.request.method).toBe('POST');
  expect(req.request.body).toEqual({ playerId: 'p9' });
  req.flush({ playerId: 'p9' });
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
  httpMock
    .expectOne(`${environment.apiBaseUrl}/sessions/sess1`)
    .flush(baseSession({ rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p9'] }));

  expect(await promise).toEqual({ ok: true });
});

it('addWalkIn posts a new name and maps ROSTER_DUPLICATE to a Thai message on refusal', async () => {
  await flushSession(baseSession());

  const promise = service.addWalkIn({ name: 'สมชาย' });
  const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/roster`);
  expect(req.request.body).toEqual({ name: 'สมชาย' });
  req.flush({ code: 'ROSTER_DUPLICATE' }, { status: 409, statusText: 'Conflict' });

  expect(await promise).toEqual({ ok: false, error: 'ผู้เล่นคนนี้อยู่ในก๊วนแล้ว' });
});
```

No reload is flushed after the second test's refusal — matching `endSession maps the server error code...` above it, `post()`'s `catch` branch returns the mapped error directly without calling `sessionResource.reload()`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix web test -- --run live-session.service.spec.ts`
Expected: FAIL — `service.addWalkIn is not a function`.

- [ ] **Step 3: Add the method and the error message**

In `web/src/app/core/live-session.service.ts`, add a case to `messageForCode`:

```ts
    case 'ROSTER_DUPLICATE':
      return $localize`:@@err.code.rosterDuplicate:ผู้เล่นคนนี้อยู่ในก๊วนแล้ว`;
```

(insert alongside the other `case` entries, e.g. right after `ROSTER_PLAYER_NOT_FOUND`).

Add the method near `setPlayerActive`:

```ts
/** Adds someone not on tonight's pasted roster — an existing group player
 *  (`playerId`) or a brand-new one (`name`) — to a running session. */
addWalkIn(input: { playerId: string } | { name: string }): Promise<ActionResult> {
  return this.post('roster', input, $localize`:@@err.addWalkIn:เพิ่มผู้เล่นไม่สำเร็จ`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix web test -- --run live-session.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full web suite**

Run: `npm --prefix web test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat(web): LiveSessionService.addWalkIn, with a Thai message for ROSTER_DUPLICATE"
```

---

## Task 6: `AddWalkInDialog` component

**Files:**
- Create: `web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.ts`
- Create: `web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.html`
- Create: `web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.css`
- Test: `web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.spec.ts`

**Interfaces:**
- Consumes: `searchCandidates`, `PlayerCandidate` from `../../core/roster-review`; `Player` from `../../../../../engines/fuzzy-match.ts`.
- Produces: `AddWalkInDialog` component with `players = input<Player[]>([])`, `excludedIds = input<ReadonlySet<string>>(new Set())`, `saving = input(false)`, `error = input<string | null>(null)`, `add = output<{ playerId: string } | { name: string }>()`, and public `open()`/`close()` methods. Used by Task 7's dashboard wiring.

This is HTTP-free, same rule as `ShuttleDetailsDialog` — the dashboard makes the actual call and passes `saving`/`error` back in.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.spec.ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AddWalkInDialog } from './add-walk-in-dialog';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

const players: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
];

describe('AddWalkInDialog', () => {
  let fixture: ComponentFixture<AddWalkInDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AddWalkInDialog] }).compileComponents();
    fixture = TestBed.createComponent(AddWalkInDialog);
    fixture.componentRef.setInput('players', players);
    fixture.componentRef.setInput('excludedIds', new Set());
  });

  async function openDialog(): Promise<void> {
    fixture.componentInstance.open();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function searchInput(): HTMLInputElement {
    return (fixture.nativeElement as HTMLElement).querySelector('input[name="search"]') as HTMLInputElement;
  }

  function type(value: string): void {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('lists a matching existing player and emits their playerId when picked', async () => {
    await openDialog();
    type('ตั้ม');

    const results = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-candidate]');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('ตั้ม');

    let emitted: { playerId: string } | { name: string } | undefined;
    fixture.componentInstance.add.subscribe((e) => (emitted = e));
    (results[0] as HTMLButtonElement).click();

    expect(emitted).toEqual({ playerId: 'p1' });
  });

  it('offers "add as new" for a query matching nobody, and emits a name', async () => {
    await openDialog();
    type('มะปราง');

    const addNewButton = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-add-new]'
    ) as HTMLButtonElement;
    expect(addNewButton).not.toBeNull();
    expect(addNewButton.textContent).toContain('มะปราง');

    let emitted: { playerId: string } | { name: string } | undefined;
    fixture.componentInstance.add.subscribe((e) => (emitted = e));
    addNewButton.click();

    expect(emitted).toEqual({ name: 'มะปราง' });
  });

  it('excludes players already on the roster from the search results', async () => {
    fixture.componentRef.setInput('excludedIds', new Set(['p1']));
    await openDialog();
    type('ตั้ม');

    const results = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-candidate]');
    expect(results.length).toBe(0);
    const addNewButton = (fixture.nativeElement as HTMLElement).querySelector('[data-add-new]');
    expect(addNewButton).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web test -- --run add-walk-in-dialog.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```ts
// web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.ts
import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { searchCandidates } from '../../core/roster-review';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

/**
 * Search-or-create sheet for adding a walk-in to a running session. Follows
 * ShuttleDetailsDialog's shape: HTTP-free, only emits a choice — the
 * dashboard makes the actual POST and reports back via `saving`/`error`, the
 * same division of responsibility that keeps this component testable
 * without a mocked backend.
 */
@Component({
  selector: 'app-add-walk-in-dialog',
  imports: [FormsModule],
  templateUrl: './add-walk-in-dialog.html',
  styleUrl: './add-walk-in-dialog.css',
})
export class AddWalkInDialog {
  readonly players = input<Player[]>([]);
  readonly excludedIds = input<ReadonlySet<string>>(new Set());
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly add = output<{ playerId: string } | { name: string }>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  protected readonly query = signal('');

  protected readonly results = computed(() =>
    searchCandidates(this.query(), this.players(), this.excludedIds())
  );

  /** Only offered when nothing in `results()` is an exact, case-folded match
   *  — a fuzzy or partial hit is a suggestion, not a reason to hide "add as
   *  new" the way `roster-review.ts`'s manual-add field already treats it. */
  protected readonly showAddNew = computed(() => {
    const trimmed = this.query().trim();
    if (!trimmed) return false;
    return !this.results().some((r) => r.rank === 'exact');
  });

  open(): void {
    this.query.set('');
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  close(): void {
    this.isOpen.set(false);
    this.dialogEl().nativeElement.close();
  }

  protected onDialogClose(): void {
    this.isOpen.set(false);
  }

  protected onCancelAttempt(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  protected onQueryInput(text: string): void {
    this.query.set(text);
  }

  protected pick(playerId: string): void {
    this.add.emit({ playerId });
  }

  protected addNew(): void {
    const name = this.query().trim();
    if (!name) return;
    this.add.emit({ name });
  }
}
```

- [ ] **Step 4: Write the template**

```html
<!-- web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.html -->
<dialog #dialog class="walk-in-dialog" (close)="onDialogClose()" (cancel)="onCancelAttempt($event)">
  @if (isOpen()) {
    <div class="form-card">
      <h2 i18n="@@walkIn.title">เพิ่มคน</h2>
      <label>
        <span i18n="@@walkIn.searchLabel">ชื่อ</span>
        <input
          type="text"
          autocomplete="off"
          name="search"
          [ngModel]="query()"
          (ngModelChange)="onQueryInput($event)"
          [disabled]="saving()"
        />
      </label>

      <ul class="candidate-list">
        @for (candidate of results(); track candidate.player.id) {
          <li>
            <button type="button" data-candidate [disabled]="saving()" (click)="pick(candidate.player.id)">
              {{ candidate.player.name }}
            </button>
          </li>
        }
        @if (showAddNew()) {
          <li>
            <button type="button" data-add-new [disabled]="saving()" (click)="addNew()">
              <ng-container i18n="@@walkIn.addAsNew">เพิ่มเป็นคนใหม่</ng-container> "{{ query().trim() }}"
            </button>
          </li>
        }
      </ul>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <div class="dialog-actions">
        <button type="button" class="ghost" [disabled]="saving()" (click)="close()" i18n="@@walkIn.cancel">ยกเลิก</button>
      </div>
    </div>
  }
</dialog>
```

- [ ] **Step 5: Write a minimal stylesheet**

```css
/* web/src/app/shared/add-walk-in-dialog/add-walk-in-dialog.css */
.walk-in-dialog {
  border: none;
  border-radius: 12px;
  padding: 0;
  max-width: 24rem;
  width: 90vw;
}

.form-card {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.candidate-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 40vh;
  overflow-y: auto;
}

.candidate-list button {
  width: 100%;
  text-align: left;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm --prefix web test -- --run add-walk-in-dialog.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add web/src/app/shared/add-walk-in-dialog/
git commit -m "feat(web): AddWalkInDialog searches existing players or stages a new one"
```

---

## Task 7: Dashboard wiring

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.html`
- Test: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`

This file has one top-level `describe('SessionDashboard', ...)` with plain (non-arrow) `function` helpers declared inside it, visible to every `it()` by hoisting: `settled(session?)` (creates the fixture, flushes session/players/stats with a fixed 2-player list, `await fixture.whenStable()`), `buttonWith(text)` (finds a button outside any `<dialog>` by substring text), `dialogButtonWith`/`dialogInputs`/`typeInto` (scoped to the currently-open `<dialog>`), and `drainReload(nextSession)` (drains whatever session/players/stats requests a mutation's reload triggers). Reuse these rather than inventing new ones. Neither test below needs a walk-in candidate outside `settled()`'s default two players (ตั้ม/เบส) — the existing-player case searches for ตั้ม's own name is avoided on purpose (ตั้ม is already on the roster and therefore excluded from search results), so the first test seeds its own 3-player list inline instead of using `settled()`.

- [ ] **Step 1: Write the failing tests**

Add to `session-dashboard.spec.ts`, after the roster-chip tests:

```ts
it('adds an existing player to the roster via the add-walk-in button', async () => {
  fixture = TestBed.createComponent(SessionDashboard);
  fixture.detectChanges();
  httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
  httpMock
    .expectOne(`${B}/groups/group1/players`)
    .flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p9', name: 'บอล', aliases: [] },
    ]);
  httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
  await fixture.whenStable();
  fixture.detectChanges();

  buttonWith('เพิ่มคน').click();
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();

  const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
  const search = dialog.querySelector('input[name="search"]') as HTMLInputElement;
  typeInto(search, 'บอล');

  const candidate = dialog.querySelector('[data-candidate]') as HTMLButtonElement;
  expect(candidate.textContent).toContain('บอล');
  candidate.click();

  const req = httpMock.expectOne(`${B}/sessions/sess1/roster`);
  expect(req.request.body).toEqual({ playerId: 'p9' });
  req.flush({ playerId: 'p9' });
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
  httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2', 'p9'] }));
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
  httpMock
    .expectOne(`${B}/groups/group1/players`)
    .flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p9', name: 'บอล', aliases: [] },
    ]);
  await fixture.whenStable();
  fixture.detectChanges();

  expect(
    fixture.componentInstance.rosterEntries().some((r) => r.id === 'p9' && r.name === 'บอล')
  ).toBe(true);
  expect(dialog.hasAttribute('open')).toBe(false);
});

it('shows the server error inside the dialog when adding a walk-in is refused', async () => {
  await settled();

  buttonWith('เพิ่มคน').click();
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();

  const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
  const search = dialog.querySelector('input[name="search"]') as HTMLInputElement;
  typeInto(search, 'ซ้ำ');

  const addNew = dialog.querySelector('[data-add-new]') as HTMLButtonElement;
  addNew.click();

  const req = httpMock.expectOne(`${B}/sessions/sess1/roster`);
  expect(req.request.body).toEqual({ name: 'ซ้ำ' });
  req.flush({ code: 'ROSTER_DUPLICATE' }, { status: 409, statusText: 'Conflict' });
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();

  expect(dialog.querySelector('.error')?.textContent).toContain('ผู้เล่นคนนี้อยู่ในก๊วนแล้ว');
  expect(dialog.hasAttribute('open')).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix web test -- --run session-dashboard.spec.ts -t "walk-in"`
Expected: FAIL — no `[data-add-walk-in]` element, `app-add-walk-in-dialog` not found.

- [ ] **Step 3: Wire the dialog into the dashboard component**

In `session-dashboard.ts`, add the import and register the component:

```ts
import { AddWalkInDialog } from '../../shared/add-walk-in-dialog/add-walk-in-dialog';
```

Add `AddWalkInDialog` to the `imports` array in the `@Component` decorator (alongside `ShuttleDetailsDialog`).

Add state and handlers (near `rosterError`/`toggleResting`):

```ts
private readonly walkInDialog = viewChild<AddWalkInDialog>('walkInDialog');
protected readonly walkInSaving = signal(false);
protected readonly walkInError = signal<string | null>(null);

protected readonly rosterPlayerIds = computed(() => new Set(this.session()?.rosterPlayerIds ?? []));

protected openWalkInDialog(): void {
  this.walkInError.set(null);
  this.walkInDialog()?.open();
}

protected async submitWalkIn(input: { playerId: string } | { name: string }): Promise<void> {
  this.walkInSaving.set(true);
  this.walkInError.set(null);
  const result = await this.liveSession.addWalkIn(input);
  this.walkInSaving.set(false);
  if (!result.ok) {
    this.walkInError.set(result.error ?? null);
    return;
  }
  // A brand-new player from the `name` branch isn't in `playersResource`
  // yet — an existing-player pick already is, so this reload is a no-op for
  // that case rather than a correctness requirement.
  this.playersResource.reload();
  this.walkInDialog()?.close();
}
```

Import `viewChild` in the existing `@angular/core` import line if not already present (it already imports `viewChild` — check the top of the file; if missing, add it there).

- [ ] **Step 4: Add the button and dialog to the template**

In `session-dashboard.html`, add the button right after the `roster-chips` block (before `@if (rosterError())`):

```html
    @if (!ended()) {
      <button type="button" class="ghost" data-add-walk-in (click)="openWalkInDialog()" i18n="@@dashboard.addWalkIn">+ เพิ่มคน</button>
    }
```

Add the dialog element near the other dialogs (e.g. alongside wherever `<app-shuttle-details-dialog>` is rendered in this template):

```html
<app-add-walk-in-dialog
  #walkInDialog
  [players]="players()"
  [excludedIds]="rosterPlayerIds()"
  [saving]="walkInSaving()"
  [error]="walkInError()"
  (add)="submitWalkIn($event)"
/>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix web test -- --run session-dashboard.spec.ts`
Expected: PASS, including the two new tests and every pre-existing dashboard test.

- [ ] **Step 6: Run the full web suite, then the full project suite**

Run: `npm --prefix web test`
Run: `npm test`
Expected: PASS across engines, server, and web.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/pages/session-dashboard/session-dashboard.ts web/src/app/pages/session-dashboard/session-dashboard.html web/src/app/pages/session-dashboard/session-dashboard.spec.ts
git commit -m "feat(dashboard): add a walk-in to a running session via the new roster route"
```

---

## Done criteria

- `POST /sessions/:code/roster` exists, owner-guarded, lock-guarded, covered by the tests in Tasks 1-4.
- A walk-in's `gamesOffset` uses the exact same `rotationCredit` arithmetic as a returning player — no drift between the two paths.
- The dashboard has a "+ เพิ่มคน" affordance that searches existing group players (via the existing `searchCandidates`, no new search logic) or stages a new one, and reports server refusals in Thai.
- No C1 (skill level) UI was added — `Player.level` doesn't exist yet.
- `npm test` (engines + server + web) is green.
- `overview.md`'s roster-review paragraph still says "no way to add a player to a running session" — updating it is listed in the spec under "`overview.md` updates owed when items ship" and is not part of this plan; do it as a small follow-up once this ships, or fold it into whichever task closes out C2 on the roadmap doc.
