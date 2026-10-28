import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { LineHostRosterService, type HostReply } from './line-host-roster.service.js';
import { LineModule } from './line.module.js';

const ROSTER = 'ก๊วนพฤหัส 8/10/26\n19.00-21.00\n1. ตั้ม\n2. มด\n3. นก';
const ROSTER_2 = 'ก๊วนศุกร์ 9/10/26\n19.00-21.00\n1. ต้น\n2. แบงค์\n3. เบียร์';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type QuickReply = { text: string; quickReply: { items: { action: { label: string; data: string } }[] } };

describe('LineHostRosterService receive and choose', () => {
  const fakeClient = {
    reply: vi.fn(), replyMessages: vi.fn(), groupName: vi.fn(), memberName: vi.fn(), leave: vi.fn()
  };
  let prisma: PrismaService;
  let service: LineHostRosterService;
  const userIds: string[] = [];

  const lineUserId = () => `U${randomUUID().replace(/-/g, '')}`;
  const messageId = () => randomUUID();

  /** A JubBad user with a linked LINE account. */
  async function host(plan = 'host', extra: Record<string, unknown> = {}) {
    const line = lineUserId();
    const user = await prisma.user.create({
      data: {
        email: `lhr-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'host',
        plan,
        lineUserId: line,
        lineLinkedAt: new Date(),
        ...extra
      }
    });
    userIds.push(user.id);
    return { userId: user.id, line };
  }

  /** A group the host owns; DM capture is on unless said otherwise, since only those groups are offered. */
  async function group(ownerId: string, name: string | null = null, createdAt?: Date, lineDmEnabled = true) {
    const code = `lhr-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({
      data: { code, name: name ?? code, ownerId, lineDmEnabled, ...(createdAt ? { createdAt } : {}) }
    });
    return code;
  }

  function choices(reply: HostReply): { label: string; data: string; pendingId: string; groupCode: string }[] {
    if (reply.kind !== 'messages') throw new Error(`expected quick reply, got: ${reply.text}`);
    const message = reply.messages[0] as QuickReply;
    return message.quickReply.items.map(({ action }) => {
      const parsed = /^pr:([^:]+):(.+)$/.exec(action.data);
      if (!parsed) throw new Error(`unparseable data ${action.data}`);
      return { label: action.label, data: action.data, pendingId: parsed[1], groupCode: parsed[2] };
    });
  }

  /** A DM from `from`: a roster with a fresh message id unless overridden. */
  const dm = (from: string, overrides: { lineMessageId?: string; text?: string } = {}) =>
    service.receive({ lineUserId: from, lineMessageId: messageId(), text: ROSTER, postedAt: new Date(), ...overrides });

  const text = (reply: HostReply) => (reply.kind === 'text' ? reply.text : '');
  const rowsFor = (groupId: string) => prisma.lineRosterMessage.findMany({ where: { groupId } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, LineModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(LineHostRosterService);
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe('receive', () => {
    it('tells an unlinked LINE user to link first and stores nothing', async () => {
      const id = messageId();
      const reply = await dm(lineUserId(), { lineMessageId: id });
      expect(reply.kind).toBe('text');
      expect(text(reply)).toContain('JubBad > ตั้งค่ากลุ่ม > LINE');
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
    });

    it('refuses text that is not a roster and stores nothing', async () => {
      const { userId, line } = await host();
      const code = await group(userId);
      await group(userId);
      const reply = await dm(line, { text: 'ไปไหมคืนนี้' });
      expect(text(reply)).toContain('ไม่เหมือนรายชื่อ');
      expect(await rowsFor(code)).toHaveLength(0);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('says why when the host owns no group', async () => {
      const { userId, line } = await host();
      const reply = await dm(line);
      expect(text(reply)).toContain('ยังไม่มีก๊วน');
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('says why when the host owns groups but none has DM capture on, and stores or holds nothing', async () => {
      const { userId, line } = await host();
      const a = await group(userId, 'ก๊วน A', undefined, false);
      const b = await group(userId, 'ก๊วน B', undefined, false);
      const id = messageId();
      const reply = await dm(line, { lineMessageId: id });
      expect(reply.kind).toBe('text');
      expect(text(reply)).toContain('ยังไม่มีก๊วนที่เปิดรับรายชื่อ');
      expect(text(reply)).toContain('JubBad > ตั้งค่ากลุ่ม > LINE');
      expect(await rowsFor(a)).toHaveLength(0);
      expect(await rowsFor(b)).toHaveLength(0);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: id } })).toBe(0);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('stores straight into the only enabled group of two, with no question', async () => {
      const { userId, line } = await host();
      const a = await group(userId, 'ก๊วน A');
      const b = await group(userId, 'ก๊วน B', undefined, false);
      const id = messageId();
      const reply = await dm(line, { lineMessageId: id });
      expect(reply.kind).toBe('text');
      expect(text(reply)).toContain('ก๊วน A');
      expect(await rowsFor(a)).toHaveLength(1);
      expect(await rowsFor(b)).toHaveLength(0);
      expect((await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } })).direct).toBe(true);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('asks only about the enabled groups when two of three have DM capture on', async () => {
      const { userId, line } = await host();
      const a = await group(userId, 'ก๊วน A', new Date(Date.now() - 3 * DAY));
      await group(userId, 'ก๊วน off', new Date(Date.now() - 2 * DAY), false);
      const b = await group(userId, 'ก๊วน B', new Date(Date.now() - DAY));
      const picks = choices(await dm(line));
      expect(picks.map((p) => p.groupCode)).toEqual([b, a]);
    });

    it('never offers or stores into an enabled group that belongs to another owner', async () => {
      const mine = await host();
      const theirs = await host();
      const mineCode = await group(mine.userId, 'ก๊วนฉัน');
      const theirCode = await group(theirs.userId, 'ก๊วนเขา');
      const reply = await dm(mine.line);
      expect(text(reply)).toContain('ก๊วนฉัน');
      expect(await rowsFor(mineCode)).toHaveLength(1);
      expect(await rowsFor(theirCode)).toHaveLength(0);
      // a host whose only enabled-looking group is someone else's has none of their own
      const lone = await host();
      const reply2 = await dm(lone.line);
      expect(text(reply2)).toContain('ยังไม่มีก๊วน');
      expect(await rowsFor(theirCode)).toHaveLength(0);
    });

    it('says why when the host is not on a paid plan, and stores nothing', async () => {
      const { userId, line } = await host('free');
      const a = await group(userId);
      const reply = await dm(line);
      expect(text(reply)).toContain('แพ็กเกจ Host');
      expect(await rowsFor(a)).toHaveLength(0);
    });

    it('says why when the paid plan lapsed, and asks nothing for two groups', async () => {
      const { userId, line } = await host('host', { planRenewsAt: new Date(Date.now() - DAY) });
      await group(userId);
      await group(userId);
      const reply = await dm(line);
      expect(text(reply)).toContain('แพ็กเกจ Host');
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('stores straight into the only group, with no sender name, and names the group', async () => {
      const { userId, line } = await host();
      const code = await group(userId, 'ก๊วนพฤหัส');
      const id = messageId();
      const postedAt = new Date('2026-10-28T11:00:00Z');
      const reply = await service.receive({ lineUserId: line, lineMessageId: id, text: ROSTER, postedAt });
      expect(text(reply)).toContain('ก๊วนพฤหัส');
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: id } });
      expect(row).toMatchObject({
        groupId: code,
        text: ROSTER,
        senderName: null,
        senderUserId: line,
        botPosted: false,
        direct: true
      });
      expect(row.postedAt.toISOString()).toBe(postedAt.toISOString());
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(0);
    });

    it('purges the group after storing, like a group capture', async () => {
      const { userId, line } = await host();
      const code = await group(userId);
      await prisma.lineRosterMessage.create({
        data: { groupId: code, text: ROSTER, postedAt: new Date(Date.now() - 31 * DAY), lineMessageId: messageId() }
      });
      await dm(line);
      expect(await rowsFor(code)).toHaveLength(1);
    });

    it('a redelivered message id stores one row and answers the same way', async () => {
      const { userId, line } = await host();
      const code = await group(userId, 'ก๊วนเดียว');
      const input = { lineUserId: line, lineMessageId: messageId(), text: ROSTER, postedAt: new Date() };
      const first = await service.receive(input);
      const second = await service.receive(input);
      expect(second).toEqual(first);
      expect(await rowsFor(code)).toHaveLength(1);
    });

    it('asks which group when the host owns two, with postback data that parses back', async () => {
      const { userId, line } = await host();
      const a = await group(userId, 'ก๊วน A', new Date(Date.now() - 2 * DAY));
      const b = await group(userId, 'ก๊วน B', new Date(Date.now() - DAY));
      const id = messageId();
      const postedAt = new Date('2026-10-28T11:00:00Z');
      const reply = await service.receive({ lineUserId: line, lineMessageId: id, text: ROSTER, postedAt });
      const picks = choices(reply);
      const pending = await prisma.linePendingRoster.findUniqueOrThrow({ where: { userId } });
      expect(pending).toMatchObject({ text: ROSTER, lineMessageId: id });
      expect(pending.postedAt.toISOString()).toBe(postedAt.toISOString());
      expect(picks.map((p) => [p.label, p.groupCode])).toEqual([
        ['ก๊วน B', b],
        ['ก๊วน A', a]
      ]);
      expect(picks.every((p) => p.pendingId === pending.id)).toBe(true);
      expect(picks.every((p) => p.data.length <= 300)).toBe(true);
      expect(await rowsFor(a)).toHaveLength(0);
      expect(await rowsFor(b)).toHaveLength(0);
    });

    it('a second DM replaces the pending roster, with a new id and both timestamps renewed', async () => {
      const { userId, line } = await host();
      await group(userId);
      await group(userId);
      await service.receive({
        lineUserId: line,
        lineMessageId: messageId(),
        text: ROSTER,
        postedAt: new Date(Date.now() - 5 * MINUTE)
      });
      const first = await prisma.linePendingRoster.findUniqueOrThrow({ where: { userId } });
      await prisma.linePendingRoster.update({
        where: { id: first.id },
        data: { createdAt: new Date(Date.now() - 5 * MINUTE) }
      });
      const secondPostedAt = new Date();
      const reply = await service.receive({
        lineUserId: line,
        lineMessageId: messageId(),
        text: ROSTER_2,
        postedAt: secondPostedAt
      });
      const second = await prisma.linePendingRoster.findUniqueOrThrow({ where: { userId } });
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(1);
      expect(second.id).not.toBe(first.id);
      expect(second.text).toBe(ROSTER_2);
      expect(second.postedAt.toISOString()).toBe(secondPostedAt.toISOString());
      expect(second.createdAt.getTime()).toBeGreaterThan(Date.now() - MINUTE);
      expect(choices(reply)[0].pendingId).toBe(second.id);
    });

    it('a redelivered DM keeps the same pending roster and the same buttons', async () => {
      const { userId, line } = await host();
      await group(userId);
      await group(userId);
      const input = { lineUserId: line, lineMessageId: messageId(), text: ROSTER, postedAt: new Date() };
      const first = await service.receive(input);
      const second = await service.receive(input);
      expect(second).toEqual(first);
      expect(await prisma.linePendingRoster.count({ where: { userId } })).toBe(1);
    });

    it('cuts a long group name in the button label only, and falls back to the code for an empty name', async () => {
      const { userId, line } = await host();
      const long = 'ก๊วนแบดมินตันวันพฤหัสบดีท';
      expect(long.length).toBe(25);
      const longCode = await group(userId, long, new Date(Date.now() - DAY));
      const emptyCode = `lhr-${randomUUID().slice(0, 10)}`;
      await prisma.group.create({ data: { code: emptyCode, name: '', ownerId: userId, lineDmEnabled: true } });
      const picks = choices(await dm(line));
      const byCode = new Map(picks.map((p) => [p.groupCode, p]));
      expect(byCode.get(longCode)!.label).toBe(long.slice(0, 20));
      expect(byCode.get(emptyCode)!.label).toBe(emptyCode.slice(0, 20));
      const done = await service.choose({ lineUserId: line, data: byCode.get(longCode)!.data });
      expect(done.text).toContain(long);
    });

    it('offers only the 13 most recently created groups when there are 14', async () => {
      const { userId, line } = await host('club');
      const codes: string[] = [];
      for (let i = 0; i < 14; i++) codes.push(await group(userId, `g${i}`, new Date(Date.now() - (14 - i) * DAY)));
      const picks = choices(await dm(line));
      expect(picks).toHaveLength(13);
      expect(picks.map((p) => p.groupCode)).not.toContain(codes[0]);
      expect(picks[0].groupCode).toBe(codes[13]);
    });
  });

  describe('choose', () => {
    async function pendingFor(text = ROSTER) {
      const owner = await host();
      const a = await group(owner.userId, 'ก๊วน A');
      const b = await group(owner.userId, 'ก๊วน B');
      const lineMessageId = messageId();
      const postedAt = new Date(Date.now() - MINUTE);
      const picks = choices(await service.receive({ lineUserId: owner.line, lineMessageId, text, postedAt }));
      const pick = (code: string) => picks.find((p) => p.groupCode === code)!;
      return { ...owner, a, b, lineMessageId, postedAt, pick };
    }

    async function nothingMoved(p: Awaited<ReturnType<typeof pendingFor>>) {
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: p.lineMessageId } })).toBe(0);
      expect(await rowsFor(p.a)).toHaveLength(0);
      expect(await rowsFor(p.b)).toHaveLength(0);
    }

    it('moves the pending roster into the tapped group, deletes it, and names the group', async () => {
      const p = await pendingFor();
      const reply = await service.choose({ lineUserId: p.line, data: p.pick(p.b).data });
      expect(reply.kind).toBe('text');
      expect(reply.text).toContain('ก๊วน B');
      const row = await prisma.lineRosterMessage.findUniqueOrThrow({ where: { lineMessageId: p.lineMessageId } });
      expect(row).toMatchObject({ groupId: p.b, text: ROSTER, senderName: null, senderUserId: p.line, direct: true });
      expect(row.postedAt.toISOString()).toBe(p.postedAt.toISOString());
      expect(await rowsFor(p.a)).toHaveLength(0);
      expect(await prisma.linePendingRoster.count({ where: { userId: p.userId } })).toBe(0);
    });

    it('a second tap after a successful one is refused and stores nothing more', async () => {
      const p = await pendingFor();
      await service.choose({ lineUserId: p.line, data: p.pick(p.a).data });
      const again = await service.choose({ lineUserId: p.line, data: p.pick(p.b).data });
      expect(again.text).toContain('ส่งรายชื่อมาใหม่');
      expect(await rowsFor(p.a)).toHaveLength(1);
      expect(await rowsFor(p.b)).toHaveLength(0);
    });

    it('a DM redelivered after the tap confirms the chosen group and asks nothing', async () => {
      const p = await pendingFor();
      await service.choose({ lineUserId: p.line, data: p.pick(p.a).data });
      const reply = await service.receive({
        lineUserId: p.line,
        lineMessageId: p.lineMessageId,
        text: ROSTER,
        postedAt: p.postedAt
      });
      expect(reply.kind).toBe('text');
      expect(text(reply)).toContain('ก๊วน A');
      expect(await prisma.linePendingRoster.count({ where: { userId: p.userId } })).toBe(0);
      expect(await rowsFor(p.a)).toHaveLength(1);
    });

    it("refuses another LINE user's tap on the host's buttons", async () => {
      const p = await pendingFor();
      const stranger = await host();
      const reply = await service.choose({ lineUserId: stranger.line, data: p.pick(p.a).data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
      expect(await prisma.linePendingRoster.count({ where: { userId: p.userId } })).toBe(1);
    });

    it('refuses a tap from a LINE user who is not linked at all', async () => {
      const p = await pendingFor();
      const reply = await service.choose({ lineUserId: lineUserId(), data: p.pick(p.a).data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
    });

    it('refuses an expired pending roster', async () => {
      const p = await pendingFor();
      const reply = await service.choose({
        lineUserId: p.line,
        data: p.pick(p.a).data,
        now: new Date(Date.now() + 11 * MINUTE)
      });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
    });

    it('refuses the buttons of a pending roster a newer DM replaced', async () => {
      const p = await pendingFor();
      const newer = messageId();
      const fresh = choices(
        await service.receive({ lineUserId: p.line, lineMessageId: newer, text: ROSTER_2, postedAt: new Date() })
      );
      const stale = await service.choose({ lineUserId: p.line, data: p.pick(p.a).data });
      expect(stale.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: newer } })).toBe(0);
      const ok = await service.choose({ lineUserId: p.line, data: fresh.find((c) => c.groupCode === p.a)!.data });
      expect(ok.text).toContain('ก๊วน A');
      expect((await rowsFor(p.a)).map((r) => r.text)).toEqual([ROSTER_2]);
    });

    it('refuses a group deleted after the question', async () => {
      const p = await pendingFor();
      await prisma.group.delete({ where: { code: p.b } });
      const reply = await service.choose({ lineUserId: p.line, data: p.pick(p.b).data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      expect(await prisma.lineRosterMessage.count({ where: { lineMessageId: p.lineMessageId } })).toBe(0);
      expect(await prisma.linePendingRoster.count({ where: { userId: p.userId } })).toBe(1);
    });

    it('refuses a group switched off after the question, and stores nothing', async () => {
      const p = await pendingFor();
      await prisma.group.update({ where: { code: p.b }, data: { lineDmEnabled: false } });
      const reply = await service.choose({ lineUserId: p.line, data: p.pick(p.b).data });
      expect(reply.kind).toBe('text');
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
      // the refusal leaves the pending roster in place, like a deleted group does
      expect(await prisma.linePendingRoster.count({ where: { userId: p.userId } })).toBe(1);
      // the other group is still on and can still be tapped
      const ok = await service.choose({ lineUserId: p.line, data: p.pick(p.a).data });
      expect(ok.text).toContain('ก๊วน A');
      expect(await rowsFor(p.a)).toHaveLength(1);
    });

    it('refuses a group transferred to another owner after the question', async () => {
      const p = await pendingFor();
      const other = await host();
      await prisma.group.update({ where: { code: p.b }, data: { ownerId: other.userId } });
      const reply = await service.choose({ lineUserId: p.line, data: p.pick(p.b).data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
    });

    it("refuses forged data naming someone else's group with the host's own pending id", async () => {
      const p = await pendingFor();
      const other = await host();
      const theirs = await group(other.userId);
      const pendingId = /^pr:([^:]+):/.exec(p.pick(p.a).data)![1];
      const reply = await service.choose({ lineUserId: p.line, data: `pr:${pendingId}:${theirs}` });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      expect(await rowsFor(theirs)).toHaveLength(0);
      await nothingMoved(p);
    });

    it('refuses when the owner lapsed to free after the question', async () => {
      const p = await pendingFor();
      await prisma.user.update({ where: { id: p.userId }, data: { plan: 'free' } });
      const reply = await service.choose({ lineUserId: p.line, data: p.pick(p.a).data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
    });

    it.each(['', 'pr:', 'pr:onlyid', 'xx:abc:def', 'pr::code', 'pr:id:'])('refuses malformed data %j', async (data) => {
      const p = await pendingFor();
      const reply = await service.choose({ lineUserId: p.line, data });
      expect(reply.text).toContain('ส่งรายชื่อมาใหม่');
      await nothingMoved(p);
    });
  });
});
