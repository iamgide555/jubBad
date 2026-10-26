import { Injectable } from '@nestjs/common';
import { PlansService } from '../plans/plans.service.js';
import { planAtLeast } from '../plans/plan.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { lineConfig } from './line-config.js';
import { summaryCard } from './line-summary-card.js';

export type LineSummaryOutcome = 'sent' | 'already-sent' | 'quota' | 'failed' | 'unavailable';

export interface LineSummaryState {
  /** The card could be posted for this session (the session may still be open). */
  available: boolean;
  /** A card has already gone out; there is never a second one. */
  sent: boolean;
  /** The group's setting for whether the end-of-session checkbox starts ticked. */
  defaultOn: boolean;
}

const FINISHED_GAME = { confirmedAt: { not: null }, endedAt: { not: null } } as const;

/** The night's totals card for a linked LINE group, posted at most once per session. */
@Injectable()
export class LineSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly line: LineClient
  ) {}

  async state(sessionCode: string, now: Date = new Date()): Promise<LineSummaryState> {
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      include: { group: true },
    });
    if (!session) return { available: false, sent: false, defaultOn: true };
    const sent = session.lineSummarySentAt !== null;
    const defaultOn = session.group.lineSummaryDefault;

    const config = lineConfig();
    if (!config.secret || !config.token || !config.publicAppUrl) return { available: false, sent, defaultOn };
    if (session.group.lineGroupId === null) return { available: false, sent, defaultOn };
    if (!planAtLeast(await this.plans.planForGroup(session.groupId, now), 'host')) {
      return { available: false, sent, defaultOn };
    }
    const games = await this.prisma.pairing.count({ where: { sessionId: sessionCode, ...FINISHED_GAME } });
    return { available: games > 0, sent, defaultOn };
  }

  /**
   * Post the card. The claim comes first (set only while empty), so two sends racing, or the end
   * dialog racing the summary page's button, cannot both push; a failed push gives the claim back.
   */
  async send(sessionCode: string, now: Date = new Date()): Promise<LineSummaryOutcome> {
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      include: { group: true },
    });
    const baseUrl = lineConfig().publicAppUrl;
    if (!session || session.endedAt === null || baseUrl === null) return 'unavailable';
    if (!(await this.state(sessionCode, now)).available) return 'unavailable';
    const lineGroupId = session.group.lineGroupId;
    if (lineGroupId === null) return 'unavailable';

    const claimed = await this.prisma.session.updateMany({
      where: { code: sessionCode, lineSummarySentAt: null },
      data: { lineSummarySentAt: now },
    });
    if (claimed.count !== 1) return 'already-sent';

    try {
      const pairings = await this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, ...FINISHED_GAME },
        select: { teamA: true, teamB: true },
      });
      const players = new Set<string>();
      for (const p of pairings) {
        for (const id of [...(JSON.parse(p.teamA) as string[]), ...(JSON.parse(p.teamB) as string[])]) players.add(id);
      }
      const card = summaryCard({
        groupName: session.group.name,
        date: session.date,
        endedAt: session.endedAt,
        venue: session.venue,
        players: players.size,
        games: pairings.length,
        url: `${baseUrl}/s/${sessionCode}/summary`,
      });
      const outcome = await this.line.push(lineGroupId, [card]);
      if (outcome === 'ok') return 'sent';
      await this.release(sessionCode, now);
      return outcome;
    } catch {
      await this.release(sessionCode, now);
      return 'failed';
    }
  }

  /** Give the claim back, but only if it is still ours. */
  private async release(sessionCode: string, claimedAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { code: sessionCode, lineSummarySentAt: claimedAt },
      data: { lineSummarySentAt: null },
    });
  }
}
