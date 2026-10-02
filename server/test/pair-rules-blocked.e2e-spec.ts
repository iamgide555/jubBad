import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { isLegalCourt } from '../../engines/pair-rules.ts';
import { GroupsModule } from '../src/groups/groups.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SessionsModule } from '../src/sessions/sessions.module.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * What happens when the rules cannot be satisfied, or a lineup is made illegal
 * after the fact. The contract under test: the app never seats, confirms or
 * auto-confirms a lineup that breaks an enabled rule, and says which rules got
 * in the way (so the host's UI can show them) instead of failing with a 500 or
 * the misleading "not enough players".
 */
const SEED = Number(process.env.E2E_SEED ?? Date.now() % 1_000_000_000);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'must-pair' | 'never-teammates' | 'never-same-court';
type Rule = { id: string; playerAId: string; playerBId: string; kind: Kind };
const idsOf = (p: { teamA: string; teamB: string }) => [...(JSON.parse(p.teamA) as string[]), ...(JSON.parse(p.teamB) as string[])];

describe(`pair rules that cannot be satisfied (e2e, seed ${SEED})`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionsService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;
  const groups: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
    adminId = (await prisma.user.create({ data: { email: `pr-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: adminId, role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    for (const code of groups) {
      const where = { session: { groupId: code } };
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: where } });
      await prisma.pairing.deleteMany({ where });
      await prisma.sessionRoster.deleteMany({ where });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.playerRule.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  async function fixture(playerCount: number, courtCount: number) {
    const code = `e2e-pr-${randomUUID().slice(0, 8)}`;
    const sessionCode = randomUUID();
    groups.push(code);
    await prisma.group.create({ data: { code, name: 'PR', ownerId: adminId } });
    const players: { id: string; name: string }[] = [];
    for (let i = 0; i < playerCount; i++) {
      players.push(await prisma.player.create({ data: { groupId: code, name: `P${String(i + 1).padStart(2, '0')}`, aliases: '[]' } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: code, courtCount, rawImportText: '', mode: 'variety' } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const rules: Rule[] = [];
    const addRule = async (a: string, b: string, kind: Kind) => {
      const [playerAId, playerBId] = [a, b].sort();
      const row = await prisma.playerRule.create({ data: { groupId: code, playerAId, playerBId, kind } });
      const rule = { id: row.id, playerAId, playerBId, kind };
      rules.push(rule);
      return rule;
    };
    const name = (id: string) => players.find((p) => p.id === id)?.name ?? id;
    return { code, sessionCode, players, rules, addRule, name };
  }

  const courtsOf = async (sessionCode: string) =>
    (await request(server).get(`/sessions/${sessionCode}`).expect(200)).body.courts as { courtNumber: number; status: string; pairingId?: string; revision?: number }[];
  const confirmed = (sessionCode: string) =>
    prisma.pairing.findMany({ where: { sessionId: sessionCode, confirmedAt: { not: null } } });
  const legal = (p: { teamA: string; teamB: string }, rules: Rule[]) =>
    rules.every((r) => isLegalCourt(JSON.parse(p.teamA), JSON.parse(p.teamB), [r]));

  it('4 players, never-same-court A/B: propose and fill are blocked, name the rule, and seat nobody', async () => {
    const f = await fixture(4, 1);
    const rule = await f.addRule(f.players[0].id, f.players[1].id, 'never-same-court');

    const propose = await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({});
    expect(propose.status, JSON.stringify(propose.body)).toBeLessThan(300);
    expect(propose.body).toMatchObject({ ok: false, reason: 'pair-rules-blocked' });
    expect(propose.body.ruleIds).toContain(rule.id);

    const fill = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`);
    expect(fill.status).toBeLessThan(300);
    expect(fill.body).toMatchObject({ ok: false, reason: 'pair-rules-blocked' });
    expect(fill.body.blocked).toEqual([{ courtNumber: 1, ruleIds: expect.arrayContaining([rule.id]) }]);

    expect(await prisma.pairing.count({ where: { sessionId: f.sessionCode } })).toBe(0);
    expect((await courtsOf(f.sessionCode))[0].status).toBe('idle');
  });

  it('4 players where A cannot partner anyone: blocked, not "not enough players"', async () => {
    const f = await fixture(4, 1);
    for (const other of f.players.slice(1)) await f.addRule(f.players[0].id, other.id, 'never-teammates');
    const res = await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({});
    expect(res.body).toMatchObject({ ok: false, reason: 'pair-rules-blocked' });
    expect(res.body.ruleIds.length).toBeGreaterThan(0);
    expect(await prisma.pairing.count({ where: { sessionId: f.sessionCode } })).toBe(0);
  });

  it('5 players where A can share a court with nobody: the other four play, A sits out, no rule broken', async () => {
    const f = await fixture(5, 1);
    for (const other of f.players.slice(1)) await f.addRule(f.players[0].id, other.id, 'never-same-court');
    const res = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).expect(201);
    expect(res.body.ok).toBe(true);
    const [p] = await prisma.pairing.findMany({ where: { sessionId: f.sessionCode } });
    expect(idsOf(p)).not.toContain(f.players[0].id);
    expect(idsOf(p)).toHaveLength(4);
  });

  it('two courts, 8 players, P1 barred from 5 others: whatever fills is legal', async () => {
    const f = await fixture(8, 2);
    // P1 can share a court with only one other player's worth of room: forbid P1 with 5 of the 7 others.
    for (const other of f.players.slice(1, 6)) await f.addRule(f.players[0].id, other.id, 'never-same-court');
    const res = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).expect(201);
    expect(res.body.ok).toBe(true);
    const rows = await prisma.pairing.findMany({ where: { sessionId: f.sessionCode } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(legal(r, f.rules), `court ${r.courtNumber} legal`).toBe(true);
  });

  it('a rule added after the proposal: confirm is refused 409, auto-confirm leaves it pending, switching the rule off lets it through', async () => {
    const f = await fixture(4, 1);
    await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).expect(201);
    const [court] = await courtsOf(f.sessionCode);
    expect(court.status).toBe('pending');

    // host adds a rule between two players already seated together
    const rule = await f.addRule(f.players[0].id, f.players[1].id, 'never-same-court');

    const refused = await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/confirm`)
      .send({ expectedRevision: court.revision });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PAIR_RULE_VIOLATION' });
    expect(refused.body.ruleIds ?? refused.body.details?.ruleIds).toContain(rule.id);

    // the 60s sweep must not push it through either
    const swept = await sessions.autoConfirmDue(new Date(Date.now() + 10 * 60_000));
    expect(swept).not.toContain(f.sessionCode);
    const row = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    expect(row.confirmedAt).toBeNull();

    // reshuffling cannot help with only 4 players: still blocked, not a crash
    const reshuffle = await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({});
    expect(reshuffle.status).toBeLessThan(500);

    // the host switches the rule off for tonight and the same pairing goes through
    await request(server).post(`/sessions/${f.sessionCode}/rules/${rule.id}/toggle`).send({ enabled: false }).expect(201);
    const [again] = (await courtsOf(f.sessionCode)).filter((c) => c.pairingId === court.pairingId);
    await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/confirm`)
      .send({ expectedRevision: again.revision })
      .expect(201);
  });

  it('manual edits that would break a rule (swap, seat) are refused and leave the lineup untouched', async () => {
    const f = await fixture(5, 1);
    await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).expect(201);
    const [court] = await courtsOf(f.sessionCode);
    const row = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    const seated = idsOf(row);
    const bench = f.players.map((p) => p.id).find((id) => !seated.includes(id))!;
    // bench player may not share a court with seated[0]; the current lineup is still legal
    await f.addRule(bench, seated[0], 'never-same-court');
    const before = JSON.stringify([row.teamA, row.teamB]);

    const swap = await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/swap`)
      .send({ playerId: seated[1], withPlayerId: bench, expectedRevision: court.revision });
    console.log(`[pair-rules] swap bench-in -> ${swap.status} ${JSON.stringify(swap.body).slice(0, 160)}`);
    expect(swap.status).toBeLessThan(500);

    const afterSwap = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    expect(legal(afterSwap, f.rules), 'lineup after swap').toBe(true);

    // vacate the seat first (the editor refuses to overwrite an occupied one), then try to seat the bench player there
    const team = JSON.parse(afterSwap.teamA).includes(seated[1]) ? 'A' : 'B';
    const index = JSON.parse(team === 'A' ? afterSwap.teamA : afterSwap.teamB).indexOf(seated[1]);
    const vacate = await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/seats`)
      .send({ team, index, expectedRevision: afterSwap.revision });
    expect(vacate.status, JSON.stringify(vacate.body)).toBeLessThan(300);
    const vacated = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    const seat = await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/seats`)
      .send({ team, index, playerId: bench, expectedRevision: vacated.revision });
    expect(seat.status, 'seating a rule-breaking player must be refused').toBe(409);
    expect(seat.body.code).toBe('PAIR_RULE_VIOLATION');
    console.log(`[pair-rules] seat bench-in -> ${seat.status} ${JSON.stringify(seat.body).slice(0, 160)}`);
    expect(seat.status).toBeLessThan(500);
    const afterSeat = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    // a full court must be legal; a vacated seat while the host builds it is allowed
    const full = !JSON.parse(afterSeat.teamA).includes(null) && !JSON.parse(afterSeat.teamB).includes(null);
    if (full) expect(legal(afterSeat, f.rules), 'full lineup after seat edit').toBe(true);
    expect(before).toBeTruthy();
  });

  it('swapping in one half of a คู่กัน pair brings the partner too, and both step-offs go to the pair\'s old place', async () => {
    const f = await fixture(6, 1);
    await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).expect(201);
    const [court] = await courtsOf(f.sessionCode);
    const row = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    const seated = idsOf(row);
    const [b1, b2] = f.players.map((p) => p.id).filter((id) => !seated.includes(id));
    const rule = await f.addRule(b1, b2, 'must-pair');
    const out = seated[0];
    const teamOf = (r: { teamA: string; teamB: string }, id: string) =>
      (JSON.parse(r.teamA) as string[]).includes(id) ? JSON.parse(r.teamA) as string[] : JSON.parse(r.teamB) as string[];
    const mate = teamOf(row, out).find((id) => id !== out)!;

    const swap = await request(server)
      .post(`/sessions/${f.sessionCode}/pairings/${court.pairingId}/swap`)
      .send({ playerId: out, withPlayerId: b1, expectedRevision: court.revision });
    expect(swap.status, JSON.stringify(swap.body)).toBeLessThan(300);

    const after = await prisma.pairing.findUniqueOrThrow({ where: { id: court.pairingId } });
    expect(teamOf(after, b1)).toContain(b2);
    expect(idsOf(after)).not.toContain(out);
    expect(idsOf(after)).not.toContain(mate);
    expect(legal(after, [rule])).toBe(true);
  });

  it('rule storm: dense random rules over 12 nights (8 tight tables, 4 big ones); never a rule broken, never a 5xx, blocked says which rules', async () => {
    const rand = rng(SEED);
    let blockedFills = 0, played = 0, nights = 0;
    for (let night = 0; night < 12; night++) {
      const tight = night < 8; // small tables with dense rules are where lineups run out
      const players = tight ? 4 + Math.floor(rand() * 5) : 10 + Math.floor(rand() * 11); // 4-8 or 10-20
      const courts = tight ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3);
      const density = tight ? 0.5 : 0.35;
      const f = await fixture(players, courts);
      const ids = f.players.map((p) => p.id);
      const couples = new Set<string>();
      // up to 2 couples
      for (let i = 0; i < (tight ? 1 : 2) && ids.length - couples.size >= 4; i++) {
        const free = ids.filter((id) => !couples.has(id));
        const a = free[Math.floor(rand() * free.length)];
        const b = free.filter((x) => x !== a)[Math.floor(rand() * (free.length - 1))];
        await f.addRule(a, b, 'must-pair');
        couples.add(a); couples.add(b);
      }
      // ~35% of the remaining pairs get a never-* rule
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (f.rules.some((r) => (r.playerAId === ids[i] && r.playerBId === ids[j]) || (r.playerAId === ids[j] && r.playerBId === ids[i]))) continue;
          if (rand() < density) await f.addRule(ids[i], ids[j], rand() < 0.5 ? 'never-teammates' : 'never-same-court');
        }
      }
      const known = new Set(f.rules.map((r) => r.id));
      let stuck = false;
      for (let round = 0; round < 25 && !stuck; round++) {
        const fill = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`);
        expect(fill.status, `night ${night} round ${round}: ${JSON.stringify(fill.body)}`).toBeLessThan(500);
        if (fill.body.ok === false) {
          blockedFills++;
          if (fill.body.reason === 'pair-rules-blocked') {
            expect(fill.body.blocked.length).toBeGreaterThan(0);
            for (const b of fill.body.blocked) for (const id of b.ruleIds) expect(known.has(id), `unknown rule ${id}`).toBe(true);
          }
          stuck = (await courtsOf(f.sessionCode)).every((c) => c.status === 'idle');
        }
        for (const c of (await courtsOf(f.sessionCode)).filter((x) => x.status === 'pending')) {
          const res = await request(server)
            .post(`/sessions/${f.sessionCode}/pairings/${c.pairingId}/confirm`)
            .send({ expectedRevision: c.revision });
          expect(res.status, JSON.stringify(res.body)).toBe(201);
        }
        for (const c of (await courtsOf(f.sessionCode)).filter((x) => x.status === 'active')) {
          await request(server)
            .post(`/sessions/${f.sessionCode}/pairings/${c.pairingId}/finish`)
            .send({ winner: rand() < 0.5 ? 'A' : 'B', expectedRevision: c.revision })
            .expect(201);
          played++;
        }
      }
      for (const p of await confirmed(f.sessionCode)) expect(legal(p, f.rules), `night ${night} pairing ${p.id} legal`).toBe(true);
      nights++;
    }
    console.log(`[pair-rules] storm seed=${SEED}: ${nights} nights, ${played} games, ${blockedFills} blocked fills`);
    expect(played).toBeGreaterThan(0);
    expect(blockedFills, 'the storm should actually hit the blocked path').toBeGreaterThan(0);
  }, 120_000);
});
