import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashPassword } from './password.js';

/** The URL lives in a LINE chat by hand and stays in scrollback indefinitely. */
const RESET_EXPIRY_MS = 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class PasswordResetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mints a one-time reset token for `userId` and returns the raw value —
   * the only place it is ever handed back. Only its SHA-256 is stored, for
   * the same reason a password is hashed rather than kept plain: the raw
   * token travels through a LINE chat by hand and lives in that scrollback
   * indefinitely.
   */
  async issue(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordReset.create({
      data: {
        userId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_EXPIRY_MS),
      },
    });
    return token;
  }

  /**
   * Consumes a reset token, setting `newPassword` and bumping the user's
   * tokenVersion so every device signed in under the old password is signed
   * out — a reset is exactly the moment that matters most.
   *
   * The `usedAt: null` clause in the claiming update is a compare-and-swap:
   * two requests racing the same token can both pass the initial lookup, but
   * only one can win the conditional update, so exactly one ever succeeds —
   * the same pattern the group-claim race in GroupsService.parse uses.
   */
  async consume(rawToken: string, newPassword: string): Promise<boolean> {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (!reset || reset.expiresAt < new Date()) return false;

    const passwordHash = await hashPassword(newPassword);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return false; // already used — lost the race, or reused

      await tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      return true;
    });
  }

  /**
   * Records that someone asked for a reset, from the one page a locked-out
   * host can still reach with no cookie at all. Recorded whether or not
   * `email` matches an account — a typo of a host's own address is still a
   * real event worth an admin seeing. This function itself does not look the
   * account up; AuthController#forgotPassword does that separately and
   * reports it to the caller (a deliberate choice for this app, see its
   * comment) — kept out of here so this write path stays the same either way.
   */
  async recordRequest(email: string): Promise<void> {
    await this.prisma.passwordResetRequest.create({ data: { email: email.trim() } });
  }
}
