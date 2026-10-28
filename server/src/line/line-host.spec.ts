import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { OwnershipGuard } from '../auth/ownership.guard.js';
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
  const groupCodes: string[] = [];

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

  async function makeGroup(
    ownerId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const code = `line-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({
      data: { code, name: `ก๊วน ${code}`, ownerId, ...extra },
    });
    groupCodes.push(code);
    return code;
  }

  /** A host-plan user who owns one group. */
  async function makeOwner(plan = 'host') {
    const userId = await makeUser(plan);
    return { userId, code: await makeGroup(userId) };
  }

  const lineId = () => `U${randomUUID().replace(/-/g, '')}`;

  const linkAccount = (userId: string) =>
    prisma.user.update({
      where: { id: userId },
      data: { lineUserId: lineId(), lineLinkedAt: new Date() },
    });

  const addRow = (groupId: string, direct: boolean) =>
    prisma.lineRosterMessage.create({
      data: {
        groupId,
        text: '1. a',
        postedAt: new Date(),
        lineMessageId: randomUUID(),
        direct,
      },
    });

  const flagOf = async (code: string) =>
    (await prisma.group.findUniqueOrThrow({ where: { code } })).lineDmEnabled;

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
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
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
    it('reports configuration, the add url, whether the owner is linked and whether the group is on', async () => {
      const { code } = await makeOwner();
      expect(await host.status(code)).toEqual({
        configured: true,
        botAddUrl: 'https://lin.ee/jubbad',
        accountLinked: false,
        enabled: false,
        summaryDefault: true,
        summaryAvailable: false,
      });
      const made = await host.createCode(code);
      await host.redeem(lineId(), made.code);
      expect(await host.status(code)).toMatchObject({
        accountLinked: true,
        enabled: true,
      });
    });

    it('is linked but not enabled when the group is switched off', async () => {
      const userId = await makeUser('host', {
        lineUserId: lineId(),
        lineLinkedAt: new Date(),
      });
      const code = await makeGroup(userId);
      expect(await host.status(code)).toMatchObject({
        accountLinked: true,
        enabled: false,
      });
    });

    it('is never enabled while the owner has no linked account', async () => {
      const userId = await makeUser();
      const code = await makeGroup(userId, { lineDmEnabled: true });
      expect(await host.status(code)).toMatchObject({
        accountLinked: false,
        enabled: false,
      });
    });

    it("reports the group's summary default", async () => {
      const userId = await makeUser();
      const code = await makeGroup(userId, { lineSummaryDefault: false });
      expect((await host.status(code)).summaryDefault).toBe(false);
      await prisma.group.update({
        where: { code },
        data: { lineSummaryDefault: true },
      });
      expect((await host.status(code)).summaryDefault).toBe(true);
    });

    it('offers the summary card only with both the public app url and the LIFF id', async () => {
      const { code } = await makeOwner();
      expect((await host.status(code)).summaryAvailable).toBe(false);
      process.env.PUBLIC_APP_URL = 'https://jubbad.test';
      expect((await host.status(code)).summaryAvailable).toBe(false);
      process.env.LINE_LIFF_ID = '1234567890-AbCdEfGh';
      expect((await host.status(code)).summaryAvailable).toBe(true);
      delete process.env.PUBLIC_APP_URL;
      expect((await host.status(code)).summaryAvailable).toBe(false);
    });

    it('is not configured without the secret and token', async () => {
      delete process.env.LINE_CHANNEL_SECRET;
      const { code } = await makeOwner();
      const status = await host.status(code);
      expect(status.configured).toBe(false);
    });

    it('is not found for an unknown group and for a group with no owner', async () => {
      await expect(host.status('no-such-group-host')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const code = `line-${randomUUID().slice(0, 10)}`;
      await prisma.group.create({ data: { code, name: 'ไม่มีเจ้าของ' } });
      groupCodes.push(code);
      await expect(host.status(code)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createCode', () => {
    it('makes a 6 character code from the fixed alphabet that expires in 10 minutes', async () => {
      const { code } = await makeOwner();
      const now = new Date('2026-10-28T10:00:00Z');
      const made = await host.createCode(code, now);
      expect(made.code).toHaveLength(6);
      for (const ch of made.code) expect(CODE_ALPHABET).toContain(ch);
      expect(new Date(made.expiresAt).getTime()).toBe(
        now.getTime() + 10 * MINUTE,
      );
    });

    it('stores only the SHA-256 hash, never the code itself, and the group it was asked for', async () => {
      const { userId, code } = await makeOwner();
      const made = await host.createCode(code);
      const rows = await prisma.lineUserLinkCode.findMany({
        where: { userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].codeHash).toBe(
        createHash('sha256').update(made.code).digest('hex'),
      );
      expect(rows[0].groupCode).toBe(code);
      expect(JSON.stringify(rows[0])).not.toContain(made.code);
    });

    it('voids the owner earlier unused code when a new one is made', async () => {
      const { userId, code } = await makeOwner();
      const other = await makeGroup(userId);
      const first = await host.createCode(code);
      await host.createCode(other);
      expect(await host.redeem(lineId(), first.code)).toBeNull();
      expect(await prisma.lineUserLinkCode.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('refuses a free owner with PLAN_REQUIRED', async () => {
      const { code } = await makeOwner('free');
      const err = await host.createCode(code).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({
        code: 'PLAN_REQUIRED',
        requiredPlan: 'host',
      });
    });

    it('refuses an already-linked owner with LINE_ALREADY_LINKED', async () => {
      const { code } = await makeOwner();
      await host.redeem(lineId(), (await host.createCode(code)).code);
      const err = await host.createCode(code).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'LINE_ALREADY_LINKED' }),
      );
    });

    it('refuses with LINE_NOT_CONFIGURED when the secret or token is missing', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      const { code } = await makeOwner();
      const err = await host.createCode(code).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'LINE_NOT_CONFIGURED' }),
      );
    });
  });

  describe('setEnabled', () => {
    it('refuses to switch on while the owner has no linked account', async () => {
      const { code } = await makeOwner();
      const err = await host.setEnabled(code, true).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'LINE_NOT_LINKED' }),
      );
      expect(await flagOf(code)).toBe(false);
    });

    it('refuses to switch on for a free owner with PLAN_REQUIRED', async () => {
      const { userId, code } = await makeOwner('free');
      await linkAccount(userId);
      const err = await host.setEnabled(code, true).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({
        code: 'PLAN_REQUIRED',
        requiredPlan: 'host',
      });
      expect(await flagOf(code)).toBe(false);
    });

    it('switches a second group on for a linked owner, and only that group', async () => {
      const { userId, code } = await makeOwner();
      const second = await makeGroup(userId);
      await linkAccount(userId);
      expect(await host.setEnabled(code, true)).toBe(true);
      expect(await flagOf(code)).toBe(true);
      expect(await flagOf(second)).toBe(false);
    });

    it('switches off, and deletes only that group direct rows', async () => {
      const { userId, code } = await makeOwner();
      const other = await makeGroup(userId, { lineDmEnabled: true });
      await prisma.group.update({
        where: { code },
        data: { lineDmEnabled: true },
      });
      await linkAccount(userId);
      await addRow(code, true);
      const lineGroupRow = await addRow(code, false);
      const otherDirect = await addRow(other, true);

      expect(await host.setEnabled(code, false)).toBe(false);

      expect(await flagOf(code)).toBe(false);
      expect(await flagOf(other)).toBe(true);
      const left = await prisma.lineRosterMessage.findMany({
        where: { groupId: { in: [code, other] } },
      });
      expect(left.map((r) => r.id).sort()).toEqual(
        [lineGroupRow.id, otherDirect.id].sort(),
      );
    });

    it('lets a free or unlinked owner switch off', async () => {
      const { code } = await makeOwner('free');
      await prisma.group.update({
        where: { code },
        data: { lineDmEnabled: true },
      });
      await addRow(code, true);
      expect(await host.setEnabled(code, false)).toBe(false);
      expect(await flagOf(code)).toBe(false);
      expect(
        await prisma.lineRosterMessage.count({ where: { groupId: code } }),
      ).toBe(0);
    });

    it('is not found for an unknown group', async () => {
      await expect(
        host.setEnabled('no-such-group-host', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('redeem', () => {
    it('binds the LINE user, sets lineLinkedAt, marks the code used and names the group', async () => {
      const userId = await makeUser();
      const code = await makeGroup(userId, { name: '  ก๊วนพฤหัส  ' });
      const line = lineId();
      const made = await host.createCode(code);
      expect(await host.redeem(line, made.code)).toEqual({
        userId,
        groupName: 'ก๊วนพฤหัส',
      });
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

    it('falls back to the group code when the name is blank', async () => {
      const userId = await makeUser();
      const code = await makeGroup(userId, { name: ' ' });
      const made = await host.createCode(code);
      expect((await host.redeem(lineId(), made.code))?.groupName).toBe(code);
    });

    it('enables the group the code was made for, and not the owner other group', async () => {
      const userId = await makeUser();
      const a = await makeGroup(userId, { name: 'ก๊วน A' });
      const b = await makeGroup(userId, { name: 'ก๊วน B' });
      const made = await host.createCode(a);
      expect(await host.redeem(lineId(), made.code)).toEqual({
        userId,
        groupName: 'ก๊วน A',
      });
      expect(await flagOf(a)).toBe(true);
      expect(await flagOf(b)).toBe(false);
    });

    it('links the account but enables nothing when the group moved to another owner first', async () => {
      const userId = await makeUser();
      const other = await makeUser();
      const a = await makeGroup(userId, { name: 'ก๊วน A' });
      const made = await host.createCode(a);
      await prisma.group.update({ where: { code: a }, data: { ownerId: other } });
      expect(await host.redeem(lineId(), made.code)).toEqual({
        userId,
        groupName: null,
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).not.toBeNull();
      expect(await flagOf(a)).toBe(false);
    });

    it('accepts a lower-case code with surrounding spaces', async () => {
      const { userId, code } = await makeOwner();
      const made = await host.createCode(code);
      expect(
        await host.redeem(lineId(), ` ${made.code.toLowerCase()} `),
      ).toMatchObject({ userId });
    });

    it('returns null for a wrong code and a badly shaped one', async () => {
      const { code } = await makeOwner();
      const made = await host.createCode(code);
      const wrong =
        made.code[0] === 'A'
          ? 'B' + made.code.slice(1)
          : 'A' + made.code.slice(1);
      expect(await host.redeem(lineId(), wrong)).toBeNull();
      expect(await host.redeem(lineId(), 'ab')).toBeNull();
    });

    it('does not accept the same code twice', async () => {
      const { code } = await makeOwner();
      const made = await host.createCode(code);
      expect(await host.redeem(lineId(), made.code)).not.toBeNull();
      expect(await host.redeem(lineId(), made.code)).toBeNull();
    });

    it('returns null once the code is past 10 minutes', async () => {
      const { userId, code } = await makeOwner();
      const now = new Date('2026-10-28T10:00:00Z');
      const made = await host.createCode(code, now);
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
      expect(await flagOf(code)).toBe(false);
    });

    it('returns null when the owner lapsed to free after making the code', async () => {
      const { userId, code } = await makeOwner();
      const made = await host.createCode(code);
      await prisma.user.update({
        where: { id: userId },
        data: { plan: 'free' },
      });
      expect(await host.redeem(lineId(), made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).toBeNull();
      expect(await flagOf(code)).toBe(false);
    });

    it('returns null when the LINE user is already linked to a different JubBad user', async () => {
      const line = lineId();
      const first = await makeOwner();
      await host.redeem(line, (await host.createCode(first.code)).code);
      const second = await makeOwner();
      const made = await host.createCode(second.code);
      expect(await host.redeem(line, made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: second.userId } }))
          .lineUserId,
      ).toBeNull();
      expect(await flagOf(second.code)).toBe(false);
    });

    it('returns null when the user is already linked to another LINE user', async () => {
      const { userId, code: groupCode } = await makeOwner();
      const made = await host.createCode(groupCode);
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
      const ownerId = await makeUser();
      const groupCode = await makeGroup(ownerId);
      const made = await groupLink.createCode(groupCode);
      expect(await host.redeem(lineId(), made.code)).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } }))
          .lineUserId,
      ).toBeNull();
    });

    it('binds exactly once when two redeems of one code race', async () => {
      const { userId, code } = await makeOwner();
      const made = await host.createCode(code);
      const results = await Promise.all([
        host.redeem(lineId(), made.code),
        host.redeem(lineId(), made.code),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).not.toBeNull();
      expect(await flagOf(code)).toBe(true);
    });
  });

  describe('unlink', () => {
    it('clears the link and deletes the pending roster and codes, for a free user too', async () => {
      const { userId, code } = await makeOwner();
      await host.redeem(lineId(), (await host.createCode(code)).code);
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
      expect((await host.status(code)).accountLinked).toBe(false);
    });

    it('switches every owned group off and deletes their direct rows, keeping LINE group rows', async () => {
      const userId = await makeUser('host', {
        lineUserId: lineId(),
        lineLinkedAt: new Date(),
      });
      const a = await makeGroup(userId, { lineDmEnabled: true });
      const b = await makeGroup(userId, { lineDmEnabled: true });
      const bystander = await makeUser('host');
      const theirs = await makeGroup(bystander, { lineDmEnabled: true });
      await addRow(a, true);
      await addRow(b, true);
      const kept = await addRow(a, false);
      const theirRow = await addRow(theirs, true);

      await host.unlink(userId);

      expect(await flagOf(a)).toBe(false);
      expect(await flagOf(b)).toBe(false);
      expect(await flagOf(theirs)).toBe(true);
      const left = await prisma.lineRosterMessage.findMany({
        where: { groupId: { in: [a, b, theirs] } },
      });
      expect(left.map((r) => r.id).sort()).toEqual(
        [kept.id, theirRow.id].sort(),
      );
    });

    it('unlinkOwnerOf unlinks the account of whoever owns the group', async () => {
      const userId = await makeUser('host', {
        lineUserId: lineId(),
        lineLinkedAt: new Date(),
      });
      const a = await makeGroup(userId, { lineDmEnabled: true });
      const b = await makeGroup(userId, { lineDmEnabled: true });
      await host.unlinkOwnerOf(a);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .lineUserId,
      ).toBeNull();
      expect(await flagOf(a)).toBe(false);
      expect(await flagOf(b)).toBe(false);
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

describe('LINE host link routes', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const fakeClient = { reply: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn() };
  const userIds: string[] = [];
  const groupCodes: string[] = [];
  let requestUser: { id: string; role: string } | undefined;

  async function makeUser(plan: string, extra: Record<string, unknown> = {}): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `line-hostdm-http-${randomUUID()}@example.test`, passwordHash: 'x', role: 'host', plan, ...extra }
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeGroup(ownerId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const code = `line-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({ data: { code, name: `ก๊วน ${code}`, ownerId, ...extra } });
    groupCodes.push(code);
    return code;
  }

  const linked = () => ({ lineUserId: lineIdFor(), lineLinkedAt: new Date() });
  const flagOf = async (code: string) => (await prisma.group.findUniqueOrThrow({ where: { code } })).lineDmEnabled;

  beforeAll(async () => {
    // OwnershipGuard is the real one, so a non-owner gets the same 404 as in production.
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LineModule],
      providers: [{ provide: APP_GUARD, useClass: OwnershipGuard }]
    })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    // Stand-in for AuthGuard: no user means the request is refused with 401, as the real guard does.
    app.use((req: { user?: unknown }, res: { status(n: number): { end(): void } }, next: () => void) => {
      if (!requestUser) return res.status(401).end();
      req.user = requestUser;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = 'secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/jubbad';
  });

  afterEach(() => {
    requestUser = undefined;
    process.env = { ...saved };
  });

  it('refuses an anonymous caller on all four routes', async () => {
    await request(server).get('/groups/any-group/line/host').expect(401);
    await request(server).post('/groups/any-group/line/host/code').expect(401);
    await request(server).put('/groups/any-group/line/host').send({ enabled: true }).expect(401);
    await request(server).delete('/groups/any-group/line/host').expect(401);
  });

  it('GET returns the status of the group', async () => {
    const userId = await makeUser('host');
    const code = await makeGroup(userId);
    requestUser = { id: userId, role: 'host' };
    const res = await request(server).get(`/groups/${code}/line/host`).expect(200);
    expect(res.body).toEqual({
      configured: true,
      botAddUrl: 'https://lin.ee/jubbad',
      accountLinked: false,
      enabled: false,
      summaryDefault: true,
      summaryAvailable: false
    });
  });

  it('GET shows an enabled group of a linked owner', async () => {
    const userId = await makeUser('host', linked());
    const code = await makeGroup(userId, { lineDmEnabled: true });
    requestUser = { id: userId, role: 'host' };
    const res = await request(server).get(`/groups/${code}/line/host`).expect(200);
    expect(res.body).toMatchObject({ accountLinked: true, enabled: true });
  });

  describe('POST code', () => {
    it('makes a code for the group and stores only its hash and the group code', async () => {
      const userId = await makeUser('host');
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      const res = await request(server).post(`/groups/${code}/line/host/code`).expect(201);
      expect(res.body.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{6}$`));
      const stored = await prisma.lineUserLinkCode.findMany({ where: { userId } });
      expect(stored).toHaveLength(1);
      expect(stored[0].codeHash).toBe(createHash('sha256').update(res.body.code).digest('hex'));
      expect(stored[0].groupCode).toBe(code);
      expect(JSON.stringify(stored[0])).not.toContain(res.body.code);
    });

    it('is 403 for a free owner', async () => {
      const userId = await makeUser('free');
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      const res = await request(server).post(`/groups/${code}/line/host/code`).expect(403);
      expect(res.body.code).toBe('PLAN_REQUIRED');
      expect(await prisma.lineUserLinkCode.count({ where: { userId } })).toBe(0);
    });

    it('is 409 LINE_ALREADY_LINKED when the owner account is already linked', async () => {
      const userId = await makeUser('host', linked());
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      const res = await request(server).post(`/groups/${code}/line/host/code`).expect(409);
      expect(res.body.code).toBe('LINE_ALREADY_LINKED');
      expect(await prisma.lineUserLinkCode.count({ where: { userId } })).toBe(0);
    });
  });

  describe('PUT', () => {
    it('switches the group on for a linked host owner and off again', async () => {
      const userId = await makeUser('host', linked());
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      const on = await request(server).put(`/groups/${code}/line/host`).send({ enabled: true }).expect(200);
      expect(on.body).toEqual({ enabled: true });
      expect(await flagOf(code)).toBe(true);
      const off = await request(server).put(`/groups/${code}/line/host`).send({ enabled: false }).expect(200);
      expect(off.body).toEqual({ enabled: false });
      expect(await flagOf(code)).toBe(false);
    });

    it('is 409 LINE_NOT_LINKED when the owner has no linked account', async () => {
      const userId = await makeUser('host');
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      const res = await request(server).put(`/groups/${code}/line/host`).send({ enabled: true }).expect(409);
      expect(res.body.code).toBe('LINE_NOT_LINKED');
      expect(await flagOf(code)).toBe(false);
    });

    it('is 403 to switch on for a free owner, but switching off still works', async () => {
      const userId = await makeUser('free', linked());
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      await request(server).put(`/groups/${code}/line/host`).send({ enabled: true }).expect(403);
      expect(await flagOf(code)).toBe(false);
      await prisma.group.update({ where: { code }, data: { lineDmEnabled: true } });
      const off = await request(server).put(`/groups/${code}/line/host`).send({ enabled: false }).expect(200);
      expect(off.body).toEqual({ enabled: false });
      expect(await flagOf(code)).toBe(false);
    });

    it('is 400 for a body without a boolean', async () => {
      const userId = await makeUser('host', linked());
      const code = await makeGroup(userId);
      requestUser = { id: userId, role: 'host' };
      await request(server).put(`/groups/${code}/line/host`).send({}).expect(400);
      await request(server).put(`/groups/${code}/line/host`).send({ enabled: 'yes' }).expect(400);
    });
  });

  it('DELETE unlinks the account and switches every owned group off, even for a free user', async () => {
    const userId = await makeUser('free', linked());
    const a = await makeGroup(userId, { lineDmEnabled: true });
    const b = await makeGroup(userId, { lineDmEnabled: true });
    requestUser = { id: userId, role: 'host' };
    const res = await request(server).delete(`/groups/${a}/line/host`).expect(200);
    expect(res.body).toEqual({ unlinked: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.lineUserId).toBeNull();
    expect(user.lineLinkedAt).toBeNull();
    expect(await flagOf(a)).toBe(false);
    expect(await flagOf(b)).toBe(false);
  });

  it("answers 404 on all four routes for a host who does not own the group, and changes nothing", async () => {
    const ownerId = await makeUser('host', linked());
    const code = await makeGroup(ownerId, { lineDmEnabled: true });
    const intruder = await makeUser('host');
    requestUser = { id: intruder, role: 'host' };
    await request(server).get(`/groups/${code}/line/host`).expect(404);
    await request(server).post(`/groups/${code}/line/host/code`).expect(404);
    await request(server).put(`/groups/${code}/line/host`).send({ enabled: false }).expect(404);
    await request(server).delete(`/groups/${code}/line/host`).expect(404);
    expect(await flagOf(code)).toBe(true);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.lineUserId).not.toBeNull();
    expect(await prisma.lineUserLinkCode.count({ where: { userId: { in: [ownerId, intruder] } } })).toBe(0);
  });

  it('no longer serves the old user-level /line/host routes', async () => {
    const userId = await makeUser('host');
    requestUser = { id: userId, role: 'host' };
    await request(server).get('/line/host').expect(404);
    await request(server).post('/line/host/code').expect(404);
    await request(server).delete('/line/host').expect(404);
  });
});

const lineIdFor = () => `U${randomUUID().replace(/-/g, '')}`;
