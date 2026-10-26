import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { LineClient } from '../line/line-client.js';
import { LineSummaryService } from '../line/line-summary.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('POST /sessions/:code/end with the LINE summary card', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const fakeClient = { reply: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn(), push: vi.fn() };
  let ownerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'end-line-test-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
    ownerId = (
      await prisma.user.create({
        data: { email: `end-line-${randomUUID()}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fakeClient.push.mockReset().mockResolvedValue('ok');
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    process.env.PUBLIC_APP_URL = 'https://jubbad.test';
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  /** An open session with one finished game and no unfinished ones, on a group linked to LINE (or not). */
  async function openSession(linked = true): Promise<string> {
    const groupCode = `end-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({
      data: {
        code: groupCode,
        name: 'ก๊วนทดสอบ',
        ownerId,
        lineGroupId: linked ? `C${randomUUID().replace(/-/g, '')}` : null,
      },
    });
    const sessionCode = `e${randomUUID().slice(0, 8)}`;
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, rawImportText: '', date: '26 ต.ค.' } });
    const at = new Date('2026-10-26T13:00:00Z');
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['a', 'b']),
        teamB: JSON.stringify(['c', 'd']),
        winner: 'A',
        confirmedAt: at,
        endedAt: at,
      },
    });
    return sessionCode;
  }

  it('posts the card after ending when asked, and reports sent', async () => {
    const code = await openSession();
    const res = await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: true }).expect(201);
    expect(res.body.lineSummary).toBe('sent');
    expect(res.body.code).toBe(code);
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).not.toBeNull();
    expect(fakeClient.push).toHaveBeenCalledTimes(1);
  });

  it('posts nothing and reports nothing when not asked', async () => {
    const code = await openSession();
    for (const body of [{}, { sendLineSummary: false }]) {
      const fresh = await openSession();
      const res = await request(server).post(`/sessions/${fresh}/end`).send(body).expect(201);
      expect(res.body).not.toHaveProperty('lineSummary');
    }
    expect(fakeClient.push).not.toHaveBeenCalled();
    await request(server).post(`/sessions/${code}/end`).expect(201);
  });

  it('still ends the session when LINE fails', async () => {
    const code = await openSession();
    fakeClient.push.mockResolvedValue('failed');
    const res = await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: true }).expect(201);
    expect(res.body.lineSummary).toBe('failed');
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).not.toBeNull();
  });

  it('still ends the session when the send itself throws', async () => {
    const code = await openSession();
    vi.spyOn(app.get(LineSummaryService), 'send').mockRejectedValue(new Error('boom'));
    const res = await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: true }).expect(201);
    expect(res.body.lineSummary).toBe('failed');
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).not.toBeNull();
  });

  it('ends an unlinked group and reports unavailable', async () => {
    const code = await openSession(false);
    const res = await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: true }).expect(201);
    expect(res.body.lineSummary).toBe('unavailable');
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('does not send when the end itself is refused', async () => {
    const code = await openSession();
    await request(server).post(`/sessions/${code}/end`).send({}).expect(201);
    await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: true }).expect(409);
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean flag', async () => {
    const code = await openSession();
    await request(server).post(`/sessions/${code}/end`).send({ sendLineSummary: 'yes' }).expect(400);
  });
});
