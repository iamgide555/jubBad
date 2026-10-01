/**
 * Scale smoke for host feedback F (group-owned level ladders): 60 players, 8 courts,
 * a six-level custom ladder. Ratings (both tracks) are compared across every ladder
 * operation, because the promise is that editing a ladder never moves earned Elo.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('smoke F: group level ladders at scale', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `smoke-f-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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

  const BUILT_IN = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
  const NAMES = ['มือใหม่', 'ปานกลาง', 'ดี', 'ดีมาก', 'เก่ง', 'เทพ'];

  it('60 players, 8 courts: ratings never move on switch, rename/swap, reorder, seed edit or reset; races stay consistent', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Smoke F', ownerId: adminId } });
    const long = new Date(Date.now() - 86_400_000);
    const players = [];
    for (let i = 0; i < 60; i++) {
      const level = BUILT_IN[i % 8];
      players.push(await prisma.player.create({
        data: { groupId: code, name: `P${String(i).padStart(2, '0')}`, aliases: '[]', level, levelSeed: 900 + 100 * (i % 8), levelSetAt: i % 5 === 0 ? null : long },
      }));
    }
    // One ended session with 60 finished matches (doubles and singles) so both rating tracks are non-trivial.
    const history = randomUUID();
    await prisma.session.create({ data: { code: history, groupId: code, courtCount: 8, rawImportText: '', endedAt: new Date() } });
    for (let g = 0; g < 60; g++) {
      const ids = [0, 1, 2, 3].map((k) => players[(g * 3 + k * 7) % 60].id);
      const singles = g % 4 === 0;
      await prisma.pairing.create({
        data: {
          sessionId: history, courtNumber: (g % 8) + 1, matchNumber: Math.floor(g / 8) + 1,
          teamA: JSON.stringify(singles ? [ids[0]] : ids.slice(0, 2)), teamB: JSON.stringify(singles ? [ids[1]] : ids.slice(2)),
          confirmedAt: new Date(Date.now() - 80_000_000 + g * 1000), endedAt: new Date(Date.now() - 79_000_000 + g * 1000), winner: g % 3 === 0 ? 'B' : 'A',
        },
      });
    }
    const levelsUrl = `/groups/${code}/levels`;
    const put = (body: object) => request(server).put(levelsUrl).send(body);
    const ratings = async () => {
      const body = (await request(server).get(`/groups/${code}/players/manage`).expect(200)).body as { id: string; rating: number; singlesRating: number | null }[];
      return Object.fromEntries(body.map((p) => [p.id, [p.rating, p.singlesRating]]));
    };
    const get = async () => (await request(server).get(levelsUrl).expect(200)).body;

    try {
      const base = await ratings();
      const log: string[] = [];

      // 1. switch to a six-level custom ladder: labels cleared, ratings untouched.
      let t = Date.now();
      await put({ action: 'customize', expectedRevision: 0, levels: NAMES.map((name, i) => ({ name, startingElo: 1000 + 100 * i })) }).expect(200);
      expect(await ratings()).toEqual(base);
      expect((await prisma.player.count({ where: { groupId: code, level: { not: null } } }))).toBe(0);
      log.push(`customize ${Date.now() - t}ms`);

      // 2. tag all 60 from the group's own ladder (each carries the revision it read).
      t = Date.now();
      let ladder = await get();
      for (const [i, p] of players.entries()) {
        await request(server).put(`/groups/${code}/players/${p.id}/level`).send({ level: NAMES[i % 6], expectedLadderRevision: ladder.revision }).expect(200);
      }
      log.push(`60 assignments ${Date.now() - t}ms`);
      const tagged = await ratings();
      ladder = await get();
      expect(Object.values(ladder.assignedCounts).reduce((a: number, b) => a + (b as number), 0)).toBe(60);

      // 3. rename + swap two names, reorder with re-spaced seeds, edit a seed: no rating moves, labels follow their ids.
      const ids = ladder.levels.map((l: { id: string }) => l.id);
      const before = Object.fromEntries((await prisma.player.findMany({ where: { groupId: code } })).map((p) => [p.id, p.level]));
      const swapped = ladder.levels.map((l: { id: string; name: string; startingElo: number }, i: number) => ({
        id: l.id,
        name: i === 0 ? ladder.levels[1].name : i === 1 ? ladder.levels[0].name : `${l.name}!`,
        startingElo: l.startingElo + (i === 4 ? 33 : 0),
      }));
      await put({ action: 'edit', expectedRevision: ladder.revision, levels: swapped }).expect(200);
      expect(await ratings()).toEqual(tagged);
      const after = Object.fromEntries((await prisma.player.findMany({ where: { groupId: code } })).map((p) => [p.id, p.level]));
      const nameOfId = (id: string, lv: { id: string; name: string }[]) => lv.find((l) => l.id === id)!.name;
      const oldLevels = ladder.levels;
      ladder = await get();
      for (const p of players) {
        const idBefore = oldLevels.find((l: { name: string }) => l.name === before[p.id]).id;
        expect(after[p.id], p.id).toBe(nameOfId(idBefore, ladder.levels));
      }
      void ids;
      // reorder: reverse the rungs keeping each level's id/name, re-spacing seeds so they increase.
      const reversed = [...ladder.levels].reverse().map((l: { id: string; name: string }, i: number) => ({ id: l.id, name: l.name, startingElo: 1100 + 100 * i }));
      await put({ action: 'edit', expectedRevision: ladder.revision, levels: reversed }).expect(200);
      expect(await ratings()).toEqual(tagged);

      // 4. an open session blocks every edit; level-mode fill on 8 courts follows the group's order.
      ladder = await get();
      const session = (await request(server).post('/sessions').send({
        groupCode: code, date: null, venue: null, courtCount: 8, rawImportText: 'x', idempotencyKey: randomUUID(),
        rosterReviews: players.map((p) => ({ inputName: p.name, decision: 'accept', match: { type: 'exact', playerId: p.id } })), waitlistReviews: [],
      }).expect(201)).body.code as string;
      await prisma.session.update({ where: { code: session }, data: { mode: 'level' } });
      expect((await put({ action: 'reset', expectedRevision: ladder.revision }).expect(409)).body.code).toBe('LEVEL_LADDER_ACTIVE_SESSION');
      t = Date.now();
      await request(server).post(`/sessions/${session}/courts/fill`).send({}).expect(201);
      log.push(`level-mode fill of 8 courts ${Date.now() - t}ms`);
      const order = ladder.levels.map((l: { name: string }) => l.name);
      const nowLevels = Object.fromEntries((await prisma.player.findMany({ where: { groupId: code } })).map((p) => [p.id, p.level as string]));
      const courts = await prisma.pairing.findMany({ where: { sessionId: session } });
      let inBand = 0;
      for (const c of courts) {
        const idx = [...JSON.parse(c.teamA), ...JSON.parse(c.teamB)].map((id: string) => order.indexOf(nowLevels[id]));
        expect(idx.every((i: number) => i >= 0)).toBe(true);
        if (Math.max(...idx) - Math.min(...idx) <= 1) inBand++;
      }
      expect(courts).toHaveLength(8);
      expect(inBand).toBeGreaterThanOrEqual(6);
      log.push(`${inBand}/8 courts inside the ±1 band by the group's order`);
      await prisma.pairing.deleteMany({ where: { sessionId: session } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: session } });
      await prisma.sessionCreation.deleteMany({ where: { groupId: code } });
      await prisma.session.delete({ where: { code: session } });

      // 5. race: 30 assignments against a rename; every final label is in the final ladder, refused ones changed nothing.
      ladder = await get();
      const target = ladder.levels[0];
      const race = await Promise.all([
        put({ action: 'edit', expectedRevision: ladder.revision, levels: ladder.levels.map((l: { id: string; name: string; startingElo: number }, i: number) => ({ ...l, name: i === 0 ? 'ใหม่เอี่ยม' : l.name })) }),
        ...players.slice(0, 30).map((p) => request(server).put(`/groups/${code}/players/${p.id}/level`).send({ level: target.name, expectedLadderRevision: ladder.revision })),
      ]);
      expect(race[0].status).toBe(200);
      const finalLadder = await get();
      const finalNames = new Set(finalLadder.levels.map((l: { name: string }) => l.name));
      const labels = (await prisma.player.findMany({ where: { groupId: code } })).map((p) => p.level);
      expect(labels.every((l) => l === null || finalNames.has(l))).toBe(true);
      const landed = race.slice(1).filter((r) => r.status === 200).length;
      const stale = race.slice(1).filter((r) => r.status === 409 && r.body.code === 'LEVEL_LADDER_STALE').length;
      expect(landed + stale).toBe(30);
      log.push(`race: ${landed} assignments landed before the rename, ${stale} refused as stale, 0 orphan labels`);

      // 6. reset: labels cleared, ratings still equal to what the last assignments produced.
      const beforeReset = await ratings();
      await put({ action: 'reset', expectedRevision: finalLadder.revision }).expect(200);
      expect(await ratings()).toEqual(beforeReset);

      // 7. export is truthful; public reads carry no level data.
      const exp = (await request(server).get(`/groups/${code}/export`).expect(200)).body;
      expect(exp.levelLadder.mode).toBe('standard');
      expect(exp.players.every((p: { levelSeed: number | null }) => typeof p.levelSeed === 'number')).toBe(true);
      for (const path of [`/groups/${code}`, `/groups/${code}/players`, `/groups/${code}/players/${players[0].id}/stats`]) {
        expect(JSON.stringify((await request(server).get(path).expect(200)).body), path).not.toMatch(/levelLadder|levelSeed|startingElo|"level"/);
      }
      console.log(`[smoke-f] 60 players / 8 courts: ${log.join('; ')}`);
    } finally {
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionCreation.deleteMany({ where: { groupId: code } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });
});
