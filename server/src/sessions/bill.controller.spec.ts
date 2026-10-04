import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('SessionsController (bill)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // This module has no AuthModule, so nothing ever sets req.user — create()
    // now reads it for the ownership check in SessionsService.createSession.
    // Standing in for AuthGuard here with a fixed admin caller keeps this file
    // about session/pairing logic, not auth; admin bypasses the check,
    // matching the behaviour these tests already assume.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'sessions-controller-test-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // supertest calls listen() itself for every request when the server is not
    // already listening. Under a few hundred requests that churn intermittently
    // produced "socket hang up" and bogus 501s that looked like app failures.
    // Listening once here keeps a single server for the file.
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const fixture = async (playerCount: number) => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = [];
    for (let i = 0; i < playerCount; i++) {
      players.push(await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const finishMatch = (ids: string[], matchNumber: number) =>
      prisma.pairing.create({
        data: {
          sessionId: sessionCode, courtNumber: 1, matchNumber,
          teamA: JSON.stringify(ids.slice(0, ids.length / 2)),
          teamB: JSON.stringify(ids.slice(ids.length / 2)),
          confirmedAt: new Date(), endedAt: new Date(), winner: 'A',
        },
      });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { groupCode, sessionCode, players, finishMatch, cleanup };
  };

  describe('walk-in mark', () => {
    it('marks a player added mid-session as walk-in', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).post(`/sessions/${sessionCode}/roster`).send({ name: 'Late' }).expect(201);
        const row = await prisma.sessionRoster.findUniqueOrThrow({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: res.body.playerId } },
        });
        expect(row.walkIn).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('toggles walk-in on and off, also after the session ended', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        const on = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: true }).expect(201);
        expect(on.body).toEqual({ playerId: players[0].id, walkIn: true });
        const off = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: false }).expect(201);
        expect(off.body.walkIn).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('404s for a player not on the roster, 400s on a bad body', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/roster/nope/walk-in`).send({ walkIn: true }).expect(404);
        expect(res.body.code).toBe('ROSTER_PLAYER_NOT_FOUND');
        await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: 'yes' }).expect(400);
      } finally {
        await cleanup();
      }
    });
  });

  describe('bill', () => {
    const baseConfig = {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 2000, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [],
    };

    it('returns defaults and an empty bill before anyone finished a match', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.configSource).toBe('default');
        expect(res.body.config.walkInFeeSatang).toBe(2000);
        expect(res.body.result.rows).toEqual([]);
        expect(res.body.players).toHaveLength(4);
      } finally {
        await cleanup();
      }
    });

    it('bills only confirmed + finished matches and applies the walk-in fee', async () => {
      const { sessionCode, players, finishMatch, cleanup } = await fixture(6);
      try {
        const ids = players.slice(0, 4).map((p) => p.id);
        await finishMatch(ids, 1);
        // pending (unconfirmed) and active (unfinished) must not count. Different
        // court numbers: both are "open" (endedAt null), and the DB's partial
        // unique index allows at most one open pairing per session+court.
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 1, matchNumber: 2,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]) } });
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 2, matchNumber: 3,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]), confirmedAt: new Date() } });
        await prisma.sessionRoster.update({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: ids[3] } }, data: { walkIn: true },
        });
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        expect(res.body.configSource).toBe('saved');
        const amounts = Object.fromEntries(res.body.result.rows.map((r: { playerId: string; amountSatang: number }) => [r.playerId, r.amountSatang]));
        const regular = Math.min(...Object.values(amounts) as number[]);
        expect(Object.keys(amounts).sort()).toEqual([...ids].sort());
        expect(amounts[ids[3]] - regular).toBe(2000);
        expect(res.body.result.totals.collectedSatang).toBe(20000);
        const again = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(again.body.config.courtFeeSatang).toBe(20000);
      } finally {
        await cleanup();
      }
    });

    it('prefills from the previous session without per-person entries', async () => {
      const { groupCode, sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          createdAt: new Date(Date.now() - 86400000),
          billConfig: JSON.stringify({ ...baseConfig, hostFeeSatang: 1000, addedIds: [players[0].id] }),
        } });
        const next = randomUUID();
        await prisma.session.create({ data: { code: next, groupId: groupCode, courtCount: 1, rawImportText: '' } });
        const res = await request(server).get(`/sessions/${next}/bill`).expect(200);
        expect(res.body.configSource).toBe('previous');
        expect(res.body.config.hostFeeSatang).toBe(1000);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('absentIds: an unplayed roster player pays the court share only; a stale tab that omits the field keeps it', async () => {
      const { sessionCode, players, finishMatch, cleanup } = await fixture(5);
      try {
        await finishMatch(players.slice(0, 4).map((p) => p.id), 1);
        const absentId = players[4].id;
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, courtFeeSatang: 50000, absentIds: [absentId] }).expect(201);
        expect(res.body.config.absentIds).toEqual([absentId]);
        const row = res.body.result.rows.find((r: { playerId: string }) => r.playerId === absentId);
        expect(row).toMatchObject({ absent: true, shuttleSatang: 0, courtSatang: 10000, amountSatang: 10000 });
        const stale = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, courtFeeSatang: 50000 }).expect(201);
        expect(stale.body.config.absentIds).toEqual([absentId]);
        const off = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, absentIds: ['stranger'] }).expect(400);
        expect(off.body.code).toBe('BILL_PLAYER_NOT_ON_ROSTER');
      } finally {
        await cleanup();
      }
    });

    it('works after the session ended; rejects off-roster ids and bad bodies', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        const off = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, addedIds: ['stranger'] }).expect(400);
        expect(off.body.code).toBe('BILL_PLAYER_NOT_ON_ROSTER');
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, hostFeeSatang: -1 }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, model: 'free' }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, roundingBaht: 3 }).expect(400);
      } finally {
        await cleanup();
      }
    });

    it('ignores a stale saved id for a player no longer on the roster', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          billConfig: JSON.stringify({ ...baseConfig, addedIds: ['gone'] }),
        } });
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('404s for an unknown session', async () => {
      await request(server).get(`/sessions/${randomUUID()}/bill`).expect(404);
    });
  });

  describe('shuttle bill and bill ready', () => {
    const cfg = (over: Record<string, unknown> = {}) => ({
      model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [], ...over,
    });

    /** An advanced session with finished games whose shuttle logs are set per game. */
    async function night(opts: { advanced?: boolean; physical?: number | null; price?: number | null } = {}) {
      const { advanced = true, physical = null, price = 1000 } = opts;
      const base = await fixture(8);
      await prisma.session.update({
        where: { code: base.sessionCode },
        data: { shuttleToolsEnabled: advanced, shuttleCount: physical, shuttlePriceSatang: price },
      });
      const shuttles: string[] = [];
      const shuttle = async (number: number, extra: Record<string, unknown> = {}) => {
        const created = await prisma.sessionShuttle.create({ data: { sessionId: base.sessionCode, number, ...extra } });
        shuttles.push(created.id);
        return created.id;
      };
      /** `log`: undefined = unknown, array = known list of shuttle ids. */
      const game = async (playerIdx: number[], matchNumber: number, log?: string[]) => {
        const created = await base.finishMatch(playerIdx.map((i) => base.players[i].id), matchNumber);
        if (log !== undefined) {
          await prisma.pairing.update({ where: { id: created.id }, data: { shuttleLogKnown: true } });
          for (const shuttleId of log) await prisma.pairingShuttleUse.create({ data: { pairingId: created.id, shuttleId } });
        }
        return created;
      };
      const saveConfig = (over: Record<string, unknown> = {}) =>
        request(server).post(`/sessions/${base.sessionCode}/bill-config`).send(cfg(over)).expect(201);
      const bill = async () => (await request(server).get(`/sessions/${base.sessionCode}/bill`).expect(200)).body;
      const cleanup = async () => {
        await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: base.sessionCode } } });
        await prisma.pairing.deleteMany({ where: { sessionId: base.sessionCode } });
        await prisma.sessionShuttle.deleteMany({ where: { sessionId: base.sessionCode } });
        await base.cleanup();
      };
      return { ...base, shuttle, game, saveConfig, bill, cleanup };
    }
    const shuttleSum = (b: { result: { rows: { shuttleSatang: number }[] } }) => b.result.rows.reduce((t, r) => t + r.shuttleSatang, 0);

    it('perShuttle full: bills each player the charge for every distinct shuttle they touched', async () => {
      const n = await night({ price: 5000 });
      try {
        const s1 = await n.shuttle(1);
        const s3 = await n.shuttle(3);
        const s4 = await n.shuttle(4);
        await n.game([0, 1, 2, 3], 1, [s1]);
        await n.game([0, 4, 5, 6], 2, [s3, s4]);
        await n.saveConfig({
          model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: 8000, startingFeeSatang: 1000, hostFeeSatang: 500,
        });
        const b = await n.bill();
        const amount = (i: number) => b.result.rows.find((r: { playerId: string }) => r.playerId === n.players[i].id).amountSatang;
        expect(amount(0)).toBe(1000 + 3 * 8000 + 500);
        expect(amount(1)).toBe(1000 + 8000 + 500);
        expect(amount(4)).toBe(1000 + 2 * 8000 + 500);
        expect(b.config).toMatchObject({ shuttleCharge: 'full', perPlayerShuttleSatang: 8000 });
      } finally {
        await n.cleanup();
      }
    });

    it('perShuttle full with a blank charge follows the session shuttle price', async () => {
      const n = await night({ price: 5000 });
      try {
        const s1 = await n.shuttle(1);
        await n.game([0, 1, 2, 3], 1, [s1]);
        await n.saveConfig({ model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: null, startingFeeSatang: 0 });
        const b = await n.bill();
        expect(b.result.rows.find((r: { playerId: string }) => r.playerId === n.players[0].id).amountSatang).toBe(5000);
        expect(b.config.perPlayerShuttleSatang).toBeNull();
      } finally {
        await n.cleanup();
      }
    });

    it('an old client that omits the new fields still saves, as shared', async () => {
      const n = await night();
      try {
        const res = await n.saveConfig({ model: 'perShuttle' });
        expect(res.body.config).toMatchObject({ shuttleCharge: 'shared', perPlayerShuttleSatang: null });
      } finally {
        await n.cleanup();
      }
    });

    it('an old client that omits the new fields keeps a stored full basis and charge', async () => {
      const n = await night();
      try {
        await n.saveConfig({ model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: 2000 });
        const res = await n.saveConfig({ model: 'perShuttle', hostFeeSatang: 500 });
        expect(res.body.config).toMatchObject({ shuttleCharge: 'full', perPlayerShuttleSatang: 2000, hostFeeSatang: 500 });
        // An explicit null still clears the charge.
        const cleared = await n.saveConfig({ model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: null });
        expect(cleared.body.config.perPlayerShuttleSatang).toBeNull();
      } finally {
        await n.cleanup();
      }
    });

    it('rejects an unknown switch, a negative charge and a fractional charge', async () => {
      const n = await night();
      try {
        const post = (over: Record<string, unknown>) =>
          request(server).post(`/sessions/${n.sessionCode}/bill-config`).send(cfg({ model: 'perShuttle', ...over }));
        await post({ shuttleCharge: 'bogus' }).expect(400);
        await post({ perPlayerShuttleSatang: -1 }).expect(400);
        await post({ perPlayerShuttleSatang: 10.5 }).expect(400);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: two games sharing #1 with no physical count bill one shuttle', async () => {
      const n = await night();
      try {
        const one = await n.shuttle(1);
        await n.game([0, 1, 2, 3], 1, [one]);
        await n.game([4, 5, 6, 7], 2, [one]);
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting).toMatchObject({ recordedFinishedShuttles: 1, unknownFinishedMatches: 0, finishedMatches: 2, physicalCount: null, effectiveCount: 1, source: 'games', allocation: 'identities' });
        expect(shuttleSum(b)).toBe(1000);
        expect(b.readyToCopy).toBe(true);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: a physical count overrides the derived count without rewriting any use', async () => {
      const n = await night({ physical: 3 });
      try {
        const one = await n.shuttle(1);
        await n.game([0, 1, 2, 3], 1, [one]);
        await n.game([4, 5, 6, 7], 2, [one]);
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting).toMatchObject({ recordedFinishedShuttles: 1, physicalCount: 3, effectiveCount: 3, source: 'physical' });
        expect(shuttleSum(b)).toBe(3000);
        expect(await prisma.pairingShuttleUse.count({ where: { shuttleId: one } })).toBe(2);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: a known-empty finished game with no physical count bills zero and is ready', async () => {
      const n = await night();
      try {
        await n.game([0, 1, 2, 3], 1, []);
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting).toMatchObject({ effectiveCount: 0, source: 'games' });
        expect(shuttleSum(b)).toBe(0);
        expect(b.readyToCopy).toBe(true);
      } finally {
        await n.cleanup();
      }
    });

    it('bill ready: no finished games and no physical count blocks a shuttle bill; so does an unknown game', async () => {
      const empty = await night();
      const unknown = await night();
      try {
        await empty.saveConfig();
        const eb = await empty.bill();
        expect(eb.accounting.source).toBe('missing');
        expect(eb.accounting.finishedMatches).toBe(0);
        expect(eb.result.warnings).toContain('MISSING_SHUTTLE_COUNT');
        expect(eb.readyToCopy).toBe(false);

        await unknown.game([0, 1, 2, 3], 1); // legacy unknown log
        await unknown.saveConfig();
        const ub = await unknown.bill();
        expect(ub.accounting).toMatchObject({ unknownFinishedMatches: 1, source: 'missing' });
        expect(ub.readyToCopy).toBe(false);
      } finally {
        await empty.cleanup();
        await unknown.cleanup();
      }
    });

    it('shuttle bill: an unknown game with a physical count uses the old equal-per-match split and says so', async () => {
      const n = await night({ physical: 2 });
      try {
        const one = await n.shuttle(1);
        await n.game([0, 1, 2, 3], 1, [one]);
        await n.game([4, 5, 6, 7], 2); // unknown
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting).toMatchObject({ allocation: 'legacy-unknown', source: 'physical', unknownFinishedMatches: 1 });
        expect(shuttleSum(b)).toBe(2000);
        expect(b.result.rows.map((r: { shuttleSatang: number }) => r.shuttleSatang)).toEqual([250, 250, 250, 250, 250, 250, 250, 250]);
        expect(b.readyToCopy).toBe(true);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: known games that reference nothing fall back to equal-per-match when the physical count is positive', async () => {
      const n = await night({ physical: 2 });
      try {
        await n.game([0, 1, 2, 3], 1, []);
        await n.game([4, 5, 6, 7], 2, []);
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting.allocation).toBe('legacy-no-uses');
        expect(shuttleSum(b)).toBe(2000);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: an ordinary session always uses its physical count and the legacy split', async () => {
      const n = await night({ advanced: false, physical: 4 });
      try {
        await n.game([0, 1, 2, 3], 1);
        await n.game([4, 5, 6, 7], 2);
        await n.saveConfig();
        const b = await n.bill();
        expect(b.accounting).toMatchObject({ source: 'ordinary', physicalCount: 4, effectiveCount: 4, allocation: 'legacy-basic', recordedFinishedShuttles: 0 });
        expect(shuttleSum(b)).toBe(4000);
        expect(b.readyToCopy).toBe(true);
      } finally {
        await n.cleanup();
      }
    });

    it('bill ready: perGame and buffet-with-shuttles-included copy with no shuttle count or price', async () => {
      const n = await night({ price: null });
      try {
        await n.game([0, 1, 2, 3], 1, []);
        await n.saveConfig({ model: 'perGame', perGameRateSatang: 5000 });
        expect((await n.bill()).readyToCopy).toBe(true);
        await n.saveConfig({ model: 'buffet', buffetPriceSatang: 8000, buffetShuttlesIncluded: true });
        expect((await n.bill()).readyToCopy).toBe(true);
        await n.saveConfig({ model: 'buffet', buffetPriceSatang: 8000, buffetShuttlesIncluded: false });
        expect((await n.bill()).readyToCopy).toBe(false);
      } finally {
        await n.cleanup();
      }
    });

    it('bill ready: fair needs a court fee and a shuttle price, but explicit zeroes are complete', async () => {
      const n = await night({ price: null, physical: 0 });
      try {
        await n.game([0, 1, 2, 3], 1, []);
        await n.saveConfig({ courtFeeSatang: null });
        const missing = await n.bill();
        expect(missing.result.warnings).toEqual(expect.arrayContaining(['MISSING_COURT_FEE', 'MISSING_SHUTTLE_PRICE']));
        expect(missing.readyToCopy).toBe(false);

        await prisma.session.update({ where: { code: n.sessionCode }, data: { shuttlePriceSatang: 0 } });
        await n.saveConfig({ courtFeeSatang: 0 });
        const zeroes = await n.bill();
        expect(zeroes.result.warnings).toEqual([]);
        expect(zeroes.readyToCopy).toBe(true);
      } finally {
        await n.cleanup();
      }
    });

    it('shuttle bill: a bill read racing a correction never mixes the old uses with the new count', async () => {
      const n = await night({ physical: null });
      try {
        const one = await n.shuttle(1);
        const two = await n.shuttle(2);
        const g1 = await n.game([0, 1, 2, 3], 1, [one]);
        await n.saveConfig();
        let revision = g1.revision;
        for (let i = 0; i < 6; i++) {
          const target = i % 2 === 0 ? [one, two] : [one];
          const [b, fix] = await Promise.all([
            n.bill(),
            request(server).post(`/sessions/${n.sessionCode}/pairings/${g1.id}/shuttles/correct`).send({ shuttleIds: target, openNew: false, expectedRevision: revision }),
          ]);
          // Whatever snapshot the read saw, its money must match its own count.
          expect(shuttleSum(b)).toBe(b.accounting.effectiveCount * 1000);
          expect(b.accounting.recordedFinishedShuttles).toBe(b.accounting.effectiveCount);
          expect(fix.status).toBe(201);
          revision = fix.body.revision;
        }
      } finally {
        await n.cleanup();
      }
    });
  });

  describe('per shuttle model', () => {
    const cfg = (over: Record<string, unknown> = {}) => ({
      model: 'perShuttle', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      startingFeeSatang: 3000, addedIds: [], removedIds: [], overrides: [], ...over,
    });
    const setAdvanced = (code: string, on: boolean) =>
      prisma.session.update({ where: { code }, data: { shuttleToolsEnabled: on } });

    it('an advanced session accepts perShuttle with a starting fee and bills it', async () => {
      const { sessionCode, players, finishMatch, cleanup } = await fixture(4);
      try {
        await setAdvanced(sessionCode, true);
        await finishMatch(players.map((p) => p.id), 1);
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`).send(cfg()).expect(201);
        expect(res.body.config).toMatchObject({ model: 'perShuttle', startingFeeSatang: 3000 });
        expect(res.body.result.rows.map((r: { amountSatang: number }) => r.amountSatang)).toEqual([3000, 3000, 3000, 3000]);
      } finally {
        await cleanup();
      }
    });

    it('an ordinary session refuses perShuttle, even if the group switch is on now', async () => {
      const { sessionCode, groupCode, cleanup } = await fixture(4);
      try {
        await prisma.group.update({ where: { code: groupCode }, data: { shuttleToolsEnabled: true } });
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`).send(cfg()).expect(400);
        expect(res.body.code).toBe('BILL_MODEL_NOT_ALLOWED');
        expect((await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } })).billConfig).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('rejects a negative or fractional starting fee and a body missing it', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await setAdvanced(sessionCode, true);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(cfg({ startingFeeSatang: -1 })).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(cfg({ startingFeeSatang: 10.5 })).expect(400);
        const { startingFeeSatang: _drop, ...without } = cfg();
        void _drop;
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(without).expect(400);
      } finally {
        await cleanup();
      }
    });

    /** Old sessions in the same group, oldest first, each with a saved config. */
    async function history(groupCode: string, saved: { model: string; advanced: boolean; extra?: Record<string, unknown> }[]) {
      const codes: string[] = [];
      for (const [i, h] of saved.entries()) {
        const code = randomUUID();
        codes.push(code);
        await prisma.session.create({
          data: {
            code, groupId: groupCode, courtCount: 1, rawImportText: '', shuttleToolsEnabled: h.advanced,
            createdAt: new Date(Date.UTC(2020, 0, 1 + i)), billConfig: JSON.stringify(cfg({ model: h.model, ...h.extra })),
          },
        });
      }
      return codes;
    }

    it('a new ordinary session skips an advanced perShuttle config and uses the newest eligible one', async () => {
      const { sessionCode, groupCode, cleanup } = await fixture(4);
      try {
        await history(groupCode, [
          { model: 'buffet', advanced: false, extra: { buffetPriceSatang: 9000 } },
          { model: 'perShuttle', advanced: true },
        ]);
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config.model).toBe('buffet');
        expect(res.body.configSource).toBe('previous');
      } finally {
        await cleanup();
      }
    });

    it('falls back to the ordinary default when only perShuttle configs exist', async () => {
      const { sessionCode, groupCode, cleanup } = await fixture(4);
      try {
        await history(groupCode, [{ model: 'perShuttle', advanced: true }, { model: 'perShuttle', advanced: true }]);
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config.model).toBe('fair');
        expect(res.body.configSource).toBe('default');
      } finally {
        await cleanup();
      }
    });

    it('a new advanced session may inherit perShuttle and its starting fee', async () => {
      const { sessionCode, groupCode, cleanup } = await fixture(4);
      try {
        await setAdvanced(sessionCode, true);
        await history(groupCode, [{ model: 'perShuttle', advanced: true, extra: { startingFeeSatang: 4200 } }]);
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config).toMatchObject({ model: 'perShuttle', startingFeeSatang: 4200 });
      } finally {
        await cleanup();
      }
    });
  });
});
