import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** 16 random bytes as base64url: 22 URL-safe characters, 128 bits. */
export function newShareToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Owns the group's public-dashboard credential. Every method refuses an
 * unknown group itself: OwnershipGuard deliberately lets a code with no group
 * through (that is how a new group gets claimed), so the guard cannot be the
 * thing that 404s here.
 */
@Injectable()
export class GroupShareService {
  constructor(private readonly prisma: PrismaService) {}

  async get(code: string): Promise<{ token: string | null }> {
    const group = await this.prisma.group.findUnique({
      where: { code },
      select: { shareToken: true },
    });
    if (!group) throw new NotFoundException();
    return { token: group.shareToken };
  }

  /**
   * Idempotent. The write only matches a group that has no token yet, and
   * SQLite serializes writers, so of any number of racing calls exactly one
   * mints a token and the rest re-read it. That is what keeps a double-tap
   * from rotating the link the host already pinned in LINE.
   */
  async enable(code: string): Promise<{ token: string | null }> {
    await this.prisma.group.updateMany({
      where: { code, shareToken: null },
      data: { shareToken: newShareToken() },
    });
    return this.get(code);
  }

  async disable(code: string): Promise<{ token: null }> {
    const { count } = await this.prisma.group.updateMany({
      where: { code },
      data: { shareToken: null },
    });
    if (count === 0) throw new NotFoundException();
    return { token: null };
  }
}
