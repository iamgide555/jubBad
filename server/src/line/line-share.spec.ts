import { randomUUID } from 'node:crypto';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { SESSION_SECRET } from '../auth/auth.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import type { SummaryCard } from './line-summary-card.js';
import { LineSummaryService } from './line-summary.service.js';

const LIFF_ID = '2001234567-AbCdEfGh';

describe('LineSummaryService.shareCard and GET /sessions/:code/line-share-card', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let summary: LineSummaryService;
  const userIds: string[] = [];
  const groupCodes: string[] = [];

  beforeAll(async () => {
    // The real app, so the global AuthGuard is in front of the route exactly as in production.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue('share-test-secret')
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser('share-test-secret'));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // Listen once, as sessions.controller.spec.ts does, so supertest does not churn a server per request.
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
    summary = app.get(LineSummaryService);
  });

  afterAll(async () => {
    await prisma.pairing.deleteMany({ where: { session: { groupId: { in: groupCodes } } } });
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    process.env.PUBLIC_APP_URL = 'https://jubbad.test';
    process.env.LINE_LIFF_ID = LIFF_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function makeOwner(plan: 'host' | 'free', lineUserId: string | null = `U${randomUUID().replace(/-/g, '')}`) {
    const user = await prisma.user.create({
      data: { email: `share-${randomUUID()}@example.test`, passwordHash: 'x', role: 'host', plan, lineUserId },
    });
    userIds.push(user.id);
    return user;
  }

  /** An unlinked group with the DM switch on (the host target), a host-plan owner who linked LINE, and two finished games over four players. */
  async function setup(
    options: {
      plan?: 'host' | 'free';
      linked?: boolean;
      dm?: boolean;
      games?: number;
      ended?: boolean;
      groupName?: string;
    } = {}
  ) {
    const { plan = 'host', linked = false, dm = true, games = 2, ended = true, groupName = 'ก๊วนพฤหัส' } = options;
    const owner = await makeOwner(plan);
    const groupCode = `share-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: {
        code: groupCode,
        name: groupName,
        ownerId: owner.id,
        lineGroupId: linked ? `C${randomUUID().replace(/-/g, '')}` : null,
        lineDmEnabled: dm,
      },
    });
    const sessionCode = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        rawImportText: '',
        date: '26 ต.ค.',
        venue: 'Bad@Mama',
        endedAt: ended ? new Date('2026-10-26T14:00:00Z') : null,
      },
    });
    const finished = new Date('2026-10-26T13:00:00Z');
    for (let i = 0; i < games; i += 1) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify(['a', 'b']),
          teamB: JSON.stringify(['c', 'd']),
          winner: 'A',
          confirmedAt: finished,
          endedAt: finished,
        },
      });
    }
    return { sessionCode, groupCode, owner };
  }

  it('serves the card, the LIFF id and a preview for an ended host-target session', async () => {
    const { sessionCode, owner } = await setup();
    const payload = await summary.shareCard(sessionCode);

    expect(Object.keys(payload)).toEqual(['liffId', 'card', 'preview']);
    expect(payload.liffId).toBe(LIFF_ID);
    expect(payload.preview).toEqual({ name: 'ก๊วนพฤหัส', date: '26 ต.ค.', venue: 'Bad@Mama', players: 4, games: 2 });

    expect(payload.card.type).toBe('flex');
    expect(payload.card.altText).toBe('สรุปก๊วน ก๊วนพฤหัส 26 ต.ค.');
    const footer = (payload.card.contents as { footer: { contents: { action: { label: string; uri: string } }[] } })
      .footer.contents;
    // One button only: the share button belongs to the host's DM copy, not to the card that gets shared on.
    expect(footer).toHaveLength(1);
    expect(footer[0].action).toEqual({ type: 'uri', label: 'ดูสรุป', uri: `https://jubbad.test/s/${sessionCode}/summary` });

    const json = JSON.stringify(payload);
    expect(json).not.toContain('lineUserId');
    expect(json).not.toContain(owner.lineUserId!);
    expect(json).not.toContain(owner.email);
    expect(json).not.toContain(owner.id);
    expect(json).not.toContain('liff.line.me');
  });

  it('is the card the host was DMed, minus the share button', async () => {
    const { sessionCode } = await setup();
    const push = vi.spyOn(app.get(LineClient), 'push').mockResolvedValue('ok');
    try {
      expect(await summary.send(sessionCode)).toBe('sent');
      const dmCard = push.mock.calls[0][1][0] as SummaryCard;
      const shared = (await summary.shareCard(sessionCode)).card;

      const footer = (card: SummaryCard) => (card.contents as { footer: { contents: unknown[] } }).footer.contents;
      expect(footer(dmCard)).toHaveLength(2);
      // Everything but the footer is identical; the footer differs only by the DM-only second button.
      const strip = (card: SummaryCard) => ({ ...card, contents: { ...card.contents, footer: undefined } });
      expect(strip(shared)).toEqual(strip(dmCard));
      expect(footer(shared)).toEqual([footer(dmCard)[0]]);
    } finally {
      push.mockRestore();
    }
  });

  it('clips a long group name in the preview exactly as the card does', async () => {
    const { sessionCode } = await setup({ groupName: 'ก'.repeat(90) });
    const { card, preview } = await summary.shareCard(sessionCode);
    expect(Array.from(preview.name)).toHaveLength(60);
    expect(preview.name.endsWith('…')).toBe(true);
    expect(JSON.stringify(card.contents)).toContain(preview.name);
  });

  describe('is a 404 when', () => {
    const expectNotFound = (sessionCode: string) =>
      expect(summary.shareCard(sessionCode)).rejects.toBeInstanceOf(NotFoundException);

    it('the session does not exist', async () => {
      await expectNotFound('nope-no-such-session');
    });

    it('the session is still open', async () => {
      const { sessionCode } = await setup({ ended: false });
      await expectNotFound(sessionCode);
    });

    it('no game finished', async () => {
      const { sessionCode } = await setup({ games: 0 });
      await expectNotFound(sessionCode);
    });

    it('the group is linked to a LINE group (that card is pushed, not shared)', async () => {
      const { sessionCode } = await setup({ linked: true });
      await expectNotFound(sessionCode);
    });

    it('the group has the DM switch off', async () => {
      const { sessionCode } = await setup({ dm: false });
      await expectNotFound(sessionCode);
    });

    it("the owner's plan has lapsed to free", async () => {
      const { sessionCode } = await setup({ plan: 'free' });
      await expectNotFound(sessionCode);
    });

    it('the LIFF id is not configured', async () => {
      const { sessionCode } = await setup();
      delete process.env.LINE_LIFF_ID;
      await expectNotFound(sessionCode);
    });

    it('the public app url is not configured', async () => {
      const { sessionCode } = await setup();
      delete process.env.PUBLIC_APP_URL;
      await expectNotFound(sessionCode);
    });
  });

  describe('over HTTP', () => {
    it('answers an anonymous caller (no cookie) with the payload', async () => {
      const { sessionCode, owner } = await setup();
      const res = await request(server).get(`/sessions/${sessionCode}/line-share-card`).expect(200);
      expect(Object.keys(res.body)).toEqual(['liffId', 'card', 'preview']);
      expect(res.body.liffId).toBe(LIFF_ID);
      expect(res.body.preview).toMatchObject({ players: 4, games: 2 });
      expect(res.text).not.toContain('lineUserId');
      expect(res.text).not.toContain(owner.email);
      expect(res.text).not.toContain(owner.id);
    });

    it('is the only public thing here: the host-only sibling route still refuses a caller with no cookie', async () => {
      const { sessionCode } = await setup();
      await request(server).get(`/sessions/${sessionCode}/line-summary`).expect(401);
    });

    it('answers 404 to an anonymous caller when the card is not available', async () => {
      const { sessionCode } = await setup({ linked: true });
      await request(server).get(`/sessions/${sessionCode}/line-share-card`).expect(404);
      await request(server).get('/sessions/nope-no-such-session/line-share-card').expect(404);
    });
  });
});
