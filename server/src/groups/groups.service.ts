import { Injectable, NotFoundException } from '@nestjs/common';
import { computeRatings, STARTING_RATING } from '../../../engines/elo.ts';
import { matchRoster } from '../../../engines/fuzzy-match.ts';
import { parseLineRosterMessage } from '../../../engines/parser.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateGroupDto } from './dto/update-group.dto.js';
import type { ParseRosterDto } from './dto/parse-roster.dto.js';

type PairCount = { played: number; won: number; decisive: number };

/**
 * Decisive games a pairing needs before its win rate is trusted. Five is about
 * two evenings together: enough that one lucky night does not crown a partner,
 * few enough that a regular pair qualifies within a month.
 */
const MIN_GAMES_TOGETHER = 5;

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every group, for the admin home page. The first query in this codebase that
   * is not scoped to a known code — until now a group was reachable only by
   * already having its URL, which is why losing a bookmark lost the group.
   *
   * Sorted by most recent session rather than by creation, so the group being
   * played tonight is at the top rather than whichever was made first. Groups
   * with no sessions yet sort last but are never dropped: a group exists from
   * the moment a roster is parsed into it, before any session is created.
   */
  async listGroups() {
    const groups = await this.prisma.group.findMany({
      include: {
        _count: { select: { sessions: true, players: true } },
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { code: true, createdAt: true },
        },
      },
    });

    return groups
      .map((group) => {
        const last = group.sessions[0] ?? null;
        return {
          code: group.code,
          name: group.name,
          sessionCount: group._count.sessions,
          playerCount: group._count.players,
          lastSessionCode: last?.code ?? null,
          lastSessionAt: last?.createdAt.toISOString() ?? null,
        };
      })
      .sort((a, b) => (b.lastSessionAt ?? '').localeCompare(a.lastSessionAt ?? ''));
  }

  async findOne(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const lastSession = await this.prisma.session.findFirst({
      where: { groupId: code },
      orderBy: { createdAt: 'desc' },
      select: { code: true },
    });

    return { code: group.code, name: group.name, lastSessionCode: lastSession?.code ?? null };
  }

  async update(code: string, dto: UpdateGroupDto) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const updated = await this.prisma.group.update({
      where: { code },
      data: { name: dto.name },
    });
    return { code: updated.code, name: updated.name };
  }

  async listPlayers(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    return players.map((p) => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases) as string[] }));
  }

  async listSessions(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const sessions = await this.prisma.session.findMany({
      where: { groupId: code },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            // A proposed match has not happened and must not inflate archive
            // history. Confirmed active matches count as matches; completed
            // ones remain counted after the session ends.
            pairings: { where: { confirmedAt: { not: null } } },
          },
        },
      },
    });

    return sessions.map((s) => ({
      code: s.code,
      date: s.date,
      venue: s.venue,
      courtCount: s.courtCount,
      createdAt: s.createdAt,
      endedAt: s.endedAt,
      matchCount: s._count.pairings,
    }));
  }

  /** Every finished, confirmed match in the group, oldest first. */
  private async finishedMatches(groupCode: string) {
    const rows = await this.prisma.pairing.findMany({
      where: {
        session: { groupId: groupCode },
        confirmedAt: { not: null },
        endedAt: { not: null },
      },
      orderBy: { confirmedAt: 'asc' },
      select: { teamA: true, teamB: true, winner: true },
    });
    return rows.map((p) => ({
      teamA: JSON.parse(p.teamA) as [string, string],
      teamB: JSON.parse(p.teamB) as [string, string],
      winner: p.winner as 'A' | 'B' | null,
    }));
  }

  async playerStats(groupCode: string, playerId: string) {
    const player = await this.prisma.player.findFirst({
      where: { id: playerId, groupId: groupCode },
    });
    if (!player) throw new NotFoundException();

    const matches = await this.finishedMatches(groupCode);

    let played = 0;
    let won = 0;
    let decisivePlayed = 0;
    // Tallies keyed by the other player: who I win with, and who I face.
    const withCounts = new Map<string, PairCount>();
    const againstCounts = new Map<string, PairCount>();
    const bump = (m: Map<string, PairCount>, id: string, win: boolean, decisive: boolean) => {
      const row = m.get(id) ?? { played: 0, won: 0, decisive: 0 };
      row.played += 1;
      if (decisive) row.decisive += 1;
      if (win) row.won += 1;
      m.set(id, row);
    };

    for (const match of matches) {
      const onA = match.teamA.includes(playerId);
      const onB = match.teamB.includes(playerId);
      if (!onA && !onB) continue;

      const win = (onA && match.winner === 'A') || (onB && match.winner === 'B');
      played += 1;
      if (match.winner !== null) decisivePlayed += 1;
      if (win) won += 1;

      const mine = onA ? match.teamA : match.teamB;
      const theirs = onA ? match.teamB : match.teamA;
      const decisive = match.winner !== null;
      for (const id of mine) if (id !== playerId) bump(withCounts, id, win, decisive);
      for (const id of theirs) bump(againstCounts, id, win, decisive);
    }

    const names = new Map(
      (await this.prisma.player.findMany({ where: { groupId: groupCode } })).map((p) => [
        p.id,
        p.name,
      ])
    );
    // Ranked on win rate together, not on raw wins. A rate needs a floor or a
    // partner you have won one game with shows as the best at 100%, so a pair
    // must have MIN_GAMES_TOGETHER decisive games before it is eligible, and
    // ties go to the pair that has played more — the proven partnership, not
    // the newer one. Rate is computed over decisive games only: an abandoned
    // match was played but says nothing about whether the pairing wins.
    //
    // If nobody clears the floor, fall back to most wins together and say so
    // via `provisional`, because a new group would otherwise see an empty
    // panel for weeks. The client labels the fallback differently.
    const bestPartner = (() => {
      const eligible = [...withCounts.entries()].filter(
        ([, row]) => row.decisive >= MIN_GAMES_TOGETHER
      );
      const provisional = eligible.length === 0;
      const ranked = (provisional ? [...withCounts.entries()] : eligible).sort((a, b) => {
        if (!provisional) {
          const rate = b[1].won / b[1].decisive - a[1].won / a[1].decisive;
          if (rate !== 0) return rate;
        } else if (b[1].won !== a[1].won) {
          return b[1].won - a[1].won;
        }
        return b[1].played - a[1].played;
      });
      if (ranked.length === 0) return null;
      const [id, row] = ranked[0];
      return {
        playerId: id,
        name: names.get(id) ?? 'Unknown',
        played: row.played,
        won: row.won,
        winRate: row.decisive === 0 ? null : row.won / row.decisive,
        provisional,
      };
    })();

    const pick = (counts: Map<string, PairCount>, by: 'won' | 'played') => {
      const ranked = [...counts.entries()].sort(
        (a, b) => b[1][by] - a[1][by] || b[1].played - a[1].played
      );
      if (ranked.length === 0) return null;
      const [id, row] = ranked[0];
      return { playerId: id, name: names.get(id) ?? 'Unknown', played: row.played, won: row.won };
    };

    // An abandoned/no-result match was played, but does not imply an Elo
    // outcome or a win/loss. Keep those metrics decisive-result-only.
    const ratings = computeRatings(
      matches.filter(
        (match): match is typeof match & { winner: 'A' | 'B' } => match.winner !== null
      )
    );

    return {
      playerId,
      name: player.name,
      played,
      won,
      winRate: decisivePlayed === 0 ? null : won / decisivePlayed,
      rating: Math.round(ratings.get(playerId) ?? STARTING_RATING),
      bestPartner,
      mostFacedOpponent: pick(againstCounts, 'played'),
    };
  }

  async exportGroup(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const [players, sessions] = await Promise.all([
      this.prisma.player.findMany({ where: { groupId: code } }),
      this.prisma.session.findMany({
        where: { groupId: code },
        orderBy: { createdAt: 'asc' },
        include: {
          roster: true,
          waitlist: { orderBy: { position: 'asc' } },
          pairings: { orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }] },
        },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      group: { code: group.code, name: group.name, createdAt: group.createdAt },
      players: players.map((p) => ({
        id: p.id,
        name: p.name,
        aliases: JSON.parse(p.aliases) as string[],
      })),
      sessions: sessions.map((s) => ({
        code: s.code,
        date: s.date,
        venue: s.venue,
        courtCount: s.courtCount,
        mode: s.mode,
        createdAt: s.createdAt,
        endedAt: s.endedAt,
        rawImportText: s.rawImportText,
        rosterPlayerIds: s.roster.map((r) => r.playerId),
        restingPlayerIds: s.roster.filter((r) => !r.active).map((r) => r.playerId),
        waitlistPlayerIds: s.waitlist.map((w) => w.playerId),
        matches: s.pairings.map((p) => ({
          courtNumber: p.courtNumber,
          matchNumber: p.matchNumber,
          teamA: JSON.parse(p.teamA) as [string, string],
          teamB: JSON.parse(p.teamB) as [string, string],
          scoreA: p.scoreA,
          scoreB: p.scoreB,
          winner: p.winner,
          confirmedAt: p.confirmedAt,
          endedAt: p.endedAt,
        })),
      })),
    };
  }

  /**
   * Hard delete, in dependency order — SQLite has no cascade configured here.
   * Irreversible, which is why the client asks for the group's name to be
   * typed before calling it.
   */
  async deleteGroup(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const sessions = await this.prisma.session.findMany({
      where: { groupId: code },
      select: { code: true },
    });
    const sessionIds = sessions.map((s) => s.code);

    await this.prisma.$transaction([
      this.prisma.pairing.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.sessionRoster.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.waitlist.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.session.deleteMany({ where: { groupId: code } }),
      this.prisma.player.deleteMany({ where: { groupId: code } }),
      this.prisma.group.delete({ where: { code } }),
    ]);

    return { code, deleted: true };
  }

  async parse(code: string, dto: ParseRosterDto) {
    await this.prisma.group.upsert({
      where: { code },
      create: { code, name: dto.groupName },
      update: {},
    });

    const result = parseLineRosterMessage(dto.rawText);
    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    const fuzzyPlayers = players.map((p) => ({
      id: p.id,
      name: p.name,
      aliases: JSON.parse(p.aliases) as string[],
    }));

    const rosterNames = result.roster.map((s) => s.name).filter((n): n is string => n !== null);
    const waitlistNames = result.waitlist.map((s) => s.name).filter((n): n is string => n !== null);

    return {
      header: {
        isoDate: result.header.isoDate,
        venue: result.header.venue,
        courtCount: result.header.timeSlots[0]?.courtCount ?? null,
      },
      rosterReviews: matchRoster(rosterNames, fuzzyPlayers),
      waitlistReviews: matchRoster(waitlistNames, fuzzyPlayers),
      warnings: result.warnings,
      unrecognizedLines: result.unrecognizedLines,
    };
  }
}
