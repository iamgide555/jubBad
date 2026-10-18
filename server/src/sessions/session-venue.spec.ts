import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

/**
 * Creating a session links it to the shared venue list by the venue text the
 * host sent: an exact normalized match reuses the venue, anything else makes a
 * new one, and Session.venue keeps the text exactly as sent.
 */
describe('session creation links the shared venue list', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const run = randomUUID().slice(0, 8);
  const groups: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'session-venue-test-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    const sessions = await prisma.session.findMany({ where: { groupId: { in: groups } }, select: { code: true } });
    const codes = sessions.map((s) => s.code);
    await prisma.sessionRoster.deleteMany({ where: { sessionId: { in: codes } } });
    await prisma.sessionCreation.deleteMany({ where: { groupId: { in: groups } } });
    await prisma.session.deleteMany({ where: { code: { in: codes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groups } } });
    await prisma.group.deleteMany({ where: { code: { in: groups } } });
    groups.length = 0;
    await prisma.venue.deleteMany({ where: { normalizedName: { contains: run } } });
  });

  afterAll(async () => {
    await app.close();
  });

  async function create(venue: string | null, idempotencyKey: string = randomUUID()) {
    const groupCode = randomUUID();
    groups.push(groupCode);
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    return createIn(groupCode, venue, idempotencyKey);
  }

  async function createIn(groupCode: string, venue: string | null, idempotencyKey: string = randomUUID()) {
    const res = await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-10-18',
        venue,
        courtCount: 2,
        rawImportText: '1. Alice',
        idempotencyKey,
        rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'accept' }],
        waitlistReviews: [],
      })
      .expect(201);
    return prisma.session.findUniqueOrThrow({ where: { code: res.body.code } });
  }

  const venueCount = () => prisma.venue.count({ where: { normalizedName: { contains: run } } });

  it('creates a venue for a new name and links the session, keeping the text as sent', async () => {
    const session = await create(`Gym A${run}`);
    const venue = await prisma.venue.findFirstOrThrow({ where: { normalizedName: { contains: run } } });
    expect(venue.displayName).toBe(`Gym A${run}`);
    expect(session.venueId).toBe(venue.id);
    expect(session.venue).toBe(`Gym A${run}`);
  });

  it('reuses the venue for a name that differs only by case and spaces, keeping that text as sent', async () => {
    const first = await create(`Gym A${run}`);
    const second = await create(` gym a${run} `);
    expect(second.venueId).toBe(first.venueId);
    expect(second.venue).toBe(` gym a${run} `);
    expect(await venueCount()).toBe(1);
  });

  it.each([['   '], [null]])('links no venue for a blank venue (%j)', async (venue) => {
    const before = await prisma.venue.count();
    const session = await create(venue);
    expect(session.venueId).toBeNull();
    expect(await prisma.venue.count()).toBe(before);
  });

  it('does not create a second venue when the same creation request is replayed', async () => {
    const key = randomUUID();
    const first = await create(`Replay${run}`, key);
    const groupCode = first.groupId;
    const replay = await createIn(groupCode, `Replay${run}`, key);
    expect(replay.code).toBe(first.code);
    expect(await venueCount()).toBe(1);
  });
});
