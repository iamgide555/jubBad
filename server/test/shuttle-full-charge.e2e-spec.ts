import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { SESSION_SECRET } from '../src/auth/auth.module.js';
import { AuthBootstrapService } from '../src/auth/bootstrap.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';

const SECRET = 'e2e-shuttle-charge-secret';
const PASSWORD = 'a genuinely correct e2e password';
const PLAYERS = 50;
const COURTS = 6;
const ROUNDS = 8;
const CHARGE = 2000;
const PRICE = 8000;
const START = 1000;
const COURT_FEE = 60000;

type Court = { courtNumber: number; status: string; pairingId?: string; revision?: number };

/**
 * ตามลูกแบด "คิดเต็มต่อคน" with a 50-player night on the real app and engines.
 * The expected amount for each player is computed here from the database rows
 * alone (their finished games and the shuttles those games used), never from
 * the engine, so the engine, the route, the DTO and the checkout quote all have
 * to agree with an independent count.
 */
describe('full per-player shuttle charge with 50 players (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let cookie: string;
  let userId: string;
  let sessionCode: string;

  const groupCode = `e2e-${randomUUID().slice(0, 8)}`;
  const names = Array.from({ length: PLAYERS }, (_, i) => `ผู้เล่น${String(i + 1).padStart(2, '0')}`);
  const rosterText = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const authed = (r: request.Test) => r.set('Cookie', cookie);

  const billConfig = (over: Record<string, unknown> = {}) => ({
    model: 'perShuttle', courtFeeSatang: COURT_FEE, courtSplit: 'equal', shuttleSplit: 'byGames',
    perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true,
    startingFeeSatang: START, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
    addedIds: [], removedIds: [], overrides: [],
    shuttleCharge: 'full', perPlayerShuttleSatang: CHARGE, ...over,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    const email = `e2e-shuttle-${randomUUID()}@example.test`;
    userId = (await app.get(UsersService).create(email, PASSWORD)).id;
    const login = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];
  });

  afterAll(async () => {
    const where = { session: { groupId: groupCode } };
    await prisma.sessionCheckout.deleteMany({ where });
    await prisma.pairingShuttleUse.deleteMany({ where: { pairing: where } });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionShuttle.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.waitlist.deleteMany({ where });
    await prisma.sessionCreation.deleteMany({ where: { groupId: groupCode } });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const courtsOf = async () =>
    (await authed(request(server).get(`/sessions/${sessionCode}`)).expect(200)).body.courts as Court[];

  /** Every finished game's players and the distinct shuttles each player touched, read from the database only. */
  async function oracle() {
    const pairings = await prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: { not: null }, endedAt: { not: null } },
      include: { shuttleUses: true },
    });
    const touched = new Map<string, Set<string>>();
    const games = new Map<string, number>();
    for (const p of pairings) {
      const players = [...(JSON.parse(p.teamA) as string[]), ...(JSON.parse(p.teamB) as string[])];
      for (const id of players) {
        games.set(id, (games.get(id) ?? 0) + 1);
        const set = touched.get(id) ?? new Set<string>();
        for (const u of p.shuttleUses) set.add(u.shuttleId);
        touched.set(id, set);
      }
    }
    const distinctAll = new Set(pairings.flatMap((p) => p.shuttleUses.map((u) => u.shuttleId)));
    return { touched, games, distinctAll: distinctAll.size, pairings: pairings.length };
  }

  const getBill = async () => (await authed(request(server).get(`/sessions/${sessionCode}/bill`)).expect(200)).body;
  const saveConfig = async (over: Record<string, unknown> = {}) =>
    (await authed(request(server).post(`/sessions/${sessionCode}/bill-config`).send(billConfig(over))).expect(201)).body;
  const amountsOf = (bill: { result: { rows: { playerId: string; status: string; amountSatang: number }[] } }) =>
    new Map(bill.result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r.amountSatang]));

  it('plays a 50-player advanced night with new and reused shuttles', async () => {
    const parsed = await authed(
      request(server).post(`/groups/${groupCode}/parse`).send({ groupName: 'ก๊วนทดสอบ 50 คน', rawText: rosterText })
    ).expect(201);
    expect(parsed.body.rosterReviews).toHaveLength(PLAYERS);
    // The group exists after parse; the switch is snapshotted onto each new session.
    await authed(request(server).post(`/groups/${groupCode}/shuttle-tools`).send({ enabled: true })).expect(201);

    const created = await authed(
      request(server).post('/sessions').send({
        groupCode, date: '2026-10-02', venue: 'ยิมทดสอบ', courtCount: COURTS, rawImportText: rosterText,
        idempotencyKey: randomUUID(),
        rosterReviews: parsed.body.rosterReviews.map((r: { inputName: string; match: unknown }) => ({
          inputName: r.inputName, match: r.match, decision: 'accept',
        })),
        waitlistReviews: [],
      })
    ).expect(201);
    sessionCode = created.body.code as string;

    for (let round = 1; round <= ROUNDS; round++) {
      await authed(request(server).post(`/sessions/${sessionCode}/courts/fill`)).expect(201);
      const pending = (await courtsOf()).filter((c) => c.status === 'pending');
      expect(pending.length).toBe(COURTS);

      // Rounds 5-8 reuse each court's last shuttle when it is offered; rounds 1-4 always open a new one.
      const inventory =
        round > ROUNDS / 2
          ? (await authed(request(server).get(`/sessions/${sessionCode}/shuttles`)).expect(200)).body
          : null;
      for (const court of pending) {
        const last = inventory?.lastShuttleByCourt.find((c: { courtNumber: number }) => c.courtNumber === court.courtNumber);
        const shuttle = last ? { kind: 'existing', shuttleId: last.shuttleId } : { kind: 'new' };
        await authed(
          request(server)
            .post(`/sessions/${sessionCode}/pairings/${court.pairingId}/confirm`)
            .send({ expectedRevision: court.revision, shuttle })
        ).expect(201);
      }
      for (const court of (await courtsOf()).filter((c) => c.status === 'active')) {
        await authed(
          request(server)
            .post(`/sessions/${sessionCode}/pairings/${court.pairingId}/finish`)
            .send({ winner: 'A', expectedRevision: court.revision })
        ).expect(201);
      }
    }

    const o = await oracle();
    expect(o.pairings).toBe(ROUNDS * COURTS);
    // Shuttles really were reused: fewer distinct shuttles than games.
    expect(o.distinctAll).toBeLessThan(o.pairings);
  }, 240_000);

  it('bills every player startingFee + distinct shuttles touched x charge, matching an independent count', async () => {
    await authed(request(server).post(`/sessions/${sessionCode}/shuttle-details`).send({ shuttlePriceSatang: PRICE })).expect(201);
    await saveConfig();
    const o = await oracle();
    const bill = await getBill();
    const got = amountsOf(bill);

    expect(got.size).toBe(PLAYERS);
    let reusedSomewhere = false;
    for (const [playerId, set] of o.touched) {
      expect(got.get(playerId), `player ${playerId}`).toBe(START + set.size * CHARGE);
      if (set.size < (o.games.get(playerId) ?? 0)) reusedSomewhere = true;
    }
    // At least one player met the same shuttle twice, so the once-per-player rule was really exercised.
    expect(reusedSomewhere).toBe(true);

    // Margin: collected vs the REAL shuttle cost, never the charge.
    const collected = [...got.values()].reduce((a, b) => a + b, 0);
    expect(bill.result.totals.collectedSatang).toBe(collected);
    expect(bill.accounting.effectiveCount).toBe(o.distinctAll);
    expect(bill.result.totals.costSatang).toBe(COURT_FEE + o.distinctAll * PRICE);
    expect(bill.result.totals.marginSatang).toBe(collected - bill.result.totals.costSatang);
    expect(bill.readyToCopy).toBe(true);
  }, 60_000);

  it('a blank charge follows the shuttle price, and the switch round-trips', async () => {
    const o = await oracle();
    const full = amountsOf(await getBill());

    const blank = amountsOf(await saveConfig({ perPlayerShuttleSatang: null }).then(() => getBill()));
    for (const [playerId, set] of o.touched) expect(blank.get(playerId)).toBe(START + set.size * PRICE);

    const shared = amountsOf(await saveConfig({ shuttleCharge: 'shared' }).then(() => getBill()));
    const sharedTotal = [...shared.values()].reduce((a, b) => a + b, 0);
    expect(sharedTotal).toBeGreaterThanOrEqual(PLAYERS * START + o.distinctAll * PRICE);
    expect([...shared].some(([id, amount]) => amount !== full.get(id))).toBe(true);

    const back = amountsOf(await saveConfig().then(() => getBill()));
    expect([...back]).toEqual([...full]);
  }, 60_000);

  it('quotes an early leaver on the same basis and leaves the other 49 amounts alone', async () => {
    await saveConfig();
    const o = await oracle();
    const before = amountsOf(await getBill());
    const leaver = [...o.touched.keys()][0];

    const quote = (
      await authed(request(server).post(`/sessions/${sessionCode}/checkouts/${leaver}/preview`).send({ model: 'perShuttle' })).expect(201)
    ).body;
    expect(quote).toMatchObject({ shuttleCharge: 'full', chargeSatang: CHARGE });
    expect(quote.amountSatang).toBe(START + o.touched.get(leaver)!.size * CHARGE);
    expect(quote.amountSatang).toBe(before.get(leaver));

    await authed(
      request(server)
        .post(`/sessions/${sessionCode}/checkouts/${leaver}/confirm`)
        .send({ model: 'perShuttle', snapshotHash: quote.snapshotHash, idempotencyKey: randomUUID() })
    ).expect(201);

    const after = await getBill();
    const afterAmounts = amountsOf(after);
    expect(afterAmounts.has(leaver)).toBe(false);
    for (const [playerId, amount] of before) {
      if (playerId !== leaver) expect(afterAmounts.get(playerId), `player ${playerId}`).toBe(amount);
    }
    expect(after.result.totals.settledTotalSatang).toBe(quote.amountSatang);
    expect(after.result.totals.excessCreditSatang).toBe(0);
    expect(after.result.totals.uncoveredCostSatang).toBe(0);
  }, 60_000);
});
