import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { LineLinkService } from './line-link.service.js';
import { LineModule } from './line.module.js';

const SECRET = 'test-secret';
const ROSTER = 'ก๊วนพฤหัส 8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด\n3. นก';
const FAIL_TEXT = 'รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE';

describe('POST /line/webhook', () => {
  const saved = { ...process.env };
  const fakeClient = { reply: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn() };
  let app: INestApplication;
  let prisma: PrismaService;
  let link: LineLinkService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let hostId: string;
  let freeId: string;

  const lineId = () => `C${randomUUID().replace(/-/g, '')}`;

  function sign(body: string, secret = SECRET): string {
    return createHmac('sha256', secret).update(body).digest('base64');
  }

  function post(events: unknown[], signature?: string, body?: string) {
    const raw = body ?? JSON.stringify({ destination: 'Ubot', events });
    return request(server)
      .post('/line/webhook')
      .set('Content-Type', 'application/json')
      .set('x-line-signature', signature ?? sign(raw))
      .send(raw);
  }

  // Recent on purpose: capture purges anything older than 30 days at once.
  let ts = Date.now() - 60 * 60 * 1000;
  function textEvent(groupId: string, text: string, opts: { userId?: string | null; id?: string; at?: number } = {}) {
    const userId = opts.userId === undefined ? 'U1' : opts.userId;
    return {
      type: 'message',
      timestamp: opts.at ?? ts++,
      replyToken: `rt-${randomUUID()}`,
      source: { type: 'group', groupId, ...(userId === null ? {} : { userId }) },
      message: { type: 'text', id: opts.id ?? randomUUID(), text },
    };
  }

  async function groupWithCode(ownerId = hostId) {
    const code = `wh-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({ data: { code, name: `ก๊วน ${code}`, ownerId } });
    const made = await link.createCode(code);
    return { code, linkCode: made.code };
  }

  async function linkedGroup(ownerId = hostId) {
    const lineGroupId = lineId();
    const code = `wh-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({ data: { code, name: code, ownerId, lineGroupId, lineLinkedAt: new Date() } });
    return { code, lineGroupId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, LineModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    prisma = app.get(PrismaService);
    link = app.get(LineLinkService);
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const tag = randomUUID();
    hostId = (
      await prisma.user.create({
        data: { email: `wh-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' },
      })
    ).id;
    freeId = (
      await prisma.user.create({
        data: { email: `wh-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = SECRET;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
    fakeClient.reply.mockReset().mockResolvedValue(undefined);
    fakeClient.leave.mockReset().mockResolvedValue(undefined);
    fakeClient.groupName.mockReset().mockResolvedValue('ก๊วนพฤหัส LINE');
    fakeClient.memberName.mockReset().mockResolvedValue('Nok');
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe('signature', () => {
    it('answers 503 when the channel is not configured', async () => {
      delete process.env.LINE_CHANNEL_SECRET;
      await post([]).expect(503);
    });

    it('refuses a missing signature', async () => {
      const raw = JSON.stringify({ events: [] });
      await request(server).post('/line/webhook').set('Content-Type', 'application/json').send(raw).expect(401);
    });

    it('refuses a tampered body', async () => {
      const raw = JSON.stringify({ events: [] });
      const tampered = JSON.stringify({ events: [], x: 1 });
      await post([], sign(raw), tampered).expect(401);
    });

    it('accepts a correctly signed body with no events (LINE verify)', async () => {
      const res = await post([]).expect(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('/link', () => {
    it('links the LINE group on a valid code and replies once with what the bot keeps', async () => {
      const { code, linkCode } = await groupWithCode();
      const lg = lineId();
      await post([textEvent(lg, `/link ${linkCode}`)]).expect(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBe(lg);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      const text = fakeClient.reply.mock.calls[0][1] as string;
      expect(text).toContain(`ก๊วน ${code}`);
      expect(text).toContain('เฉพาะข้อความรายชื่อ');
    });

    it('accepts a loosely typed command', async () => {
      const { code, linkCode } = await groupWithCode();
      const lg = lineId();
      await post([textEvent(lg, `  /LINK ${linkCode.toLowerCase()}  `)]).expect(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBe(lg);
    });

    it('replies once with the generic failure text on a wrong code, and links nothing', async () => {
      const { code } = await groupWithCode();
      await post([textEvent(lineId(), '/link ZZZZZZ')]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      const text = fakeClient.reply.mock.calls[0][1] as string;
      expect(text).toBe(FAIL_TEXT);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBeNull();
    });

    it('stays silent once one sender is throttled, but another sender can still link', async () => {
      const { code, linkCode } = await groupWithCode();
      const lg = lineId();
      for (let i = 0; i < 10; i++) await post([textEvent(lg, '/link BADBAD', { userId: 'Ugriefer' })]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(10);
      fakeClient.reply.mockClear();
      await post([textEvent(lg, `/link ${linkCode}`, { userId: 'Ugriefer' })]).expect(200);
      expect(fakeClient.reply).not.toHaveBeenCalled();
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBeNull();
      await post([textEvent(lg, `/link ${linkCode}`, { userId: 'Uhost' })]).expect(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBe(lg);
    });

    it('links once when the same code arrives twice in one batch', async () => {
      const { code, linkCode } = await groupWithCode();
      const lg = lineId();
      await post([textEvent(lg, `/link ${linkCode}`), textEvent(lg, `/link ${linkCode}`)]).expect(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBe(lg);
      const texts = fakeClient.reply.mock.calls.map((c) => c[1] as string);
      expect(texts.filter((t) => t === FAIL_TEXT)).toHaveLength(1);
      expect(texts).toHaveLength(2);
    });

    it('is not treated as roster capture', async () => {
      const { code, lineGroupId } = await linkedGroup();
      await post([textEvent(lineGroupId, '/link ABC234')]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });
  });

  describe('capture', () => {
    it('stores a roster from a linked group with the sender name', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const id = randomUUID();
      const AT = Date.now() - 5 * 60 * 1000;
      await post([textEvent(lineGroupId, ROSTER, { id, at: AT })]).expect(200);
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row).toMatchObject({ groupId: code, senderName: 'Nok', senderUserId: 'U1' });
      expect(row.postedAt.getTime()).toBe(AT);
    });

    it('stores a redelivered message once', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const event = textEvent(lineGroupId, ROSTER);
      await post([event]).expect(200);
      await post([event]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(1);
    });

    it('does not store ordinary chat', async () => {
      const { code, lineGroupId } = await linkedGroup();
      await post([textEvent(lineGroupId, 'ไปไหมคืนนี้')]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('does not store anything for a free owner', async () => {
      const { code, lineGroupId } = await linkedGroup(freeId);
      await post([textEvent(lineGroupId, ROSTER)]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('stores a message with no user id, with null sender fields and no name lookup', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = randomUUID();
      await post([textEvent(lineGroupId, ROSTER, { id, userId: null })]).expect(200);
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect([row.senderUserId, row.senderName]).toEqual([null, null]);
      expect(fakeClient.memberName).not.toHaveBeenCalled();
    });

    it('ignores messages from a one-to-one chat', async () => {
      const { code } = await linkedGroup();
      const event = { ...textEvent(lineId(), ROSTER), source: { type: 'user', userId: 'U1' } };
      await post([event]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('answers 200 even when one event in the batch fails', async () => {
      const { code, lineGroupId } = await linkedGroup();
      fakeClient.memberName.mockRejectedValueOnce(new Error('LINE exploded'));
      const first = randomUUID();
      const second = randomUUID();
      await post([textEvent(lineGroupId, ROSTER, { id: first }), textEvent(lineGroupId, ROSTER, { id: second })]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code, lineMessageId: second } })).toBe(1);
    });
  });

  describe('edit, unsend and leave', () => {
    it('follows an edited message', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = randomUUID();
      await post([textEvent(lineGroupId, ROSTER, { id })]).expect(200);
      const edited = { ...textEvent(lineGroupId, `${ROSTER}\n4. แมว`, { id }), type: 'messageEdited' };
      await post([edited]).expect(200);
      expect((await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } })).text).toBe(`${ROSTER}\n4. แมว`);
    });

    it('removes an unsent message', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = randomUUID();
      await post([textEvent(lineGroupId, ROSTER, { id })]).expect(200);
      await post([{ type: 'unsend', timestamp: ts++, source: { type: 'group', groupId: lineGroupId }, unsend: { messageId: id } }]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
    });

    it('unlinks and remembers when the bot leaves the group', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const id = randomUUID();
      await post([textEvent(lineGroupId, ROSTER, { id })]).expect(200);
      await post([{ type: 'leave', timestamp: ts++, source: { type: 'group', groupId: lineGroupId } }]).expect(200);
      const group = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect(group.lineGroupId).toBeNull();
      expect(group.lineLeftAt).not.toBeNull();
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('ignores events it does not know', async () => {
      await post([{ type: 'follow', timestamp: ts++, source: { type: 'user', userId: 'U1' } }, { type: 'join', timestamp: ts++, source: { type: 'group', groupId: lineId() } }]).expect(200);
    });
  });
});
