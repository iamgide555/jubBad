import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { GroupsModule } from './groups.module.js';

describe('custom level assignment', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `assign-admin-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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

  const CUSTOM = [
    { id: 'la', name: 'อ', startingElo: 1100 },
    { id: 'lb', name: 'บ', startingElo: 1400 },
  ];

  /** A group (standard unless `ladder`), one tagged + one untagged player, and one OPEN session for walk-ins. */
  async function fixture(opts: { ladder?: object[]; revision?: number; openSession?: boolean } = {}) {
    const code = randomUUID();
    await prisma.group.create({
      data: { code, name: 'Assign', ownerId: adminId, levelLadder: opts.ladder ? JSON.stringify(opts.ladder) : null, levelLadderRevision: opts.revision ?? 0 },
    });
    const tagged = await prisma.player.create({
      data: { groupId: code, name: 'Tagged', aliases: '[]', level: opts.ladder ? 'อ' : 'S', levelSeed: opts.ladder ? 1100 : 1100, levelSetAt: new Date('2026-09-01T00:00:00Z') },
    });
    const plain = await prisma.player.create({ data: { groupId: code, name: 'Plain', aliases: '[]' } });
    let sessionCode: string | null = null;
    if (opts.openSession) {
      sessionCode = randomUUID();
      await prisma.session.create({ data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' } });
    }
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.waitlist.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionCreation.deleteMany({ where: { groupId: code } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    const oneField = (playerId: string, body: object) => request(server).put(`/groups/${code}/players/${playerId}/level`).send(body);
    const edit = (playerId: string, body: object) => request(server).put(`/groups/${code}/players/${playerId}`).send(body);
    const walkIn = (body: object) => request(server).post(`/sessions/${sessionCode}/roster`).send(body);
    const createSession = (rosterReviews: object[], extra: object = {}) =>
      request(server).post('/sessions').send({
        groupCode: code, date: null, venue: null, courtCount: 1, rawImportText: 'x', idempotencyKey: randomUUID(),
        rosterReviews, waitlistReviews: [], ...extra,
      });
    const row = (id: string) => prisma.player.findUniqueOrThrow({ where: { id } });
    const counts = async () => ({
      players: await prisma.player.count({ where: { groupId: code } }),
      sessions: await prisma.session.count({ where: { groupId: code } }),
    });
    return { code, tagged, plain, sessionCode, cleanup, oneField, edit, walkIn, createSession, row, counts };
  }

  const review = (inputName: string, extra: object = {}, match: object = { type: 'new' }) => ({ inputName, decision: 'reject-new', match, ...extra });

  describe('one-field level edit (roster chip and dashboard panel)', () => {
    it('custom level assignment: a standard name saves its frozen seed and timestamp; a custom name saves the custom seed', async () => {
      const std = await fixture();
      const cus = await fixture({ ladder: CUSTOM, revision: 2 });
      try {
        const before = Date.now();
        await std.oneField(std.plain.id, { level: 'P', expectedLadderRevision: 0 }).expect(200);
        const a = await std.row(std.plain.id);
        expect(a).toMatchObject({ level: 'P', levelSeed: 1300 });
        expect(a.levelSetAt!.getTime()).toBeGreaterThanOrEqual(before);
        await cus.oneField(cus.plain.id, { level: 'บ', expectedLadderRevision: 2 }).expect(200);
        expect(await cus.row(cus.plain.id)).toMatchObject({ level: 'บ', levelSeed: 1400 });
      } finally {
        await std.cleanup();
        await cus.cleanup();
      }
    });

    it('level anchor: clearing reseeds 1200 with a new time; picking the same level after its seed was edited does nothing', async () => {
      const f = await fixture({ ladder: CUSTOM });
      try {
        await f.oneField(f.tagged.id, { level: null, expectedLadderRevision: 0 }).expect(200);
        expect(await f.row(f.tagged.id)).toMatchObject({ level: null, levelSeed: 1200 });
        await f.oneField(f.tagged.id, { level: 'อ', expectedLadderRevision: 0 }).expect(200);
        const tagged = await f.row(f.tagged.id);
        expect(tagged.levelSeed).toBe(1100);
        // The host edits 'อ' to a new seed; the player keeps what they were given.
        await request(server).put(`/groups/${f.code}/levels`).send({
          action: 'edit', expectedRevision: 0, levels: [{ id: 'la', name: 'อ', startingElo: 1250 }, { id: 'lb', name: 'บ', startingElo: 1400 }],
        }).expect(200);
        await f.oneField(f.tagged.id, { level: 'อ', expectedLadderRevision: 1 }).expect(200);
        const same = await f.row(f.tagged.id);
        expect(same.levelSeed).toBe(1100);
        expect(same.levelSetAt!.getTime()).toBe(tagged.levelSetAt!.getTime());
        // A deliberate change to another level uses that level's CURRENT seed.
        await f.oneField(f.tagged.id, { level: 'บ', expectedLadderRevision: 1 }).expect(200);
        expect((await f.row(f.tagged.id)).levelSeed).toBe(1400);
      } finally {
        await f.cleanup();
      }
    });

    it('level anchor: both rating tracks follow the new anchor only when someone is retagged, never when a seed is edited', async () => {
      const f = await fixture({ ladder: CUSTOM });
      try {
        const sess = randomUUID();
        await prisma.session.create({ data: { code: sess, groupId: f.code, courtCount: 1, rawImportText: '', endedAt: new Date() } });
        const partner = f.plain.id;
        await prisma.pairing.create({
          data: { sessionId: sess, courtNumber: 1, matchNumber: 1, teamA: JSON.stringify([f.tagged.id]), teamB: JSON.stringify([partner]),
            confirmedAt: new Date('2026-09-10T00:00:00Z'), endedAt: new Date('2026-09-10T00:30:00Z'), winner: 'A' },
        });
        const ratings = async () => (await request(server).get(`/groups/${f.code}/players/manage`).expect(200)).body.find((p: { id: string }) => p.id === f.tagged.id);
        const before = await ratings();
        await request(server).put(`/groups/${f.code}/levels`).send({
          action: 'edit', expectedRevision: 0, levels: [{ id: 'la', name: 'อ', startingElo: 1300 }, { id: 'lb', name: 'บ', startingElo: 1400 }],
        }).expect(200);
        const afterSeedEdit = await ratings();
        expect([afterSeedEdit.rating, afterSeedEdit.singlesRating]).toEqual([before.rating, before.singlesRating]);
        await f.oneField(f.tagged.id, { level: 'บ', expectedLadderRevision: 1 }).expect(200);
        const afterRetag = await ratings();
        expect(afterRetag.rating).toBe(1400);
        expect(afterRetag.singlesRating).toBe(1400);
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: missing or stale revision, a missing level key, an unknown name and another ladder\'s name are all refused with no write', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 3 });
      try {
        expect((await f.oneField(f.plain.id, { level: 'อ' }).expect(400)).body).toBeDefined();
        await f.oneField(f.plain.id, { expectedLadderRevision: 3 }).expect(400);
        expect((await f.oneField(f.plain.id, { level: 'อ', expectedLadderRevision: 2 }).expect(409)).body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.oneField(f.plain.id, { level: null, expectedLadderRevision: 2 }).expect(409)).body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.oneField(f.plain.id, { level: 'P', expectedLadderRevision: 3 }).expect(400)).body.code).toBe('LEVEL_UNKNOWN');
        expect(await f.row(f.plain.id)).toMatchObject({ level: null, levelSeed: null });
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: an old tab\'s "N" is refused after a switch to a custom ladder that is also named "N"', async () => {
      const f = await fixture();
      try {
        await request(server).put(`/groups/${f.code}/levels`).send({ action: 'customize', expectedRevision: 0, levels: [{ name: 'N', startingElo: 1150 }, { name: 'S', startingElo: 1250 }] }).expect(200);
        const res = await f.oneField(f.plain.id, { level: 'N', expectedLadderRevision: 0 }).expect(409);
        expect(res.body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.row(f.plain.id)).level).toBeNull();
        await f.oneField(f.plain.id, { level: 'N', expectedLadderRevision: 1 }).expect(200);
        expect((await f.row(f.plain.id)).levelSeed).toBe(1150);
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: two groups with the same label text keep their own seeds', async () => {
      const a = await fixture({ ladder: [{ id: 'x', name: 'Pro', startingElo: 1000 }] });
      const b = await fixture({ ladder: [{ id: 'y', name: 'Pro', startingElo: 1500 }] });
      try {
        await a.oneField(a.plain.id, { level: 'Pro', expectedLadderRevision: 0 }).expect(200);
        await b.oneField(b.plain.id, { level: 'Pro', expectedLadderRevision: 0 }).expect(200);
        expect((await a.row(a.plain.id)).levelSeed).toBe(1000);
        expect((await b.row(b.plain.id)).levelSeed).toBe(1500);
      } finally {
        await a.cleanup();
        await b.cleanup();
      }
    });
  });

  describe('group player edit', () => {
    it('custom level assignment: saves level, frozen seed and time; a contact-only edit leaves the tag alone; explicit null clears and reseeds', async () => {
      const f = await fixture({ ladder: CUSTOM });
      try {
        await f.edit(f.plain.id, { name: 'Plain', level: 'บ', expectedLadderRevision: 0 }).expect(200);
        expect(await f.row(f.plain.id)).toMatchObject({ level: 'บ', levelSeed: 1400 });
        const tagged = await f.row(f.tagged.id);
        await f.edit(f.tagged.id, { name: 'Tagged', phone: '0812345678' }).expect(200);
        const afterContact = await f.row(f.tagged.id);
        expect(afterContact).toMatchObject({ level: 'อ', levelSeed: 1100, phone: '0812345678' });
        expect(afterContact.levelSetAt!.getTime()).toBe(tagged.levelSetAt!.getTime());
        await f.edit(f.tagged.id, { name: 'Tagged', level: null, expectedLadderRevision: 0 }).expect(200);
        expect(await f.row(f.tagged.id)).toMatchObject({ level: null, levelSeed: 1200 });
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: a level without a current revision, or an unknown name, is refused and the rest of the row is not written', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 1 });
      try {
        await f.edit(f.plain.id, { name: 'Renamed', level: 'อ' }).expect(409);
        await f.edit(f.plain.id, { name: 'Renamed', level: 'อ', expectedLadderRevision: 0 }).expect(409);
        expect((await f.edit(f.plain.id, { name: 'Renamed', level: 'Q', expectedLadderRevision: 1 }).expect(400)).body.code).toBe('LEVEL_UNKNOWN');
        expect(await f.row(f.plain.id)).toMatchObject({ name: 'Plain', level: null });
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('roster review (session creation)', () => {
    it('custom level assignment: new and untagged-existing players get the custom level and seed; a tagged existing one is left alone', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 5 });
      try {
        const res = await f.createSession(
          [
            review('Newbie', { level: 'บ' }),
            review('Plain', { level: 'อ' }, { type: 'exact', playerId: f.plain.id }),
            { ...review('Tagged', { level: 'บ' }, { type: 'exact', playerId: f.tagged.id }), decision: 'accept' },
          ].map((r) => (r.inputName === 'Plain' ? { ...r, decision: 'accept' } : r)),
          { expectedLadderRevision: 5 }
        ).expect(201);
        expect(res.body.code).toBeDefined();
        expect(await f.row(f.plain.id)).toMatchObject({ level: 'อ', levelSeed: 1100 });
        expect(await f.row(f.tagged.id)).toMatchObject({ level: 'อ', levelSeed: 1100 });
        const newbie = await prisma.player.findFirstOrThrow({ where: { groupId: f.code, name: 'Newbie' } });
        expect(newbie).toMatchObject({ level: 'บ', levelSeed: 1400 });
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: a stale revision or unknown name creates no session, no player and no tag', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 2 });
      try {
        const before = await f.counts();
        const stale = await f.createSession([review('Newbie', { level: 'อ' })], { expectedLadderRevision: 1 }).expect(409);
        expect(stale.body.code).toBe('LEVEL_LADDER_STALE');
        const missing = await f.createSession([review('Newbie', { level: 'อ' })]).expect(409);
        expect(missing.body.code).toBe('LEVEL_LADDER_STALE');
        const unknown = await f.createSession([review('Newbie', { level: 'zz' })], { expectedLadderRevision: 2 }).expect(400);
        expect(unknown.body.code).toBe('LEVEL_UNKNOWN');
        expect(await f.counts()).toEqual(before);
        expect((await f.row(f.plain.id)).level).toBeNull();
      } finally {
        await f.cleanup();
      }
    });

    it('custom level assignment: a session with no level choice needs no revision', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 2 });
      try {
        await f.createSession([review('Newbie')]).expect(201);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('walk-in', () => {
    it('custom level assignment: a new walk-in takes the custom level with its seed; a stale or unknown one adds nobody', async () => {
      const f = await fixture({ ladder: CUSTOM, revision: 1, openSession: true });
      try {
        await f.walkIn({ name: 'Late', level: 'บ', expectedLadderRevision: 1 }).expect(201);
        const late = await prisma.player.findFirstOrThrow({ where: { groupId: f.code, name: 'Late' } });
        expect(late).toMatchObject({ level: 'บ', levelSeed: 1400 });
        const before = await f.counts();
        expect((await f.walkIn({ name: 'Old', level: 'บ', expectedLadderRevision: 0 }).expect(409)).body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.walkIn({ name: 'Old', level: 'บ' }).expect(409)).body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.walkIn({ name: 'Odd', level: 'P', expectedLadderRevision: 1 }).expect(400)).body.code).toBe('LEVEL_UNKNOWN');
        expect(await f.counts()).toEqual(before);
        await f.walkIn({ name: 'NoLevel' }).expect(201);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('group level race', () => {
    it('group level race: an assignment racing a ladder edit never leaves a label the final ladder does not contain', async () => {
      for (let round = 0; round < 6; round++) {
        const f = await fixture({ ladder: CUSTOM });
        try {
          const [assign, save] = await Promise.all([
            f.oneField(f.plain.id, { level: 'อ', expectedLadderRevision: 0 }),
            request(server).put(`/groups/${f.code}/levels`).send({
              action: 'edit', expectedRevision: 0, levels: [{ id: 'la', name: 'อใหม่', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1400 }],
            }),
          ]);
          expect([200, 409]).toContain(assign.status);
          expect(save.status).toBe(200);
          const finalNames = new Set(['อใหม่', 'บ']);
          const level = (await f.row(f.plain.id)).level;
          if (assign.status === 200) {
            // Assignment landed first, so the rename carried it along.
            expect(level).toBe('อใหม่');
          } else {
            expect(assign.body.code).toBe('LEVEL_LADDER_STALE');
            expect(level).toBeNull();
          }
          if (level !== null) expect(finalNames.has(level)).toBe(true);
        } finally {
          await f.cleanup();
        }
      }
    });
  });
});
