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
 * A realistic 4-hour ตามระดับ night: 67 players on the group's custom ladder,
 * 7 must-pair couples read from the host's sheet, random never-teammates /
 * never-same-court rules, courts raised 4 -> 6 -> 8 while games are running,
 * and 6 early leavers settled on the perShuttle model.
 *
 * Nothing waits: only `Date` is faked, and it jumps ~8 minutes per round.
 * Reproduce a failure with E2E_SEED=<printed seed>.
 */
const SEED = Number(process.env.E2E_SEED ?? Date.now() % 1_000_000_000);
const LADDER = ['BG', 'BGN', 'N', 'NS', 'S', 'SP-', 'P-'];
const SHEET = `ต้า BGN
Pk P-
เจฟ NS
โชค P-
มุก BG
อาม P-
ซ่า S
มิก P-
ปอง S
ปลื้ม S
พีเค NS
น้องมิก S
เเป๊ะ NS
เงาะ NS
เจี๊ยบ NS
ป๊อป N
เค BG
นาย N
พี S
เจ๊กชัย SP-
ป๊า BG
ต้นไผ่ P-
หนุ่ม S
บังเชน NS
กอล์ฟ NS
น้องนัท P-
ต่อ BGN
ซัน S
ตาหวาน BGN
ยู S
เชียร์ P-
เติ้ง N
มิน BG
นนท์ N
บัว N
วิท N
ฟลุ๊ก S
อ๊บ S
พี่นัด SP-
อาลีฟ N
เก้อ BGN
บูม P-
นัด NS
เบล BG
เก๋ SP-
กิ๊ก BG
กิต N
หนึ่ง SP-
ก็อต SP-
โจ SP-
ไทม์ SP-
จูน BGN
นาว N
ฝน N
เฟิร์ส N
ธนู NS
อันวา BGN
โก๋ P-
เจ P-
นัตตี้ P-
เซิน S
โบ๊ท S
เปตอง NS
นะ S
เบส SP-
ปูน SP-
พิม SP-`;
// The sheet marks one player of each couple "คู่กันตลอด"; the partner is the next row.
const MUST_PAIR: [string, string][] = [
  ['ปอง', 'ปลื้ม'], ['พีเค', 'น้องมิก'], ['เงาะ', 'เจี๊ยบ'], ['ป๊อป', 'เค'],
  ['ฟลุ๊ก', 'อ๊บ'], ['นัด', 'เบล'], ['เบส', 'ปูน'],
];
const PLAYERS = SHEET.split('\n').map((l) => {
  const [name, level] = l.split(' ');
  return { name, level };
});

const NIGHT_MS = 4 * 60 * 60 * 1000;
const PRICE = 8000;
const CHARGE = 2000;
const START = 1000;
const LEAVERS = 6;
// E2E_RULES=off is the control run: rules are tracked but never created, so we can count what the engine does without them.
const RULES_ON = process.env.E2E_RULES !== 'off';

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

type Court = { courtNumber: number; status: string; pairingId?: string; revision?: number };
const idsOf = (p: { teamA: string; teamB: string }) => [...(JSON.parse(p.teamA) as string[]), ...(JSON.parse(p.teamB) as string[])];

describe(`67-player level-mode night, 4 hours, seed ${SEED} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;
  const groupCode = `e2e-lv-${randomUUID().slice(0, 8)}`;
  const sessionCode = randomUUID();
  const rand = rng(SEED);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  const idByName = new Map<string, string>();
  const nameById = new Map<string, string>();
  const levelOf = new Map<string, number>();
  const neverTeam: [string, string][] = [];
  const neverCourt: [string, string][] = [];
  const mustPair: [string, string][] = [];
  // Windows in which a player is resting or checked out; no game may be confirmed inside one.
  const absent = new Map<string, { from: number; to: number }[]>();
  const goAway = (id: string) => absent.set(id, [...(absent.get(id) ?? []), { from: Date.now(), to: Infinity }]);
  const comeBack = (id: string) => {
    const w = absent.get(id)!;
    w[w.length - 1].to = Date.now();
  };
  const isAbsent = (id: string, t: number) => (absent.get(id) ?? []).some((w) => t > w.from && t < w.to);

  // Every rule the night should obey, with the windows in which it is NOT in force (toggled off, deleted, or not yet added).
  type Tracked = { a: string; b: string; kind: string; id?: string; tag: string; off: { from: number; to: number }[] };
  const tracked: Tracked[] = [];
  const inForce = (r: Tracked, t: number) => !r.off.some((w) => t > w.from && t < w.to);
  const hasRule = (x: string, y: string) => tracked.some((r) => (r.a === x && r.b === y) || (r.a === y && r.b === x));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `lv-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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
    vi.useRealTimers();
    const where = { session: { groupId: groupCode } };
    await prisma.sessionCheckout.deleteMany({ where });
    await prisma.pairingShuttleUse.deleteMany({ where: { pairing: where } });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionShuttle.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.waitlist.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.playerRule.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  const courtsOf = async () => (await request(server).get(`/sessions/${sessionCode}`).expect(200)).body.courts as Court[];
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  async function openPairings() {
    return prisma.pairing.findMany({ where: { sessionId: sessionCode, endedAt: null } });
  }

  /** Nobody may sit on two open courts at once; every court holds 4 distinct players. */
  async function assertNoDoubleBooking(label: string) {
    const seen = new Map<string, number>();
    for (const p of await openPairings()) {
      const ids = idsOf(p);
      expect(new Set(ids).size, `${label}: court ${p.courtNumber} has duplicates`).toBe(ids.length);
      for (const id of ids) {
        expect(seen.has(id), `${label}: ${nameById.get(id)} on courts ${seen.get(id)} and ${p.courtNumber}`).toBe(false);
        seen.set(id, p.courtNumber);
      }
    }
  }

  let shuttleCount = 0;
  async function confirmAll(round: number) {
    const pending = (await courtsOf()).filter((c) => c.status === 'pending');
    const inv = round % 2 === 0 ? (await request(server).get(`/sessions/${sessionCode}/shuttles`).expect(200)).body : null;
    for (const c of pending) {
      const last = inv?.lastShuttleByCourt.find((x: { courtNumber: number }) => x.courtNumber === c.courtNumber);
      const shuttle = last ? { kind: 'existing', shuttleId: last.shuttleId } : { kind: 'new' };
      if (!last) shuttleCount++;
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${c.pairingId}/confirm`)
        .send({ expectedRevision: c.revision, shuttle })
        .expect(201);
    }
    return pending.length;
  }

  async function finishAll() {
    const active = (await courtsOf()).filter((c) => c.status === 'active');
    for (const c of active) {
      const r = rand();
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${c.pairingId}/finish`)
        .send({ winner: r < 0.03 ? null : r < 0.515 ? 'A' : 'B', expectedRevision: c.revision })
        .expect(201);
    }
    return active.length;
  }

  async function oracle() {
    const pairings = await prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: { not: null }, endedAt: { not: null } },
      include: { shuttleUses: true },
    });
    const touched = new Map<string, Set<string>>();
    for (const p of pairings) {
      for (const id of idsOf(p)) {
        const s = touched.get(id) ?? new Set<string>();
        for (const u of p.shuttleUses) s.add(u.shuttleId);
        touched.set(id, s);
      }
    }
    return { touched, pairings };
  }

  it('plays the whole night', async () => {
    console.log(`[level-night] seed=${SEED} (reproduce with E2E_SEED=${SEED})`);
    // --- group, ladder, players
    await prisma.group.create({
      data: {
        code: groupCode, name: 'ก๊วนทดสอบ 67 คน', ownerId: adminId,
        levelLadder: JSON.stringify(LADDER.map((name, i) => ({ id: `l${i}`, name, startingElo: 900 + 100 * i }))),
      },
    });
    for (const p of PLAYERS) {
      const row = await prisma.player.create({
        data: {
          groupId: groupCode, name: p.name, aliases: '[]', level: p.level,
          levelSeed: 900 + 100 * LADDER.indexOf(p.level), levelSetAt: new Date(Date.now() - 86_400_000),
        },
      });
      idByName.set(p.name, row.id);
      nameById.set(row.id, p.name);
      levelOf.set(row.id, LADDER.indexOf(p.level));
    }
    expect(PLAYERS).toHaveLength(67);
    expect(new Set(PLAYERS.map((p) => p.name)).size).toBe(67);

    // --- rules: sheet couples, then seeded random ones among everyone else
    const taken = new Set<string>();
    const addRule = async (a: string, b: string, kind: string, tag = 'random') => {
      const t: Tracked = { a: idByName.get(a)!, b: idByName.get(b)!, kind, tag, off: [] };
      if (RULES_ON) {
        t.id = (await request(server).post(`/groups/${groupCode}/rules`).send({ playerAId: t.a, playerBId: t.b, kind }).expect(201)).body.id;
      }
      tracked.push(t);
      return t;
    };
    for (const [a, b] of MUST_PAIR) {
      await addRule(a, b, 'must-pair', 'couple');
      mustPair.push([idByName.get(a)!, idByName.get(b)!]);
      taken.add(a); taken.add(b);
    }
    const free = PLAYERS.map((p) => p.name).filter((n) => !taken.has(n));
    const used = new Set<string>();
    const randomPair = (near: boolean): [string, string] => {
      for (;;) {
        const a = pick(free), b = pick(free);
        if (a === b || used.has([a, b].sort().join('|'))) continue;
        // half the rules link same/adjacent levels, so they really get in the engine's way
        if (near && Math.abs(LADDER.indexOf(PLAYERS.find((p) => p.name === a)!.level) - LADDER.indexOf(PLAYERS.find((p) => p.name === b)!.level)) > 1) continue;
        used.add([a, b].sort().join('|'));
        return [a, b];
      }
    };
    for (let i = 0; i < 10; i++) {
      const [a, b] = randomPair(i % 2 === 0);
      await addRule(a, b, 'never-teammates');
      neverTeam.push([idByName.get(a)!, idByName.get(b)!]);
    }
    for (let i = 0; i < 10; i++) {
      const [a, b] = randomPair(i % 2 === 0);
      await addRule(a, b, 'never-same-court');
      neverCourt.push([idByName.get(a)!, idByName.get(b)!]);
    }

    // rules that reach INTO the couples: a member vs an outsider, and one couple vs another
    const extra: [string, string, string][] = [
      ['พีเค', pick(free), 'never-same-court'],
      ['อ๊บ', pick(free), 'never-teammates'],
      ['นัด', 'เบส', 'never-same-court'],
      ['ฟลุ๊ก', 'ป๊อป', 'never-teammates'],
    ];
    for (const [a, b, kind] of extra) {
      await addRule(a, b, kind, 'couple-edge');
      (kind === 'never-same-court' ? neverCourt : neverTeam).push([idByName.get(a)!, idByName.get(b)!]);
    }
    // nested rules among N/NS players, the rungs most likely to be put on one court:
    //   chain:    n1=n2 (must-pair) | n2 !court n3 | n3=n4 (must-pair) | n2 !team n4
    //   triangle: n5=n6 (must-pair) | n6 !court n7 | n7 !team n5 | n7=n8 (must-pair) | n8 !team n6
    const pool = free.filter((n) => ['N', 'NS'].includes(PLAYERS.find((x) => x.name === n)!.level));
    const nest: string[] = [];
    while (nest.length < 8) {
      const n = pick(pool);
      if (!nest.includes(n)) nest.push(n);
    }
    const [n1, n2, n3, n4, n5, n6, n7, n8] = nest;
    for (const [a, b, kind] of [
      [n1, n2, 'must-pair'], [n2, n3, 'never-same-court'], [n3, n4, 'must-pair'], [n2, n4, 'never-teammates'],
      [n5, n6, 'must-pair'], [n6, n7, 'never-same-court'], [n7, n5, 'never-teammates'], [n7, n8, 'must-pair'], [n8, n6, 'never-teammates'],
    ] as [string, string, string][]) {
      if (hasRule(idByName.get(a)!, idByName.get(b)!)) continue; // already carries a random rule
      await addRule(a, b, kind, 'nested');
      if (kind === 'must-pair') mustPair.push([idByName.get(a)!, idByName.get(b)!]);
    }
    console.log(`[level-night] nested chain ${[n1, n2, n3, n4].join(' ')} | triangle ${[n5, n6, n7, n8].join(' ')}`);
    // a couple cannot also carry another rule on the same pair
    if (RULES_ON) await request(server).post(`/groups/${groupCode}/rules`)
      .send({ playerAId: idByName.get('ปอง'), playerBId: idByName.get('ปลื้ม'), kind: 'never-same-court' }).expect(409);

    // --- session: level mode, shuttle tools on, 4 courts
    await prisma.session.create({
      data: {
        code: sessionCode, groupId: groupCode, courtCount: 4, rawImportText: '', mode: 'level',
        shuttleToolsEnabled: true, date: '2026-10-02',
      },
    });
    for (const id of idByName.values()) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: id } });
    await request(server).post(`/sessions/${sessionCode}/shuttle-details`).send({ shuttlePriceSatang: PRICE }).expect(201);
    const saveConfig = (over: Record<string, unknown> = {}) => request(server).post(`/sessions/${sessionCode}/bill-config`).send({
      model: 'perShuttle', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true,
      startingFeeSatang: START, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [], shuttleCharge: 'full', perPlayerShuttleSatang: CHARGE, ...over,
    }).expect(201);
    await saveConfig();

    // --- the night
    const startAt = Date.now();
    let round = 0;
    let courtCount = 4;
    let raised6 = false, raised8 = false, leftYet = false, walkedIn = false, rested = false;
    let restBackRound = 0, rejoinRound = 0, rejoinId = '';
    const walkIns: { id: string; at: number }[] = [];
    let ruleStep = 0;
    let toggled: Tracked | undefined;
    const resting: string[] = [];
    const leavers: { id: string; quote: number; expected: number; settledAfterRound: number }[] = [];
    const log: string[] = [];

    while (Date.now() - startAt < NIGHT_MS) {
      round++;
      await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);
      await assertNoDoubleBooking(`round ${round} after fill`);
      const confirmed = await confirmAll(round);
      await assertNoDoubleBooking(`round ${round} after confirm`);

      // raise courts while this round's games are still running (~1h, ~2h in)
      const elapsed = Date.now() - startAt;
      const target = !raised6 && elapsed > NIGHT_MS * 0.25 ? 6 : !raised8 && elapsed > NIGHT_MS * 0.5 ? 8 : 0;
      if (target) {
        const before = (await openPairings()).map((p) => [p.id, p.teamA, p.teamB, p.revision]);
        await request(server).post(`/sessions/${sessionCode}/court-count`).send({ courtCount: target }).expect(201);
        expect((await openPairings()).map((p) => [p.id, p.teamA, p.teamB, p.revision]), 'raising courts must not touch running games').toEqual(before);
        courtCount = target;
        if (target === 6) raised6 = true; else raised8 = true;
        // the new courts open up while the old ones are still playing
        await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);
        await assertNoDoubleBooking(`round ${round} after raising to ${target}`);
        await confirmAll(round + 100);
        await assertNoDoubleBooking(`round ${round} new courts confirmed`);
        log.push(`round ${round}: courts -> ${target}, open games ${(await openPairings()).length}`);
      }

      advance(Math.round((6 + rand() * 4) * 60_000)); // 6-10 minutes of "playing"
      const finished = await finishAll();
      log.push(`round ${round}: ${confirmed} confirmed, ${finished} finished on ${courtCount} courts`);

      // host edits rules while the night runs (rules-on run only)
      if (RULES_ON) {
        const el = Date.now() - startAt;
        const live = (kind: string) => tracked.filter((r) => r.tag === 'random' && r.kind === kind && r.off.length === 0);
        if (ruleStep === 0 && el > NIGHT_MS * 0.3) {
          ruleStep = 1;
          toggled = pick(live('never-same-court'));
          await request(server).post(`/sessions/${sessionCode}/rules/${toggled.id}/toggle`).send({ enabled: false }).expect(201);
          toggled.off.push({ from: Date.now(), to: Infinity });
          advance(1000);
          log.push(`round ${round}: session switched off never-same-court ${nameById.get(toggled.a)} / ${nameById.get(toggled.b)}`);
        } else if (ruleStep === 1 && el > NIGHT_MS * 0.45) {
          ruleStep = 2;
          // two players who were just on the same court / the same team get a rule now
          const done = await prisma.pairing.findMany({ where: { sessionId: sessionCode, endedAt: { not: null } }, orderBy: { endedAt: 'desc' }, take: 40 });
          const inCouple = new Set(tracked.filter((r) => r.kind === 'must-pair').flatMap((r) => [r.a, r.b]));
          for (const kind of ['never-same-court', 'never-teammates']) {
            for (;;) {
              const g = pick(done);
              const team = JSON.parse(rand() < 0.5 ? g.teamA : g.teamB) as string[];
              const [x, y] = kind === 'never-teammates' ? team : [team[0], pick(idsOf(g).filter((id) => !team.includes(id)))];
              if (inCouple.has(x) || inCouple.has(y) || hasRule(x, y)) continue;
              const added = await addRule(nameById.get(x)!, nameById.get(y)!, kind, 'midnight');
              added.off.push({ from: -Infinity, to: Date.now() });
              log.push(`round ${round}: host added ${kind} ${nameById.get(x)} / ${nameById.get(y)}`);
              break;
            }
          }
          advance(1000);
        } else if (ruleStep === 2 && el > NIGHT_MS * 0.5) {
          ruleStep = 3;
          toggled!.off[toggled!.off.length - 1].to = Date.now();
          await request(server).post(`/sessions/${sessionCode}/rules/${toggled!.id}/toggle`).send({ enabled: true }).expect(201);
          const doomed = pick(live('never-teammates'));
          await request(server).delete(`/groups/${groupCode}/rules/${doomed.id}`).expect(200);
          doomed.off.push({ from: Date.now(), to: Infinity });
          advance(1000);
          log.push(`round ${round}: switched that rule back on; host deleted never-teammates ${nameById.get(doomed.a)} / ${nameById.get(doomed.b)}`);
        }
      }

      // late arrivals, ~1h10 in: two tagged, one with no level at all
      if (!walkedIn && Date.now() - startAt > NIGHT_MS * 0.3) {
        walkedIn = true;
        const ladder = (await request(server).get(`/groups/${groupCode}/levels`).expect(200)).body;
        for (const [name, level] of [['วอล์คอิน1', 'N'], ['วอล์คอิน2', 'S'], ['วอล์คอิน3', undefined]] as const) {
          await request(server).post(`/sessions/${sessionCode}/roster`)
            .send({ name, ...(level ? { level } : {}), expectedLadderRevision: ladder.revision }).expect(201);
          const row = await prisma.player.findFirstOrThrow({ where: { groupId: groupCode, name } });
          idByName.set(name, row.id); nameById.set(row.id, name);
          if (level) levelOf.set(row.id, LADDER.indexOf(level));
          walkIns.push({ id: row.id, at: Date.now() });
        }
        advance(1000);
        log.push(`round ${round}: 3 walk-ins joined`);
      }

      // rest 5 (one half of a couple) for 2 rounds, ~1h35 in
      if (!rested && Date.now() - startAt > NIGHT_MS * 0.4) {
        rested = true;
        const pool = PLAYERS.map((x) => x.name).filter((n) => !['ปอง', 'ปลื้ม'].includes(n) && !MUST_PAIR.flat().includes(n));
        resting.push(idByName.get('ฟลุ๊ก')!);
        while (resting.length < 5) {
          const id = idByName.get(pick(pool))!;
          if (!resting.includes(id)) resting.push(id);
        }
        for (const id of resting) {
          await request(server).post(`/sessions/${sessionCode}/roster/${id}/active`).send({ active: false }).expect(201);
          goAway(id);
        }
        advance(1000);
        restBackRound = round + 2;
        log.push(`round ${round}: resting ${resting.map((id) => nameById.get(id)).join(', ')}`);
      }
      if (restBackRound && round === restBackRound) {
        for (const id of resting) {
          await request(server).post(`/sessions/${sessionCode}/roster/${id}/active`).send({ active: true }).expect(201);
          comeBack(id);
        }
        advance(1000);
        log.push(`round ${round}: rested players back`);
      }
      if (rejoinRound && round === rejoinRound) {
        const receipts = (await request(server).get(`/sessions/${sessionCode}/checkouts`).expect(200)).body as { id: string; playerId: string }[];
        await request(server).post(`/sessions/${sessionCode}/checkouts/${receipts.find((r) => r.playerId === rejoinId)!.id}/undo`).expect(201);
        comeBack(rejoinId);
        advance(1000);
        log.push(`round ${round}: ${nameById.get(rejoinId)} rejoined (checkout undone)`);
      }

      // early leavers, ~2h40 in, between rounds so nobody is on a court
      if (!leftYet && Date.now() - startAt > NIGHT_MS * 0.65) {
        leftYet = true;
        const o = await oracle();
        const candidates = [...idByName.values()].filter((id) => id !== idByName.get('ปอง') && id !== idByName.get('ปลื้ม'));
        const chosen = [idByName.get('ปอง')!];
        while (chosen.length < LEAVERS) {
          const id = pick(candidates);
          if (!chosen.includes(id)) chosen.push(id);
        }
        // the shared basis, checked while no receipt exists (the basis locks once one does)
        await saveConfig({ shuttleCharge: 'shared' });
        const sharedBill = (await request(server).get(`/sessions/${sessionCode}/bill`).expect(200)).body;
        const sharedRows = sharedBill.result.rows.filter((r: { status: string }) => r.status === 'billed') as { amountSatang: number }[];
        const distinct = new Set([...o.touched.values()].flatMap((x) => [...x])).size;
        const sharedTotal = sharedRows.reduce((a, r) => a + r.amountSatang, 0);
        expect(sharedRows).toHaveLength(67 + walkIns.length);
        expect(sharedTotal, 'shared basis must recover at least fees + real shuttle cost').toBeGreaterThanOrEqual(sharedRows.length * START + distinct * PRICE);
        const sharedQuote = (await request(server).post(`/sessions/${sessionCode}/checkouts/${chosen[1]}/preview`).send({ model: 'perShuttle' }).expect(201)).body;
        expect(sharedQuote.shuttleCharge).toBe('shared');
        expect(sharedQuote.amountSatang).toBeGreaterThanOrEqual(START);
        await saveConfig();
        log.push(`round ${round}: shared basis ok (total ${sharedTotal}, distinct shuttles ${distinct})`);

        for (const id of chosen) {
          const quote = (await request(server).post(`/sessions/${sessionCode}/checkouts/${id}/preview`).send({ model: 'perShuttle' }).expect(201)).body;
          const expected = START + (o.touched.get(id)?.size ?? 0) * CHARGE;
          expect(quote.amountSatang, `${nameById.get(id)} quote`).toBe(expected);
          await request(server).post(`/sessions/${sessionCode}/checkouts/${id}/confirm`)
            .send({ model: 'perShuttle', snapshotHash: quote.snapshotHash, idempotencyKey: randomUUID() }).expect(201);
          leavers.push({ id, quote: quote.amountSatang, expected, settledAfterRound: round });
          goAway(id);
        }
        advance(1000);
        rejoinId = chosen[1];
        rejoinRound = round + 3;
        log.push(`round ${round}: ${LEAVERS} early leavers settled`);
      }
    }
    console.log(['[level-night] timeline', ...log].join('\n  '));
    expect(raised6 && raised8 && leftYet && walkedIn && rested && rejoinRound > 0).toBe(true);
    if (RULES_ON) expect(ruleStep).toBe(3);

    // --- verdicts over every game played
    const { pairings } = await oracle();
    console.log(`[level-night] ${pairings.length} games, ${shuttleCount} new shuttles, final courts ${courtCount}`);
    expect(pairings.length).toBeGreaterThan(150);

    const brokenBandPairs = mustPair.filter(([a, b]) => Math.abs(levelOf.get(a)! - levelOf.get(b)!) > 1);
    const games = new Map<string, number>();
    const mustTogether = new Map<string, { together: number; apart: number }>();
    const bandViolations: string[] = [];
    const broken = { 'never-teammates': [] as string[], 'never-same-court': [] as string[], 'must-pair': [] as string[] };
    let singles = 0;

    for (const p of pairings) {
      const a = JSON.parse(p.teamA) as string[], b = JSON.parse(p.teamB) as string[];
      if (a.length !== 2 || b.length !== 2) singles++;
      const all = [...a, ...b];
      const t = p.confirmedAt!.getTime();
      for (const id of all) {
        games.set(id, (games.get(id) ?? 0) + 1);
        expect(isAbsent(id, t), `${nameById.get(id)} played while resting or checked out`).toBe(false);
      }
      const sameTeam = (x: string, y: string) => (a.includes(x) && a.includes(y)) || (b.includes(x) && b.includes(y));
      for (const r of tracked) {
        if (!inForce(r, t)) continue;
        const label = `${r.tag}: ${nameById.get(r.a)} / ${nameById.get(r.b)}`;
        const hasA = all.includes(r.a), hasB = all.includes(r.b);
        if (r.kind === 'never-teammates' && sameTeam(r.a, r.b)) broken[r.kind].push(label);
        if (r.kind === 'never-same-court' && hasA && hasB) broken[r.kind].push(label);
        if (r.kind === 'must-pair') {
          if (hasA && hasB && !sameTeam(r.a, r.b)) broken[r.kind].push(`${label} (same court, split)`);
          // a lone half is fine only while the other is away; sitting out while present is the unit waiting, not a play
          else if (hasA !== hasB && !isAbsent(hasA ? r.b : r.a, t)) broken[r.kind].push(`${label} (one played alone)`);
        }
      }
      for (const [x, y] of mustPair) {
        const key = `${nameById.get(x)}+${nameById.get(y)}`;
        const rec = mustTogether.get(key) ?? { together: 0, apart: 0 };
        if (sameTeam(x, y)) rec.together++;
        else if (all.includes(x) || all.includes(y)) rec.apart++;
        mustTogether.set(key, rec);
      }
      const lv = all.filter((id) => levelOf.has(id)).map((id) => levelOf.get(id)!);
      if (lv.length > 1 && Math.max(...lv) - Math.min(...lv) > 1) {
        const excused = brokenBandPairs.some(([x, y]) => all.includes(x) && all.includes(y));
        if (!excused) bandViolations.push(`${all.map((id) => `${nameById.get(id)}(${LADDER[levelOf.get(id)!] ?? '-'})`).join(' ')}`);
      }
    }
    const counts3 = Object.fromEntries(Object.entries(broken).map(([k, v]) => [k, v.length]));
    console.log(`[level-night] RULES ${RULES_ON ? 'ON' : 'OFF (control)'} -> rule breaks over ${pairings.length} games: ${JSON.stringify(counts3)}`);
    for (const [k, v] of Object.entries(broken)) if (v.length) console.log(`  ${k}: ${[...new Set(v)].slice(0, 8).join(' ; ')}`);
    if (RULES_ON) {
      expect(broken, 'a rule was broken while in force').toEqual({ 'never-teammates': [], 'never-same-court': [], 'must-pair': [] });
    } else {
      expect(Object.values(counts3).reduce((x, y) => x + y, 0), 'control run: without rules the engine should break some').toBeGreaterThan(0);
    }
    console.log('[level-night] must-pair together/apart:', JSON.stringify([...mustTogether]));
    console.log(`[level-night] band violations outside the two cross-band couples: ${bandViolations.length}`);
    if (bandViolations.length) console.log('  ' + bandViolations.slice(0, 15).join('\n  '));
    expect(singles).toBe(0);
    // The band is dominant but never a hard rule (docs/overview.md): a thin rung may force a wider court.
    const rate = bandViolations.length / pairings.length;
    console.log(`[level-night] band violation rate ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeLessThan(0.25);

    // everyone got on court at least once; spread is reported
    const counts = [...idByName.values()].map((id) => games.get(id) ?? 0);
    console.log(`[level-night] games per player: min ${Math.min(...counts)} max ${Math.max(...counts)}`);
    for (const id of idByName.values()) expect(games.get(id) ?? 0, `${nameById.get(id)} never played`).toBeGreaterThan(0);

    // leavers: frozen quote, no games after leaving, their partner is not stranded
    const checkouts = await prisma.sessionCheckout.findMany({ where: { sessionId: sessionCode, undoneAt: null } });
    expect(checkouts).toHaveLength(LEAVERS - 1); // one leaver rejoined
    for (const l of leavers.filter((x) => x.id !== rejoinId)) {
      const row = checkouts.find((c) => c.playerId === l.id)!;
      expect(row.amountSatang).toBe(l.quote);
      expect(row.amountSatang).toBe(l.expected);
    }
    const undone = await prisma.sessionCheckout.findFirstOrThrow({ where: { sessionId: sessionCode, playerId: rejoinId, undoneAt: { not: null } } });
    const backAt = undone.undoneAt!.getTime();
    expect(pairings.some((p) => p.confirmedAt!.getTime() > backAt && idsOf(p).includes(rejoinId)), `${nameById.get(rejoinId)} never played after rejoining`).toBe(true);
    for (const w of walkIns) {
      expect(pairings.some((p) => p.confirmedAt!.getTime() > w.at && idsOf(p).includes(w.id)), `${nameById.get(w.id)} never played after arriving`).toBe(true);
    }
    for (const id of resting) {
      const back = absent.get(id)![0].to;
      expect(pairings.some((p) => p.confirmedAt!.getTime() > back && idsOf(p).includes(id)), `${nameById.get(id)} never played after resting`).toBe(true);
    }
    const aoi = idByName.get('อ๊บ')!;
    const rest = absent.get(idByName.get('ฟลุ๊ก')!)![0];
    const during = pairings.filter((p) => p.confirmedAt!.getTime() > rest.from && p.confirmedAt!.getTime() < rest.to);
    console.log(`[level-night] while ฟลุ๊ก rested, partner อ๊บ played ${during.filter((p) => idsOf(p).includes(aoi)).length} of ${during.length} games`);
    const partner = idByName.get('ปลื้ม')!;
    console.log(`[level-night] leavers: ${leavers.map((l) => nameById.get(l.id)).join(', ')}`);
    const leaveTime = checkouts.find((c) => c.playerId === idByName.get('ปอง'))!.settledAt;
    const partnerAfter = pairings.filter((p) => p.confirmedAt! > leaveTime && idsOf(p).includes(partner)).length;
    console.log(`[level-night] ปลื้ม games after partner ปอง left: ${partnerAfter}`);
    expect(partnerAfter).toBeGreaterThan(0);

    // bill still balances: leavers settled, everybody else billed by the same basis
    const bill = (await request(server).get(`/sessions/${sessionCode}/bill`).expect(200)).body;
    const o = await oracle();
    const billed = new Map<string, number>(bill.result.rows.filter((r: { status: string }) => r.status === 'billed').map((r: { playerId: string; amountSatang: number }) => [r.playerId, r.amountSatang]));
    expect(billed.size).toBe(67 + walkIns.length - (LEAVERS - 1));
    for (const [id, amount] of billed) expect(amount, nameById.get(id)).toBe(START + (o.touched.get(id)?.size ?? 0) * CHARGE);
  }, 300_000);
});
