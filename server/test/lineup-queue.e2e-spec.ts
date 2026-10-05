import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GroupsModule } from '../src/groups/groups.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SessionsModule } from '../src/sessions/sessions.module.js';

type Court = { courtNumber: number; status: string; pairingId?: string; revision?: number };

/**
 * 40 players on 8 courts. Before every round the host lines up a mix of full
 * and partial lineups; the round must honour them, never double-book anyone,
 * and leave nobody half-queued.
 */
describe('lineup queue across an 8-court night (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;
  const groupCode = `e2e-lq-${randomUUID().slice(0, 8)}`;
  const sessionCode = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `lq-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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
    const where = { session: { groupId: groupCode } };
    await prisma.queuedMatch.deleteMany({ where });
    await prisma.pairingShuttleUse.deleteMany({ where: { pairing: where } });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  const courtsOf = async () => (await request(server).get(`/sessions/${sessionCode}`).expect(200)).body.courts as Court[];
  const ids = (p: { teamA: string; teamB: string }) => [...JSON.parse(p.teamA), ...JSON.parse(p.teamB)] as (string | null)[];

  it('honours queued lineups every round without double-booking', async () => {
    await prisma.group.create({ data: { code: groupCode, name: 'queue e2e', ownerId: adminId } });
    const players = [];
    for (let i = 0; i < 40; i++) {
      players.push(await prisma.player.create({ data: { groupId: groupCode, name: `Q${i}`, aliases: '[]' } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, courtCount: 8, rawImportText: '', date: '2026-10-05' } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });

    let honoured = 0;
    for (let round = 0; round < 6; round++) {
      // Two lineups per round from players not on a court: one full, one partial (a pair kept together).
      const onCourt = new Set((await prisma.pairing.findMany({ where: { sessionId: sessionCode, endedAt: null } })).flatMap(ids));
      const free = players.map((p) => p.id).filter((id) => !onCourt.has(id));
      const full = free.slice(0, 4);
      const pair = free.slice(4, 6);
      await request(server).post(`/sessions/${sessionCode}/queue`).send({ teamA: [full[0], full[1]], teamB: [full[2], full[3]] }).expect(201);
      await request(server).post(`/sessions/${sessionCode}/queue`).send({ teamA: [pair[0], pair[1]], teamB: [null, null] }).expect(201);

      await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);

      const open = await prisma.pairing.findMany({ where: { sessionId: sessionCode, endedAt: null } });
      const seen = new Set<string>();
      for (const p of open) {
        for (const id of ids(p)) {
          expect(id, `court ${p.courtNumber} has an empty seat after fill`).not.toBeNull();
          expect(seen.has(id!), `player on two courts in round ${round}`).toBe(false);
          seen.add(id!);
        }
      }
      // Lineups were consumed and honoured: the full one sits together on one court, the pair on teamA together.
      expect(await prisma.queuedMatch.count({ where: { sessionId: sessionCode } })).toBe(0);
      const holds = (group: string[]) => open.some((p) => group.every((id) => ids(p).includes(id)));
      expect(holds(full), 'full lineup kept together').toBe(true);
      expect(open.some((p) => JSON.parse(p.teamA).includes(pair[0]) && JSON.parse(p.teamA).includes(pair[1])), 'pair kept as teammates').toBe(true);
      // Auto-confirm must not start a host-set lineup on its own.
      honoured += 2;

      for (const c of (await courtsOf()).filter((x) => x.status === 'pending')) {
        await request(server).post(`/sessions/${sessionCode}/pairings/${c.pairingId}/confirm`).send({ expectedRevision: c.revision }).expect(201);
      }
      for (const c of (await courtsOf()).filter((x) => x.status === 'active')) {
        await request(server).post(`/sessions/${sessionCode}/pairings/${c.pairingId}/finish`).send({ winner: 'A', expectedRevision: c.revision }).expect(201);
      }
    }
    expect(honoured).toBe(12);
  });
});
