import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LEVELS, levelIndex, type Level } from '../../../engines/levels.ts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

/**
 * Smoke test for host-feedback A (court labels), B (level-mode wait queue +
 * carry game) and C (pair rules) at big-night scale: 60 players, 8 courts,
 * several rotations, over the real HTTP routes.
 */
describe('smoke A/B/C at scale (60 players, 8 courts)', () => {
  const PLAYERS = 60;
  const COURTS = 8;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'smoke-abc-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function seed(mode: 'variety' | 'level', newcomers = 1) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Smoke' } });
    // Far-below newcomers (BG) over a spread of everyone else, tagged an
    // hour ago so the carry rule sees them as "tagged, not yet played".
    const longAgo = new Date(Date.now() - 3_600_000);
    const spread: Level[] = ['S', 'P-', 'P', 'P+', 'C', 'B'];
    await prisma.player.createMany({
      data: Array.from({ length: PLAYERS }, (_, i) => ({
        groupId: groupCode,
        name: `P${String(i + 1).padStart(2, '0')}`,
        aliases: '[]',
        level: mode === 'level' ? (i < newcomers ? 'BG' : spread[i % spread.length]) : null,
        levelSetAt: mode === 'level' ? longAgo : null,
      })),
    });
    const players = (await prisma.player.findMany({ where: { groupId: groupCode } })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: COURTS, rawImportText: '', mode },
    });
    await prisma.sessionRoster.createMany({
      data: players.map((p) => ({ sessionId: sessionCode, playerId: p.id })),
    });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.playerRule.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { groupCode, sessionCode, players, cleanup };
  }

  const teams = (row: { teamA: string; teamB: string }) => ({
    a: JSON.parse(row.teamA) as string[],
    b: JSON.parse(row.teamB) as string[],
  });
  const seatsOf = (row: { teamA: string; teamB: string }) => {
    const { a, b } = teams(row);
    return [...a, ...b];
  };

  /** Fill every idle court, confirm all, finish all. Returns this round's rows. */
  async function playRound(s: Seeded, round: number) {
    const fill = await request(server).post(`/sessions/${s.sessionCode}/courts/fill`).expect(201);
    expect(fill.body.ok).toBe(true);
    const pending = await prisma.pairing.findMany({
      where: { sessionId: s.sessionCode, endedAt: null },
    });
    expect(pending).toHaveLength(COURTS);
    const seated = pending.flatMap(seatsOf);
    expect(new Set(seated).size).toBe(COURTS * 4); // nobody on two courts
    for (const row of pending) {
      await request(server)
        .post(`/sessions/${s.sessionCode}/pairings/${row.id}/confirm`)
        .send({})
        .expect(201);
    }
    for (const row of pending) {
      await request(server)
        .post(`/sessions/${s.sessionCode}/pairings/${row.id}/finish`)
        .send({ winner: round % 2 === 0 ? 'A' : 'B' })
        .expect(201);
    }
    return pending;
  }

  // ---------------------------------------------------------------- A
  it('A: court labels on all 8 courts survive a full night and reject duplicates', async () => {
    const s = await seed('variety');
    try {
      const labels = ['สนาม 1', 'Court B', 'สนามริม', 'D', 'E', 'F', 'G', 'H'];
      for (const [i, label] of labels.entries()) {
        await request(server)
          .post(`/sessions/${s.sessionCode}/courts/${i + 1}/label`)
          .send({ label })
          .expect(201);
      }
      const dup = await request(server)
        .post(`/sessions/${s.sessionCode}/courts/2/label`)
        .send({ label: 'D' });
      expect(dup.status).toBeGreaterThanOrEqual(400);
      expect(dup.status).toBeLessThan(500);

      for (let round = 0; round < 3; round++) await playRound(s, round);

      const read = await request(server).get(`/sessions/${s.sessionCode}`).expect(200);
      expect(read.body.courtLabels.slice(0, COURTS)).toEqual(labels);
      expect(read.body.courts).toHaveLength(COURTS);

      // Blank resets a court to its number.
      await request(server)
        .post(`/sessions/${s.sessionCode}/courts/3/label`)
        .send({ label: '   ' })
        .expect(201);
      const after = await request(server).get(`/sessions/${s.sessionCode}`).expect(200);
      expect(after.body.courtLabels[2]).toBeNull();
    } finally {
      await s.cleanup();
    }
  }, 120_000);

  // ---------------------------------------------------------------- B
  it('B: level mode queues by wait time and gives a lone far-below newcomer a carry game', async () => {
    const s = await seed('level', 1);
    const level = new Map(s.players.map((p) => [p.id, p.level as Level]));
    const bg = s.players[0];
    try {
      const read = await request(server).get(`/sessions/${s.sessionCode}`).expect(200);
      expect(read.body.mode).toBe('level');
      expect(read.body.queueBy).toBe('wait');

      const streak = new Map<string, number>(s.players.map((p) => [p.id, 0]));
      let maxStreak = 0;
      let bgFirst: { partner: string; round: number } | null = null;
      const ROUNDS = 5;
      for (let round = 0; round < ROUNDS; round++) {
        const rows = await playRound(s, round);
        const played = new Set(rows.flatMap(seatsOf));
        for (const p of s.players) {
          const n = played.has(p.id) ? 0 : (streak.get(p.id) ?? 0) + 1;
          streak.set(p.id, n);
          maxStreak = Math.max(maxStreak, n);
        }
        if (!bgFirst) {
          for (const row of rows) {
            const { a, b } = teams(row);
            for (const team of [a, b]) {
              if (team.includes(bg.id)) bgFirst = { partner: team.find((x) => x !== bg.id)!, round };
            }
          }
        }
      }

      expect(bgFirst, 'BG newcomer never played').not.toBeNull();
      const partnerLevel = level.get(bgFirst!.partner)!;
      // eslint-disable-next-line no-console
      console.log(`B carry: BG newcomer round ${bgFirst!.round}, partner level ${partnerLevel}`);
      expect(bgFirst!.round).toBe(0); // first turn after being tagged
      expect(levelIndex(partnerLevel)).toBeGreaterThanOrEqual(levelIndex('P+')); // top of those waiting

      // Wait-time queue, within the band-clustering the mode deliberately does:
      // 28 of 60 sit each round, and nobody should sit 3 rounds running.
      // eslint-disable-next-line no-console
      console.log(`B longest sit-out streak over ${ROUNDS} rounds: ${maxStreak}`);
      expect(maxStreak).toBeLessThanOrEqual(2);

      // Level spread on non-carry courts, for the record.
      const rows = await prisma.pairing.findMany({ where: { sessionId: s.sessionCode } });
      const spans = rows
        .filter((r) => !seatsOf(r).includes(bg.id))
        .map((r) => {
          const idx = seatsOf(r).map((id) => levelIndex(level.get(id)!));
          return Math.max(...idx) - Math.min(...idx);
        });
      // eslint-disable-next-line no-console
      console.log(
        `B level spread, non-carry courts: max ${Math.max(...spans)}, mean ${(
          spans.reduce((x, y) => x + y, 0) / spans.length
        ).toFixed(2)} over ${spans.length} games`
      );
      const hist = new Map<number, number>();
      for (const sp of spans) hist.set(sp, (hist.get(sp) ?? 0) + 1);
      // eslint-disable-next-line no-console
      console.log('B span histogram (span:count)', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
      // Bands are a dominant preference, never a hard rule (overview.md): the
      // typical court is tight, a few leftover-seat courts may not be.
      expect(spans.reduce((x, y) => x + y, 0) / spans.length).toBeLessThanOrEqual(1.5);
      expect(LEVELS.length).toBe(8);
    } finally {
      await s.cleanup();
    }
  }, 180_000);

  it('B: two far-below newcomers share one court on their first turn, no pro', async () => {
    const s = await seed('level', 2);
    try {
      const rows = await playRound(s, 0);
      const [x, y] = s.players;
      const court = rows.find((r) => seatsOf(r).includes(x.id));
      expect(court).toBeDefined();
      expect(seatsOf(court!)).toContain(y.id);
    } finally {
      await s.cleanup();
    }
  }, 120_000);

  // ---------------------------------------------------------------- C
  for (const mode of ['variety', 'level'] as const) {
    it(`C: pair rules hold across 5 rotations in ${mode} mode with 22 rules`, async () => {
      const s = await seed(mode);
      const id = (n: number) => s.players[n - 1].id;
      const mustPair: [number, number][] = [
        [3, 4],
        [5, 6],
        [7, 8],
        [9, 10],
        [11, 12],
        [13, 14],
      ];
      const neverTeam: [number, number][] = [
        [15, 16],
        [17, 18],
        [19, 20],
        [21, 22],
        [23, 24],
        [25, 26],
        [27, 28],
        [29, 30],
      ];
      const neverCourt: [number, number][] = [
        [31, 32],
        [33, 34],
        [35, 36],
        [37, 38],
        [39, 40],
        [41, 42],
        [43, 44],
        [45, 46],
      ];
      try {
        const defs = [
          ...mustPair.map((p) => ['must-pair', p] as const),
          ...neverTeam.map((p) => ['never-teammates', p] as const),
          ...neverCourt.map((p) => ['never-same-court', p] as const),
        ];
        await prisma.playerRule.createMany({
          data: defs.map(([kind, [a, b]]) => ({
            groupId: s.groupCode,
            playerAId: id(a),
            playerBId: id(b),
            kind,
          })),
        });

        const rules = await request(server).get(`/sessions/${s.sessionCode}/rules`).expect(200);
        expect(rules.body.rules).toHaveLength(defs.length);

        for (let round = 0; round < 5; round++) await playRound(s, round);

        const rows = await prisma.pairing.findMany({ where: { sessionId: s.sessionCode } });
        expect(rows).toHaveLength(5 * COURTS);
        const sameTeam = (r: (typeof rows)[number], x: string, y: string) => {
          const { a, b } = teams(r);
          return (a.includes(x) && a.includes(y)) || (b.includes(x) && b.includes(y));
        };
        let mustPairGames = 0;
        for (const r of rows) {
          const seats = seatsOf(r);
          for (const [x, y] of mustPair) {
            const hasX = seats.includes(id(x));
            const hasY = seats.includes(id(y));
            expect(hasX, `must-pair ${x}/${y} split across courts`).toBe(hasY);
            if (hasX) {
              mustPairGames++;
              expect(sameTeam(r, id(x), id(y)), `must-pair ${x}/${y} on opposite teams`).toBe(true);
            }
          }
          for (const [x, y] of neverTeam) {
            expect(sameTeam(r, id(x), id(y)), `never-teammates ${x}/${y} partnered`).toBe(false);
          }
          for (const [x, y] of neverCourt) {
            expect(
              seats.includes(id(x)) && seats.includes(id(y)),
              `never-same-court ${x}/${y} shared a court`
            ).toBe(false);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`C ${mode}: ${rows.length} games, ${mustPairGames} must-pair appearances, 0 violations`);
        expect(mustPairGames).toBeGreaterThan(0);

        // Tonight-only switch: disabling a rule is reflected and re-enabling restores it.
        const first = rules.body.rules[0].id as string;
        const off = await request(server)
          .post(`/sessions/${s.sessionCode}/rules/${first}/toggle`)
          .send({ enabled: false })
          .expect(201);
        expect(off.body.disabledRuleIds).toContain(first);
        const on = await request(server)
          .post(`/sessions/${s.sessionCode}/rules/${first}/toggle`)
          .send({ enabled: true })
          .expect(201);
        expect(on.body.disabledRuleIds).not.toContain(first);
      } finally {
        await s.cleanup();
      }
    }, 180_000);
  }

  // ------------------------------------------------- C negative controls
  // A rule only proves itself if the same setup breaks it once switched off.
  type Kind = 'must-pair' | 'never-teammates' | 'never-same-court';
  async function smallSeed(playerCount: number, kind: Kind) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Ctl' } });
    await prisma.player.createMany({
      data: Array.from({ length: playerCount }, (_, i) => ({
        groupId: groupCode,
        name: `Q${i + 1}`,
        aliases: '[]',
      })),
    });
    const players = (await prisma.player.findMany({ where: { groupId: groupCode } })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.sessionRoster.createMany({
      data: players.map((p) => ({ sessionId: sessionCode, playerId: p.id })),
    });
    const rule = await prisma.playerRule.create({
      data: { groupId: groupCode, playerAId: players[0].id, playerBId: players[1].id, kind },
    });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.playerRule.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionCode, players, rule, cleanup };
  }

  /** Propose N fresh matches on court 1; returns how many broke `bad`. */
  async function proposeMany(
    sessionCode: string,
    n: number,
    bad: (a: string[], b: string[]) => boolean
  ) {
    let broken = 0;
    for (let i = 0; i < n; i++) {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(res.body.ok).toBe(true);
      const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
      if (bad(teamA, teamB)) broken++;
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    }
    return broken;
  }

  const setRule = (sessionCode: string, ruleId: string, enabled: boolean) =>
    request(server).post(`/sessions/${sessionCode}/rules/${ruleId}/toggle`).send({ enabled }).expect(201);

  const cases: {
    kind: Kind;
    players: number;
    bad: (x: string, y: string) => (a: string[], b: string[]) => boolean;
    why: string;
  }[] = [
    {
      kind: 'must-pair',
      players: 4,
      // Split across teams is the violation; 2 of 3 splits do it.
      bad: (x, y) => (a, b) => !((a.includes(x) && a.includes(y)) || (b.includes(x) && b.includes(y))),
      why: 'คู่กัน',
    },
    {
      kind: 'never-teammates',
      players: 4,
      // Teammates is the violation; 1 of 3 splits does it.
      bad: (x, y) => (a, b) => (a.includes(x) && a.includes(y)) || (b.includes(x) && b.includes(y)),
      why: 'ห้ามอยู่ด้วยกัน',
    },
    {
      kind: 'never-same-court',
      players: 5, // one sits out, so the engine has room to bench one of the pair
      // Both seated is the violation; happens when the sitter is one of the other 3.
      bad: (x, y) => (a, b) => [...a, ...b].includes(x) && [...a, ...b].includes(y),
      why: 'ห้ามเล่นด้วยกัน',
    },
  ];

  for (const c of cases) {
    it(`C control: ${c.why} (${c.kind}) binds when on and breaks when switched off`, async () => {
      const s = await smallSeed(c.players, c.kind);
      try {
        const [x, y] = [s.players[0].id, s.players[1].id];
        const ROUNDS = 40;
        const withRule = await proposeMany(s.sessionCode, ROUNDS, c.bad(x, y));
        await setRule(s.sessionCode, s.rule.id, false);
        const withoutRule = await proposeMany(s.sessionCode, ROUNDS, c.bad(x, y));
        // eslint-disable-next-line no-console
        console.log(`C control ${c.kind}: violations on=${withRule}/${ROUNDS} off=${withoutRule}/${ROUNDS}`);
        expect(withRule).toBe(0);
        expect(withoutRule).toBeGreaterThan(0);
        await setRule(s.sessionCode, s.rule.id, true);
        expect(await proposeMany(s.sessionCode, 10, c.bad(x, y))).toBe(0);
      } finally {
        await s.cleanup();
      }
    }, 120_000);
  }
});
