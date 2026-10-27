import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { LineRosterService } from './line-roster.service.js';
import { LineModule } from './line.module.js';

const ROSTER = 'ก๊วนพฤหัส 8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด\n3. นก';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('LineRosterService capture, edit, unsend and purge', () => {
  const fakeClient = { reply: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn() };
  let prisma: PrismaService;
  let roster: LineRosterService;
  let hostId: string;
  let freeId: string;

  const lineId = () => `C${randomUUID().replace(/-/g, '')}`;
  const messageId = () => randomUUID();

  async function linkedGroup(ownerId = hostId) {
    const lineGroupId = lineId();
    const code = `lr-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({
      data: { code, name: code, ownerId, lineGroupId, lineLinkedAt: new Date() },
    });
    return { code, lineGroupId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, LineModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    roster = moduleRef.get(LineRosterService);
    const tag = randomUUID();
    hostId = (
      await prisma.user.create({
        data: { email: `lr-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' },
      })
    ).id;
    freeId = (
      await prisma.user.create({
        data: { email: `lr-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
      })
    ).id;
  });

  beforeEach(() => {
    fakeClient.memberName.mockReset().mockResolvedValue('Nok');
  });

  describe('capture', () => {
    it('stores a roster from a linked, paid group with the sender name and the event time', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const postedAt = new Date('2026-10-26T11:42:00Z');
      const id = messageId();
      const result = await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U1', postedAt });
      expect(result).toBe('stored');
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row).toMatchObject({ groupId: code, text: ROSTER, senderUserId: 'U1', senderName: 'Nok', botPosted: false });
      expect(row.postedAt.toISOString()).toBe(postedAt.toISOString());
      expect(fakeClient.memberName).toHaveBeenCalledWith(lineGroupId, 'U1');
    });

    it('stores the same LINE message id once', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const input = { lineGroupId, lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: new Date() };
      expect(await roster.capture(input)).toBe('stored');
      expect(await roster.capture(input)).toBe('ignored');
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(1);
    });

    it('does not store ordinary chat', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const result = await roster.capture({
        lineGroupId, lineMessageId: messageId(), text: 'ไปไหมคืนนี้', senderUserId: 'U1', postedAt: new Date(),
      });
      expect(result).toBe('ignored');
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('does not store a numbered post that has no date, venue or time', async () => {
      const { code, lineGroupId } = await linkedGroup();
      await roster.capture({
        lineGroupId, lineMessageId: messageId(), text: 'กฎก๊วน\n1. มาตรงเวลา\n2. ห้ามเสียงดัง\n3. จ่ายก่อนกลับ',
        senderUserId: 'U1', postedAt: new Date(),
      });
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('ignores a LINE group that is not linked', async () => {
      const result = await roster.capture({
        lineGroupId: lineId(), lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: new Date(),
      });
      expect(result).toBe('ignored');
    });

    it('ignores a group whose owner is on the free plan', async () => {
      const { code, lineGroupId } = await linkedGroup(freeId);
      const result = await roster.capture({
        lineGroupId, lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: new Date(),
      });
      expect(result).toBe('ignored');
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
    });

    it('stores a null name when LINE will not give one', async () => {
      const { lineGroupId } = await linkedGroup();
      fakeClient.memberName.mockResolvedValue(null);
      const id = messageId();
      await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U1', postedAt: new Date() });
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect([row.senderUserId, row.senderName]).toEqual(['U1', null]);
    });

    it('stores null sender fields and skips the name lookup when the event has no user id', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = messageId();
      await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: null, postedAt: new Date() });
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect([row.senderUserId, row.senderName]).toEqual([null, null]);
      expect(fakeClient.memberName).not.toHaveBeenCalled();
    });

    it('keeps only the newest 20 per group', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const base = Date.now() - 2 * HOUR;
      for (let i = 0; i < 22; i++) {
        await roster.capture({
          lineGroupId, lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: new Date(base + i * 1000),
        });
      }
      const rows = await prisma.lineRosterMessage.findMany({ where: { groupId: code }, orderBy: { postedAt: 'asc' } });
      expect(rows).toHaveLength(20);
      expect(rows[0].postedAt.getTime()).toBe(base + 2 * 1000);
    });

    it('decides newest by the LINE event time, not arrival order', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const t1 = new Date('2026-10-26T10:00:00Z');
      const t2 = new Date('2026-10-26T11:00:00Z');
      await roster.capture({ lineGroupId, lineMessageId: messageId(), text: `${ROSTER}\n4. B`, senderUserId: 'U1', postedAt: t2 });
      await roster.capture({ lineGroupId, lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: t1 });
      const newest = await prisma.lineRosterMessage.findFirstOrThrow({ where: { groupId: code }, orderBy: { postedAt: 'desc' } });
      expect(newest.text).toBe(`${ROSTER}\n4. B`);
    });
  });

  describe('edit', () => {
    it('replaces the stored text and keeps the original time', async () => {
      const { code, lineGroupId } = await linkedGroup();
      const id = messageId();
      const postedAt = new Date('2026-10-26T10:00:00Z');
      await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U1', postedAt });
      const edited = `${ROSTER}\n4. แมว`;
      const result = await roster.edit({
        lineGroupId, lineMessageId: id, text: edited, senderUserId: 'U1', postedAt: new Date('2026-10-26T12:00:00Z'),
      });
      expect(result).toBe('updated');
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row.text).toBe(edited);
      expect(row.postedAt.toISOString()).toBe(postedAt.toISOString());
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(1);
    });

    it('deletes the row when the edited text is no longer a roster', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = messageId();
      await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U1', postedAt: new Date() });
      const result = await roster.edit({ lineGroupId, lineMessageId: id, text: 'ขอโทษ ส่งผิด', senderUserId: 'U1', postedAt: new Date() });
      expect(result).toBe('removed');
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
    });

    it('stores a never-stored message that was edited into a roster, with the event time', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = messageId();
      const at = new Date('2026-10-26T13:00:00Z');
      const result = await roster.edit({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U2', postedAt: at });
      expect(result).toBe('stored');
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row.postedAt.toISOString()).toBe(at.toISOString());
    });

    it('ignores an edit in an unlinked group', async () => {
      const result = await roster.edit({
        lineGroupId: lineId(), lineMessageId: messageId(), text: ROSTER, senderUserId: 'U1', postedAt: new Date(),
      });
      expect(result).toBe('ignored');
    });

    it('ignores an edit for a free owner and leaves the stored text alone', async () => {
      const { lineGroupId } = await linkedGroup(freeId);
      const id = messageId();
      const group = await prisma.group.findUniqueOrThrow({ where: { lineGroupId } });
      await prisma.lineRosterMessage.create({
        data: { groupId: group.code, text: ROSTER, postedAt: new Date(), lineMessageId: id },
      });
      const result = await roster.edit({ lineGroupId, lineMessageId: id, text: `${ROSTER}\n4. X`, senderUserId: 'U1', postedAt: new Date() });
      expect(result).toBe('ignored');
      expect((await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } })).text).toBe(ROSTER);
    });
  });

  describe('unsend', () => {
    it('removes the stored row, and an unknown id is a no-op', async () => {
      const { lineGroupId } = await linkedGroup();
      const id = messageId();
      await roster.capture({ lineGroupId, lineMessageId: id, text: ROSTER, senderUserId: 'U1', postedAt: new Date() });
      await roster.unsend(id);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
      await expect(roster.unsend(messageId())).resolves.toBeUndefined();
    });
  });

  describe('latest', () => {
    async function addMessage(groupId: string, postedAt: Date, text = ROSTER) {
      return prisma.lineRosterMessage.create({
        data: { groupId, text, postedAt, lineMessageId: messageId(), senderName: 'Nok', senderUserId: 'U1' },
      });
    }
    async function endSession(groupId: string, endedAt: Date) {
      await prisma.session.create({
        data: { code: `ls-${randomUUID().slice(0, 12)}`, groupId, rawImportText: '', endedAt },
      });
    }
    const now = new Date('2026-10-26T12:00:00Z');

    it('returns the newest by posted time, not the last inserted', async () => {
      const { code } = await linkedGroup();
      await addMessage(code, new Date(now.getTime() - HOUR), `${ROSTER}\n4. ใหม่`);
      await addMessage(code, new Date(now.getTime() - 3 * HOUR), ROSTER);
      const latest = await roster.latest(code, now);
      expect(latest).toEqual({
        text: `${ROSTER}\n4. ใหม่`,
        senderName: 'Nok',
        postedAt: new Date(now.getTime() - HOUR).toISOString(),
        stale: false,
        direct: false,
      });
    });

    it('is stale when a session ended after it was posted, fresh when it is newer', async () => {
      const { code } = await linkedGroup();
      await endSession(code, new Date(now.getTime() - 2 * HOUR));
      await addMessage(code, new Date(now.getTime() - 5 * HOUR));
      expect((await roster.latest(code, now))?.stale).toBe(true);
      await addMessage(code, new Date(now.getTime() - HOUR));
      expect((await roster.latest(code, now))?.stale).toBe(false);
    });

    it('with no session, an 8 day old message is stale and a 1 day old one is fresh', async () => {
      const old = await linkedGroup();
      await addMessage(old.code, new Date(now.getTime() - 8 * DAY));
      expect((await roster.latest(old.code, now))?.stale).toBe(true);
      const recent = await linkedGroup();
      await addMessage(recent.code, new Date(now.getTime() - DAY));
      expect((await roster.latest(recent.code, now))?.stale).toBe(false);
    });

    it('is null for a linked group with no message', async () => {
      const { code } = await linkedGroup();
      expect(await roster.latest(code, now)).toBeNull();
    });

    it('is null for a group that is not linked', async () => {
      const code = `lr-${randomUUID().slice(0, 10)}`;
      await prisma.group.create({ data: { code, name: code, ownerId: hostId } });
      await addMessage(code, new Date(now.getTime() - HOUR));
      expect(await roster.latest(code, now)).toBeNull();
    });

    it('is null when the owner is on the free plan', async () => {
      const { code } = await linkedGroup(freeId);
      await addMessage(code, new Date(now.getTime() - HOUR));
      expect(await roster.latest(code, now)).toBeNull();
    });
  });

  describe('latest for a host DM link', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const dmText = `${ROSTER}\n4. ทาง DM`;

    async function dmOwner(plan: 'host' | 'free', linked = true) {
      return (
        await prisma.user.create({
          data: {
            email: `lr-dm-${randomUUID()}@example.test`,
            passwordHash: 'x',
            role: 'host',
            plan,
            lineUserId: linked ? `U${randomUUID().replace(/-/g, '')}` : null,
          },
        })
      ).id;
    }
    async function groupOf(ownerId: string, lineGroupId: string | null = null) {
      const code = `lr-${randomUUID().slice(0, 10)}`;
      await prisma.group.create({ data: { code, name: code, ownerId, lineGroupId, lineLinkedAt: lineGroupId ? new Date() : null } });
      return code;
    }
    async function addMessage(groupId: string, postedAt: Date, direct: boolean, text = ROSTER) {
      return prisma.lineRosterMessage.create({
        data: { groupId, text, postedAt, direct, lineMessageId: messageId(), senderName: 'Nok', senderUserId: 'U1' },
      });
    }

    it('returns a stored DM roster for a group with no LINE group when the owner has a host link', async () => {
      const code = await groupOf(await dmOwner('host'));
      const postedAt = new Date(now.getTime() - HOUR);
      await addMessage(code, postedAt, true, dmText);
      expect(await roster.latest(code, now)).toEqual({
        text: dmText,
        senderName: 'Nok',
        postedAt: postedAt.toISOString(),
        stale: false,
        direct: true,
      });
    });

    it('is null for the same group when the owner has no host link', async () => {
      const code = await groupOf(await dmOwner('host', false));
      await addMessage(code, new Date(now.getTime() - HOUR), true);
      expect(await roster.latest(code, now)).toBeNull();
    });

    it('is null when the linked owner has lapsed to the free plan', async () => {
      const code = await groupOf(await dmOwner('free'));
      await addMessage(code, new Date(now.getTime() - HOUR), true);
      expect(await roster.latest(code, now)).toBeNull();
    });

    it('with both links, returns the newest across a group-captured and a DM-captured row', async () => {
      const code = await groupOf(await dmOwner('host'), lineId());
      await addMessage(code, new Date(now.getTime() - 3 * HOUR), false, ROSTER);
      await addMessage(code, new Date(now.getTime() - HOUR), true, dmText);
      expect(await roster.latest(code, now)).toMatchObject({ text: dmText, direct: true });
      await addMessage(code, new Date(now.getTime() - 30 * 60 * 1000), false, `${ROSTER}\n4. กลุ่ม`);
      expect(await roster.latest(code, now)).toMatchObject({ text: `${ROSTER}\n4. กลุ่ม`, direct: false });
    });

    it('stale still follows the group last finished session', async () => {
      const code = await groupOf(await dmOwner('host'));
      await prisma.session.create({
        data: { code: `ls-${randomUUID().slice(0, 12)}`, groupId: code, rawImportText: '', endedAt: new Date(now.getTime() - 2 * HOUR) },
      });
      await addMessage(code, new Date(now.getTime() - 5 * HOUR), true);
      expect((await roster.latest(code, now))?.stale).toBe(true);
      await addMessage(code, new Date(now.getTime() - HOUR), true);
      expect((await roster.latest(code, now))?.stale).toBe(false);
    });
  });

  describe('purge', () => {
    it('removes a row older than 30 days and keeps the recent ones', async () => {
      const { code } = await linkedGroup();
      const now = new Date();
      await prisma.lineRosterMessage.create({
        data: { groupId: code, text: ROSTER, postedAt: new Date(now.getTime() - 31 * DAY), lineMessageId: messageId() },
      });
      await prisma.lineRosterMessage.create({
        data: { groupId: code, text: ROSTER, postedAt: new Date(now.getTime() - HOUR), lineMessageId: messageId() },
      });
      const removed = await roster.purge(now);
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(1);
    });
  });
});
