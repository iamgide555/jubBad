import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from '../groups/groups.module.js';
import { GroupsService } from '../groups/groups.service.js';
import { LineClient } from './line-client.js';
import { LineLinkService } from './line-link.service.js';
import { LineModule } from './line.module.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MINUTE = 60_000;

describe('LINE link codes, status and unlink', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let prisma: PrismaService;
  let link: LineLinkService;
  let groups: GroupsService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const fakeClient = {
    reply: vi.fn(),
    groupName: vi.fn(),
    memberName: vi.fn(),
    leave: vi.fn(),
  };
  let hostId: string;
  let freeId: string;
  let requestUserId: string;

  async function makeGroup(ownerId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const code = `line-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({ data: { code, name: `ก๊วน ${code}`, ownerId, ...extra } });
    return code;
  }

  const lineId = () => `C${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, LineModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    link = app.get(LineLinkService);
    groups = app.get(GroupsService);
    const tag = randomUUID();
    hostId = (
      await prisma.user.create({
        data: { email: `line-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' },
      })
    ).id;
    freeId = (
      await prisma.user.create({
        data: { email: `line-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
      })
    ).id;
    requestUserId = hostId;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: requestUserId, role: 'host' };
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = 'secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/jubbad';
    requestUserId = hostId;
    fakeClient.reply.mockReset();
    fakeClient.leave.mockReset().mockResolvedValue(undefined);
    fakeClient.memberName.mockReset();
    fakeClient.groupName.mockReset().mockResolvedValue('ก๊วนวันพฤหัส');
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe('createCode', () => {
    it('makes a 6 character code from the fixed alphabet that expires in 10 minutes', async () => {
      const code = await makeGroup(hostId);
      const now = new Date('2026-10-26T10:00:00Z');
      const made = await link.createCode(code, now);
      expect(made.code).toHaveLength(6);
      for (const ch of made.code) expect(CODE_ALPHABET).toContain(ch);
      expect(new Date(made.expiresAt).getTime()).toBe(now.getTime() + 10 * MINUTE);
    });

    it('stores only the SHA-256 hash, never the code itself', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      const rows = await prisma.lineLinkCode.findMany({ where: { groupId: code } });
      expect(rows).toHaveLength(1);
      expect(rows[0].codeHash).toBe(createHash('sha256').update(made.code).digest('hex'));
      expect(JSON.stringify(rows[0])).not.toContain(made.code);
    });

    it('voids the group earlier unused code when a new one is made', async () => {
      const code = await makeGroup(hostId);
      const first = await link.createCode(code);
      await link.createCode(code);
      expect(await link.redeem(lineId(), first.code)).toBeNull();
    });
  });

  describe('redeem', () => {
    it('links the LINE group, names it from LINE, and marks the code used', async () => {
      const code = await makeGroup(hostId);
      const lg = lineId();
      const made = await link.createCode(code);
      const result = await link.redeem(lg, made.code);
      expect(result).toEqual({ groupCode: code, groupName: `ก๊วน ${code}` });
      const group = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect(group.lineGroupId).toBe(lg);
      expect(group.lineGroupName).toBe('ก๊วนวันพฤหัส');
      expect(group.lineLinkedAt).not.toBeNull();
      expect(fakeClient.groupName).toHaveBeenCalledWith(lg);
      const row = await prisma.lineLinkCode.findFirstOrThrow({ where: { groupId: code } });
      expect(row.usedAt).not.toBeNull();
    });

    it('does not accept the same code twice', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      expect(await link.redeem(lineId(), made.code)).not.toBeNull();
      expect(await link.redeem(lineId(), made.code)).toBeNull();
    });

    it('rejects an expired code', async () => {
      const code = await makeGroup(hostId);
      const now = new Date('2026-10-26T10:00:00Z');
      const made = await link.createCode(code, now);
      expect(await link.redeem(lineId(), made.code, new Date(now.getTime() + 11 * MINUTE))).toBeNull();
    });

    it('accepts a loosely typed code (lowercase, surrounding spaces)', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      expect(await link.redeem(lineId(), `  ${made.code.toLowerCase()} `)).not.toBeNull();
    });

    it('rejects text that is not shaped like a code', async () => {
      expect(await link.redeem(lineId(), 'nope')).toBeNull();
      expect(await link.redeem(lineId(), '')).toBeNull();
    });

    it('refuses a LINE group already linked to another JubBad group', async () => {
      const lg = lineId();
      await makeGroup(hostId, { lineGroupId: lg });
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      expect(await link.redeem(lg, made.code)).toBeNull();
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBeNull();
    });

    it('refuses a JubBad group that is already linked', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      await prisma.group.update({ where: { code }, data: { lineGroupId: lineId() } });
      const other = lineId();
      expect(await link.redeem(other, made.code)).toBeNull();
    });

    it('refuses when the owner is on the free plan at redeem time', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      await prisma.user.update({ where: { id: hostId }, data: { plan: 'free' } });
      try {
        expect(await link.redeem(lineId(), made.code)).toBeNull();
      } finally {
        await prisma.user.update({ where: { id: hostId }, data: { plan: 'host' } });
      }
    });

    it('lets only one of two simultaneous redeems link', async () => {
      const code = await makeGroup(hostId);
      const made = await link.createCode(code);
      const results = await Promise.all([link.redeem(lineId(), made.code), link.redeem(lineId(), made.code)]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });
  });

  describe('status', () => {
    it('reports configured false when the channel env is unset', async () => {
      delete process.env.LINE_CHANNEL_SECRET;
      const code = await makeGroup(hostId);
      expect((await link.status(code)).configured).toBe(false);
    });

    it('reports the add-bot link and an unlinked group', async () => {
      const code = await makeGroup(hostId);
      expect(await link.status(code)).toEqual({
        configured: true,
        botAddUrl: 'https://lin.ee/jubbad',
        linked: false,
        lineGroupName: null,
        linkedAt: null,
        leftAt: null,
      });
    });

    it('reports leftAt after the bot is removed, and a re-link clears it', async () => {
      const code = await makeGroup(hostId);
      const lg = lineId();
      await link.redeem(lg, (await link.createCode(code)).code);
      const left = new Date('2026-10-26T12:00:00Z');
      await link.markLeft(lg, left);
      const after = await link.status(code);
      expect(after.linked).toBe(false);
      expect(after.leftAt).toBe(left.toISOString());
      await link.redeem(lineId(), (await link.createCode(code)).code);
      const relinked = await link.status(code);
      expect(relinked.linked).toBe(true);
      expect(relinked.leftAt).toBeNull();
    });
  });

  describe('unlink', () => {
    it('clears the link, deletes stored messages and codes, and asks the bot to leave', async () => {
      const lg = lineId();
      const code = await makeGroup(hostId, { lineGroupId: lg, lineGroupName: 'x', lineLinkedAt: new Date() });
      await prisma.lineRosterMessage.create({
        data: { groupId: code, text: '1. a', postedAt: new Date(), lineMessageId: randomUUID() },
      });
      await prisma.lineLinkCode.create({
        data: { groupId: code, codeHash: randomUUID(), expiresAt: new Date(Date.now() + MINUTE) },
      });
      await link.unlink(code);
      const group = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect([group.lineGroupId, group.lineGroupName, group.lineLinkedAt]).toEqual([null, null, null]);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
      expect(await prisma.lineLinkCode.count({ where: { groupId: code } })).toBe(0);
      expect(fakeClient.leave).toHaveBeenCalledTimes(1);
      expect(fakeClient.leave).toHaveBeenCalledWith(lg);
    });

    it('still succeeds when the bot cannot leave', async () => {
      const code = await makeGroup(hostId, { lineGroupId: lineId() });
      fakeClient.leave.mockRejectedValue(new Error('LINE down'));
      await expect(link.unlink(code)).resolves.toBeUndefined();
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBeNull();
    });

    it('a later leave event for the same LINE group changes nothing', async () => {
      const lg = lineId();
      const code = await makeGroup(hostId, { lineGroupId: lg });
      await link.unlink(code);
      await link.markLeft(lg);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineLeftAt).toBeNull();
    });

    it('deleting a linked JubBad group also asks the bot to leave', async () => {
      const lg = lineId();
      const code = await makeGroup(hostId, { lineGroupId: lg });
      await groups.deleteGroup(code);
      expect(fakeClient.leave).toHaveBeenCalledWith(lg);
    });
  });

  describe('owner routes', () => {
    it('GET /groups/:code/line returns the status', async () => {
      const code = await makeGroup(hostId);
      const res = await request(server).get(`/groups/${code}/line`).expect(200);
      expect(res.body).toMatchObject({ configured: true, linked: false });
    });

    it('POST /groups/:code/line/code returns a code on a paid plan', async () => {
      const code = await makeGroup(hostId);
      const res = await request(server).post(`/groups/${code}/line/code`).expect(201);
      expect(res.body.code).toHaveLength(6);
      expect(typeof res.body.expiresAt).toBe('string');
    });

    it('POST code answers 503 LINE_NOT_CONFIGURED when the channel env is unset', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      const code = await makeGroup(hostId);
      const res = await request(server).post(`/groups/${code}/line/code`).expect(503);
      expect(res.body.code).toBe('LINE_NOT_CONFIGURED');
    });

    it('POST code answers 403 PLAN_REQUIRED on a free plan', async () => {
      requestUserId = freeId;
      const code = await makeGroup(freeId);
      const res = await request(server).post(`/groups/${code}/line/code`).expect(403);
      expect(res.body.code).toBe('PLAN_REQUIRED');
    });

    it('POST code answers 409 LINE_ALREADY_LINKED for a linked group', async () => {
      const code = await makeGroup(hostId, { lineGroupId: lineId() });
      const res = await request(server).post(`/groups/${code}/line/code`).expect(409);
      expect(res.body.code).toBe('LINE_ALREADY_LINKED');
    });

    it('POST code answers 404 for a group that does not exist', async () => {
      await request(server).post('/groups/no-such-group-line/line/code').expect(404);
    });

    it('DELETE unlinks, and still works for a free owner', async () => {
      requestUserId = freeId;
      const code = await makeGroup(freeId, { lineGroupId: lineId() });
      await prisma.lineRosterMessage.create({
        data: { groupId: code, text: '1. a', postedAt: new Date(), lineMessageId: randomUUID() },
      });
      const res = await request(server).delete(`/groups/${code}/line`).expect(200);
      expect(res.body).toEqual({ unlinked: true });
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });
  });
});
