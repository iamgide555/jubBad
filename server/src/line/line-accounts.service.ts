import { Injectable } from '@nestjs/common';
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
}

/** A name or picture worth storing: an empty value is treated as unknown, so it never blanks a stored one. */
function present(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}
