import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { GuestMenuService } from '../line/guest-menu.service.js';
import type { LiffUser } from '../line/liff-identity.js';
import { LineClient } from '../line/line-client.js';
import { lineConfig } from '../line/line-config.js';
import { liffSignupUrl } from '../line/signup-links.js';
import { effectivePlan, planAtLeast } from '../plans/plan.js';
import { upgradeContactUrl } from '../plans/plan.js';
import { TrialService } from '../plans/trial.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionLock } from '../sessions/session-lock.js';
import { UsersService } from '../users/users.service.js';

export interface SignupInfo {
  liffId: string | null;
  lineSignupUrl: string | null;
  botAddUrl: string | null;
  /** Where a person can reach the operator (the privacy page's contact); an https link or null. */
  contactUrl: string | null;
}

export interface LineStatus {
  lineDisplayName: string | null;
  /** This LINE account already belongs to a JubBad account. */
  registered: boolean;
  /** This LINE account has never had a trial (and is not registered). */
  trialAvailable: boolean;
}

export type LinkRefusal = 'bad-credentials' | 'account-linked' | 'line-taken';

/** Which unique column a P2002 was about; tolerant of how the driver words `meta`. */
function violated(error: Prisma.PrismaClientKnownRequestError): 'email' | 'lineUserId' | 'other' {
  const meta = JSON.stringify(error.meta ?? {});
  if (meta.includes('lineUserId')) return 'lineUserId';
  if (meta.includes('email')) return 'email';
  return 'other';
}

const isUniqueViolation = (error: unknown): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class SignupService {
  /** One LINE account's sign-up or link at a time. In process, like the session lock: a single API container. */
  private readonly lock = new SessionLock();

  constructor(
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly trials: TrialService,
    private readonly line: LineClient,
    private readonly guestMenu: GuestMenuService
  ) {}

  /** A host who signed up on the website: free plan, no LINE link, no trial yet. */
  async registerWeb(email: string, password: string): Promise<User> {
    try {
      return await this.users.create(email, password, 'host', { plan: 'free', signupSource: 'web' });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ code: 'EMAIL_TAKEN' });
      throw error;
    }
  }

  /** What the website's sign-up page needs; the LINE option is only offered when LIFF is fully configured. */
  info(): SignupInfo {
    const { liffId, loginChannelId, botAddUrl } = lineConfig();
    const liffReady = liffId !== null && loginChannelId !== null;
    return {
      liffId: liffReady ? liffId : null,
      lineSignupUrl: liffReady ? liffSignupUrl(liffId) : null,
      botAddUrl,
      contactUrl: upgradeContactUrl(process.env.UPGRADE_CONTACT_URL),
    };
  }

  async lineStatus(line: LiffUser): Promise<LineStatus> {
    const owner = await this.prisma.user.findUnique({ where: { lineUserId: line.userId }, select: { id: true } });
    return {
      lineDisplayName: line.displayName,
      registered: owner !== null,
      trialAvailable: owner === null && (await this.trials.availableForLine(line.userId)),
    };
  }

  /**
   * A host who signed up through LINE: the account is created already linked, so the trial starts now
   * (unless this LINE account has had one). A LINE account whose trial is used still gets an account, on free.
   */
  registerLine(
    line: LiffUser,
    email: string,
    password: string,
    now: Date = new Date()
  ): Promise<{ user: User; trialUntil: Date | null; botFriend: boolean | null }> {
    return this.lock.run(`line:${line.userId}`, async () => {
      let created: { user: User; trialUntil: Date | null };
      try {
        created = await this.prisma.$transaction(async (tx) => {
          const held = await tx.user.findUnique({ where: { lineUserId: line.userId }, select: { id: true } });
          if (held) throw new ConflictException({ code: 'LINE_ALREADY_REGISTERED' });
          const user = await this.users.create(email, password, 'host', { plan: 'free', signupSource: 'line' }, tx);
          await tx.user.update({ where: { id: user.id }, data: { lineUserId: line.userId, lineLinkedAt: now } });
          const trialUntil = await this.trials.applyOnLink(tx, { userId: user.id, lineUserId: line.userId }, now);
          return { user: await tx.user.findUniqueOrThrow({ where: { id: user.id } }), trialUntil };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({ code: violated(error) === 'email' ? 'EMAIL_TAKEN' : 'LINE_ALREADY_REGISTERED' });
        }
        throw error;
      }
      await this.guestMenu.hide(line.userId);
      return { ...created, botFriend: await this.friendOfBot(line.userId) };
    });
  }

  /**
   * Links this LINE account to an existing JubBad account, proven by that account's email and password. Starts
   * the trial when the account is free and neither side has had one. It never signs the browser in.
   */
  async linkLine(
    line: LiffUser,
    email: string,
    password: string,
    now: Date = new Date()
  ): Promise<{ trialUntil: Date | null; botFriend: boolean | null } | LinkRefusal> {
    const user = await this.users.verifyCredentials(email, password);
    if (!user) return 'bad-credentials';
    const outcome = await this.lock.run(`line:${line.userId}`, async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const linked = await tx.user.updateMany({
            where: { id: user.id, lineUserId: null },
            data: { lineUserId: line.userId, lineLinkedAt: now },
          });
          if (linked.count !== 1) return 'account-linked' as const;
          const trialUntil = await this.trials.applyOnLink(tx, { userId: user.id, lineUserId: line.userId }, now);
          // A linked host on a plan that allows it takes rosters by DM for every group they already own.
          const owner = await tx.user.findUniqueOrThrow({
            where: { id: user.id },
            select: { role: true, plan: true, planRenewsAt: true },
          });
          if (planAtLeast(effectivePlan(owner, now), 'host')) {
            await tx.group.updateMany({ where: { ownerId: user.id }, data: { lineDmEnabled: true } });
          }
          return { trialUntil };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return 'line-taken' as const;
        throw error;
      }
    });
    if (typeof outcome === 'string') return outcome;
    await this.guestMenu.hide(line.userId);
    return { trialUntil: outcome.trialUntil, botFriend: await this.friendOfBot(line.userId) };
  }

  /** Whether the LINE account has the bot as a friend; null when LINE cannot say. Never throws. */
  private async friendOfBot(lineUserId: string): Promise<boolean | null> {
    try {
      return await this.line.friendStatus(lineUserId);
    } catch {
      return null;
    }
  }
}
