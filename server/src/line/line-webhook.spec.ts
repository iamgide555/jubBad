import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_ATTEMPTS } from '../auth/login-throttle.js';
import { LineClient } from './line-client.js';
import { LineHostService } from './line-host.service.js';
import { LineLinkService } from './line-link.service.js';
import { LineModule } from './line.module.js';

const SECRET = 'test-secret';
const ROSTER = 'ก๊วนพฤหัส 8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด\n3. นก';
const FAIL_TEXT = 'รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > LINE';

describe('POST /line/webhook', () => {
  const saved = { ...process.env };
  const fakeClient = { reply: vi.fn(), replyMessages: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn() };
  let app: INestApplication;
  let prisma: PrismaService;
  let link: LineLinkService;
  let host: LineHostService;
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
    host = app.get(LineHostService);
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
    fakeClient.replyMessages.mockReset().mockResolvedValue(undefined);
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

  describe('host direct messages', () => {
    const lineUser = () => `U${randomUUID().replace(/-/g, '')}`;

    function dm(userId: string, text: string, opts: { id?: string; replyToken?: string | null } = {}) {
      return {
        type: 'message',
        timestamp: ts++,
        ...(opts.replyToken === null ? {} : { replyToken: opts.replyToken ?? `rt-${randomUUID()}` }),
        source: { type: 'user', userId },
        message: { type: 'text', id: opts.id ?? randomUUID(), text },
      };
    }

    function postback(userId: string, data: string, opts: { replyToken?: string | null } = {}) {
      return {
        type: 'postback',
        timestamp: ts++,
        ...(opts.replyToken === null ? {} : { replyToken: opts.replyToken ?? `rt-${randomUUID()}` }),
        source: { type: 'user', userId },
        postback: { data },
      };
    }

    async function makeUser(lineUserId: string | null = null) {
      return (
        await prisma.user.create({
          data: {
            email: `wh-dm-${randomUUID()}@example.test`,
            passwordHash: 'x',
            role: 'host',
            plan: 'host',
            ...(lineUserId ? { lineUserId, lineLinkedAt: new Date() } : {}),
          },
        })
      ).id;
    }

    /** A group the host owns; DM capture is on unless said otherwise, since only those groups are offered. */
    async function ownedGroup(ownerId: string, lineDmEnabled = true) {
      const code = `wh-${randomUUID().slice(0, 10)}`;
      await prisma.group.create({ data: { code, name: `ก๊วน ${code}`, ownerId, lineDmEnabled } });
      return code;
    }

    /** The label and data of every Quick Reply button in the one replyMessages call. */
    function buttons(): { label: string; data: string }[] {
      expect(fakeClient.replyMessages).toHaveBeenCalledTimes(1);
      const [message] = fakeClient.replyMessages.mock.calls[0][1] as { quickReply: { items: { action: { label: string; data: string } }[] } }[];
      return message.quickReply.items.map(({ action }) => action);
    }

    it('links the LINE account on a valid host code and replies once', async () => {
      const userId = await makeUser();
      const { code } = await host.createCode(await ownedGroup(userId, false));
      const line = lineUser();
      await post([dm(line, `/link ${code}`)]).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lineUserId).toBe(line);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      const text = fakeClient.reply.mock.calls[0][1] as string;
      expect(text).not.toBe(FAIL_TEXT);
      expect(text).toContain('เฉพาะข้อความรายชื่อ');
    });

    it('names the group the code was made for in the reply, and switches only that group on', async () => {
      const userId = await makeUser();
      const first = await ownedGroup(userId, false);
      const second = await ownedGroup(userId, false);
      const { code } = await host.createCode(first);
      await post([dm(lineUser(), `/link ${code}`)]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      const text = fakeClient.reply.mock.calls[0][1] as string;
      expect(text).toContain(`«ก๊วน ${first}»`);
      expect(text).not.toContain(second);
      expect((await prisma.group.findUniqueOrThrow({ where: { code: first } })).lineDmEnabled).toBe(true);
      expect((await prisma.group.findUniqueOrThrow({ where: { code: second } })).lineDmEnabled).toBe(false);
    });

    it('replies without a group name when the group moved away before the code was used', async () => {
      const userId = await makeUser();
      const first = await ownedGroup(userId, false);
      const { code } = await host.createCode(first);
      await prisma.group.update({ where: { code: first }, data: { ownerId: await makeUser() } });
      await post([dm(lineUser(), `/link ${code}`)]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      const text = fakeClient.reply.mock.calls[0][1] as string;
      expect(text).not.toBe(FAIL_TEXT);
      expect(text).not.toContain('«');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lineUserId).not.toBeNull();
    });

    it('replies the generic failure on a wrong code and links nothing', async () => {
      const line = lineUser();
      await post([dm(line, '/link ZZZZZZ')]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      expect(fakeClient.reply.mock.calls[0][1]).toBe(FAIL_TEXT);
      expect(await prisma.user.count({ where: { lineUserId: line } })).toBe(0);
    });

    it('replies the generic failure when the LINE user is already linked, and links no one else', async () => {
      const line = lineUser();
      await makeUser(line);
      const otherId = await makeUser();
      const { code } = await host.createCode(await ownedGroup(otherId));
      await post([dm(line, `/link ${code}`)]).expect(200);
      expect(fakeClient.reply.mock.calls.map((c) => c[1])).toEqual([FAIL_TEXT]);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: otherId } })).lineUserId).toBeNull();
    });

    it('drops bad codes from one LINE user silently once throttled, on a key apart from the group throttle', async () => {
      const line = lineUser();
      for (let i = 0; i < MAX_ATTEMPTS; i++) await post([dm(line, '/link BADBAD')]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      fakeClient.reply.mockClear();
      const userId = await makeUser();
      const { code } = await host.createCode(await ownedGroup(userId));
      await post([dm(line, `/link ${code}`)]).expect(200);
      expect(fakeClient.reply).not.toHaveBeenCalled();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lineUserId).toBeNull();

      // The same LINE user in a group is counted on its own key, so a group link still answers.
      const { code: groupCode, linkCode } = await groupWithCode();
      const lg = lineId();
      await post([textEvent(lg, `/link ${linkCode}`, { userId: line })]).expect(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { code: groupCode } })).lineGroupId).toBe(lg);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
    });

    it('stores a roster from a linked host with one group and replies naming it', async () => {
      const line = lineUser();
      const code = await ownedGroup(await makeUser(line));
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row).toMatchObject({ groupId: code, senderUserId: line, senderName: null, direct: true });
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      expect(fakeClient.reply.mock.calls[0][1]).toContain(`ก๊วน ${code}`);
      expect(fakeClient.memberName).not.toHaveBeenCalled();
    });

    it('tells a stranger to link first and stores nothing', async () => {
      const line = lineUser();
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      expect(fakeClient.reply.mock.calls[0][1]).toContain('/link');
    });

    it('asks a host with two groups which one, then files the roster for the tapped group', async () => {
      const line = lineUser();
      const userId = await makeUser(line);
      const first = await ownedGroup(userId);
      const second = await ownedGroup(userId);
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      expect(fakeClient.reply).not.toHaveBeenCalled();
      const choices = buttons();
      expect(choices.map((c) => c.label).sort()).toEqual([`ก๊วน ${first}`, `ก๊วน ${second}`].sort());
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);

      const tapped = choices.find((c) => c.data.endsWith(`:${second}`))!;
      await post([postback(line, tapped.data)]).expect(200);
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row).toMatchObject({ groupId: second, direct: true, text: ROSTER });
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      expect(fakeClient.reply.mock.calls[0][1]).toContain(`ก๊วน ${second}`);
    });

    it('refuses a postback from another LINE user and moves nothing', async () => {
      const line = lineUser();
      const userId = await makeUser(line);
      await ownedGroup(userId);
      const target = await ownedGroup(userId);
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      const tapped = buttons().find((c) => c.data.endsWith(`:${target}`))!;

      const forger = lineUser();
      await makeUser(forger);
      await post([postback(forger, tapped.data)]).expect(200);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(1);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
    });

    it('still files a postback that carries no reply token, without replying', async () => {
      const line = lineUser();
      const userId = await makeUser(line);
      await ownedGroup(userId);
      const target = await ownedGroup(userId);
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      const tapped = buttons().find((c) => c.data.endsWith(`:${target}`))!;
      fakeClient.replyMessages.mockClear();
      await post([postback(line, tapped.data, { replyToken: null })]).expect(200);
      expect(fakeClient.reply).not.toHaveBeenCalled();
      expect(fakeClient.replyMessages).not.toHaveBeenCalled();
      expect((await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } })).groupId).toBe(target);
    });

    it('greets a new friend with how to link', async () => {
      await post([{ type: 'follow', timestamp: ts++, replyToken: `rt-${randomUUID()}`, source: { type: 'user', userId: lineUser() } }]).expect(200);
      expect(fakeClient.reply).toHaveBeenCalledTimes(1);
      expect(fakeClient.reply.mock.calls[0][1]).toContain('/link');
    });

    it('forgets the pending roster on unfollow but keeps the link', async () => {
      const line = lineUser();
      const userId = await makeUser(line);
      await ownedGroup(userId);
      await ownedGroup(userId);
      await post([dm(line, ROSTER)]).expect(200);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(1);
      await post([{ type: 'unfollow', timestamp: ts++, source: { type: 'user', userId: line } }]).expect(200);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lineUserId).toBe(line);
    });

    it('ignores an unsend or an edit in a DM', async () => {
      const line = lineUser();
      await ownedGroup(await makeUser(line));
      const id = randomUUID();
      await post([dm(line, ROSTER, { id })]).expect(200);
      fakeClient.reply.mockClear();
      await post([
        { ...dm(line, `${ROSTER}\n4. แมว`, { id }), type: 'messageEdited' },
        { type: 'unsend', timestamp: ts++, source: { type: 'user', userId: line }, unsend: { messageId: id } },
      ]).expect(200);
      expect((await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } })).text).toBe(ROSTER);
      expect(fakeClient.reply).not.toHaveBeenCalled();
    });
  });
});
