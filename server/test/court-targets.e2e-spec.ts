import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { vi } from 'vitest';
import { GroupsModule } from '../src/groups/groups.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SessionsModule } from '../src/sessions/sessions.module.js';

/**
 * Per-court Low/High targets on a big night (30+ players, 6 courts), driven
 * through the real HTTP routes exactly as the host's phone does: propose each
 * idle court, confirm, finish, repeat. Every confirmed match is checked
 * against the court's target at the time it was confirmed.
 */
describe('court targets: big mixed night', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `ctt-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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
    await prisma.group.updateMany({ where: { ownerId: adminId }, data: { ownerId: null } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  const LOW = new Set(['BG', 'N', 'S']);
  const HIGH = new Set(['P-', 'P', 'P+']);

  async function night(levels: (string | null)[], courtCount: number) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Night', ownerId: adminId } });
    const players = [];
    for (const [i, level] of levels.entries()) {
      players.push(
        await prisma.player.create({
          data: {
            groupId: groupCode,
            name: `P${String(i + 1).padStart(2, '0')}`,
            aliases: '[]',
            level,
            levelSeed: level ? 1200 : null,
            levelSetAt: level ? new Date(Date.now() - 5 * 3_600_000) : null,
          },
        })
      );
    }
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '', mode: 'level' },
    });
    await prisma.sessionRoster.createMany({ data: players.map((p) => ({ sessionId: sessionCode, playerId: p.id })) });
    const levelOf = new Map(players.map((p) => [p.id, p.level]));
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionCode, players, levelOf, cleanup };
  }

  type Night = Awaited<ReturnType<typeof night>>;

  async function setTargets(n: Night, targets: ('auto' | 'low' | 'high')[]) {
    for (const [i, target] of targets.entries()) {
      await request(server).post(`/sessions/${n.sessionCode}/courts/${i + 1}/target`).send({ target }).expect(201);
    }
  }

  /** One host round: propose every idle court one by one, confirm all, finish all. Returns what was confirmed per court. */
  async function playRound(n: Night, courtCount: number) {
    for (let c = 1; c <= courtCount; c++) {
      await request(server).post(`/sessions/${n.sessionCode}/courts/${c}/propose`).send({}).expect(201);
    }
    const session = (await request(server).get(`/sessions/${n.sessionCode}`).expect(200)).body;
    const matches: { court: number; levels: (string | null)[]; ids: string[] }[] = [];
    for (const court of session.courts) {
      if (court.status !== 'pending') continue;
      await request(server)
        .post(`/sessions/${n.sessionCode}/pairings/${court.pairingId}/confirm`)
        .send({ expectedRevision: court.revision })
        .expect(201);
      const ids = [...court.teamA, ...court.teamB] as string[];
      matches.push({ court: court.courtNumber, ids, levels: ids.map((id) => n.levelOf.get(id) ?? null) });
    }
    const live = (await request(server).get(`/sessions/${n.sessionCode}`).expect(200)).body;
    for (const [i, court] of live.courts.entries()) {
      if (court.status !== 'active') continue;
      await request(server)
        .post(`/sessions/${n.sessionCode}/pairings/${court.pairingId}/finish`)
        .send({ winner: i % 2 ? 'A' : 'B', expectedRevision: court.revision })
        .expect(201);
    }
    return matches;
  }

  const fullOfHalf = (levels: (string | null)[], half: Set<string>) =>
    levels.every((l) => l === null || half.has(l));

  vi.setConfig({ testTimeout: 120_000 });

  it('40 players on 6 courts: High courts hold only the upper half, Low only the lower, for ten rounds, across a mid-night retarget', async () => {
    // 18 lower (BG/N/S), 18 upper (P-/P/P+), 4 untagged.
    const levels: (string | null)[] = [
      ...['BG', 'N', 'S'].flatMap((l) => Array(6).fill(l)),
      ...['P-', 'P', 'P+'].flatMap((l) => Array(6).fill(l)),
      null, null, null, null,
    ];
    const n = await night(levels, 6);
    try {
      expect(n.players.length).toBeGreaterThanOrEqual(30);
      await setTargets(n, ['high', 'high', 'low', 'low', 'auto', 'auto']);
      let target: Record<number, 'high' | 'low' | 'auto'> = { 1: 'high', 2: 'high', 3: 'low', 4: 'low', 5: 'auto', 6: 'auto' };
      const played = new Map<string, number>();
      let checked = 0;

      for (let round = 1; round <= 10; round++) {
        if (round === 6) {
          // The host flips two courts mid-night; the very next matches must obey.
          await request(server).post(`/sessions/${n.sessionCode}/courts/1/target`).send({ target: 'low' }).expect(201);
          await request(server).post(`/sessions/${n.sessionCode}/courts/3/target`).send({ target: 'high' }).expect(201);
          target = { ...target, 1: 'low', 3: 'high' };
        }
        const matches = await playRound(n, 6);
        expect(matches.length, `round ${round}: every court should have a match`).toBe(6);
        for (const m of matches) {
          expect(new Set(m.ids).size, `round ${round} court ${m.court}: duplicate player`).toBe(4);
          for (const id of m.ids) played.set(id, (played.get(id) ?? 0) + 1);
          const t = target[m.court];
          if (t === 'high') expect(fullOfHalf(m.levels, HIGH), `round ${round} court ${m.court} (High): ${m.levels}`).toBe(true);
          if (t === 'low') expect(fullOfHalf(m.levels, LOW), `round ${round} court ${m.court} (Low): ${m.levels}`).toBe(true);
          checked++;
        }
      }
      expect(checked).toBe(60);

      // Nobody is starved: targeted courts rotate within their half, auto courts mop up the rest.
      for (const p of n.players) {
        expect(played.get(p.id) ?? 0, `${p.name} (${p.level}) never played in 10 rounds`).toBeGreaterThan(0);
      }
      const counts = n.players.map((p) => played.get(p.id) ?? 0);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(8);
    } finally {
      await n.cleanup();
    }
  });

  it('33 players, 6 pros and 27 beginners: the High court always holds the pros together, Low courts the beginners', async () => {
    const levels: (string | null)[] = [...Array(27).fill('N'), ...Array(6).fill('P+')];
    const n = await night(levels, 3);
    try {
      await setTargets(n, ['high', 'low', 'low']);
      const prosPlayed = new Set<string>();
      for (let round = 1; round <= 8; round++) {
        const matches = await playRound(n, 3);
        expect(matches).toHaveLength(3);
        for (const m of matches) {
          if (m.court === 1) {
            expect(m.levels.every((l) => l === 'P+'), `round ${round} High court: ${m.levels}`).toBe(true);
            m.ids.forEach((id) => prosPlayed.add(id));
          } else {
            expect(m.levels.every((l) => l === 'N'), `round ${round} court ${m.court}: ${m.levels}`).toBe(true);
          }
        }
      }
      // 6 pros share one 4-seat court, so the wait queue must rotate all of them through.
      expect(prosPlayed.size).toBe(6);
    } finally {
      await n.cleanup();
    }
  });

  it('skewed roster: the High court is the upper half by headcount, always full, never errors', async () => {
    // 15 N, 15 S, 2 P+. The cut that balances headcount is at S, so "upper half" is S and above:
    // the High court is S/P+ only (never N), even though only 2 of those are true pros.
    const levels: (string | null)[] = [...Array(15).fill('N'), ...Array(15).fill('S'), 'P+', 'P+'];
    const n = await night(levels, 4);
    try {
      await setTargets(n, ['high', 'auto', 'auto', 'auto']);
      for (let round = 1; round <= 4; round++) {
        const matches = await playRound(n, 4);
        expect(matches).toHaveLength(4);
        const high = matches.find((m) => m.court === 1)!;
        expect(high.levels.every((l) => l === 'S' || l === 'P+'), `round ${round}: High court took a beginner: ${high.levels}`).toBe(true);
      }
    } finally {
      await n.cleanup();
    }
  });
});
