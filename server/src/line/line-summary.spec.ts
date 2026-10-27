import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { LineSummaryService } from './line-summary.service.js';
import { LineModule } from './line.module.js';

describe('LineSummaryService', () => {
  const saved = { ...process.env };
  let prisma: PrismaService;
  let summary: LineSummaryService;
  const fakeClient = {
    reply: vi.fn(),
    groupName: vi.fn(),
    memberName: vi.fn(),
    leave: vi.fn(),
    push: vi.fn(),
  };
  let hostId: string;
  let freeId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, LineModule] })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    summary = moduleRef.get(LineSummaryService);
    const tag = randomUUID();
    hostId = (
      await prisma.user.create({
        data: { email: `sum-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' },
      })
    ).id;
    freeId = (
      await prisma.user.create({
        data: { email: `sum-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
      })
    ).id;
  });

  beforeEach(() => {
    fakeClient.push.mockReset().mockResolvedValue('ok');
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    process.env.PUBLIC_APP_URL = 'https://jubbad.test';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  /** A linked group whose owner is on `ownerId`'s plan, with a session of two finished games over four players. */
  async function setup(
    options: { ownerId?: string; linked?: boolean; games?: number; ended?: boolean; date?: string | null } = {}
  ): Promise<{ groupCode: string; sessionCode: string }> {
    const { ownerId = hostId, linked = true, games = 2, ended = true, date = '26 ต.ค.' } = options;
    const groupCode = `sum-${randomUUID().slice(0, 10)}`;
    await prisma.group.create({
      data: {
        code: groupCode,
        name: 'ก๊วนพฤหัส',
        ownerId,
        lineGroupId: linked ? `C${randomUUID().replace(/-/g, '')}` : null,
      },
    });
    const sessionCode = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        rawImportText: '',
        date,
        venue: 'Bad@Mama',
        endedAt: ended ? new Date('2026-10-26T14:00:00Z') : null,
      },
    });
    const ids = ['a', 'b', 'c', 'd'];
    const finished = new Date('2026-10-26T13:00:00Z');
    for (let i = 0; i < games; i += 1) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([ids[0], ids[1]]),
          teamB: JSON.stringify([ids[2], ids[3]]),
          winner: 'A',
          confirmedAt: finished,
          endedAt: finished,
        },
      });
    }
    return { groupCode, sessionCode };
  }

  it('reports the state of a linked, paid group with finished games', async () => {
    const { sessionCode } = await setup();
    expect(await summary.state(sessionCode)).toEqual({ available: true, sent: false, defaultOn: true });
  });

  it('sends one flex card with the night totals and records the send', async () => {
    const { groupCode, sessionCode } = await setup();
    expect(await summary.send(sessionCode)).toBe('sent');

    expect(fakeClient.push).toHaveBeenCalledTimes(1);
    const group = await prisma.group.findUniqueOrThrow({ where: { code: groupCode } });
    const [to, messages] = fakeClient.push.mock.calls[0];
    expect(to).toBe(group.lineGroupId);
    const card = messages[0];
    expect(card.type).toBe('flex');
    expect(card.altText).toBe('สรุปก๊วน ก๊วนพฤหัส 26 ต.ค.');
    const json = JSON.stringify(card.contents);
    expect(json).toContain('4 คน');
    expect(json).toContain('2 เกม');
    expect(json).toContain(`https://jubbad.test/s/${sessionCode}/summary`);

    const session = await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    expect(session.lineSummarySentAt).not.toBeNull();
    expect(await summary.state(sessionCode)).toMatchObject({ sent: true });
    // The retry key is stable per session, a UUID, so LINE can drop a duplicate of this exact push.
    expect(fakeClient.push.mock.calls[0][2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('never sends a second card for the same session', async () => {
    const { sessionCode } = await setup();
    expect(await summary.send(sessionCode)).toBe('sent');
    expect(await summary.send(sessionCode)).toBe('already-sent');
    expect(fakeClient.push).toHaveBeenCalledTimes(1);
  });

  it('sends exactly one card when two sends race', async () => {
    const { sessionCode } = await setup();
    const outcomes = await Promise.all([summary.send(sessionCode), summary.send(sessionCode)]);
    expect([...outcomes].sort()).toEqual(['already-sent', 'sent']);
    expect(fakeClient.push).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the push fails so a later send can try again', async () => {
    const { sessionCode } = await setup();
    fakeClient.push.mockResolvedValueOnce('failed');
    expect(await summary.send(sessionCode)).toBe('failed');
    const session = await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    expect(session.lineSummarySentAt).toBeNull();
    expect(session.lineSummaryClaimedAt).toBeNull();
    expect(await summary.send(sessionCode)).toBe('sent');
  });

  it('reports quota and releases the claim when LINE refuses for this month', async () => {
    const { sessionCode } = await setup();
    fakeClient.push.mockResolvedValueOnce('quota');
    expect(await summary.send(sessionCode)).toBe('quota');
    const session = await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    expect(session.lineSummarySentAt).toBeNull();
  });

  it('releases the claim and reports failed if the push throws', async () => {
    const { sessionCode } = await setup();
    fakeClient.push.mockRejectedValueOnce(new Error('boom'));
    expect(await summary.send(sessionCode)).toBe('failed');
    const session = await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    expect(session.lineSummarySentAt).toBeNull();
  });

  it('uses the same retry key for every attempt on one session and a different one per session', async () => {
    const one = await setup();
    const two = await setup();
    fakeClient.push.mockResolvedValueOnce('failed');
    await summary.send(one.sessionCode);
    await summary.send(one.sessionCode);
    await summary.send(two.sessionCode);
    const keys = fakeClient.push.mock.calls.map((c) => c[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('is not marked sent while a card is only claimed, and a fresh claim reads as busy', async () => {
    const { sessionCode } = await setup();
    await prisma.session.update({ where: { code: sessionCode }, data: { lineSummaryClaimedAt: new Date() } });
    expect(await summary.state(sessionCode)).toMatchObject({ sent: false });
    expect(await summary.send(sessionCode)).toBe('busy');
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('can send again when an earlier attempt claimed and then died without sending', async () => {
    const { sessionCode } = await setup();
    await prisma.session.update({
      where: { code: sessionCode },
      data: { lineSummaryClaimedAt: new Date(Date.now() - 2 * 60_000) },
    });
    expect(await summary.send(sessionCode)).toBe('sent');
    expect(fakeClient.push).toHaveBeenCalledTimes(1);
    const session = await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    expect(session.lineSummarySentAt).not.toBeNull();
  });

  it('writes a stored yyyy-mm-dd date on the card as a Thai date', async () => {
    const { sessionCode } = await setup({ date: '2026-10-29' });
    await summary.send(sessionCode);
    const altText = fakeClient.push.mock.calls[0][1][0].altText as string;
    expect(altText).not.toContain('2026-10-29');
    expect(altText).toContain('ต.ค.');
  });

  it('falls back to the end date when the session has no date text', async () => {
    const { sessionCode } = await setup({ date: null });
    await summary.send(sessionCode);
    expect(fakeClient.push.mock.calls[0][1][0].altText).toContain('ต.ค.');
  });

  describe('is unavailable and pushes nothing when', () => {
    async function expectUnavailable(sessionCode: string, stateAvailable = false) {
      expect((await summary.state(sessionCode)).available).toBe(stateAvailable);
      expect(await summary.send(sessionCode)).toBe('unavailable');
      expect(fakeClient.push).not.toHaveBeenCalled();
    }

    it("the owner's plan is free", async () => {
      const { sessionCode } = await setup({ ownerId: freeId });
      await expectUnavailable(sessionCode);
    });

    it('the group is not linked to a LINE group', async () => {
      const { sessionCode } = await setup({ linked: false });
      await expectUnavailable(sessionCode);
    });

    it('the public app url is not set', async () => {
      delete process.env.PUBLIC_APP_URL;
      const { sessionCode } = await setup();
      await expectUnavailable(sessionCode);
    });

    it('the bot is not configured', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      const { sessionCode } = await setup();
      await expectUnavailable(sessionCode);
    });

    it('no game finished', async () => {
      const { sessionCode } = await setup({ games: 0 });
      await expectUnavailable(sessionCode);
    });

    it('the session has not ended yet (the dialog may still ask, but nothing sends)', async () => {
      const { sessionCode } = await setup({ ended: false });
      await expectUnavailable(sessionCode, true);
    });

    it('the session does not exist', async () => {
      expect(await summary.send('nope-nope')).toBe('unavailable');
      expect((await summary.state('nope-nope')).available).toBe(false);
    });
  });
});
