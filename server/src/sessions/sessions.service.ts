import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { confirmExistingPlayerAlias, createNewPlayer, type Player as FuzzyPlayer } from '../../../engines/fuzzy-match.ts';
import { computeRatings } from '../../../engines/elo.ts';
import {
  compareArrangements,
  generateRound,
  InvalidRoundInputError,
} from '../../../engines/pairing.ts';
import { isValidIsoDate } from '../../../engines/parser.ts';
import { waitingSinceMap } from '../../../engines/waiting.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { deriveHistory } from './derive-history.js';
import { SessionLock } from './session-lock.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';
import type { FinishPairingDto } from './dto/finish-pairing.dto.js';
import type { SetCourtCountDto } from './dto/set-court-count.dto.js';
import type { SetModeDto } from './dto/set-mode.dto.js';
import type { SetRosterActiveDto } from './dto/set-roster-active.dto.js';
import type { SwapPlayerDto } from './dto/swap-player.dto.js';

@Injectable()
export class SessionsService {
  private readonly lock = new SessionLock();

  constructor(private readonly prisma: PrismaService) {}

  private badRequest(code: string): BadRequestException {
    return new BadRequestException({ code });
  }

  /**
   * The engine refuses input it cannot mean anything about — a duplicated
   * roster entry, a negative game count. Those are corrupt server state, not
   * something the host did, so they must not come back as the ordinary
   * "not enough players" answer: that reads as "go find more people" and hides
   * the real fault indefinitely. 500 with a distinct code, and the detail is
   * kept because these endpoints are already admin-only.
   */
  private runGenerateRound(...args: Parameters<typeof generateRound>) {
    try {
      return generateRound(...args);
    } catch (error) {
      if (error instanceof InvalidRoundInputError) {
        throw new InternalServerErrorException({
          code: 'INVALID_SESSION_STATE',
          detail: error.message,
        });
      }
      throw error;
    }
  }

  private conflict(code: string, details?: Record<string, unknown>): ConflictException {
    return new ConflictException({ code, ...details });
  }

  private notFound(code: string): NotFoundException {
    return new NotFoundException({ code });
  }

  async createSession(dto: CreateSessionDto): Promise<{ code: string }> {
    if (dto.date != null && !isValidIsoDate(dto.date)) {
      throw new BadRequestException('Session date must be a valid ISO calendar date.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const prior = await tx.sessionCreation.findUnique({
          where: {
            groupId_idempotencyKey: {
              groupId: dto.groupCode,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          select: { sessionId: true },
        });
        if (prior) return { code: prior.sessionId };

        const group = await tx.group.findUnique({
          where: { code: dto.groupCode },
          select: { code: true },
        });
        if (!group) throw new BadRequestException('The requested group does not exist.');

        const dbPlayers = await tx.player.findMany({ where: { groupId: dto.groupCode } });
        const playersById = new Map(dbPlayers.map((player) => [player.id, player]));
        let players: FuzzyPlayer[] = dbPlayers.map((player) => ({
          id: player.id,
          name: player.name,
          aliases: JSON.parse(player.aliases) as string[],
        }));
        const newPlayerWrites: { id: string; name: string }[] = [];
        const aliasWrites = new Map<string, string[]>();

        // Resolve all choices before deduplicating IDs. An earlier fuzzy
        // suggestion may become a new player while a later duplicate is
        // accepted as the real existing player.
        const resolve = (reviews: NameReviewDto[]): string[] => {
          const resolvedIds: string[] = [];
          for (const review of reviews) {
            const useExisting = review.decision === 'accept' && review.match.type !== 'new';
            if (useExisting) {
              const playerId = review.match.playerId;
              if (!playerId || !playersById.has(playerId)) {
                throw new BadRequestException(
                  'Each accepted player must exist in the requested group.'
                );
              }

              if (review.match.type === 'fuzzy' || review.match.type === 'duplicate') {
                players = confirmExistingPlayerAlias(players, playerId, review.inputName);
                const updated = players.find((player) => player.id === playerId)!;
                aliasWrites.set(playerId, updated.aliases);
              }
              resolvedIds.push(playerId);
            } else {
              const id = randomUUID();
              players = createNewPlayer(players, id, review.inputName);
              newPlayerWrites.push({ id, name: review.inputName });
              resolvedIds.push(id);
            }
          }
          return [...new Set(resolvedIds)];
        };

        const rosterPlayerIds = resolve(dto.rosterReviews);
        const waitlistPlayerIds = resolve(dto.waitlistReviews);
        const code = randomUUID().slice(0, 8);

        await Promise.all(
          newPlayerWrites.map((player) =>
            tx.player.create({
              data: { id: player.id, groupId: dto.groupCode, name: player.name, aliases: '[]' },
            })
          )
        );
        await Promise.all(
          [...aliasWrites.entries()].map(([id, aliases]) =>
            tx.player.update({ where: { id }, data: { aliases: JSON.stringify(aliases) } })
          )
        );
        await tx.session.create({
          data: {
            code,
            groupId: dto.groupCode,
            date: dto.date,
            venue: dto.venue,
            courtCount: dto.courtCount,
            rawImportText: dto.rawImportText,
          },
        });
        await tx.sessionCreation.create({
          data: {
            groupId: dto.groupCode,
            idempotencyKey: dto.idempotencyKey,
            sessionId: code,
          },
        });
        await Promise.all(
          rosterPlayerIds.map((playerId) =>
            tx.sessionRoster.create({ data: { sessionId: code, playerId } })
          )
        );
        await Promise.all(
          waitlistPlayerIds.map((playerId, position) =>
            tx.waitlist.create({ data: { sessionId: code, playerId, position } })
          )
        );
        return { code };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const prior = await this.prisma.sessionCreation.findUnique({
          where: {
            groupId_idempotencyKey: {
              groupId: dto.groupCode,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          select: { sessionId: true },
        });
        if (prior) return { code: prior.sessionId };
      }
      throw error;
    }
  }

  async getSession(code: string) {
    const session = await this.prisma.session.findUnique({
      where: { code },
      include: { roster: true, waitlist: { orderBy: { position: 'asc' } }, pairings: true },
    });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

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
        ? {
            courtNumber,
            status: 'active' as const,
            pairingId: current.id,
            revision: current.revision,
            teamA,
            teamB,
          }
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            teamA,
            teamB,
          };
    });

    return {
      code: session.code,
      groupCode: session.groupId,
      date: session.date,
      venue: session.venue,
      courtCount: session.courtCount,
      endedAt: session.endedAt,
      createdAt: session.createdAt,
      mode: session.mode,
      // Waiting time is derived, not stored: the client subtracts this from
      // now, falling back to createdAt for anyone who has not played yet.
      lastPlayedAt: Object.fromEntries(
        session.pairings
          .filter((p) => p.endedAt !== null)
          .sort((a, b) => a.endedAt!.getTime() - b.endedAt!.getTime())
          .flatMap((p) => [
            ...(JSON.parse(p.teamA) as [string, string]),
            ...(JSON.parse(p.teamB) as [string, string]),
          ].map((id) => [id, p.endedAt!.toISOString()] as const))
      ),
      rosterPlayerIds: session.roster.map((r) => r.playerId),
      restingPlayerIds: session.roster.filter((r) => !r.active).map((r) => r.playerId),
      /**
       * Games as the *rotation* counts them: matches played tonight plus the
       * fairness offset a late arrival was credited with. This exists so the
       * waiting list can be ordered the way the engine actually selects, and
       * is deliberately not a statistic — the stats endpoints read the Pairing
       * rows and never see the offset.
       */
      queueGames: Object.fromEntries(
        session.roster.map((r) => [
          r.playerId,
          r.gamesOffset +
            session.pairings.filter(
              (p) =>
                p.confirmedAt !== null &&
                [
                  ...(JSON.parse(p.teamA) as [string, string]),
                  ...(JSON.parse(p.teamB) as [string, string]),
                ].includes(r.playerId)
            ).length,
        ])
      ),
      // Only set for players who joined or returned part-way through. Their
      // wait runs from here rather than from the session start, which would
      // otherwise credit a late arrival with hours they were not present for.
      activatedAt: Object.fromEntries(
        session.roster
          .filter((r) => r.activatedAt !== null)
          .map((r) => [r.playerId, r.activatedAt!.toISOString()])
      ),
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

    const [allTime, thisSession, roster, session, finished] = await Promise.all([
      this.prisma.pairing.findMany({
        where: { session: { groupId: groupCode }, confirmedAt: { not: null } },
        select: { teamA: true, teamB: true },
      }),
      this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, confirmedAt: { not: null } },
        select: { teamA: true, teamB: true },
      }),
      this.prisma.sessionRoster.findMany({
        where: { sessionId: sessionCode },
        select: { playerId: true, gamesOffset: true, activatedAt: true },
      }),
      this.prisma.session.findUnique({
        where: { code: sessionCode },
        select: { createdAt: true },
      }),
      this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, endedAt: { not: null } },
        select: { teamA: true, teamB: true, endedAt: true },
        orderBy: { endedAt: 'asc' },
      }),
    ]);

    const history = deriveHistory(allTime.map(toPairing), thisSession.map(toPairing));

    // Rotation fairness only. The offset credits a player who joined part-way
    // through with the games they were not here for, so they queue alongside
    // everyone instead of ahead of them. Stats read the Pairing rows directly
    // and never see this.
    for (const { playerId, gamesOffset } of roster) {
      if (gamesOffset === 0) continue;
      history.gamesPlayedThisSession.set(
        playerId,
        (history.gamesPlayedThisSession.get(playerId) ?? 0) + gamesOffset
      );
    }

    // Breaks ties between players level on games, so the person who has been
    // sitting longest goes on first — the order the host already sees in the
    // waiting list. Built from the same three moments the client uses.
    if (session) {
      const lastPlayedAt: Record<string, string> = {};
      for (const pairing of finished) {
        for (const id of [
          ...(JSON.parse(pairing.teamA) as [string, string]),
          ...(JSON.parse(pairing.teamB) as [string, string]),
        ]) {
          lastPlayedAt[id] = pairing.endedAt!.toISOString();
        }
      }
      const activatedAt: Record<string, string> = {};
      for (const entry of roster) {
        if (entry.activatedAt) activatedAt[entry.playerId] = entry.activatedAt.toISOString();
      }
      history.waitingSince = waitingSinceMap(
        roster.map((r) => r.playerId),
        lastPlayedAt,
        session.createdAt.toISOString(),
        activatedAt
      );
    }

    return history;
  }

  private assertCourtNumber(courtCount: number | null, courtNumber: number): void {
    if (
      !Number.isInteger(courtNumber) ||
      courtNumber < 1 ||
      courtCount === null ||
      courtNumber > courtCount
    ) {
      throw this.badRequest('INVALID_COURT_NUMBER');
    }
  }

  propose(sessionCode: string, courtNumber: number) {
    return this.lock.run(sessionCode, () => this.proposeExclusively(sessionCode, courtNumber));
  }

  private async proposeExclusively(sessionCode: string, courtNumber: number) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) {
      throw this.conflict('SESSION_ENDED');
    }
    this.assertCourtNumber(session.courtCount, courtNumber);

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, active: true },
    });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });
    const reserved = new Set<string>();
    let existingPending: (typeof nonEnded)[number] | undefined;
    for (const p of nonEnded) {
      if (p.courtNumber === courtNumber) {
        if (p.confirmedAt !== null) {
          throw this.conflict('COURT_ACTIVE');
        }
        existingPending = p;
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

    const ratings =
      session.mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;

    const result = this.runGenerateRound(
      available,
      1,
      history,
      undefined,
      avoidSplit,
      ratings
    );
    if (result.courts.length === 0) {
      return { ok: false as const, reason: 'not-enough-players' as const };
    }
    const [proposed] = result.courts;
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    let pairing;
    if (existingPending) {
      const updated = await this.prisma.pairing.updateMany({
        where: {
          id: existingPending.id,
          confirmedAt: null,
          endedAt: null,
          revision: existingPending.revision,
        },
        data: { teamA, teamB, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      pairing = await this.prisma.pairing.findUniqueOrThrow({ where: { id: existingPending.id } });
    } else {
      pairing = await this.prisma.pairing.create({
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
    }

    return {
      ok: true as const,
      pairing: {
        id: pairing.id,
        courtNumber: pairing.courtNumber,
        matchNumber: pairing.matchNumber,
        revision: pairing.revision,
        teamA: proposed.teamA,
        teamB: proposed.teamB,
      },
    };
  }

  /**
   * Loads a pairing, insisting it belongs to the session named in the URL.
   *
   * These routes are declared /sessions/:code/pairings/:id/... but used to read
   * only :id, so the session segment was decorative and a request naming one
   * session could drive a pairing in another. That is reachable without malice
   * — a tab left open on last week's session has buttons pointing at a code
   * whose pairings have long since moved on.
   *
   * A pairing in another session reports the same 404 as one that does not
   * exist: whether some other session holds that id is not something the answer
   * should disclose.
   */
  private async pairingInSession(sessionCode: string, id: string) {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing || pairing.sessionId !== sessionCode) throw this.notFound('PAIRING_NOT_FOUND');
    return pairing;
  }

  confirmPairing(sessionCode: string, id: string, expectedRevision?: number) {
    return this.lock.run(sessionCode, () =>
      this.confirmPairingExclusively(sessionCode, id, expectedRevision)
    );
  }

  private async confirmPairingExclusively(
    sessionCode: string,
    id: string,
    expectedRevision?: number
  ) {
    const pairing = await this.pairingInSession(sessionCode, id);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    if (session.endedAt !== null) {
      throw this.conflict('SESSION_ENDED');
    }
    if (pairing.endedAt !== null) {
      throw this.conflict('PAIRING_ENDED');
    }
    if (pairing.confirmedAt !== null) {
      throw this.conflict('PAIRING_CONFIRMED');
    }

    // Availability is checked here, not when the player was rested. Resting
    // someone must never disturb a match already being played — they are on
    // court — but a *pending* proposal is only a suggestion, and confirming it
    // would put a player who has gone home onto a court. Checking at
    // confirmation covers both without the host having to remember which
    // courts had proposals open. The fix is a swap or a reshuffle, both of
    // which already draw only from active players.
    const four = [
      ...(JSON.parse(pairing.teamA) as [string, string]),
      ...(JSON.parse(pairing.teamB) as [string, string]),
    ];
    const unavailable = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, playerId: { in: four }, active: false },
      select: { playerId: true },
    });
    if (unavailable.length > 0) {
      throw this.conflict('PLAYER_UNAVAILABLE', {
        playerIds: unavailable.map((r) => r.playerId),
      });
    }

    const updated = await this.prisma.pairing.updateMany({
      where: {
        id,
        confirmedAt: null,
        endedAt: null,
        revision: expectedRevision ?? pairing.revision,
      },
      data: { confirmedAt: new Date(), revision: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw this.conflict('PAIRING_STALE');
    }
    return this.prisma.pairing.findUniqueOrThrow({ where: { id } });
  }

  finishPairing(sessionCode: string, id: string, dto: FinishPairingDto) {
    return this.lock.run(sessionCode, () => this.finishPairingExclusively(sessionCode, id, dto));
  }

  private async finishPairingExclusively(
    sessionCode: string,
    id: string,
    dto: FinishPairingDto
  ) {
    const pairing = await this.pairingInSession(sessionCode, id);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    if (session.endedAt !== null) {
      throw this.conflict('SESSION_ENDED');
    }
    // Finishing a pairing nobody confirmed would leave a row that counts in
    // the stats table but is invisible to the pairing history, since the two
    // read different columns. Confirm is the single commit point (§7.2).
    if (pairing.confirmedAt === null) {
      throw this.conflict('PAIRING_CONFIRMATION_REQUIRED');
    }
    if (pairing.endedAt !== null) {
      throw this.conflict('PAIRING_ENDED');
    }
    this.assertCoherentResult(dto);

    const updated = await this.prisma.pairing.updateMany({
      where: {
        id,
        confirmedAt: { not: null },
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: {
        endedAt: new Date(),
        scoreA: dto.scoreA ?? null,
        scoreB: dto.scoreB ?? null,
        winner: dto.winner ?? null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw this.conflict('PAIRING_STALE');
    }
    return this.prisma.pairing.findUniqueOrThrow({ where: { id } });
  }

  private assertCoherentResult(dto: FinishPairingDto): void {
    const scoreA = dto.scoreA ?? null;
    const scoreB = dto.scoreB ?? null;
    const winner = dto.winner ?? null;
    const hasScoreA = scoreA !== null;
    const hasScoreB = scoreB !== null;

    if (hasScoreA !== hasScoreB) {
      throw this.badRequest('INCOMPLETE_SCORES');
    }
    if (
      (hasScoreA && (!Number.isInteger(scoreA) || scoreA! < 0)) ||
      (hasScoreB && (!Number.isInteger(scoreB) || scoreB! < 0))
    ) {
      throw this.badRequest('INVALID_SCORE');
    }
    if (winner !== null && winner !== 'A' && winner !== 'B') {
      throw this.badRequest('INVALID_WINNER');
    }
    if (hasScoreA && winner === null) {
      throw this.badRequest('WINNER_REQUIRED_FOR_SCORES');
    }
    if (
      hasScoreA &&
      ((winner === 'A' && scoreA! <= scoreB!) || (winner === 'B' && scoreB! <= scoreA!))
    ) {
      throw this.badRequest('WINNER_SCORE_MISMATCH');
    }
  }

  endSession(code: string) {
    return this.lock.run(code, () => this.endSessionExclusively(code));
  }

  private async endSessionExclusively(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const unfinished = await this.prisma.pairing.findFirst({
      where: { sessionId: code, endedAt: null },
    });
    if (unfinished) {
      throw this.conflict('SESSION_HAS_UNFINISHED_PAIRINGS');
    }

    const updated = await this.prisma.session.updateMany({
      where: { code, endedAt: null },
      data: { endedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw this.conflict('SESSION_ENDED');
    }
    const ended = await this.prisma.session.findUniqueOrThrow({ where: { code } });
    return { code: ended.code, endedAt: ended.endedAt };
  }

  async swapPlayer(sessionCode: string, pairingId: string, dto: SwapPlayerDto) {
    // Checked before taking the lock, so a request for the wrong session is
    // refused without queueing behind that session's work.
    const target = await this.pairingInSession(sessionCode, pairingId);
    return this.lock.run(target.sessionId, () =>
      this.swapPlayerExclusively(sessionCode, pairingId, dto)
    );
  }

  private async swapPlayerExclusively(
    sessionCode: string,
    pairingId: string,
    dto: SwapPlayerDto
  ) {
    const pairing = await this.pairingInSession(sessionCode, pairingId);
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) {
      throw this.conflict('PAIRING_NOT_PENDING');
    }

    const teamA = JSON.parse(pairing.teamA) as [string, string];
    const teamB = JSON.parse(pairing.teamB) as [string, string];
    const currentFour = new Set([...teamA, ...teamB]);
    if (!currentFour.has(dto.playerId)) throw this.notFound('PAIRING_PLAYER_NOT_FOUND');

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: pairing.sessionId, active: true },
    });
    const rosterPlayerIds = roster.map((r) => r.playerId);

    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: pairing.sessionId, endedAt: null, id: { not: pairingId } },
    });

    if (dto.withPlayerId !== undefined) {
      return this.swapWithChosenPlayer(pairing, dto, dto.withPlayerId, rosterPlayerIds, nonEnded);
    }

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
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    const history = await this.loadHistory(session.groupId, pairing.sessionId);
    const ratings =
      session.mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;

    const swapIn = (candidate: string): [[string, string], [string, string]] => {
      const replace = (team: [string, string]): [string, string] => [
        team[0] === dto.playerId ? candidate : team[0],
        team[1] === dto.playerId ? candidate : team[1],
      ];
      return [replace(teamA), replace(teamB)];
    };

    // The playing-pool choice follows normal rotation first. Pairing quality
    // only breaks ties between people with equally few games tonight.
    const [{ substitute }] = pool
      .map((candidate) => {
        const [candidateA, candidateB] = swapIn(candidate);
        return {
          substitute: candidate,
          games: history.gamesPlayedThisSession.get(candidate) ?? 0,
          assignment: { teamA: candidateA, teamB: candidateB },
        };
      })
      .sort(
        (one, other) =>
          one.games - other.games ||
          compareArrangements(
            [one.assignment],
            [other.assignment],
            history.partnerCounts,
            history.opponentCounts,
            ratings
          )
      );

    const [newTeamA, newTeamB] = swapIn(substitute);

    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(newTeamA),
        teamB: JSON.stringify(newTeamB),
        revision: { increment: 1 },
      },
    });
    if (write.count !== 1) {
      throw this.conflict('PAIRING_STALE');
    }
    const updated = await this.prisma.pairing.findUniqueOrThrow({ where: { id: pairingId } });

    return {
      ok: true as const,
      pairing: {
        id: updated.id,
        courtNumber: updated.courtNumber,
        matchNumber: updated.matchNumber,
        revision: updated.revision,
        teamA: newTeamA,
        teamB: newTeamB,
      },
    };
  }

  /**
   * Manual swap: the caller names who comes on instead of taking rotation's
   * choice. Two shapes share this path, because from the screen they are the
   * same gesture — drag a name onto a player. If the incoming player is idle
   * they simply replace the outgoing one; if they are on another court that is
   * still pending, the two trade places, which is why this can write two rows.
   *
   * A trade is refused once the other court is confirmed or running. Pulling
   * someone out of a match already in progress is not a scheduling change, it
   * is rewriting history, and the score being entered would no longer belong
   * to the players it names.
   */
  private async swapWithChosenPlayer(
    pairing: { id: string; sessionId: string; revision: number; teamA: string; teamB: string },
    dto: SwapPlayerDto,
    incomingId: string,
    rosterPlayerIds: string[],
    nonEnded: { id: string; revision: number; teamA: string; teamB: string; confirmedAt: Date | null }[]
  ) {
    if (incomingId === dto.playerId) throw this.conflict('SWAP_SAME_PLAYER');

    const seat = await this.prisma.sessionRoster.findFirst({
      where: { sessionId: pairing.sessionId, playerId: incomingId },
    });
    if (!seat) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
    if (!seat.active) {
      throw this.conflict('PLAYER_UNAVAILABLE', { playerIds: [incomingId] });
    }
    if (!rosterPlayerIds.includes(incomingId)) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');

    const replaceIn = (raw: string, out: string, into: string): [string, string] => {
      const team = JSON.parse(raw) as [string, string];
      return [team[0] === out ? into : team[0], team[1] === out ? into : team[1]];
    };

    const other = nonEnded.find((p) => {
      const four = [
        ...(JSON.parse(p.teamA) as string[]),
        ...(JSON.parse(p.teamB) as string[]),
      ];
      return four.includes(incomingId);
    });
    if (other && other.confirmedAt !== null) {
      throw this.conflict('PAIRING_NOT_PENDING');
    }

    const newTeamA = replaceIn(pairing.teamA, dto.playerId, incomingId);
    const newTeamB = replaceIn(pairing.teamB, dto.playerId, incomingId);

    // The throw has to happen inside the transaction. An updateMany that
    // matches nothing is not a database error, so checking the counts after
    // committing would leave the far court traded and the near one untouched —
    // one player on two courts, the exact corruption this guards.
    await this.prisma.$transaction(async (tx) => {
      const near = await tx.pairing.updateMany({
        where: {
          id: pairing.id,
          confirmedAt: null,
          endedAt: null,
          revision: dto.expectedRevision ?? pairing.revision,
        },
        data: {
          teamA: JSON.stringify(newTeamA),
          teamB: JSON.stringify(newTeamB),
          revision: { increment: 1 },
        },
      });
      if (near.count !== 1) throw this.conflict('PAIRING_STALE');

      if (other) {
        const far = await tx.pairing.updateMany({
          where: { id: other.id, confirmedAt: null, endedAt: null, revision: other.revision },
          data: {
            teamA: JSON.stringify(replaceIn(other.teamA, incomingId, dto.playerId)),
            teamB: JSON.stringify(replaceIn(other.teamB, incomingId, dto.playerId)),
            revision: { increment: 1 },
          },
        });
        if (far.count !== 1) throw this.conflict('PAIRING_STALE');
      }
    });

    const updated = await this.prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    return {
      ok: true as const,
      pairing: {
        id: updated.id,
        courtNumber: updated.courtNumber,
        matchNumber: updated.matchNumber,
        revision: updated.revision,
        teamA: newTeamA,
        teamB: newTeamB,
      },
    };
  }

  /**
   * Sits a player out for the rest of tonight, or brings them back. The only
   * effect is on *future* court fills: a player rested mid-match plays that
   * match out, because `propose` reads the roster fresh each time and nothing
   * here touches an existing pairing. That is what makes this one control
   * cover a no-show, an early leaver and someone resting a few rounds.
   */
  /**
   * Elo over every finished, confirmed match this group has played, replayed in
   * the order they were confirmed — Elo is path dependent, so the ordering is
   * part of the result, not a detail.
   */
  private async loadRatings(groupCode: string) {
    const played = await this.prisma.pairing.findMany({
      where: {
        session: { groupId: groupCode },
        confirmedAt: { not: null },
        endedAt: { not: null },
        winner: { not: null },
      },
      orderBy: { confirmedAt: 'asc' },
      select: { teamA: true, teamB: true, winner: true },
    });

    return computeRatings(
      played.map((p) => ({
        teamA: JSON.parse(p.teamA) as [string, string],
        teamB: JSON.parse(p.teamB) as [string, string],
        winner: p.winner as 'A' | 'B',
      }))
    );
  }

  setMode(code: string, dto: SetModeDto) {
    return this.lock.run(code, () => this.setModeExclusively(code, dto));
  }

  /**
   * Court bookings change during an evening — one court from 19:00, three from
   * 20:00 is a normal booking. The imported message is parsed for a single
   * count, so the host adjusts it here when the later slot starts.
   *
   * Shrinking is refused while a court above the new count is in use, rather
   * than cancelling those matches: the players are physically on that court,
   * and a mis-typed count must not wipe a match in progress. Finish or undo
   * first, then shrink.
   */
  setCourtCount(code: string, dto: SetCourtCountDto) {
    return this.lock.run(code, () => this.setCourtCountExclusively(code, dto));
  }

  private async setCourtCountExclusively(code: string, dto: SetCourtCountDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    const occupied = await this.prisma.pairing.findMany({
      where: { sessionId: code, endedAt: null, courtNumber: { gt: dto.courtCount } },
      select: { courtNumber: true },
      orderBy: { courtNumber: 'asc' },
    });
    if (occupied.length > 0) {
      const courts = [...new Set(occupied.map((p) => p.courtNumber))];
      throw this.conflict('COURT_IN_USE', {
        courtNumbers: courts,
      });
    }

    const updated = await this.prisma.session.update({
      where: { code },
      data: { courtCount: dto.courtCount },
    });
    return { code: updated.code, courtCount: updated.courtCount };
  }

  private async setModeExclusively(code: string, dto: SetModeDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    const updated = await this.prisma.session.update({
      where: { code },
      data: { mode: dto.mode },
    });
    return { code: updated.code, mode: updated.mode };
  }

  /**
   * Reverses the single most recent step on one court, whatever it was: a
   * finish goes back to active, a confirm back to pending, and an unconfirmed
   * proposal is discarded so the court returns to idle. One rule rather than
   * three special cases, which matters because the common mistake — a
   * mis-tapped winner — is usually noticed only after the host has already
   * proposed the next match. Two taps get back to it.
   *
   * Scoped to a court rather than a global undo stack because that is how the
   * host thinks ("court 2, wrong winner"), and because a session-wide "last
   * action" is ambiguous with several courts running at once.
   *
   * Undoing a finish puts four players back on court, so it refuses when any of
   * them has since been picked up by another open match — restoring would
   * double-book them.
   */
  undoLastOnCourt(sessionCode: string, courtNumber: number) {
    return this.lock.run(sessionCode, () => this.undoExclusively(sessionCode, courtNumber));
  }

  private async undoExclusively(sessionCode: string, courtNumber: number) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) {
      throw this.conflict('SESSION_ENDED');
    }
    this.assertCourtNumber(session.courtCount, courtNumber);

    const latest = await this.prisma.pairing.findFirst({
      where: { sessionId: sessionCode, courtNumber },
      orderBy: { matchNumber: 'desc' },
    });
    if (!latest) {
      return { ok: false as const, reason: 'nothing-to-undo' as const };
    }

    if (latest.confirmedAt === null) {
      const deleted = await this.prisma.pairing.deleteMany({
        where: { id: latest.id, confirmedAt: null, endedAt: null, revision: latest.revision },
      });
      if (deleted.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      return { ok: true as const, undone: 'propose' as const };
    }

    if (latest.endedAt !== null) {
      const four = [
        ...(JSON.parse(latest.teamA) as [string, string]),
        ...(JSON.parse(latest.teamB) as [string, string]),
      ];
      const openElsewhere = await this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, endedAt: null, id: { not: latest.id } },
        select: { teamA: true, teamB: true },
      });
      const busy = new Set(
        openElsewhere.flatMap((p) => [
          ...(JSON.parse(p.teamA) as [string, string]),
          ...(JSON.parse(p.teamB) as [string, string]),
        ])
      );
      if (four.some((id) => busy.has(id))) {
        return { ok: false as const, reason: 'players-busy' as const };
      }

      const restored = await this.prisma.pairing.updateMany({
        where: { id: latest.id, confirmedAt: { not: null }, endedAt: { not: null }, revision: latest.revision },
        data: {
          endedAt: null,
          scoreA: null,
          scoreB: null,
          winner: null,
          revision: { increment: 1 },
        },
      });
      if (restored.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      return { ok: true as const, undone: 'finish' as const };
    }

    const unconfirmed = await this.prisma.pairing.updateMany({
      where: { id: latest.id, confirmedAt: { not: null }, endedAt: null, revision: latest.revision },
      data: { confirmedAt: null, revision: { increment: 1 } },
    });
    if (unconfirmed.count !== 1) {
      throw this.conflict('PAIRING_STALE');
    }
    return { ok: true as const, undone: 'confirm' as const };
  }

  /**
   * Proposes for every idle court at once — the session-start case, where
   * three courts meant six taps. One `generateRound` call across all of them
   * rather than a loop of single-court calls, so the arrangement is scored as
   * a whole and a player cannot land on two courts.
   */
  fillIdleCourts(sessionCode: string) {
    return this.lock.run(sessionCode, () => this.fillExclusively(sessionCode));
  }

  private async fillExclusively(sessionCode: string) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, active: true },
    });
    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });

    const busyCourts = new Set(nonEnded.map((p) => p.courtNumber));
    const reserved = new Set(
      nonEnded.flatMap((p) => [
        ...(JSON.parse(p.teamA) as [string, string]),
        ...(JSON.parse(p.teamB) as [string, string]),
      ])
    );
    const idleCourts = Array.from({ length: session.courtCount ?? 0 }, (_, i) => i + 1).filter(
      (n) => !busyCourts.has(n)
    );
    const available = roster.map((r) => r.playerId).filter((id) => !reserved.has(id));

    if (idleCourts.length === 0 || available.length < 4) {
      return { ok: false as const, reason: 'not-enough-players' as const, filled: [] as number[] };
    }

    const history = await this.loadHistory(session.groupId, sessionCode);
    const ratings =
      session.mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const result = this.runGenerateRound(
      available,
      idleCourts.length,
      history,
      undefined,
      undefined,
      ratings
    );

    const filled = await this.prisma.$transaction(async (tx) => {
      const written: number[] = [];
      for (const [i, assignment] of result.courts.entries()) {
        const courtNumber = idleCourts[i];
        const matchNumber =
          (await tx.pairing.count({
            where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
          })) + 1;
        await tx.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber,
            matchNumber,
            teamA: JSON.stringify(assignment.teamA),
            teamB: JSON.stringify(assignment.teamB),
          },
        });
        written.push(courtNumber);
      }
      return written;
    });

    return { ok: true as const, filled };
  }

  setRosterActive(sessionCode: string, playerId: string, dto: SetRosterActiveDto) {
    return this.lock.run(sessionCode, () =>
      this.setRosterActiveExclusively(sessionCode, playerId, dto)
    );
  }

  private async setRosterActiveExclusively(
    sessionCode: string,
    playerId: string,
    dto: SetRosterActiveDto
  ) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    const entry = await this.prisma.sessionRoster.findUnique({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
    });
    if (!entry) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');

    // Coming back needs a credit; going out never does.
    //
    // Without one, someone enabled part-way through sits on zero games while
    // everyone else is on five, and wins every draw until they catch up — which
    // is what players noticed. They are credited up to the highest count
    // already on court so they rejoin at the back of the rotation rather than
    // the front; everyone still playing passes them within a round or two, so
    // it costs them one wait, not their evening.
    //
    // max() rather than a plain assignment so toggling someone off and back on
    // can never *lower* them into a free turn.
    let gamesOffset = entry.gamesOffset;
    if (dto.active && !entry.active) {
      const history = await this.loadHistory(session.groupId, sessionCode);
      const others = await this.prisma.sessionRoster.findMany({
        where: { sessionId: sessionCode, active: true, playerId: { not: playerId } },
        select: { playerId: true },
      });
      const highest = others.reduce(
        (max, o) => Math.max(max, history.gamesPlayedThisSession.get(o.playerId) ?? 0),
        0
      );
      const own = history.gamesPlayedThisSession.get(playerId) ?? 0;
      gamesOffset = Math.max(entry.gamesOffset, highest - own + entry.gamesOffset);
    }

    const result = await this.prisma.sessionRoster.updateMany({
      where: { id: entry.id, active: entry.active, gamesOffset: entry.gamesOffset },
      data: {
        active: dto.active,
        gamesOffset,
        // Their wait restarts now; going out does not reset anything.
        activatedAt: dto.active && !entry.active ? new Date() : entry.activatedAt,
      },
    });
    if (result.count !== 1) {
      throw this.conflict('ROSTER_STALE');
    }
    const updated = await this.prisma.sessionRoster.findUniqueOrThrow({ where: { id: entry.id } });
    return { playerId: updated.playerId, active: updated.active };
  }

  async getStats(code: string, scope: 'session' | 'all') {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

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
