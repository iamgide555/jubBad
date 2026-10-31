import { randomUUID } from 'node:crypto';
import { ConflictException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { AppModule } from '../../app.module.js';
import { AuthBootstrapService } from '../../auth/bootstrap.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BillService } from '../bill.service.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';

const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];

const user = (name: string | null = 'Somchai'): LiffUser => ({
  userId: `U${randomUUID().replace(/-/g, '')}`,
  displayName: name,
  pictureUrl: null,
});

describe('slip payments: LINE account links', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bills: BillService;
  let slips: SlipPaymentsService;
  const groupCodes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    bills = app.get(BillService);
    slips = app.get(SlipPaymentsService);
  });

  afterAll(async () => {
    const where = { session: { groupId: { in: groupCodes } } };
    await prisma.sessionPayment.deleteMany({ where });
    await prisma.playerLineAccount.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await app.close();
  });

  /** Four players who played one game, an ended session with a bill. */
  async function setup() {
    const groupCode = `lnk-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({ data: { code: groupCode, name: 'ตีชิล' } });
    const ids: string[] = [];
    for (const name of NAMES) {
      ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    }
    const code = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code, groupId: groupCode, rawImportText: '', date: '2026-10-30', venue: 'Bad@Mama',
        shuttleCount: 3, shuttlePriceSatang: 8000,
      },
    });
    for (const id of ids) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: id } });
    const at = new Date('2026-10-30T13:00:00Z');
    await prisma.pairing.create({
      data: {
        sessionId: code, courtNumber: 1, matchNumber: 1,
        teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
        winner: 'A', confirmedAt: at, endedAt: at,
      },
    });
    await bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [],
    } as never);
    await prisma.session.update({ where: { code }, data: { endedAt: new Date('2026-10-30T15:00:00Z') } });
    return { code, groupCode, ids };
  }

  const linkCount = (groupCode: string) => prisma.playerLineAccount.count({ where: { groupId: groupCode } });

  describe('claimPlayer', () => {
    it('links the account to the player and linkedPlayerOf returns it', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user('Somchai');
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBeNull();
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('linked');
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[0]);
      expect(await prisma.playerLineAccount.findFirstOrThrow({ where: { groupId: groupCode } })).toMatchObject({
        playerId: ids[0], lineUserId: a.userId, displayName: 'Somchai', linkedBy: 'self',
      });
    });

    it('refuses a second account claiming the same player and changes nothing', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      const b = user();
      await slips.claimPlayer(code, a, ids[0]);
      expect(await slips.claimPlayer(code, b, ids[0])).toBe('player-taken');
      expect(await linkCount(groupCode)).toBe(1);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[0]);
      expect(await slips.linkedPlayerOf(groupCode, b.userId)).toBeNull();
    });

    it('refuses the same account claiming a second player and changes nothing', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.claimPlayer(code, a, ids[0]);
      expect(await slips.claimPlayer(code, a, ids[1])).toBe('account-already-linked');
      expect(await linkCount(groupCode)).toBe(1);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[0]);
    });

    it('is idempotent when the same account re-claims its own player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.claimPlayer(code, a, ids[0]);
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('linked');
      expect(await linkCount(groupCode)).toBe(1);
    });

    it('refuses a player who is not on the bill, or belongs to another group', async () => {
      const { code, groupCode, ids } = await setup();
      const stranger = await prisma.player.create({ data: { groupId: groupCode, name: 'คนนอก', aliases: '[]' } });
      const other = await setup();
      const a = user();
      expect(await slips.claimPlayer(code, a, stranger.id)).toBe('not-on-bill');
      expect(await slips.claimPlayer(code, a, other.ids[0])).toBe('not-on-bill');
      expect(await slips.claimPlayer(code, a, 'no-such-player')).toBe('not-on-bill');
      expect(await linkCount(groupCode)).toBe(0);
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('linked');
    });

    it('throws NotFound for an unknown session code', async () => {
      await expect(slips.claimPlayer('no-such-session', user(), 'x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('claimPlayer racing another session of the same group', () => {
    const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });

    /** The next create loses: a competing row is written first (as if another session won), then P2002 is thrown. */
    function loseRaceTo(groupCode: string, winner: { playerId: string; lineUserId: string }) {
      const create = prisma.playerLineAccount.create.bind(prisma.playerLineAccount);
      return vi.spyOn(prisma.playerLineAccount, 'create').mockImplementationOnce((async () => {
        await create({ data: { groupId: groupCode, linkedBy: 'self', displayName: null, ...winner } });
        throw p2002();
      }) as never);
    }

    afterEach(() => vi.restoreAllMocks());

    it('answers linked when the winning row is this very account on this player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      loseRaceTo(groupCode, { playerId: ids[0], lineUserId: a.userId });
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('linked');
      expect(await linkCount(groupCode)).toBe(1);
    });

    it('answers account-already-linked when the winning row put this account on another player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      loseRaceTo(groupCode, { playerId: ids[1], lineUserId: a.userId });
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('account-already-linked');
      expect(await linkCount(groupCode)).toBe(1);
    });

    it('answers player-taken when the winning row put another account on this player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      const winner = user();
      loseRaceTo(groupCode, { playerId: ids[0], lineUserId: winner.userId });
      expect(await slips.claimPlayer(code, a, ids[0])).toBe('player-taken');
      expect(await slips.linkedPlayerOf(groupCode, winner.userId)).toBe(ids[0]);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBeNull();
    });

    it('rethrows an error that is not a unique violation', async () => {
      const { code } = await setup();
      vi.spyOn(prisma.playerLineAccount, 'create').mockRejectedValueOnce(new Error('disk full') as never);
      const { ids } = await prisma.session
        .findUniqueOrThrow({ where: { code }, include: { roster: true } })
        .then((x) => ({ ids: x.roster.map((r) => r.playerId) }));
      await expect(slips.claimPlayer(code, user(), ids[0])).rejects.toThrow('disk full');
    });

    it('setLink turns a unique violation into ACCOUNT_ALREADY_LINKED and leaves the old link', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.claimPlayer(code, a, ids[0]);
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(p2002() as never);
      const error = await slips.setLink(code, ids[0], user().userId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' });
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[0]);
    });
  });

  describe('setLink', () => {
    it('removes the player link with null, and is a no-op when there is none', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.claimPlayer(code, a, ids[0]);
      await slips.setLink(code, ids[0], null);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBeNull();
      expect(await linkCount(groupCode)).toBe(0);
      await expect(slips.setLink(code, ids[0], null)).resolves.toBeUndefined();
    });

    it('refuses an account already linked to another player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.claimPlayer(code, a, ids[0]);
      const error = await slips.setLink(code, ids[1], a.userId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' });
      expect(await linkCount(groupCode)).toBe(1);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[0]);
    });

    it('repoints an existing link to another account as a host link', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user('Somchai');
      const b = user('Malee');
      await slips.claimPlayer(code, a, ids[0]);
      await slips.setLink(code, ids[0], b.userId);
      expect(await linkCount(groupCode)).toBe(1);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBeNull();
      expect(await slips.linkedPlayerOf(groupCode, b.userId)).toBe(ids[0]);
      expect(await prisma.playerLineAccount.findFirstOrThrow({ where: { groupId: groupCode } })).toMatchObject({
        playerId: ids[0], lineUserId: b.userId, displayName: null, linkedBy: 'host',
      });
    });

    it('creates a host link for a player with none, and accepts the account already on that player', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user();
      await slips.setLink(code, ids[2], a.userId);
      expect(await slips.linkedPlayerOf(groupCode, a.userId)).toBe(ids[2]);
      await slips.setLink(code, ids[2], a.userId);
      expect(await linkCount(groupCode)).toBe(1);
    });

    it('flips a self link of the same account to host in place, keeping its name and age', async () => {
      const { code, groupCode, ids } = await setup();
      const a = user('Somchai');
      await slips.claimPlayer(code, a, ids[0]);
      const before = await prisma.playerLineAccount.findFirstOrThrow({ where: { groupId: groupCode } });
      await slips.setLink(code, ids[0], a.userId);
      const after = await prisma.playerLineAccount.findFirstOrThrow({ where: { groupId: groupCode } });
      expect(after).toMatchObject({ id: before.id, displayName: 'Somchai', linkedBy: 'host', lineUserId: a.userId });
      expect(after.createdAt).toEqual(before.createdAt);
      expect(await linkCount(groupCode)).toBe(1);
    });

    it('refuses a player outside the session group', async () => {
      const { code } = await setup();
      const other = await setup();
      const error = await slips.setLink(code, other.ids[0], user().userId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PLAYER_NOT_IN_GROUP' });
      await expect(slips.setLink(code, 'no-such-player', user().userId)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFound for an unknown session code', async () => {
      await expect(slips.setLink('no-such-session', 'x', null)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listLinks', () => {
    it('lists the group links oldest first with their self/host label', async () => {
      const { code, ids } = await setup();
      expect(await slips.listLinks(code)).toEqual([]);
      await slips.claimPlayer(code, user('Somchai'), ids[0]);
      await slips.setLink(code, ids[1], user().userId);
      expect(await slips.listLinks(code)).toEqual([
        { playerId: ids[0], displayName: 'Somchai', linkedBy: 'self' },
        { playerId: ids[1], displayName: null, linkedBy: 'host' },
      ]);
    });

    it('throws NotFound for an unknown session code', async () => {
      await expect(slips.listLinks('no-such-session')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
