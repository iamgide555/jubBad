import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { LineHostService } from './line-host.service.js';
import { LineLinkService } from './line-link.service.js';
import { LineModule } from './line.module.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MINUTE = 60_000;

describe('LINE host link codes, status and unlink', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let prisma: PrismaService;
  let host: LineHostService;
  let groupLink: LineLinkService;
  const fakeClient = {
    reply: vi.fn(),
    groupName: vi.fn(),
    memberName: vi.fn(),
    leave: vi.fn(),
  };
  const tag = randomUUID();
  const userIds: string[] = [];

  async function makeUser(
    plan = 'host',
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `line-hostdm-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'host',
        plan,
        ...extra,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  const lineId = () => `U${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LineModule],
    })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    host = app.get(LineHostService);
    groupLink = app.get(LineLinkService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = 'secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/jubbad';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe('status', () => {
    it('reports configuration, the add url and whether the user is linked', async () => {
      const userId = await makeUser();
      expect(await host.status(userId)).toEqual({
        configured: true,
        botAddUrl: 'https://lin.ee/jubbad',
        linked: false,
        linkedAt: null,
      });
      const made = await host.createCode(userId);
      await host.redeem(lineId(), made.code);
      const after = await host.status(userId);
      expect(after.linked).toBe(true);
      expect(after.linkedAt).not.toBeNull();
    });

    it('is not configured without the secret and token', async () => {
      delete process.env.LINE_CHANNEL_SECRET;
      const status = await host.status(await makeUser());
      expect(status.configured).toBe(false);
    });
  });

  describe('createCode', () => {
    it('makes a 6 character code from the fixed alphabet that expires in 10 minutes', async () => {
      const userId = await makeUser();
      const now = new Date('2026-10-28T10:00:00Z');
      const made = await host.createCode(userId, now);
      expect(made.code).toHaveLength(6);
      for (const ch of made.code) expect(CODE_ALPHABET).toContain(ch);
      expect(new Date(made.expiresAt).getTime()).toBe(
        now.getTime() + 10 * MINUTE,
      );
    });

    it('stores only the SHA-256 hash, never the code itself', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      const rows = await prisma.lineUserLinkCode.findMany({
        where: { userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].codeHash).toBe(
        createHash('sha256').update(made.code).digest('hex'),
      );
      expect(JSON.stringify(rows[0])).not.toContain(made.code);
    });

    it('voids the user earlier unused code when a new one is made', async () => {
      const userId = await makeUser();
      const first = await host.createCode(userId);
      await host.createCode(userId);
      expect(await host.redeem(lineId(), first.code)).toBeNull();
      expect(await prisma.lineUserLinkCode.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('refuses a free user with PLAN_REQUIRED', async () => {
      const err = await host.createCode(await makeUser('free')).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({
        code: 'PLAN_REQUIRED',
        requiredPlan: 'host',
      });
    });

    it('refuses an already-linked user with LINE_ALREADY_LINKED', async () => {
      const userId = await makeUser();
      await host.redeem(lineId(), (await host.createCode(userId)).code);
      const err = await host.createCode(userId).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'LINE_ALREADY_LINKED' }),
      );
    });

    it('refuses with LINE_NOT_CONFIGURED when the secret or token is missing', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      const err = await host.createCode(await makeUser()).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'LINE_NOT_CONFIGURED' }),
      );
    });
  });

  describe('redeem', () => {
    it('binds the LINE user, sets lineLinkedAt and marks the code used', async () => {
      const userId = await makeUser();
      const line = lineId();
      const made = await host.createCode(userId);
      expect(await host.redeem(line, made.code)).toEqual({ userId });
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.lineUserId).toBe(line);
      expect(user.lineLinkedAt).not.toBeNull();
      const row = await prisma.lineUserLinkCode.findFirstOrThrow({
        where: { userId },
      });
      expect(row.usedAt).not.toBeNull();
      expect(await host.userForLineUser(line)).toEqual({ id: userId });
      expect(await host.userForLineUser(lineId())).toBeNull();
    });

    it('accepts a lower-case code with surrounding spaces', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      expect(
        await host.redeem(lineId(), ` ${made.code.toLowerCase()} `),
      ).toEqual({ userId });
    });

    it('returns null for a wrong code and a badly shaped one', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      const wrong =
        made.code[0] === 'A'
          ? 'B' + made.code.slice(1)
          : 'A' + made.code.slice(1);
      expect(await host.redeem(lineId(), wrong)).toBeNull();
      expect(await host.redeem(lineId(), 'ab')).toBeNull();
    });

    it('does not accept the same code twice', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      expect(await host.redeem(lineId(), made.code)).not.toBeNull();
      expect(await host.redeem(lineId(), made.code)).toBeNull();
    });

    it('returns null once the code is past 10 minutes', async () => {
      const userId = await makeUser();
      const now = new Date('2026-10-28T10:00:00Z');
      const made = await host.createCode(userId, now);
      expect(
        await host.redeem(
          lineId(),
          made.code,
          new Date(now.getTime() + 10 * MINUTE + 1),
        ),
      ).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).toBeNull();
    });

    it('returns null when the owner lapsed to free after making the code', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { plan: 'free' },
      });
      expect(await host.redeem(lineId(), made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).toBeNull();
    });

    it('returns null when the LINE user is already linked to a different JubBad user', async () => {
      const line = lineId();
      const first = await makeUser();
      await host.redeem(line, (await host.createCode(first)).code);
      const second = await makeUser();
      const made = await host.createCode(second);
      expect(await host.redeem(line, made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: second } }))
          .lineUserId,
      ).toBeNull();
    });

    it('returns null when the user is already linked to another LINE user', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      // a second unused code cannot exist through createCode, so seed one directly
      const code = 'ZZZZZZ';
      await prisma.user.update({
        where: { id: userId },
        data: { lineUserId: lineId(), lineLinkedAt: new Date() },
      });
      await prisma.lineUserLinkCode.create({
        data: {
          userId,
          codeHash: createHash('sha256').update(code).digest('hex'),
          expiresAt: new Date(Date.now() + 5 * MINUTE),
        },
      });
      expect(await host.redeem(lineId(), code)).toBeNull();
      expect(await host.redeem(lineId(), made.code)).toBeNull();
    });

    it('returns null for a group-link code, whose hash lives only in LineLinkCode', async () => {
      const groupCode = `line-${randomUUID().slice(0, 10)}`;
      const ownerId = await makeUser();
      await prisma.group.create({
        data: { code: groupCode, name: 'g', ownerId },
      });
      const made = await groupLink.createCode(groupCode);
      expect(await host.redeem(lineId(), made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } }))
          .lineUserId,
      ).toBeNull();
      await prisma.group.delete({ where: { code: groupCode } });
    });

    it('binds exactly once when two redeems of one code race', async () => {
      const userId = await makeUser();
      const made = await host.createCode(userId);
      const results = await Promise.all([
        host.redeem(lineId(), made.code),
        host.redeem(lineId(), made.code),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).not.toBeNull();
    });
  });

  describe('unlink', () => {
    it('clears the link and deletes the pending roster and codes, for a free user too', async () => {
      const userId = await makeUser();
      await host.redeem(lineId(), (await host.createCode(userId)).code);
      await prisma.lineUserLinkCode.create({
        data: {
          userId,
          codeHash: `h-${tag}-${userId}`,
          expiresAt: new Date(Date.now() + 5 * MINUTE),
        },
      });
      await prisma.linePendingRoster.create({
        data: {
          userId,
          text: 'roster',
          lineMessageId: `m-${randomUUID()}`,
          postedAt: new Date(),
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { plan: 'free' },
      });

      await host.unlink(userId);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.lineUserId).toBeNull();
      expect(user.lineLinkedAt).toBeNull();
      expect(await prisma.lineUserLinkCode.count({ where: { userId } })).toBe(
        0,
      );
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(
        0,
      );
      expect((await host.status(userId)).linked).toBe(false);
    });
  });

  describe('purgeExpired', () => {
    it('removes a pending roster older than 10 minutes and keeps a fresh one', async () => {
      const stale = await makeUser();
      const fresh = await makeUser();
      const now = new Date('2026-10-28T12:00:00Z');
      await prisma.linePendingRoster.create({
        data: {
          userId: stale,
          text: 'old',
          lineMessageId: `m-${randomUUID()}`,
          postedAt: new Date(now.getTime() - 11 * MINUTE),
          createdAt: new Date(now.getTime() - 11 * MINUTE),
        },
      });
      await prisma.linePendingRoster.create({
        data: {
          userId: fresh,
          text: 'new',
          lineMessageId: `m-${randomUUID()}`,
          postedAt: new Date(now.getTime() - 2 * MINUTE),
          createdAt: new Date(now.getTime() - 2 * MINUTE),
        },
      });
      await host.purgeExpired(now);
      expect(
        await prisma.linePendingRoster.count({ where: { userId: stale } }),
      ).toBe(0);
      expect(
        await prisma.linePendingRoster.count({ where: { userId: fresh } }),
      ).toBe(1);
    });

    it('removes codes that expired or were used more than a day ago and keeps recent ones', async () => {
      const userId = await makeUser();
      const now = new Date('2026-10-28T12:00:00Z');
      const day = 24 * 60 * MINUTE;
      await prisma.lineUserLinkCode.createMany({
        data: [
          {
            userId,
            codeHash: `old-${randomUUID()}`,
            expiresAt: new Date(now.getTime() - 2 * day),
          },
          {
            userId,
            codeHash: `used-${randomUUID()}`,
            expiresAt: new Date(now.getTime() + MINUTE),
            usedAt: new Date(now.getTime() - 2 * day),
          },
          {
            userId,
            codeHash: `recent-${randomUUID()}`,
            expiresAt: new Date(now.getTime() - MINUTE),
          },
        ],
      });
      await host.purgeExpired(now);
      const left = await prisma.lineUserLinkCode.findMany({
        where: { userId },
      });
      expect(left).toHaveLength(1);
      expect(left[0].codeHash.startsWith('recent-')).toBe(true);
    });
  });
});
