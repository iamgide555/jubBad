import { Injectable, NotFoundException } from '@nestjs/common';
import { computeRatingTracks, STARTING_RATING } from '../../../engines/elo.ts';
import { matchRoster } from '../../../engines/fuzzy-match.ts';
import { asLevel, type Level } from '../../../engines/levels.ts';
import { parseLineRosterMessage } from '../../../engines/parser.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { levelWrite, loadPlayerLevels, loadRatingAnchors } from '../player-levels.js';
import { parseCourtFormats } from '../sessions/court-formats.js';
import { parseSeatTeams, parseTeams } from '../sessions/pairing-teams.js';
import type { UpdateGroupDto } from './dto/update-group.dto.js';
import type { ParseRosterDto } from './dto/parse-roster.dto.js';
import type { UpdatePlayerDto } from './dto/update-player.dto.js';

type PairCount = { played: number; won: number; decisive: number };
type Caller = { id: string; role: string };

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
   *
   * Scoped to `caller`'s own groups; an admin sees every group, since the
   * admin console needs exactly that view.
   */
  async listGroups(caller: Caller) {
    const groups = await this.prisma.group.findMany({
      where: caller.role === 'admin' ? undefined : { ownerId: caller.id },
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

  async listPlayersManage(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) throw new NotFoundException();

    const players = await this.prisma.player.findMany({ where: { groupId: code } });
    const matches = await this.finishedMatches(code);
    const decisiveMatches = matches.filter(
      (m): m is typeof m & { winner: 'A' | 'B' } => m.winner !== null
    );
    const levels = await loadPlayerLevels(this.prisma, code);
    const anchors = await loadRatingAnchors(this.prisma, code);
    const ratings = computeRatingTracks(decisiveMatches, anchors);

    // Overall played/won/decisive per player, across both formats, in one
    // pass over every match — the group-wide equivalent of the per-player
    // tally playerStats builds for a single target player.
    const tally = new Map<string, PairCount>();
    const bump = (id: string, win: boolean, decisive: boolean) => {
      const row = tally.get(id) ?? { played: 0, won: 0, decisive: 0 };
      row.played += 1;
      if (decisive) row.decisive += 1;
      if (win) row.won += 1;
      tally.set(id, row);
    };
    for (const match of matches) {
      const decisive = match.winner !== null;
      for (const id of match.teamA) bump(id, match.winner === 'A', decisive);
      for (const id of match.teamB) bump(id, match.winner === 'B', decisive);
    }

    return players.map((p) => {
      const row = tally.get(p.id);
      return {
        id: p.id,
        name: p.name,
        aliases: JSON.parse(p.aliases) as string[],
        age: p.age,
        email: p.email,
        phone: p.phone,
        level: levels.get(p.id) ?? null,
        rating: Math.round(ratings.doubles.get(p.id) ?? anchors.get(p.id)?.rating ?? STARTING_RATING),
        singlesRating: ratings.singles.has(p.id) ? Math.round(ratings.singles.get(p.id)!) : null,
        winRate: !row || row.decisive === 0 ? null : row.won / row.decisive,
      };
    });
  }

  async updatePlayer(code: string, playerId: string, dto: UpdatePlayerDto) {
    const player = await this.prisma.player.findFirst({ where: { id: playerId, groupId: code } });
    if (!player) throw new NotFoundException();

    const updated = await this.prisma.player.update({
      where: { id: playerId },
      data: {
        name: dto.name,
        age: dto.age ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        ...levelWrite(asLevel(player.level), dto.level ?? null),
      },
    });
    return {
      id: updated.id,
      name: updated.name,
      aliases: JSON.parse(updated.aliases) as string[],
      age: updated.age,
      email: updated.email,
      phone: updated.phone,
      level: asLevel(updated.level),
    };
  }

  /**
   * A one-field save for the inline chip on the roster page, deliberately
   * separate from `updatePlayer`: that route overwrites every optional field
   * on every save (see its `?? null` fallbacks), so routing the chip through
   * it would blank out a player's age/email/phone the first time a host taps
   * a level without also re-typing the rest of the row.
   */
  async updatePlayerLevel(code: string, playerId: string, level: Level | null) {
    const player = await this.prisma.player.findFirst({ where: { id: playerId, groupId: code } });
    if (!player) throw new NotFoundException();

    const updated = await this.prisma.player.update({
      where: { id: playerId },
      data: levelWrite(asLevel(player.level), level),
    });
    return { id: updated.id, level: asLevel(updated.level) };
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
      select: { teamA: true, teamB: true, winner: true, confirmedAt: true },
    });
    return rows.map((p) => ({
      ...parseTeams(p),
      winner: p.winner as 'A' | 'B' | null,
      // Non-null: the `confirmedAt: { not: null }` filter above guarantees
      // it, Prisma's generated type just can't narrow on a `where` clause.
      // Required by computeRatingTracks whenever a caller passes rating
      // anchors (engines/elo.ts) — a level set mid-history needs to know
      // which matches happened before or after it.
      at: p.confirmedAt!.getTime(),
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
    // Same played/won/decisive shape as withCounts/againstCounts, but keyed
    // by format (team size 1 = singles, 2 = doubles) instead of by opponent.
    const formatCounts = new Map<'singles' | 'doubles', PairCount>();
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
      bump(formatCounts, match.teamA.length === 1 ? 'singles' : 'doubles', win, match.winner !== null);

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
    //
    // Levels seed the rating but are never returned from this route — it is
    // @Public (a player's own stat card) and a level is host-only.
    const anchors = await loadRatingAnchors(this.prisma, groupCode);
    const ratings = computeRatingTracks(
      matches.filter(
        (match): match is typeof match & { winner: 'A' | 'B' } => match.winner !== null
      ),
      anchors
    );

    // `rating` keeps meaning the doubles rating — the default format, and
    // what nearly every row will be — so no existing consumer's meaning
    // changes. singlesRating is null (not 1200) when the player has never
    // played singles, so a group that never plays it sees exactly today's
    // profile with no new, meaningless number attached.
    //
    // Checked against `ratings.singles` itself, not by re-scanning `matches`
    // for any singles appearance: that scan would count an abandoned/
    // no-result singles match, which `ratings.singles` — decisive-only, like
    // `ratings.doubles` above — never replays, so a player whose only
    // singles match had no result would get a fabricated 1200 "rating"
    // instead of the null this comment promises.
    const hasSinglesMatch = ratings.singles.has(playerId);

    // Null when this format was never played, not zero — same convention as
    // singlesRating, so a doubles-only player's profile looks exactly as it
    // did before this split existed.
    const formatStat = (format: 'singles' | 'doubles') => {
      const row = formatCounts.get(format);
      if (!row || row.played === 0) return null;
      return {
        played: row.played,
        won: row.won,
        winRate: row.decisive === 0 ? null : row.won / row.decisive,
      };
    };

    return {
      playerId,
      name: player.name,
      played,
      won,
      winRate: decisivePlayed === 0 ? null : won / decisivePlayed,
      rating: Math.round(
        ratings.doubles.get(playerId) ?? anchors.get(playerId)?.rating ?? STARTING_RATING
      ),
      singlesRating: hasSinglesMatch ? Math.round(ratings.singles.get(playerId) ?? STARTING_RATING) : null,
      singles: formatStat('singles'),
      doubles: formatStat('doubles'),
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
        courtFormats: parseCourtFormats(s.courtFormats),
        createdAt: s.createdAt,
        endedAt: s.endedAt,
        rawImportText: s.rawImportText,
        rosterPlayerIds: s.roster.map((r) => r.playerId),
        restingPlayerIds: s.roster.filter((r) => !r.active).map((r) => r.playerId),
        waitlistPlayerIds: s.waitlist.map((w) => w.playerId),
        matches: s.pairings.map((p) => ({
          courtNumber: p.courtNumber,
          matchNumber: p.matchNumber,
          // Tolerant: unlike `finishedMatches`, this walks every pairing —
          // including a still-being-filled custom-mode draft — so an empty
          // seat must export honestly as null, not throw.
          ...parseSeatTeams(p),
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
    const ops = await this.buildDeleteGroupOps(code);
    if (!ops) throw new NotFoundException();
    await this.prisma.$transaction(ops);
    return { code, deleted: true };
  }

  /**
   * The delete operations for one group, unexecuted — null if the group does
   * not exist. Exists so the admin module can delete several groups and a
   * user in a single transaction (see AdminService#deleteUser): composing
   * several independent `$transaction` calls would not be atomic across all
   * of them, but concatenating their operation arrays into one call is.
   */
  async buildDeleteGroupOps(code: string) {
    const group = await this.prisma.group.findUnique({ where: { code } });
    if (!group) return null;

    const sessions = await this.prisma.session.findMany({
      where: { groupId: code },
      select: { code: true },
    });
    const sessionIds = sessions.map((s) => s.code);

    return [
      this.prisma.pairing.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.sessionRoster.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.waitlist.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.session.deleteMany({ where: { groupId: code } }),
      this.prisma.player.deleteMany({ where: { groupId: code } }),
      this.prisma.group.delete({ where: { code } }),
    ];
  }

  /**
   * The one place a group is created — see the controller comment on this
   * route for why that makes it the create-or-own point.
   *
   * The upsert is what keeps this safe under two hosts racing to claim the
   * same fresh code at once: SQLite serializes the two writes (see
   * PrismaService's WAL/busy_timeout comment), so exactly one `create`
   * branch wins and sets `ownerId`; the loser's `update: {}` is a no-op, and
   * the ownership check below then correctly refuses the loser rather than
   * letting them import a roster into someone else's new group.
   */
  async parse(code: string, dto: ParseRosterDto, caller: Caller) {
    const group = await this.prisma.group.upsert({
      where: { code },
      create: { code, name: dto.groupName, ownerId: caller.id },
      update: {},
    });
    if (group.ownerId !== caller.id && caller.role !== 'admin') {
      // Same 404 the rest of the ownership boundary uses — OwnershipGuard
      // already let this through because the code had no group *before* this
      // upsert ran; this is the one case that can only be caught after.
      throw new NotFoundException();
    }

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
