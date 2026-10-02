import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeBill, type CheckoutModel, type BillConfig, type BillResult, type ShuttleAllocation } from '../../../engines/bill.ts';
import { deriveShuttleAccounting } from './shuttle-tracking.js';
import { serializeBillConfig } from './bill-config.js';
import { engineMatches, loadBillSnapshot } from './bill-snapshot.js';
import { parseCheckoutBreakdown } from './checkout-pricing.js';
import { SessionLock } from './session-lock.js';
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
  /** Early checkouts as frozen (advanced sessions; empty otherwise). They are not still-due rows. */
  settled: { id: string; playerId: string; name: string; model: CheckoutModel; amountSatang: number; settledAt: string }[];
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
    /** Confirmed, finished games — 0 means there is nothing to compare a physical count against yet. */
    finishedMatches: number;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SessionLock
  ) {}

  async getBill(code: string): Promise<BillResponse> {
    // One read transaction: the session (with its physical count and price),
    // the finished games and their shuttle uses come from a single snapshot, so
    // a correction landing mid-read can never pair old uses with a new count.
    const snapshot = await this.prisma.$transaction((tx) => loadBillSnapshot(tx, code));
    const { session, config, configSource, pairings, uses, checkouts } = snapshot;
    const live = checkouts.filter((c) => c.undoneAt === null);
    const names = new Map(session.roster.map((r) => [r.playerId, r.player.name]));

    const advanced = session.shuttleToolsEnabled;
    const usesByPairing = new Map<string, string[]>();
    for (const u of uses) usesByPairing.set(u.pairingId, [...(usesByPairing.get(u.pairingId) ?? []), u.shuttleId]);
    const matches = engineMatches(snapshot);

    const physicalCount = session.shuttleCount;
    let effectiveCount: number | null = physicalCount;
    let source: BillResponse['accounting']['source'] = advanced ? 'physical' : 'ordinary';
    let recordedFinishedShuttles = 0;
    let unknownFinishedMatches = 0;
    let finishedMatches = 0;
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
      finishedMatches = accounting.finishedMatches;
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
      settled: live.map((c) => {
        const b = parseCheckoutBreakdown(c.breakdown);
        return {
          id: c.id, playerId: c.playerId, model: c.model as CheckoutModel, amountSatang: c.amountSatang,
          settledAt: c.settledAt.toISOString(), walkInFeeSatang: b.walkInFeeSatang, walkInDiscountSatang: b.discountSatang,
          startingFeeSatang: c.model === 'perShuttle' ? b.baseSatang : 0,
        };
      }),
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
      settled: result.settledRows.map((r) => ({ ...r, name: names.get(r.playerId) ?? '' })),
      result,
      accounting: {
        recordedFinishedShuttles,
        unknownFinishedMatches,
        finishedMatches,
        physicalCount,
        effectiveCount,
        source,
        allocation: result.shuttleAllocation,
      },
      // The engine only warns about inputs this model actually requires.
      readyToCopy: result.warnings.length === 0,
    };
  }

  /** Under the session lock: a config write can change a checkout quote, so it queues with settlement. */
  setBillConfig(code: string, dto: SetBillConfigDto): Promise<BillResponse> {
    return this.lock.run(code, () => this.setBillConfigExclusively(code, dto));
  }

  private async setBillConfigExclusively(code: string, dto: SetBillConfigDto): Promise<BillResponse> {
    const session = await this.prisma.session.findUnique({ where: { code }, include: { roster: { select: { playerId: true } } } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    // perShuttle is an advanced-session model: refused on an ordinary session
    // whatever the group's switch says today (the session's snapshot decides).
    if (dto.model === 'perShuttle' && !session.shuttleToolsEnabled) {
      throw new BadRequestException({ code: 'BILL_MODEL_NOT_ALLOWED' });
    }
    const on = new Set(session.roster.map((r) => r.playerId));
    const referenced = [...dto.addedIds, ...dto.removedIds, ...dto.overrides.map((o) => o.playerId)];
    if (referenced.some((id) => !on.has(id))) throw new BadRequestException({ code: 'BILL_PLAYER_NOT_ON_ROSTER' });
    const overrideIds = dto.overrides.map((o) => o.playerId);
    if (new Set(overrideIds).size !== overrideIds.length) throw new BadRequestException({ code: 'BILL_CONFIG_INVALID' });
    // A field an older open tab does not send keeps its stored value; only an explicit value (null included) changes it.
    const { config: effective } = await this.prisma.$transaction((tx) => loadBillSnapshot(tx, code));
    const shuttleCharge = dto.shuttleCharge ?? effective.shuttleCharge;
    // Receipts are frozen on the basis they were quoted under, and the cost-sharing credit logic reads them as
    // shuttle money: flipping the basis under an active ตามลูกแบด receipt would price people on two bases at once.
    if (shuttleCharge !== effective.shuttleCharge) {
      const active = await this.prisma.sessionCheckout.count({ where: { sessionId: code, model: 'perShuttle', undoneAt: null } });
      if (active > 0) throw new ConflictException({ code: 'SHUTTLE_CHARGE_LOCKED' });
    }
    const config: BillConfig = {
      ...dto,
      shuttleCharge,
      perPlayerShuttleSatang: dto.perPlayerShuttleSatang === undefined ? effective.perPlayerShuttleSatang : dto.perPlayerShuttleSatang,
      overrides: dto.overrides.map((o) => ({ playerId: o.playerId, amountSatang: o.amountSatang })),
    };
    await this.prisma.session.update({ where: { code }, data: { billConfig: serializeBillConfig(config) } });
    return this.getBill(code);
  }
}
