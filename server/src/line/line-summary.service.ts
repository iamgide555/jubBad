import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PlansService } from '../plans/plans.service.js';
import { planAtLeast } from '../plans/plan.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { lineConfig } from './line-config.js';
import { cardTexts, liffShareUrl, summaryCard, type SummaryCard } from './line-summary-card.js';

/** `busy`: another send for this session is in flight right now. */
export type LineSummaryOutcome = 'sent' | 'already-sent' | 'busy' | 'quota' | 'failed' | 'unavailable';

/** Where the card goes: the linked LINE group, or (no bot in the group) the owner's own LINE chat with the bot. */
export type LineSummaryTarget = 'group' | 'host';

export interface LineSummaryState {
  /** The card could be posted for this session (the session may still be open). */
  available: boolean;
  /** A card has already gone out; there is never a second one. */
  sent: boolean;
  /** The group's setting for whether the end-of-session checkbox starts ticked. */
  defaultOn: boolean;
  /** Who the card would go to; null when it cannot go anywhere. */
  target: LineSummaryTarget | null;
  /** The LIFF link behind the host card's "send to group" button; set only for the `host` target when available. */
  shareUrl: string | null;
}

/** What the LIFF page needs to share the card on: the app's LIFF id, the card, and the text that previews it. */
export interface LineShareCard {
  liffId: string;
  card: SummaryCard;
  preview: { name: string; date: string; venue: string | null; players: number; games: number };
}

/** The session with its group and the group's owner, which is all `resolve` needs. */
type SessionForSummary = Prisma.SessionGetPayload<{ include: { group: { include: { owner: true } } } }>;

const FINISHED_GAME = { confirmedAt: { not: null }, endedAt: { not: null } } as const;
/** A claim older than this is treated as abandoned (the process may have died mid-send). */
const STALE_CLAIM_MS = 30_000;

/**
 * A UUID that is the same on every attempt for one session and target. LINE drops a repeat of a push with the
 * same retry key (and answers 409), so retrying after a timeout we could not read the answer to cannot post
 * twice. The two targets hash different inputs, so they are separate keys by construction: a group push LINE
 * accepted but whose answer we lost can never make a later host DM read as already sent via a 409. The group
 * input is the one used before the host target existed and must not change.
 */
export function retryKeyFor(target: LineSummaryTarget, sessionCode: string): string {
  const input = target === 'host' ? `jubbad-line-summary:host:${sessionCode}` : `jubbad-line-summary:${sessionCode}`;
  const h = createHash('sha1').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The night's totals card, posted at most once per session: into the linked LINE group, or, when no bot is in
 * the group, DMed to the host with a button that shares it on.
 */
@Injectable()
export class LineSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly line: LineClient
  ) {}

  async state(sessionCode: string, now: Date = new Date()): Promise<LineSummaryState> {
    const session = await this.load(sessionCode);
    if (!session) return { available: false, sent: false, defaultOn: true, target: null, shareUrl: null };
    const resolved = await this.resolve(session, now);
    return {
      available: resolved !== null,
      sent: session.lineSummarySentAt !== null,
      defaultOn: session.group.lineSummaryDefault,
      target: resolved?.target ?? null,
      shareUrl: resolved?.shareUrl ?? null,
    };
  }

  /**
   * Where a LINE card for this session would go, by exactly the summary card's rules (config, link, plan,
   * finished game), or null. The payment card reads it so the two can never disagree about who gets a card.
   */
  async destination(
    sessionCode: string,
    now: Date = new Date()
  ): Promise<{ target: LineSummaryTarget; to: string } | null> {
    const session = await this.load(sessionCode);
    if (!session) return null;
    const resolved = await this.resolve(session, now);
    return resolved === null ? null : { target: resolved.target, to: resolved.to };
  }

  /**
   * Post the card. The claim comes first (set only while nobody holds a fresh one and nothing was sent), so two
   * sends racing, or the end dialog racing the summary page's button, cannot both push. "Sent" is recorded only
   * after LINE accepted the push; a failed push gives the claim back, and a claim that was never given back
   * (a crash mid-send) goes stale and can be taken again, which the retry key makes safe.
   */
  async send(sessionCode: string, now: Date = new Date()): Promise<LineSummaryOutcome> {
    const session = await this.load(sessionCode);
    const baseUrl = lineConfig().publicAppUrl;
    if (!session || session.endedAt === null || baseUrl === null) return 'unavailable';
    const resolved = await this.resolve(session, now);
    if (resolved === null) return 'unavailable';
    if (session.lineSummarySentAt !== null) return 'already-sent';

    const claimed = await this.prisma.session.updateMany({
      where: {
        code: sessionCode,
        lineSummarySentAt: null,
        OR: [{ lineSummaryClaimedAt: null }, { lineSummaryClaimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
      },
      data: { lineSummaryClaimedAt: now },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.session.findUnique({
        where: { code: sessionCode },
        select: { lineSummarySentAt: true },
      });
      return current?.lineSummarySentAt != null ? 'already-sent' : 'busy';
    }

    try {
      const { card } = await this.buildCard(session, session.endedAt, baseUrl, resolved.shareUrl);
      const outcome = await this.line.push(resolved.to, [card], retryKeyFor(resolved.target, sessionCode));
      if (outcome === 'ok') {
        await this.prisma.session.update({ where: { code: sessionCode }, data: { lineSummarySentAt: now } });
        return 'sent';
      }
      await this.release(sessionCode, now);
      return outcome;
    } catch {
      await this.release(sessionCode, now).catch(() => undefined);
      return 'failed';
    }
  }

  /**
   * What the LIFF page shares into a LINE chat. Public: the route carries no login, so it serves only a session
   * of the `host` target that is ended and has a finished game (anything else is a 404, which also hides whether
   * the session exists), and only what the public summary page already shows. The card is the one the host was
   * DMed without its share button, built by the same code so the two cannot drift.
   */
  async shareCard(sessionCode: string, now: Date = new Date()): Promise<LineShareCard> {
    // Config first: with the feature off, an anonymous caller must not cost a database lookup.
    const { publicAppUrl: baseUrl, liffId } = lineConfig();
    if (baseUrl === null || liffId === null) throw new NotFoundException();
    const session = await this.load(sessionCode);
    if (!session || session.endedAt === null) throw new NotFoundException();
    const resolved = await this.resolve(session, now);
    if (resolved?.target !== 'host') throw new NotFoundException();
    const { card, preview } = await this.buildCard(session, session.endedAt, baseUrl);
    return { liffId, card, preview };
  }

  /** The night's totals and the card for them; `shareUrl` adds the host copy's "send to group" button. */
  private async buildCard(
    session: SessionForSummary,
    endedAt: Date,
    baseUrl: string,
    shareUrl?: string | null
  ): Promise<{ card: SummaryCard; preview: LineShareCard['preview'] }> {
    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: session.code, ...FINISHED_GAME },
      select: { teamA: true, teamB: true },
    });
    const players = new Set<string>();
    for (const p of pairings) {
      for (const id of [...(JSON.parse(p.teamA) as string[]), ...(JSON.parse(p.teamB) as string[])]) players.add(id);
    }
    const input = {
      groupName: session.group.name,
      date: session.date,
      endedAt,
      venue: session.venue,
      players: players.size,
      games: pairings.length,
      url: `${baseUrl}/s/${session.code}/summary`,
      ...(shareUrl ? { shareUrl } : {}),
    };
    return {
      card: summaryCard(input),
      preview: { ...cardTexts(input), players: input.players, games: input.games },
    };
  }

  private load(sessionCode: string): Promise<SessionForSummary | null> {
    return this.prisma.session.findUnique({
      where: { code: sessionCode },
      include: { group: { include: { owner: true } } },
    });
  }

  /**
   * Where the card goes, or null when it cannot go anywhere. A group linked to a LINE group posts there, whether
   * or not its host DM switch is on. Otherwise the host target needs the DM switch, an owner who linked their own
   * LINE account, and the LIFF app behind the share button. Both need the bot configured, a paid plan (read now,
   * so a lapsed plan stops it) and a finished game. The session may still be open: only `send` requires it ended.
   */
  private async resolve(
    session: SessionForSummary,
    now: Date
  ): Promise<{ target: LineSummaryTarget; to: string; shareUrl: string | null } | null> {
    const config = lineConfig();
    if (!config.secret || !config.token || !config.publicAppUrl) return null;

    const { group } = session;
    const hostLineUserId = group.owner?.lineUserId ?? null;
    let resolved: { target: LineSummaryTarget; to: string; shareUrl: string | null };
    if (group.lineGroupId !== null) {
      resolved = { target: 'group', to: group.lineGroupId, shareUrl: null };
    } else if (group.lineDmEnabled && hostLineUserId !== null && config.liffId !== null) {
      resolved = { target: 'host', to: hostLineUserId, shareUrl: liffShareUrl(config.liffId, session.code) };
    } else {
      return null;
    }

    if (!planAtLeast(await this.plans.planForGroup(session.groupId, now), 'host')) return null;
    const games = await this.prisma.pairing.count({ where: { sessionId: session.code, ...FINISHED_GAME } });
    return games > 0 ? resolved : null;
  }

  /** Give the claim back, but only if it is still ours. */
  private async release(sessionCode: string, claimedAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { code: sessionCode, lineSummaryClaimedAt: claimedAt, lineSummarySentAt: null },
      data: { lineSummaryClaimedAt: null },
    });
  }
}
