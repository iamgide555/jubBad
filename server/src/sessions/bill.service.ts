import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeBill, DEFAULT_BILL_CONFIG, type BillConfig, type BillResult } from '../../../engines/bill.ts';
import { parseBillConfig, sanitizeForRoster, serializeBillConfig, withoutPerPerson } from './bill-config.js';
import { teamPlayers } from './pairing-teams.js';
import type { SetBillConfigDto } from './dto/set-bill-config.dto.js';

export interface BillResponse {
  session: {
    code: string; date: string | null; venue: string | null; endedAt: Date | null;
    shuttleCount: number | null; shuttlePriceSatang: number | null;
  };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[];
  result: BillResult;
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
    const session = await this.prisma.session.findUnique({
      where: { code },
      include: { roster: { include: { player: { select: { name: true } } } } },
    });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    const rosterIds = session.roster.map((r) => r.playerId);

    let config = parseBillConfig(session.billConfig);
    let configSource: BillResponse['configSource'] = 'saved';
    if (config === null) {
      const previous = await this.prisma.session.findFirst({
        where: { groupId: session.groupId, code: { not: code }, billConfig: { not: null }, createdAt: { lt: session.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { billConfig: true },
      });
      const prev = parseBillConfig(previous?.billConfig ?? null);
      config = prev ? withoutPerPerson(prev) : DEFAULT_BILL_CONFIG;
      configSource = prev ? 'previous' : 'default';
    }
    config = sanitizeForRoster(config, rosterIds);

    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: code, confirmedAt: { not: null }, endedAt: { not: null } },
      orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
    });
    const matches = pairings.map((p) => ({ players: teamPlayers(p) }));
    const result = computeBill({
      config,
      matches,
      walkInIds: session.roster.filter((r) => r.walkIn).map((r) => r.playerId),
      shuttleCount: session.shuttleCount,
      shuttlePriceSatang: session.shuttlePriceSatang,
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
      },
      config,
      configSource,
      players,
      result,
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
