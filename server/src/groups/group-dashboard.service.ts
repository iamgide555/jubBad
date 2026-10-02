import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { teamPlayers } from '../sessions/pairing-teams.js';
import {
  buildSessionList,
  buildStandings,
  type DashboardMatch,
  type DashboardSession,
  type StandingRow,
} from './dashboard-standings.js';

export interface GroupDashboard {
  groupName: string | null;
  lastSessionDate: string | null;
  sessions: DashboardSession[];
  standings: StandingRow[];
}

/**
 * The read model behind the public /d/:token page. Keyed by the group's
 * revocable share token, never the group code (host-chosen, guessable). Only
 * confirmed pairings are read, so a draft with an empty seat never reaches
 * teamPlayers.
 */
@Injectable()
export class GroupDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(token: string): Promise<GroupDashboard> {
    const group = await this.prisma.group.findUnique({
      where: { shareToken: token },
      select: { code: true, name: true },
    });
    if (!group) throw new NotFoundException();

    const [sessions, pairings, players] = await Promise.all([
      this.prisma.session.findMany({
        where: { groupId: group.code },
        orderBy: { createdAt: 'desc' },
        select: { code: true, date: true, venue: true, createdAt: true, endedAt: true },
      }),
      this.prisma.pairing.findMany({
        where: { session: { groupId: group.code }, confirmedAt: { not: null } },
        select: { sessionId: true, teamA: true, teamB: true },
      }),
      this.prisma.player.findMany({
        where: { groupId: group.code },
        select: { id: true, name: true },
      }),
    ]);

    const matches: DashboardMatch[] = pairings.map((p) => ({
      sessionCode: p.sessionId,
      playerIds: teamPlayers(p),
    }));
    const list = buildSessionList(sessions, matches);

    return {
      groupName: group.name,
      lastSessionDate: list[0]?.date ?? null,
      sessions: list,
      standings: buildStandings(matches, new Map(players.map((p) => [p.id, p.name]))),
    };
  }
}
