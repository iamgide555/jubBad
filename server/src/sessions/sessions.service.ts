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
import { computeRatingTracks } from '../../../engines/elo.ts';
import {
  compareArrangements,
  generateRound,
  groupKey,
  InvalidRoundInputError,
  type CourtSize,
} from '../../../engines/pairing.ts';
import { isValidIsoDate } from '../../../engines/parser.ts';
import { waitingSinceMap } from '../../../engines/waiting.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  courtSizeFor,
  formatAt,
  InvalidCourtNumberError,
  parseCourtFormats,
  withFormatAt,
} from './court-formats.js';
import { deriveHistory } from './derive-history.js';
import { CorruptPairingError, parseTeam, parseTeams, teamPlayers } from './pairing-teams.js';
import { SessionLock } from './session-lock.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';
import type { FinishPairingDto } from './dto/finish-pairing.dto.js';
import type { SetCourtCountDto } from './dto/set-court-count.dto.js';
import type { SetCourtFormatDto } from './dto/set-court-format.dto.js';
import type { SetModeDto } from './dto/set-mode.dto.js';
import type { SetRosterActiveDto } from './dto/set-roster-active.dto.js';
import type { SwapPlayerDto } from './dto/swap-player.dto.js';

export interface SessionMatch {
  matchNumber: number;
  courtNumber: number;
  /** Null for a singles match — there is no partner to name. */
  partnerName: string | null;
  opponentNames: string[];
  scoreA: number | null;
  scoreB: number | null;
  result: 'win' | 'loss' | 'no-result';
}

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

  /**
   * Converts a corrupt row into the same INVALID_SESSION_STATE 500 the
   * engine's own input validation uses (see `runGenerateRound`) — a
   * malformed `teamA`/`teamB` is corrupt server state, not something the
   * host did, and must not surface as an ordinary "not enough players" or
   * 404 that hides where the fault actually is. Shared by every
   * pairing-teams parse below so that mapping can't drift between them.
   */
  private parseOrThrow<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CorruptPairingError) {
        throw new InternalServerErrorException({ code: 'INVALID_SESSION_STATE', detail: error.message });
      }
      throw error;
    }
  }

  private teamsOf(pairing: { teamA: string; teamB: string }): { teamA: string[]; teamB: string[] } {
    return this.parseOrThrow(() => parseTeams(pairing));
  }

  /** Every player named by a pairing's two teams, in teamA-then-teamB order. */
  private playersOf(pairing: { teamA: string; teamB: string }): string[] {
    return this.parseOrThrow(() => teamPlayers(pairing));
  }

  /** Parses one already-JSON team string, with the same corrupt-state mapping as `teamsOf`. */
  private oneTeamOf(raw: string): string[] {
    return this.parseOrThrow(() => parseTeam(raw));
  }

  async createSession(
    dto: CreateSessionDto,
    caller: { id: string; role: string }
  ): Promise<{ code: string }> {
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
          select: { code: true, ownerId: true },
        });
        // "No such group" and "a real group, not yours" get the identical
        // 404 — the group is named in the body, so OwnershipGuard could not
        // check this route by path alone, and this is that check, deferred
        // here. Telling the two apart (as a plain "does not exist" 400 once
        // did, before ownership existed to disagree with) would let a caller
        // probe arbitrary codes for existence by their status code alone.
        if (!group || (group.ownerId !== caller.id && caller.role !== 'admin')) {
          throw new NotFoundException();
        }

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
    // Parsed once rather than inside the loop below — this is a live-polled
    // endpoint, and formatAt would otherwise re-parse the identical JSON
    // string once per court on every poll.
    const courtFormats = parseCourtFormats(session.courtFormats);
    const courts = Array.from({ length: courtCount }, (_, i) => {
      const courtNumber = i + 1;
      // Authoritative regardless of the court's status: the toggle only ever
      // writes while idle (see setCourtFormatExclusively), so a pending or
      // active pairing's actual team size can never disagree with this.
      const format = courtFormats[courtNumber - 1] ?? 'doubles';
      const current = session.pairings
        .filter((p) => p.courtNumber === courtNumber && p.endedAt === null)
        .sort((a, b) => b.matchNumber - a.matchNumber)[0];

      if (!current) return { courtNumber, status: 'idle' as const, format };

      const { teamA, teamB } = this.teamsOf(current);
      return current.confirmedAt
        ? {
            courtNumber,
            status: 'active' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            teamA,
            teamB,
          }
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
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
          .flatMap((p) => this.playersOf(p).map((id) => [id, p.endedAt!.toISOString()] as const))
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
              (p) => p.confirmedAt !== null && this.playersOf(p).includes(r.playerId)
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
    const toPairing = (p: { teamA: string; teamB: string }) => this.teamsOf(p);

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
        select: { createdAt: true, courtCount: true },
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
        for (const id of this.playersOf(pairing)) {
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

      // One round's worth of the most recently finished matches, across every
      // court — not just the one being reshuffled. Async court finishes are
      // exactly what ties players level on games and waiting time, which is
      // when the engine needs this to avoid handing a quartet straight back
      // onto another court with the teams swapped.
      const courtCount = session.courtCount ?? 0;
      if (courtCount > 0) {
        const recentGroups = finished.slice(-courtCount).map((p) => this.playersOf(p));
        history.recentGroupKeys = new Set(recentGroups.map((group) => groupKey(group)));
        // Raw, unhashed — server-only, used by deprioritizeWaitingExclusively
        // to target the actual players in the last group, not just detect a
        // repeat. Not part of MatchHistory; the engine never reads it.
        (history as typeof history & { recentGroups: string[][] }).recentGroups = recentGroups;
      }
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
      for (const id of this.playersOf(p)) reserved.add(id);
    }
    const available = rosterPlayerIds.filter((id) => !reserved.has(id));

    const history = await this.loadHistory(session.groupId, sessionCode);

    const avoidSplit = existingPending ? this.teamsOf(existingPending) : undefined;

    const ratings =
      session.mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;

    // Plan across every idle court, then commit only the one asked for.
    //
    // Solving one court in isolation takes the least-played and leaves
    // whoever remains to be shovelled onto the next court together — that
    // court gets no choice of players at all, only of how to split them. When
    // two courts finish together that reliably recreates the same opponents,
    // which is what players actually noticed in a real session. Planning
    // across all of them and committing one keeps the per-court flow the host
    // is used to while giving the engine the freedom it needs.
    //
    // The requested court counts as idle even when it holds an unconfirmed
    // proposal, because that proposal is exactly what this call replaces.
    //
    // The requested court is offered *first* and every other idle court
    // follows in ascending number order. generateRound consumes offered
    // sizes as a strict prefix with no skipping, so this is what guarantees
    // the requested court is never starved by another idle court ahead of
    // it, and — since a prefix's first entry is always position 0 in
    // whatever the engine returns — that `result.courts[0]`, when present,
    // is always this court.
    const idleCourtNumbers = Array.from({ length: session.courtCount ?? 1 }, (_, i) => i + 1).filter(
      (n) => n === courtNumber || !nonEnded.some((p) => p.courtNumber === n)
    );
    const orderedCourtNumbers = [
      courtNumber,
      ...idleCourtNumbers.filter((n) => n !== courtNumber),
    ];
    const sizes: CourtSize[] = orderedCourtNumbers.map((n) =>
      courtSizeFor(formatAt(session.courtFormats, n))
    );

    const result = this.runGenerateRound(available, sizes, history, undefined, avoidSplit, ratings);
    if (result.courts.length === 0) {
      return {
        ok: false as const,
        reason: 'not-enough-players' as const,
        available: available.length,
        format: formatAt(session.courtFormats, courtNumber),
      };
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
    const players = this.playersOf(pairing);
    const unavailable = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, playerId: { in: players }, active: false },
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

    const { teamA, teamB } = this.teamsOf(pairing);
    const onThisCourt = new Set([...teamA, ...teamB]);
    if (!onThisCourt.has(dto.playerId)) throw this.notFound('PAIRING_PLAYER_NOT_FOUND');

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
      for (const id of this.playersOf(p)) reserved.add(id);
    }
    const pool = rosterPlayerIds.filter((id) => !reserved.has(id) && !onThisCourt.has(id));
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

    const swapIn = (candidate: string): [string[], string[]] => {
      const replace = (team: string[]): string[] =>
        team.map((id) => (id === dto.playerId ? candidate : id));
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

    const replaceIn = (raw: string, out: string, into: string): string[] => {
      const team = this.oneTeamOf(raw);
      return team.map((id) => (id === out ? into : id));
    };

    /**
     * Both players already on this court is a trade of seats, not a
     * substitution. Running the one-way replace for it rewrote the outgoing
     * player's seat to the incoming one and left the incoming player's own seat
     * alone, so picking A then B on the same court produced "B & B vs C & D" —
     * a court with a duplicate and a player silently dropped out of the match.
     *
     * There is no far pairing to trade back against here, which is exactly why
     * the general path could not catch it: `nonEnded` excludes this pairing.
     */
    const tradeIn = (raw: string, x: string, y: string): string[] => {
      const team = this.oneTeamOf(raw);
      const at = (id: string) => (id === x ? y : id === y ? x : id);
      return team.map(at);
    };

    const onThisCourt = new Set(this.playersOf(pairing));
    const sameCourt = onThisCourt.has(incomingId);

    const other = sameCourt
      ? undefined
      : nonEnded.find((p) => this.playersOf(p).includes(incomingId));
    if (other && other.confirmedAt !== null) {
      throw this.conflict('PAIRING_NOT_PENDING');
    }

    const newTeamA = sameCourt
      ? tradeIn(pairing.teamA, dto.playerId, incomingId)
      : replaceIn(pairing.teamA, dto.playerId, incomingId);
    const newTeamB = sameCourt
      ? tradeIn(pairing.teamB, dto.playerId, incomingId)
      : replaceIn(pairing.teamB, dto.playerId, incomingId);

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
   *
   * Returns both tracks; a singles result never moves the doubles map or vice
   * versa (see engines/elo.ts `computeRatingTracks`). Callers pass the whole
   * result straight through to the pairing engine, which picks the track
   * matching each court's own format — this is what lets one balanced-mode
   * round mix formats correctly.
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

    return computeRatingTracks(
      played.map((p) => ({
        ...this.teamsOf(p),
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

  setCourtFormat(code: string, courtNumber: number, dto: SetCourtFormatDto) {
    return this.lock.run(code, () => this.setCourtFormatExclusively(code, courtNumber, dto));
  }

  /**
   * Idle-only, enforced here rather than left to the client: a live pairing's
   * actual team size must never disagree with its court's configured format,
   * and idle is the only state where nothing in progress depends on it. Reuses
   * the existing COURT_ACTIVE code — it already means "this court has a match
   * on it" for both a pending and an active pairing, which is exactly the
   * refusal condition here too. COURT_IN_USE is deliberately not reused: its
   * Thai copy is written for shrinking the court count, not this.
   */
  private async setCourtFormatExclusively(code: string, courtNumber: number, dto: SetCourtFormatDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    this.assertCourtNumber(session.courtCount, courtNumber);

    const occupied = await this.prisma.pairing.findFirst({
      where: { sessionId: code, courtNumber, endedAt: null },
      select: { id: true },
    });
    if (occupied) throw this.conflict('COURT_ACTIVE');

    // A session created before CreateSessionDto capped courtCount at 20 could
    // still have more courts than withFormatAt's storage can hold — the DTO
    // cap prevents this for every session created from here on, but
    // assertCourtNumber above only checks against this session's own
    // (possibly grandfathered) courtCount, not the storage limit.
    let courtFormats: string;
    try {
      courtFormats = withFormatAt(session.courtFormats, courtNumber, dto.format);
    } catch (error) {
      if (error instanceof InvalidCourtNumberError) throw this.badRequest('INVALID_COURT_NUMBER');
      throw error;
    }
    const updated = await this.prisma.session.update({
      where: { code },
      data: { courtFormats },
    });
    return {
      code: updated.code,
      courtNumber,
      format: formatAt(updated.courtFormats, courtNumber),
    };
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
      const players = this.playersOf(latest);
      const openElsewhere = await this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, endedAt: null, id: { not: latest.id } },
        select: { teamA: true, teamB: true },
      });
      const busy = new Set(openElsewhere.flatMap((p) => this.playersOf(p)));
      if (players.some((id) => busy.has(id))) {
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
    const reserved = new Set(nonEnded.flatMap((p) => this.playersOf(p)));
    const idleCourts = Array.from({ length: session.courtCount ?? 0 }, (_, i) => i + 1).filter(
      (n) => !busyCourts.has(n)
    );
    const available = roster.map((r) => r.playerId).filter((id) => !reserved.has(id));

    // This call has no single court to favour, unlike `proposeExclusively`,
    // so it should seat as many players as it can rather than merely fill as
    // many courts as it can — the two are not the same thing once sizes
    // differ. Sorting idle courts smallest-first and taking a prefix (the
    // natural-looking approach) is provably wrong: with a free doubles court
    // and a free singles court and 4 players waiting, that offers the
    // singles court first, seats 2, and leaves the doubles court idle with
    // the other 2 still benched — even though filling the doubles court
    // instead seats all 4 for the same one court used. Since a court is only
    // ever 2 or 4, the exact best combination is cheap to find directly:
    // try every count of doubles courts to use, greedily fill the rest with
    // singles courts, and keep whichever total seats the most players. Ties
    // (same total, different mix) keep the first found — iterating fewer
    // doubles courts first means a tie prefers using more courts of the
    // idle set rather than fewer, which fits this endpoint's own name.
    const idleDoublesCourts = idleCourts.filter(
      (n) => formatAt(session.courtFormats, n) === 'doubles'
    );
    const idleSinglesCourts = idleCourts.filter(
      (n) => formatAt(session.courtFormats, n) === 'singles'
    );

    let bestSeated = 0;
    let bestDoublesUsed = 0;
    let bestSinglesUsed = 0;
    for (let doublesUsed = 0; doublesUsed <= idleDoublesCourts.length; doublesUsed++) {
      const remaining = available.length - doublesUsed * 4;
      if (remaining < 0) break;
      const singlesUsed = Math.min(idleSinglesCourts.length, Math.floor(remaining / 2));
      const seated = doublesUsed * 4 + singlesUsed * 2;
      if (seated > bestSeated) {
        bestSeated = seated;
        bestDoublesUsed = doublesUsed;
        bestSinglesUsed = singlesUsed;
      }
    }

    if (idleCourts.length === 0 || bestSeated === 0) {
      return { ok: false as const, reason: 'not-enough-players' as const, filled: [] as number[] };
    }

    const chosenCourts = [
      ...idleDoublesCourts.slice(0, bestDoublesUsed),
      ...idleSinglesCourts.slice(0, bestSinglesUsed),
    ];
    const sizes: CourtSize[] = chosenCourts.map((n) => courtSizeFor(formatAt(session.courtFormats, n)));

    const history = await this.loadHistory(session.groupId, sessionCode);
    const ratings =
      session.mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const result = this.runGenerateRound(available, sizes, history, undefined, undefined, ratings);

    const filled = await this.prisma.$transaction(async (tx) => {
      const written: number[] = [];
      for (const assignment of result.courts) {
        const courtNumber = chosenCourts[assignment.court - 1];
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

  deprioritizeWaiting(sessionCode: string) {
    return this.lock.run(sessionCode, () => this.deprioritizeWaitingExclusively(sessionCode));
  }

  /**
   * Manual escape hatch for the async-court-desync case the pairing engine
   * handles automatically (see recentGroupKeys in loadHistory) but only ever
   * by swapping the single player nearest the fairness boundary. A host who
   * wants more than that can credit everyone waiting except the one with the
   * fewest games up to the roster-wide max, so the next draw favours them —
   * and additionally push half of the last-played group's still-waiting
   * members above that level (2 of 4 for a doubles group, 1 of 2 for
   * singles), guaranteeing at least that many sit out next. Half, not the
   * whole group: pushing everyone by an identical amount would just keep
   * them tied to each other and reforming as a unit later, rather than
   * actually breaking it up. Reuses the same gamesOffset rotation-only
   * credit as re-activating a player — stats read the Pairing rows directly
   * and never see it.
   */
  private async deprioritizeWaitingExclusively(sessionCode: string) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, active: true },
    });
    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null },
    });
    const onCourt = new Set<string>();
    for (const p of nonEnded) {
      for (const id of this.playersOf(p)) onCourt.add(id);
    }
    const waiting = roster.filter((r) => !onCourt.has(r.playerId));
    if (waiting.length <= 1) {
      return { ok: true as const, deprioritized: [] as string[] };
    }

    const history = await this.loadHistory(session.groupId, sessionCode);
    const recentGroups = (history as typeof history & { recentGroups?: string[][] }).recentGroups ?? [];
    const effective = (playerId: string, gamesOffset: number) =>
      (history.gamesPlayedThisSession.get(playerId) ?? 0) + gamesOffset;

    // Whole roster, not just who's currently on court — meaningful even when
    // both courts are already idle, which is exactly when this gets clicked.
    const target = roster.reduce((max, r) => Math.max(max, effective(r.playerId, r.gamesOffset)), 0);
    const lowest = waiting.reduce((min, r) =>
      effective(r.playerId, r.gamesOffset) < effective(min.playerId, min.gamesOffset) ? r : min
    );

    const waitingIds = new Set(waiting.map((r) => r.playerId));
    const pushIds = new Set<string>();
    for (const group of recentGroups) {
      const candidates = group.filter((id) => waitingIds.has(id) && id !== lowest.playerId);
      // Half the group, not all of it — pushing everyone by an identical
      // amount would just keep them tied to each other, reforming as a unit
      // later, rather than actually breaking it up. `slice(0, 2)` for a
      // 4-player group; for a 2-player singles group that generalizes to 1,
      // since pushing both would push the whole group after all.
      const pushCount = Math.max(1, Math.floor(group.length / 2));
      for (const id of candidates.slice(0, pushCount)) pushIds.add(id);
    }

    const updates = waiting
      .filter((r) => r.id !== lowest.id)
      .map((r) => {
        const level = pushIds.has(r.playerId) ? target + 1 : target;
        return {
          entry: r,
          // max() so this can only ever add credit, never take it away.
          gamesOffset: Math.max(r.gamesOffset, level - effective(r.playerId, r.gamesOffset) + r.gamesOffset),
        };
      })
      .filter(({ entry, gamesOffset }) => gamesOffset !== entry.gamesOffset);

    const results = await Promise.all(
      updates.map(({ entry, gamesOffset }) =>
        this.prisma.sessionRoster.updateMany({
          where: { id: entry.id, gamesOffset: entry.gamesOffset },
          data: { gamesOffset },
        })
      )
    );
    if (results.some((r) => r.count !== 1)) {
      throw this.conflict('ROSTER_STALE');
    }

    return { ok: true as const, deprioritized: updates.map(({ entry }) => entry.playerId) };
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
      const { teamA, teamB } = this.teamsOf(p);
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

  async getSummary(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const finishedMatch = { confirmedAt: { not: null }, endedAt: { not: null } } as const;
    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: code, ...finishedMatch },
      orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
    });

    const allPlayerIds = new Set<string>();
    for (const p of pairings) {
      for (const id of this.playersOf(p)) allPlayerIds.add(id);
    }
    const players = await this.prisma.player.findMany({
      where: { id: { in: [...allPlayerIds] } },
    });
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    const played = new Map<string, number>();
    const won = new Map<string, number>();
    const lost = new Map<string, number>();
    const matches = new Map<string, SessionMatch[]>();
    // Same played/won/lost tallies, but split by format (team size 1 =
    // singles, 2 = doubles) so a mixed session can report each separately.
    const byFormat = new Map<string, Record<'singles' | 'doubles', { played: number; won: number; lost: number }>>();
    const formatRow = (playerId: string) => {
      let row = byFormat.get(playerId);
      if (!row) {
        row = {
          singles: { played: 0, won: 0, lost: 0 },
          doubles: { played: 0, won: 0, lost: 0 },
        };
        byFormat.set(playerId, row);
      }
      return row;
    };

    for (const p of pairings) {
      const { teamA, teamB } = this.teamsOf(p);
      const format = teamA.length === 1 ? 'singles' : 'doubles';

      for (const [team, letter, opponents] of [
        [teamA, 'A', teamB],
        [teamB, 'B', teamA],
      ] as const) {
        const teamResult: 'win' | 'loss' | 'no-result' =
          p.winner === null ? 'no-result' : p.winner === letter ? 'win' : 'loss';
        for (const id of team) {
          played.set(id, (played.get(id) ?? 0) + 1);
          if (teamResult === 'win') won.set(id, (won.get(id) ?? 0) + 1);
          if (teamResult === 'loss') lost.set(id, (lost.get(id) ?? 0) + 1);

          const fRow = formatRow(id)[format];
          fRow.played += 1;
          if (teamResult === 'win') fRow.won += 1;
          if (teamResult === 'loss') fRow.lost += 1;

          // Null for a singles team: `find` has no other member to return,
          // so this already generalizes correctly — the old `?? id` fallback
          // is what silently made a singles player their own partner instead.
          const partnerId = team.find((otherId) => otherId !== id) ?? null;
          const entry: SessionMatch = {
            matchNumber: p.matchNumber,
            courtNumber: p.courtNumber,
            partnerName: partnerId === null ? null : nameById.get(partnerId) ?? 'Unknown',
            opponentNames: opponents.map((opponentId) => nameById.get(opponentId) ?? 'Unknown'),
            scoreA: p.scoreA,
            scoreB: p.scoreB,
            result: teamResult,
          };
          if (!matches.has(id)) matches.set(id, []);
          matches.get(id)!.push(entry);
        }
      }
    }

    return {
      session: {
        code: session.code,
        groupCode: session.groupId,
        date: session.date,
        venue: session.venue,
        courtCount: session.courtCount,
        endedAt: session.endedAt,
      },
      players: [...played.entries()]
        .map(([playerId, count]) => {
          const formats = byFormat.get(playerId);
          return {
            playerId,
            name: nameById.get(playerId) ?? 'Unknown',
            played: count,
            won: won.get(playerId) ?? 0,
            lost: lost.get(playerId) ?? 0,
            singles: formats && formats.singles.played > 0 ? formats.singles : null,
            doubles: formats && formats.doubles.played > 0 ? formats.doubles : null,
            matches: matches.get(playerId) ?? [],
          };
        })
        .sort((a, b) => b.played - a.played),
    };
  }
}
