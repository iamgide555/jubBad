import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/** Where a group first saw a LINE account: a roster post, a slip, the pay page's "this is me", or a host link. */
export type LineAccountSource = 'roster' | 'slip' | 'claim' | 'host';

/** A LINE user as one source knows them. A null name or picture means "not known here", never "remove it". */
export interface LineProfile {
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
}

/** One account in a group's list. The browser addresses it by `id`; the raw LINE user id never leaves the server. */
export interface LineAccountRow {
  id: string;
  displayName: string | null;
  pictureUrl: string | null;
  source: LineAccountSource;
  firstSeenAt: string;
  lastSeenAt: string;
  player: { id: string; name: string; linkedBy: 'self' | 'host' } | null;
}

/**
 * The directory of LINE accounts JubBad has seen: one global `LineAccount` per LINE user id, listed per group through
 * `LineAccountGroup`. Every write goes through here (docs/superpowers/specs/2026-11-01-line-accounts-design.md).
 */
@Injectable()
export class LineAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records that this account was seen in the group: upserts the account (a stored name or picture is only ever
   * replaced, never blanked) and its membership (the first source and first-seen time stay; last-seen moves).
   * Returns the account id. Two first sightings racing each other lose to a unique violation; the loser retries once.
   */
  async touch(groupId: string, profile: LineProfile, source: LineAccountSource, now: Date = new Date()): Promise<string> {
    try {
      return await this.upsert(groupId, profile, source, now);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      return this.upsert(groupId, profile, source, now);
    }
  }

  private async upsert(groupId: string, profile: LineProfile, source: LineAccountSource, now: Date): Promise<string> {
    const displayName = present(profile.displayName);
    const pictureUrl = present(profile.pictureUrl);
    const fresh = displayName !== null || pictureUrl !== null;
    const account = await this.prisma.lineAccount.upsert({
      where: { lineUserId: profile.lineUserId },
      create: { lineUserId: profile.lineUserId, displayName, pictureUrl, profileAt: fresh ? now : null },
      update: {
        ...(displayName !== null ? { displayName } : {}),
        ...(pictureUrl !== null ? { pictureUrl } : {}),
        ...(fresh ? { profileAt: now } : {}),
      },
      select: { id: true },
    });
    await this.prisma.lineAccountGroup.upsert({
      where: { groupId_lineAccountId: { groupId, lineAccountId: account.id } },
      create: { groupId, lineAccountId: account.id, source, firstSeenAt: now, lastSeenAt: now },
      update: { lastSeenAt: now },
    });
    return account.id;
  }

  /**
   * Every account this group has seen, unlinked first and each by newest last-seen, with the player it is linked to.
   * Reads only through the group's own memberships, so nothing another group knows can appear here.
   */
  async list(groupId: string): Promise<LineAccountRow[]> {
    const memberships = await this.prisma.lineAccountGroup.findMany({
      where: { groupId },
      include: { lineAccount: true },
    });
    const links = await this.prisma.playerLineAccount.findMany({ where: { groupId }, include: { player: true } });
    const linkByUserId = new Map(links.map((l) => [l.lineUserId, l]));
    const rows = memberships.map((m) => {
      const link = linkByUserId.get(m.lineAccount.lineUserId);
      return {
        id: m.lineAccount.id,
        displayName: m.lineAccount.displayName,
        pictureUrl: m.lineAccount.pictureUrl,
        source: toSource(m.source),
        firstSeenAt: m.firstSeenAt.toISOString(),
        lastSeenAt: m.lastSeenAt.toISOString(),
        player: link ? { id: link.player.id, name: link.player.name, linkedBy: toLinkedBy(link.linkedBy) } : null,
        seenAt: m.lastSeenAt.getTime(),
      };
    });
    rows.sort((a, b) => Number(a.player !== null) - Number(b.player !== null) || b.seenAt - a.seenAt || a.id.localeCompare(b.id));
    return rows.map(({ seenAt: _seenAt, ...row }) => row);
  }

  /**
   * Host: points the player at this account (replacing any other account the player had). The account is found only
   * through this group's membership and the player only in this group, so neither can be another group's (404).
   * An account already linked to a different player is refused, never taken over. Linking the same pair again changes
   * nothing. Another request linking the account between the check and the write loses to a unique violation, which
   * rolls the transaction back and is reported the same way.
   */
  async link(groupId: string, accountId: string, playerId: string): Promise<void> {
    const membership = await this.prisma.lineAccountGroup.findUnique({
      where: { groupId_lineAccountId: { groupId, lineAccountId: accountId } },
      select: { lineAccount: { select: { lineUserId: true } } },
    });
    if (!membership) throw new NotFoundException();
    if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) {
      throw new NotFoundException();
    }
    const lineUserId = membership.lineAccount.lineUserId;
    const byAccount = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId, lineUserId } },
    });
    if (byAccount) {
      if (byAccount.playerId !== playerId) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
      return;
    }
    try {
      await this.prisma.$transaction([
        this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
        this.prisma.playerLineAccount.create({ data: { groupId, playerId, lineUserId, linkedBy: 'host' } }),
      ]);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
      }
      throw error;
    }
  }

  /**
   * Host: removes this account's link in the group. Only the link goes; the account and its listing stay. An account
   * that is not linked is already in the wanted state (ok), one this group never saw is 404.
   */
  async unlink(groupId: string, accountId: string): Promise<void> {
    const membership = await this.prisma.lineAccountGroup.findUnique({
      where: { groupId_lineAccountId: { groupId, lineAccountId: accountId } },
      select: { lineAccount: { select: { lineUserId: true } } },
    });
    if (!membership) throw new NotFoundException();
    await this.prisma.playerLineAccount.deleteMany({ where: { groupId, lineUserId: membership.lineAccount.lineUserId } });
  }

  /**
   * The retention sweep. Deletes every unlinked membership not seen for more than UNLINKED_RETENTION_DAYS, then every
   * account left with no membership and no link (this is also what cleans up after a deleted group, whose cascade only
   * removes the join rows). A linked membership is never swept, and an account with a link is never deleted: the link
   * foreign key cascades, so deleting such an account would silently drop the link. Safe to run repeatedly.
   */
  async sweep(now: Date = new Date()): Promise<{ memberships: number; accounts: number }> {
    const cutoff = new Date(now.getTime() - UNLINKED_RETENTION_DAYS * 86_400_000);
    const stale = await this.prisma.lineAccountGroup.findMany({
      where: { lastSeenAt: { lt: cutoff } },
      select: { id: true, groupId: true, lineAccount: { select: { lineUserId: true } } },
    });
    const linked = new Set<string>();
    for (let i = 0; i < stale.length; i += SWEEP_CHUNK) {
      const links = await this.prisma.playerLineAccount.findMany({
        where: { lineUserId: { in: stale.slice(i, i + SWEEP_CHUNK).map((m) => m.lineAccount.lineUserId) } },
        select: { groupId: true, lineUserId: true },
      });
      for (const l of links) linked.add(`${l.groupId}\u0000${l.lineUserId}`);
    }
    const doomed = stale
      .filter((m) => !linked.has(`${m.groupId}\u0000${m.lineAccount.lineUserId}`))
      .map((m) => m.id);
    let memberships = 0;
    for (let i = 0; i < doomed.length; i += SWEEP_CHUNK) {
      const { count } = await this.prisma.lineAccountGroup.deleteMany({ where: { id: { in: doomed.slice(i, i + SWEEP_CHUNK) } } });
      memberships += count;
    }
    const { count: accounts } = await this.prisma.lineAccount.deleteMany({ where: { groups: { none: {} }, links: { none: {} } } });
    return { memberships, accounts };
  }
}

/** An unlinked group membership not seen for this many days is swept. A linked one never is. */
export const UNLINKED_RETENTION_DAYS = 365;

/** Ids per query, well under SQLite's bound-variable limit. */
const SWEEP_CHUNK = 500;

function toSource(value: string): LineAccountSource {
  return value === 'slip' || value === 'claim' || value === 'host' ? value : 'roster';
}

function toLinkedBy(value: string): 'self' | 'host' {
  return value === 'self' ? 'self' : 'host';
}

/** A name or picture worth storing: an empty value is treated as unknown, so it never blanks a stored one. */
function present(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}
