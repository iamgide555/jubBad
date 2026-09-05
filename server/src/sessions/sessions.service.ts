import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { confirmExistingPlayerAlias, createNewPlayer, type Player as FuzzyPlayer } from '../../../engines/fuzzy-match.ts';
import { generateRound, scoreArrangement } from '../../../engines/pairing.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { deriveHistory } from './derive-history.js';
import { SessionLock } from './session-lock.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';
import type { FinishPairingDto } from './dto/finish-pairing.dto.js';
import type { SwapPlayerDto } from './dto/swap-player.dto.js';

@Injectable()
export class SessionsService {
  private readonly lock = new SessionLock();

  constructor(private readonly prisma: PrismaService) {}

  async createSession(dto: CreateSessionDto): Promise<{ code: string }> {
    const dbPlayers = await this.prisma.player.findMany({ where: { groupId: dto.groupCode } });
    let players: FuzzyPlayer[] = dbPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      aliases: JSON.parse(p.aliases) as string[],
    }));

    const newPlayerWrites: { id: string; name: string }[] = [];
    const aliasWrites = new Map<string, string[]>();

    const resolve = (reviews: NameReviewDto[]): string[] =>
      reviews.map((review) => {
        if (review.match.type === 'exact') {
          return review.match.playerId!;
        }
        if (review.match.type === 'fuzzy' && review.decision === 'accept') {
          players = confirmExistingPlayerAlias(players, review.match.playerId!, review.inputName);
          const updated = players.find((p) => p.id === review.match.playerId)!;
          aliasWrites.set(updated.id, updated.aliases);
          return updated.id;
        }
        const newId = randomUUID();
        players = createNewPlayer(players, newId, review.inputName);
        newPlayerWrites.push({ id: newId, name: review.inputName });
        return newId;
      });

    const rosterPlayerIds = resolve(dto.rosterReviews);
    const waitlistPlayerIds = resolve(dto.waitlistReviews);

    const code = randomUUID().slice(0, 8);

    await this.prisma.$transaction([
      ...newPlayerWrites.map((p) =>
        this.prisma.player.create({
          data: { id: p.id, groupId: dto.groupCode, name: p.name, aliases: '[]' },
        })
      ),
      ...[...aliasWrites.entries()].map(([id, aliases]) =>
        this.prisma.player.update({ where: { id }, data: { aliases: JSON.stringify(aliases) } })
      ),
      this.prisma.session.create({
        data: {
          code,
          groupId: dto.groupCode,
          date: dto.date,
          venue: dto.venue,
          courtCount: dto.courtCount,
          rawImportText: dto.rawImportText,
        },
      }),
      ...rosterPlayerIds.map((playerId) =>
        this.prisma.sessionRoster.create({ data: { sessionId: code, playerId } })
      ),
      ...waitlistPlayerIds.map((playerId, i) =>
        this.prisma.waitlist.create({ data: { sessionId: code, playerId, position: i } })
      ),
    ]);

    return { code };
  }

  async getSession(code: string) {
    const session = await this.prisma.session.findUnique({
      where: { code },
      include: { roster: true, waitlist: { orderBy: { position: 'asc' } }, pairings: true },
    });
    if (!session) throw new NotFoundException();

    const courtCount = session.courtCount ?? 0;
    const courts = Array.from({ length: courtCount }, (_, i) => {
      const courtNumber = i + 1;
      const current = session.pairings
        .filter((p) => p.courtNumber === courtNumber && p.endedAt === null)
        .sort((a, b) => b.matchNumber - a.matchNumber)[0];

      if (!current) return { courtNumber, status: 'idle' as const };

      const teamA = JSON.parse(current.teamA) as [string, string];
      const teamB = JSON.parse(current.teamB) as [string, string];
      return current.confirmedAt
        ? { courtNumber, status: 'active' as const, pairingId: current.id, teamA, teamB }
        : { courtNumber, status: 'pending' as const, pairingId: current.id, teamA, teamB };
    });

    return {
      code: session.code,
      groupCode: session.groupId,
      date: session.date,
      venue: session.venue,
      courtCount: session.courtCount,
      endedAt: session.endedAt,
      rosterPlayerIds: session.roster.map((r) => r.playerId),
      waitlistPlayerIds: session.waitlist.map((w) => w.playerId),
      courts,
    };
  }

  /**
   * Partner/opponent counts come from every session this group has ever
   * played; games-played comes from this session alone. See the note on
   * `deriveHistory`, and docs/overview.md, "How the engines think — Pairing".
   */
  private async loadHistory(groupCode: string, sessionCode: string) {
    const toPairing = (p: { teamA: string; teamB: string }) => ({
      teamA: JSON.parse(p.teamA) as [string, string],
      teamB: JSON.parse(p.teamB) as [string, string],
    });

    const [allTime, thisSession] = await Promise.all([
      this.prisma.pairing.findMany({
        where: { session: { groupId: groupCode }, confirmedAt: { not: null } },
        select: { teamA: true, teamB: true },
      }),
      this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, confirmedAt: { not: null } },
        select: { teamA: true, teamB: true },
      }),
    ]);

    return deriveHistory(allTime.map(toPairing), thisSession.map(toPairing));
  }

  propose(sessionCode: string, courtNumber: number) {
    return this.lock.run(sessionCode, () => this.proposeExclusively(sessionCode, courtNumber));
  }

  private async proposeExclusively(sessionCode: string, courtNumber: number) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw new NotFoundException();
    if (session.endedAt !== null) {
      throw new ConflictException('This session has ended.');
    }

    const roster = await this.prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });
    const reserved = new Set<string>();
    let existingPending: (typeof nonEnded)[number] | undefined;
    for (const p of nonEnded) {
      if (p.courtNumber === courtNumber) {
        if (p.confirmedAt === null) existingPending = p;
        continue;
      }
      const [a1, a2] = JSON.parse(p.teamA) as [string, string];
      const [b1, b2] = JSON.parse(p.teamB) as [string, string];
      reserved.add(a1);
      reserved.add(a2);
      reserved.add(b1);
      reserved.add(b2);
    }
    const available = rosterPlayerIds.filter((id) => !reserved.has(id));

    const history = await this.loadHistory(session.groupId, sessionCode);

    const avoidSplit = existingPending
      ? {
          teamA: JSON.parse(existingPending.teamA) as [string, string],
          teamB: JSON.parse(existingPending.teamB) as [string, string],
        }
      : undefined;

    const result = generateRound(available, 1, history, undefined, avoidSplit);
    if (result.courts.length === 0) {
      return { ok: false as const, reason: 'not-enough-players' as const };
    }
    const [proposed] = result.courts;
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    const pairing = existingPending
      ? await this.prisma.pairing.update({
          where: { id: existingPending.id },
          data: { teamA, teamB },
        })
      : await this.prisma.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber,
            matchNumber:
              (await this.prisma.pairing.count({
                where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
              })) + 1,
            teamA,
            teamB,
          },
        });

    return {
      ok: true as const,
      pairing: {
        id: pairing.id,
        courtNumber: pairing.courtNumber,
        matchNumber: pairing.matchNumber,
        teamA: proposed.teamA,
        teamB: proposed.teamB,
      },
    };
  }

  async confirmPairing(id: string) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) throw new NotFoundException();
    if (pairing.endedAt !== null) {
      throw new ConflictException('This match has already finished.');
    }
    if (pairing.confirmedAt !== null) {
      throw new ConflictException('This match has already started.');
    }
    return this.prisma.pairing.update({ where: { id }, data: { confirmedAt: new Date() } });
  }

  async finishPairing(id: string, dto: FinishPairingDto) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) throw new NotFoundException();
    // Finishing a pairing nobody confirmed would leave a row that counts in
    // the stats table but is invisible to the pairing history, since the two
    // read different columns. Confirm is the single commit point (§7.2).
    if (pairing.confirmedAt === null) {
      throw new ConflictException('Confirm this match before finishing it.');
    }
    if (pairing.endedAt !== null) {
      throw new ConflictException('This match has already finished.');
    }
    return this.prisma.pairing.update({
      where: { id },
      data: { endedAt: new Date(), scoreA: dto.scoreA, scoreB: dto.scoreB, winner: dto.winner },
    });
  }

  async endSession(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException();

    const unfinished = await this.prisma.pairing.findFirst({
      where: { sessionId: code, endedAt: null },
    });
    if (unfinished) {
      throw new ConflictException('Finish all active courts before ending the session.');
    }

    const updated = await this.prisma.session.update({
      where: { code },
      data: { endedAt: new Date() },
    });
    return { code: updated.code, endedAt: updated.endedAt };
  }

  async swapPlayer(pairingId: string, dto: SwapPlayerDto) {
    const target = await this.prisma.pairing.findUnique({
      where: { id: pairingId },
      select: { sessionId: true },
    });
    if (!target) throw new NotFoundException();
    return this.lock.run(target.sessionId, () => this.swapPlayerExclusively(pairingId, dto));
  }

  private async swapPlayerExclusively(pairingId: string, dto: SwapPlayerDto) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id: pairingId } });
    if (!pairing) throw new NotFoundException();
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) {
      throw new ConflictException('Only a pending pairing can be swapped.');
    }

    const teamA = JSON.parse(pairing.teamA) as [string, string];
    const teamB = JSON.parse(pairing.teamB) as [string, string];
    const currentFour = new Set([...teamA, ...teamB]);
    if (!currentFour.has(dto.playerId)) throw new NotFoundException('Player is not in this pairing.');

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: pairing.sessionId },
    });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: pairing.sessionId, endedAt: null, id: { not: pairingId } },
    });
    const reserved = new Set<string>();
    for (const p of nonEnded) {
      const [a1, a2] = JSON.parse(p.teamA) as [string, string];
      const [b1, b2] = JSON.parse(p.teamB) as [string, string];
      reserved.add(a1);
      reserved.add(a2);
      reserved.add(b1);
      reserved.add(b2);
    }
    const pool = rosterPlayerIds.filter((id) => !reserved.has(id) && !currentFour.has(id));
    if (pool.length === 0) {
      return { ok: false as const, reason: 'no-substitute' as const };
    }

    const session = await this.prisma.session.findUniqueOrThrow({
      where: { code: pairing.sessionId },
    });
    const history = await this.loadHistory(session.groupId, pairing.sessionId);

    const swapIn = (candidate: string): [[string, string], [string, string]] => {
      const replace = (team: [string, string]): [string, string] => [
        team[0] === dto.playerId ? candidate : team[0],
        team[1] === dto.playerId ? candidate : team[1],
      ];
      return [replace(teamA), replace(teamB)];
    };

    // Ranked the same way `generateRound` ranks a whole arrangement — repeat
    // partners dominate, repeat opponents break ties (§6.3) — so a swap can't
    // undo the avoidance the proposal just achieved. Games played tonight only
    // separates candidates the history term rates equally.
    const [{ substitute }] = pool
      .map((candidate) => {
        const [candidateA, candidateB] = swapIn(candidate);
        return {
          substitute: candidate,
          score: scoreArrangement(
            [{ teamA: candidateA, teamB: candidateB }],
            history.partnerCounts,
            history.opponentCounts
          ),
          games: history.gamesPlayedThisSession.get(candidate) ?? 0,
        };
      })
      .sort((one, other) => one.score - other.score || one.games - other.games);

    const [newTeamA, newTeamB] = swapIn(substitute);

    const updated = await this.prisma.pairing.update({
      where: { id: pairingId },
      data: { teamA: JSON.stringify(newTeamA), teamB: JSON.stringify(newTeamB) },
    });

    return {
      ok: true as const,
      pairing: {
        id: updated.id,
        courtNumber: updated.courtNumber,
        matchNumber: updated.matchNumber,
        teamA: newTeamA,
        teamB: newTeamB,
      },
    };
  }

  async getStats(code: string, scope: 'session' | 'all') {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException();

    // Both `confirmedAt` and `endedAt`: a match counts once it was actually
    // played and finished. Filtering on `endedAt` alone would let a row that
    // skipped confirm into the stats while the pairing history ignored it.
    const finishedMatch = { confirmedAt: { not: null }, endedAt: { not: null } } as const;
    const pairings = await this.prisma.pairing.findMany({
      where:
        scope === 'all'
          ? { session: { groupId: session.groupId }, ...finishedMatch }
          : { sessionId: code, ...finishedMatch },
    });

    const played = new Map<string, number>();
    const won = new Map<string, number>();
    for (const p of pairings) {
      const teamA = JSON.parse(p.teamA) as [string, string];
      const teamB = JSON.parse(p.teamB) as [string, string];
      for (const id of [...teamA, ...teamB]) {
        played.set(id, (played.get(id) ?? 0) + 1);
      }
      if (p.winner === 'A' || p.winner === 'B') {
        const winningTeam = p.winner === 'A' ? teamA : teamB;
        for (const id of winningTeam) {
          won.set(id, (won.get(id) ?? 0) + 1);
        }
      }
    }

    const players = await this.prisma.player.findMany({
      where: { id: { in: [...played.keys()] } },
    });
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    return [...played.entries()]
      .map(([playerId, count]) => ({
        playerId,
        name: nameById.get(playerId) ?? 'Unknown',
        played: count,
        won: won.get(playerId) ?? 0,
      }))
      .sort((a, b) => b.played - a.played);
  }
}
