import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeBill, DEFAULT_BILL_CONFIG, type BillConfig, type BillResult, type ShuttleAllocation } from '../../../engines/bill.ts';
import { deriveShuttleAccounting } from './shuttle-tracking.js';
import { parseBillConfig, sanitizeForRoster, serializeBillConfig, withoutPerPerson } from './bill-config.js';
import { teamPlayers } from './pairing-teams.js';
import type { SetBillConfigDto } from './dto/set-bill-config.dto.js';

export interface BillResponse {
  session: {
    code: string; date: string | null; venue: string | null; endedAt: Date | null;
    shuttleCount: number | null; shuttlePriceSatang: number | null;
    /** The session's snapshot: true means shuttle use is tracked per game. */
    shuttleToolsEnabled: boolean;
  };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[];
  result: BillResult;
  /**
   * Where the shuttle count came from and how its cost was shared. The
   * physical nightly count is never rewritten; `effectiveCount` is what was
   * actually billed (physical if set, else the distinct shuttles in complete
   * finished-game logs, else missing).
   */
  accounting: {
    recordedFinishedShuttles: number;
    unknownFinishedMatches: number;
    physicalCount: number | null;
    effectiveCount: number | null;
    source: 'physical' | 'games' | 'missing' | 'ordinary';
    allocation: ShuttleAllocation;
  };
  /**
   * False while a required input is missing for this model. The engine still
   * returns provisional rows (zero-based) so a host can see the warnings, but
   * a client must hide final amounts and refuse to copy while this is false.
   */
  readyToCopy: boolean;
}

/**
 * C3 per-person bill. Stores inputs only (Session.billConfig); the bill is
 * recomputed on every read by engines/bill.ts. Owner-only by the global
 * guards; allowed after the session ends. The walk-in mark itself is written
 * by SessionsService.setRosterWalkIn (a roster fact, under the session lock).
 */
@Injectable()
export class BillService {
  constructor(private readonly prisma: PrismaService) {}

  async getBill(code: string): Promise<BillResponse> {
    // One read transaction: the session (with its physical count and price),
    // the finished games and their shuttle uses come from a single snapshot, so
    // a correction landing mid-read can never pair old uses with a new count.
    const snapshot = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { code },
        include: { roster: { include: { player: { select: { name: true } } } } },
      });
      if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
      const previous = session.billConfig
        ? null
        : await tx.session.findFirst({
            where: { groupId: session.groupId, code: { not: code }, billConfig: { not: null }, createdAt: { lt: session.createdAt } },
            orderBy: { createdAt: 'desc' },
            select: { billConfig: true },
          });
      const pairings = await tx.pairing.findMany({
        where: { sessionId: code, confirmedAt: { not: null }, endedAt: { not: null } },
        orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
      });
      const [identities, uses] = session.shuttleToolsEnabled
        ? await Promise.all([
            tx.sessionShuttle.findMany({ where: { sessionId: code } }),
            tx.pairingShuttleUse.findMany({ where: { pairing: { sessionId: code } } }),
          ])
        : [[], []];
      return { session, previous, pairings, identities, uses };
    });
    const { session, previous, pairings, identities, uses } = snapshot;
    const rosterIds = session.roster.map((r) => r.playerId);

    let config = parseBillConfig(session.billConfig);
    let configSource: BillResponse['configSource'] = 'saved';
    if (config === null) {
      const prev = parseBillConfig(previous?.billConfig ?? null);
      config = prev ? withoutPerPerson(prev) : DEFAULT_BILL_CONFIG;
      configSource = prev ? 'previous' : 'default';
    }
    config = sanitizeForRoster(config, rosterIds);

    const advanced = session.shuttleToolsEnabled;
    // Engine ids are opaque; zero-padded display numbers sort in number order,
    // so the engine's stable remainders follow shuttle numbering.
    const keyOf = new Map(identities.map((sh) => [sh.id, `n${String(sh.number).padStart(6, '0')}`]));
    const usesByPairing = new Map<string, string[]>();
    for (const u of uses) usesByPairing.set(u.pairingId, [...(usesByPairing.get(u.pairingId) ?? []), u.shuttleId]);

    const matches = pairings.map((p) => ({
      players: teamPlayers(p),
      ...(advanced
        ? {
            shuttleIds: p.shuttleLogKnown
              ? (usesByPairing.get(p.id) ?? []).map((id) => keyOf.get(id) ?? id).sort()
              : null,
          }
        : {}),
    }));

    const physicalCount = session.shuttleCount;
    let effectiveCount: number | null = physicalCount;
    let source: BillResponse['accounting']['source'] = advanced ? 'physical' : 'ordinary';
    let recordedFinishedShuttles = 0;
    let unknownFinishedMatches = 0;
    if (advanced) {
      const accounting = deriveShuttleAccounting(
        pairings.map((p) => ({
          confirmedAt: p.confirmedAt,
          endedAt: p.endedAt,
          shuttleLogKnown: p.shuttleLogKnown,
          shuttleIds: usesByPairing.get(p.id) ?? [],
        }))
      );
      recordedFinishedShuttles = accounting.recordedFinishedShuttles;
      unknownFinishedMatches = accounting.unknownFinishedMatches;
      if (physicalCount === null) {
        // Derived only from a complete log of at least one finished game; an
        // empty or partly unknown night has no honest count, never an inferred zero.
        const complete = accounting.finishedMatches > 0 && accounting.unknownFinishedMatches === 0;
        effectiveCount = complete ? accounting.recordedFinishedShuttles : null;
        source = complete ? 'games' : 'missing';
      }
    }

    const result = computeBill({
      config,
      matches,
      walkInIds: session.roster.filter((r) => r.walkIn).map((r) => r.playerId),
      shuttleCount: effectiveCount,
      shuttlePriceSatang: session.shuttlePriceSatang,
      shuttleAllocation: advanced ? 'identities' : 'legacy',
    });

    const games = new Map<string, number>();
    for (const m of matches) for (const id of m.players) games.set(id, (games.get(id) ?? 0) + 1);
    const players = session.roster
      .map((r) => ({ playerId: r.playerId, name: r.player.name, games: games.get(r.playerId) ?? 0, walkIn: r.walkIn }))
      .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'th'));

    return {
      session: {
        code: session.code, date: session.date, venue: session.venue, endedAt: session.endedAt,
        shuttleCount: session.shuttleCount, shuttlePriceSatang: session.shuttlePriceSatang,
        shuttleToolsEnabled: advanced,
      },
      config,
      configSource,
      players,
      result,
      accounting: {
        recordedFinishedShuttles,
        unknownFinishedMatches,
        physicalCount,
        effectiveCount,
        source,
        allocation: result.shuttleAllocation,
      },
      // The engine only warns about inputs this model actually requires.
      readyToCopy: result.warnings.length === 0,
    };
  }

  async setBillConfig(code: string, dto: SetBillConfigDto): Promise<BillResponse> {
    const session = await this.prisma.session.findUnique({ where: { code }, include: { roster: { select: { playerId: true } } } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    const on = new Set(session.roster.map((r) => r.playerId));
    const referenced = [...dto.addedIds, ...dto.removedIds, ...dto.overrides.map((o) => o.playerId)];
    if (referenced.some((id) => !on.has(id))) throw new BadRequestException({ code: 'BILL_PLAYER_NOT_ON_ROSTER' });
    const overrideIds = dto.overrides.map((o) => o.playerId);
    if (new Set(overrideIds).size !== overrideIds.length) throw new BadRequestException({ code: 'BILL_CONFIG_INVALID' });
    const config: BillConfig = {
      ...dto,
      overrides: dto.overrides.map((o) => ({ playerId: o.playerId, amountSatang: o.amountSatang })),
    };
    await this.prisma.session.update({ where: { code }, data: { billConfig: serializeBillConfig(config) } });
    return this.getBill(code);
  }
}
