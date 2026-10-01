import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { GroupsModule } from './groups.module.js';

describe('group levels editor', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `levels-admin-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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

  const SET_AT = new Date('2026-09-20T00:00:00.000Z');

  /** A group with tagged players (frozen seeds + times) and one ended session with a finished match. */
  async function fixture(opts: { ladder?: object[] | null; revision?: number } = {}) {
    const code = randomUUID();
    await prisma.group.create({
      data: {
        code, name: 'Lv', ownerId: adminId,
        levelLadder: opts.ladder ? JSON.stringify(opts.ladder) : null,
        levelLadderRevision: opts.revision ?? 0,
      },
    });
    const mk = (name: string, level: string | null, levelSeed: number | null, levelSetAt: Date | null) =>
      prisma.player.create({ data: { groupId: code, name, aliases: '[]', level, levelSeed, levelSetAt } });
    const players = {
      a: await mk('A', opts.ladder ? 'อ' : 'BG', opts.ladder ? 1100 : 900, SET_AT),
      b: await mk('B', opts.ladder ? 'บ' : 'P', opts.ladder ? 1300 : 1300, null),
      c: await mk('C', null, 1200, SET_AT),
      d: await mk('D', null, null, null),
    };
    const sessionCode = randomUUID();
    await prisma.session.create({ data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '', endedAt: new Date() } });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode, courtNumber: 1, matchNumber: 1,
        teamA: JSON.stringify([players.a.id, players.c.id]), teamB: JSON.stringify([players.b.id, players.d.id]),
        confirmedAt: new Date(), endedAt: new Date(), winner: 'A',
      },
    });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionCreation.deleteMany({ where: { groupId: code } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    const get = () => request(server).get(`/groups/${code}/levels`);
    const put = (body: object) => request(server).put(`/groups/${code}/levels`).send(body);
    const row = (id: string) => prisma.player.findUniqueOrThrow({ where: { id } });
    const ratings = async () => {
      const res = await request(server).get(`/groups/${code}/players/manage`).expect(200);
      return Object.fromEntries(res.body.map((p: { id: string; rating: number; singlesRating: number | null }) => [p.id, [p.rating, p.singlesRating]]));
    };
    return { code, players, sessionCode, cleanup, get, put, row, ratings };
  }

  const three = [
    { name: 'มือใหม่', startingElo: 1100 },
    { name: 'กลาง', startingElo: 1200 },
    { name: 'เก่ง', startingElo: 1300 },
  ];

  describe('group levels read', () => {
    it('a standard group lists the eight built-in levels with assigned counts, including zeros, at revision 0', async () => {
      const f = await fixture();
      try {
        const res = await f.get().expect(200);
        expect(res.body.mode).toBe('standard');
        expect(res.body.revision).toBe(0);
        expect(res.body.levels).toHaveLength(8);
        expect(res.body.levels[0]).toEqual({ id: 'standard:BG', name: 'BG', startingElo: 900 });
        expect(res.body.assignedCounts).toMatchObject({ 'standard:BG': 1, 'standard:P': 1, 'standard:N': 0, 'standard:B': 0 });
      } finally {
        await f.cleanup();
      }
    });

    it('a corrupt stored ladder is an explicit data-integrity error, not the standard ladder', async () => {
      const f = await fixture();
      try {
        await prisma.group.update({ where: { code: f.code }, data: { levelLadder: '{broken' } });
        const res = await f.get().expect(500);
        expect(res.body.code).toBe('LEVEL_LADDER_CORRUPT');
      } finally {
        await f.cleanup();
      }
    });

    it('an assigned label the ladder does not contain is surfaced, never read as untagged', async () => {
      const f = await fixture();
      try {
        await prisma.player.update({ where: { id: f.players.a.id }, data: { level: 'ZZ' } });
        const res = await f.get().expect(500);
        expect(res.body.code).toBe('LEVEL_DATA_INTEGRITY');
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('group levels customize and reset', () => {
    it('customize clears labels only: seeds, times, history and both ratings are untouched', async () => {
      const f = await fixture();
      try {
        const before = await f.ratings();
        const res = await f.put({ action: 'customize', expectedRevision: 0, levels: three }).expect(200);
        expect(res.body.mode).toBe('custom');
        expect(res.body.revision).toBe(1);
        expect(res.body.levels.map((l: { name: string }) => l.name)).toEqual(['มือใหม่', 'กลาง', 'เก่ง']);
        expect(res.body.levels.every((l: { id: string }) => typeof l.id === 'string' && l.id.length > 0)).toBe(true);
        expect(Object.values(res.body.assignedCounts)).toEqual([0, 0, 0]);
        for (const p of Object.values(f.players)) {
          const after = await f.row(p.id);
          expect(after.level).toBeNull();
          expect(after.levelSeed).toBe(p.levelSeed);
          expect(after.levelSetAt?.getTime() ?? null).toBe(p.levelSetAt?.getTime() ?? null);
        }
        expect(await f.ratings()).toEqual(before);
      } finally {
        await f.cleanup();
      }
    });

    it('reset returns to the standard ladder the same way, even when the custom names look identical', async () => {
      const f = await fixture({ ladder: [{ id: 'x1', name: 'อ', startingElo: 1100 }, { id: 'x2', name: 'บ', startingElo: 1300 }] });
      try {
        const before = await f.ratings();
        const res = await f.put({ action: 'reset', expectedRevision: 0 }).expect(200);
        expect(res.body.mode).toBe('standard');
        expect(res.body.revision).toBe(1);
        expect(res.body.levels).toHaveLength(8);
        expect((await prisma.group.findUniqueOrThrow({ where: { code: f.code } })).levelLadder).toBeNull();
        expect((await f.row(f.players.a.id)).level).toBeNull();
        expect((await f.row(f.players.a.id)).levelSeed).toBe(1100);
        expect(await f.ratings()).toEqual(before);
      } finally {
        await f.cleanup();
      }
    });

    it('customizing with the built-in names still counts as a first switch and clears labels', async () => {
      const f = await fixture();
      try {
        const same = [{ name: 'BG', startingElo: 900 }, { name: 'N', startingElo: 1000 }];
        await f.put({ action: 'customize', expectedRevision: 0, levels: same }).expect(200);
        expect((await f.row(f.players.a.id)).level).toBeNull();
      } finally {
        await f.cleanup();
      }
    });

    it('a standard group is unchanged until an explicit customize', async () => {
      const f = await fixture();
      try {
        await f.get().expect(200);
        expect((await f.row(f.players.a.id)).level).toBe('BG');
        expect((await prisma.group.findUniqueOrThrow({ where: { code: f.code } })).levelLadderRevision).toBe(0);
      } finally {
        await f.cleanup();
      }
    });

    it('customize wants new levels without ids; edit and reset are refused in the wrong mode', async () => {
      const f = await fixture();
      try {
        await f.put({ action: 'customize', expectedRevision: 0, levels: [{ id: 'standard:BG', name: 'x', startingElo: 1000 }] }).expect(400);
        await f.put({ action: 'customize', expectedRevision: 0 }).expect(400);
        await f.put({ action: 'edit', expectedRevision: 0, levels: three }).expect(400);
        await f.put({ action: 'reset', expectedRevision: 0 }).expect(400);
        await f.put({ action: 'customize', expectedRevision: 0, levels: three }).expect(200);
        await f.put({ action: 'customize', expectedRevision: 1, levels: three }).expect(400);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('group levels edit', () => {
    const ladder = [{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }];

    it('renaming updates assigned labels and swapping two names in one save loses neither group; anchors do not move', async () => {
      const f = await fixture({ ladder });
      try {
        const before = await f.ratings();
        const res = await f.put({
          action: 'edit', expectedRevision: 0,
          levels: [{ id: 'la', name: 'บ', startingElo: 1100 }, { id: 'lb', name: 'อ', startingElo: 1300 }],
        }).expect(200);
        expect(res.body.revision).toBe(1);
        const a = await f.row(f.players.a.id);
        const b = await f.row(f.players.b.id);
        expect(a.level).toBe('บ'); // was 'อ' (id la), la is now called บ
        expect(b.level).toBe('อ');
        expect(a.levelSeed).toBe(1100);
        expect(b.levelSeed).toBe(1300);
        expect(a.levelSetAt?.getTime()).toBe(SET_AT.getTime());
        expect(await f.ratings()).toEqual(before);
        expect(res.body.assignedCounts).toEqual({ la: 1, lb: 1 });
      } finally {
        await f.cleanup();
      }
    });

    it('reorder and seed edits keep assigned players\' anchors; adding a level assigns nobody', async () => {
      const f = await fixture({ ladder });
      try {
        const before = await f.ratings();
        const res = await f.put({
          action: 'edit', expectedRevision: 0,
          levels: [{ id: 'lb', name: 'บ', startingElo: 900 }, { name: 'ใหม่', startingElo: 1000 }, { id: 'la', name: 'อ', startingElo: 1700 }],
        }).expect(200);
        expect(res.body.levels.map((l: { name: string }) => l.name)).toEqual(['บ', 'ใหม่', 'อ']);
        expect(res.body.levels[1].id).not.toBe('la');
        expect(res.body.levels.find((l: { name: string }) => l.name === 'อ').id).toBe('la');
        expect((await f.row(f.players.a.id)).levelSeed).toBe(1100);
        expect((await f.row(f.players.b.id)).levelSeed).toBe(1300);
        expect(res.body.assignedCounts[res.body.levels[1].id]).toBe(0);
        expect(await f.ratings()).toEqual(before);
      } finally {
        await f.cleanup();
      }
    });

    it('removing a level someone has is refused with the counts; an unassigned one can go', async () => {
      const f = await fixture({ ladder: [...ladder, { id: 'lc', name: 'ค', startingElo: 1500 }] });
      try {
        const refused = await f.put({ action: 'edit', expectedRevision: 0, levels: [{ id: 'lb', name: 'บ', startingElo: 1300 }, { id: 'lc', name: 'ค', startingElo: 1500 }] }).expect(409);
        expect(refused.body.code).toBe('LEVEL_IN_USE');
        expect(refused.body.counts).toEqual({ la: 1 });
        expect((await f.row(f.players.a.id)).level).toBe('อ');
        expect((await prisma.group.findUniqueOrThrow({ where: { code: f.code } })).levelLadderRevision).toBe(0);
        await f.put({ action: 'edit', expectedRevision: 0, levels: [{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }] }).expect(200);
      } finally {
        await f.cleanup();
      }
    });

    it('rejects unknown, foreign and duplicate ids, duplicate names, bad seeds and bad sizes with LEVEL_LADDER_INVALID', async () => {
      const f = await fixture({ ladder });
      try {
        const bad = async (levels: object[]) => {
          const res = await f.put({ action: 'edit', expectedRevision: 0, levels }).expect(400);
          expect(res.body.code).toBe('LEVEL_LADDER_INVALID');
        };
        await bad([{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'zz', name: 'บ', startingElo: 1300 }]);
        await bad([{ id: 'standard:BG', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }]);
        await bad([{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'la', name: 'บ', startingElo: 1300 }]);
        await bad([{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'อ', startingElo: 1300 }]);
        await bad([{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1100 }]);
        await bad([{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300.5 }]);
        await bad([]);
        await bad(Array.from({ length: 17 }, (_, i) => ({ id: i === 0 ? 'la' : undefined, name: `L${i}`, startingElo: 1000 + i })));
        expect((await prisma.group.findUniqueOrThrow({ where: { code: f.code } })).levelLadderRevision).toBe(0);
      } finally {
        await f.cleanup();
      }
    });

    it('a stale revision conflicts without writing anything', async () => {
      const f = await fixture({ ladder, revision: 4 });
      try {
        const res = await f.put({ action: 'edit', expectedRevision: 3, levels: [{ id: 'la', name: 'x', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }] }).expect(409);
        expect(res.body.code).toBe('LEVEL_LADDER_STALE');
        expect((await f.row(f.players.a.id)).level).toBe('อ');
        expect((await prisma.group.findUniqueOrThrow({ where: { code: f.code } })).levelLadderRevision).toBe(4);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('group ladder live sessions', () => {
    it('any open session blocks every action: an unstarted one and one being played', async () => {
      const f = await fixture({ ladder: [{ id: 'la', name: 'อ', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }] });
      try {
        const open = randomUUID();
        await prisma.session.create({ data: { code: open, groupId: f.code, courtCount: 1, rawImportText: '' } });
        const edit = { action: 'edit', expectedRevision: 0, levels: [{ id: 'la', name: 'อ2', startingElo: 1100 }, { id: 'lb', name: 'บ', startingElo: 1300 }] };
        for (const body of [edit, { action: 'reset', expectedRevision: 0 }]) {
          expect((await f.put(body).expect(409)).body.code).toBe('LEVEL_LADDER_ACTIVE_SESSION');
        }
        await prisma.pairing.create({
          data: { sessionId: open, courtNumber: 1, matchNumber: 1, teamA: JSON.stringify(['x', 'y']), teamB: JSON.stringify(['z', 'w']), confirmedAt: new Date() },
        });
        expect((await f.put(edit).expect(409)).body.code).toBe('LEVEL_LADDER_ACTIVE_SESSION');
        await prisma.pairing.deleteMany({ where: { sessionId: open } });
        await prisma.session.update({ where: { code: open }, data: { endedAt: new Date() } });
        await f.put(edit).expect(200);
      } finally {
        await f.cleanup();
      }
    });

    it('a standard group is blocked from customizing during an open session too', async () => {
      const f = await fixture();
      try {
        await prisma.session.create({ data: { code: randomUUID(), groupId: f.code, courtCount: 1, rawImportText: '' } });
        expect((await f.put({ action: 'customize', expectedRevision: 0, levels: three }).expect(409)).body.code).toBe('LEVEL_LADDER_ACTIVE_SESSION');
        expect((await f.row(f.players.a.id)).level).toBe('BG');
      } finally {
        await f.cleanup();
      }
    });

    it('a session created while a ladder is being saved either blocks the save or sees the new ladder, never a half-cleared roster', async () => {
      for (let round = 0; round < 6; round++) {
        const f = await fixture();
        try {
          const [save, create] = await Promise.all([
            f.put({ action: 'customize', expectedRevision: 0, levels: three }),
            request(server).post('/sessions').send({
              groupCode: f.code, date: null, venue: null, courtCount: 1, rawImportText: 'A', idempotencyKey: randomUUID(),
              rosterReviews: [{ inputName: 'A', decision: 'accept', match: { type: 'exact', playerId: f.players.a.id } }], waitlistReviews: [],
            }),
          ]);
          expect(create.status, JSON.stringify(create.body)).toBe(201);
          const group = await prisma.group.findUniqueOrThrow({ where: { code: f.code } });
          const labels = await Promise.all(Object.values(f.players).map((p) => f.row(p.id).then((r) => r.level)));
          if (save.status === 200) {
            // The save won: every label cleared together, ladder written.
            expect(group.levelLadder).not.toBeNull();
            expect(labels.every((l) => l === null)).toBe(true);
          } else {
            // The session won: the save was refused and nothing changed.
            expect(save.status).toBe(409);
            expect(save.body.code).toBe('LEVEL_LADDER_ACTIVE_SESSION');
            expect(group.levelLadder).toBeNull();
            expect(labels).toEqual(['BG', 'P', null, null]);
          }
        } finally {
          await f.cleanup();
        }
      }
    });
  });
});
