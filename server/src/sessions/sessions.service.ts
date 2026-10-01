import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type Session } from '@prisma/client';
import { confirmExistingPlayerAlias, createNewPlayer, type Player as FuzzyPlayer } from '../../../engines/fuzzy-match.ts';
import { computeRatingTracks } from '../../../engines/elo.ts';
import {
  compareArrangements,
  completeCourt,
  generateRound,
  groupKey,
  InvalidRoundInputError,
  type CourtSize,
  type Team,
} from '../../../engines/pairing.ts';
import { isValidIsoDate } from '../../../engines/parser.ts';
import {
  isRuleKind,
  NoLegalRuleMatchError,
  PairRuleSearchLimitError,
  rulesTouching,
  type PairRule,
} from '../../../engines/pair-rules.ts';
import { asLevel, type Level } from '../../../engines/levels.ts';
import { waitingSinceMap } from '../../../engines/waiting.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { levelWrite, loadLevelSetAt, loadPlayerLevels, loadRatingAnchors } from '../player-levels.js';
import { computeCarryEligibility } from './carry-eligibility.js';
import { carryOutcomesForConfirm, InvalidCarryOutcomesError, parseCarryOutcomes } from './carry-outcomes.js';
import {
  courtSizeFor,
  formatAt,
  InvalidCourtNumberError,
  parseCourtFormats,
  withFormatAt,
} from './court-formats.js';
import { modeAt, withModeAt } from './court-modes.js';
import {
  editableCourtCount,
  hasDuplicateCourtLabels,
  normalizeCourtLabel,
  parseCourtLabels,
  withLabelAt,
} from './court-labels.js';
import {
  applicableRules,
  enabledRules,
  InvalidDisabledRuleIdsError,
  parseDisabledRuleIds,
  rulesForParticipants,
  violatedRules,
} from './session-rules.js';
import { deriveHistory } from './derive-history.js';
import { deriveShuttleAccounting, parseShuttleChoice, type ShuttleChoice, type ShuttleRef } from './shuttle-tracking.js';
import { effectiveCourtMode, isCustomMode, isLevelMode, type SessionMode } from './session-mode.js';
import {
  CorruptPairingError,
  emptySeatCount,
  parseSeats,
  parseSeatTeams,
  parseTeams,
  seatedPlayers,
  type Seat,
} from './pairing-teams.js';
import { SessionLock } from './session-lock.js';
import type { AddWalkInDto } from './dto/add-walk-in.dto.js';
import type { CreateSessionDto, NameReviewDto } from './dto/create-session.dto.js';
import type { FinishPairingDto } from './dto/finish-pairing.dto.js';
import type { SetCourtCountDto } from './dto/set-court-count.dto.js';
import type { SetCourtFormatDto } from './dto/set-court-format.dto.js';
import type { SetCourtLabelDto } from './dto/set-court-label.dto.js';
import type { SetCourtModeDto } from './dto/set-court-mode.dto.js';
import type { SetModeDto } from './dto/set-mode.dto.js';
import type { SetRosterActiveDto } from './dto/set-roster-active.dto.js';
import type { SetRosterWalkInDto } from './dto/set-roster-walk-in.dto.js';
import type { SetSeatDto } from './dto/set-seat.dto.js';
import type { SetShuttleDetailsDto } from './dto/set-shuttle-details.dto.js';
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
  durationSeconds: number;
}

/** How long a pending match sits untouched before it confirms itself. */
export const AUTO_CONFIRM_DELAY_MS = 60_000;

/**
 * How far back of that moment the auto-confirm backdates `confirmedAt` — an
 * estimate of how long players take to read the lineup, check with the
 * host, and walk onto the court once it stops changing. Anchored to
 * `pendingSince` rather than to when the sweep actually runs, so a slow or
 * late sweep (a restart, a busy tick) never changes the recorded start
 * time — see the spec's "Backdating (D5)" section.
 */
export const AUTO_CONFIRM_WALK_ON_MS = 30_000;

type FillBlocked = { courtNumber: number; ruleIds: string[] };

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
  /** Shared by every engine entry point, so the corrupt-state mapping above
   *  can't drift between them. */
  private runEngine<T>(fn: () => T): T {
    try {
      return fn();
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

  private runGenerateRound(...args: Parameters<typeof generateRound>) {
    return this.runEngine(() => generateRound(...args));
  }

  private runCompleteCourt(...args: Parameters<typeof completeCourt>) {
    return this.runEngine(() => completeCourt(...args));
  }

  /**
   * The group's rules minus this session's switched-off ones, read fresh on
   * every call so a group edit applies to the next operation. An unknown
   * kind is corrupt data, not a rule to quietly skip.
   */
  private async loadEnabledRules(session: { groupId: string; disabledRuleIds: string | null }): Promise<PairRule[]> {
    const disabled = this.parseDisabledOrThrow(session.disabledRuleIds);
    const rows = await this.prisma.playerRule.findMany({
      where: { groupId: session.groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return enabledRules(rows, disabled).map((r) => {
      if (!isRuleKind(r.kind)) {
        throw new InternalServerErrorException({
          code: 'INVALID_SESSION_STATE',
          detail: `pair rule "${r.id}" has unknown kind "${r.kind}"`,
        });
      }
      return { id: r.id, playerAId: r.playerAId, playerBId: r.playerBId, kind: r.kind };
    });
  }

  /** Enabled rules that bind right now: both players active on the roster. */
  private async loadApplicableRules(
    session: { code: string; groupId: string; disabledRuleIds: string | null },
    activeIds?: ReadonlySet<string>
  ): Promise<PairRule[]> {
    const active =
      activeIds ??
      new Set(
        (
          await this.prisma.sessionRoster.findMany({
            where: { sessionId: session.code, active: true },
            select: { playerId: true },
          })
        ).map((r) => r.playerId)
      );
    return applicableRules(await this.loadEnabledRules(session), active);
  }

  /**
   * The pool and rules for one engine call over `pool`. A must-pair player
   * whose partner is busy on another court leaves the pool: a proposal that
   * seated them alone could never be confirmed.
   */
  private async engineRulesFor(
    session: { code: string; groupId: string; disabledRuleIds: string | null },
    activeIds: ReadonlySet<string>,
    pool: string[]
  ): Promise<{ rules: PairRule[]; pool: string[]; strandedRuleIds: string[] }> {
    const applicable = await this.loadApplicableRules(session, activeIds);
    const { stranded } = rulesForParticipants(applicable, new Set(pool));
    const usable = pool.filter((id) => !stranded.has(id));
    const { rules } = rulesForParticipants(applicable, new Set(usable));
    return { rules, pool: usable, strandedRuleIds: [...new Set(stranded.values())] };
  }

  private rulesBlocked(ruleIds: string[]) {
    return { ok: false as const, reason: 'pair-rules-blocked' as const, ruleIds };
  }

  /** Inconclusive is not "no legal match" and never "not enough players". */
  private searchLimit(): ServiceUnavailableException {
    return new ServiceUnavailableException({ code: 'PAIR_RULE_SEARCH_LIMIT' });
  }

  /** Throws when a full court breaks an applicable rule; a draft with an
   *  empty seat is still being built and is left alone. */
  private assertCourtLegal(teamA: Seat[], teamB: Seat[], rules: readonly PairRule[]): void {
    if (teamA.includes(null) || teamB.includes(null)) return;
    const broken = violatedRules(teamA as string[], teamB as string[], rules);
    if (broken.length > 0) throw this.conflict('PAIR_RULE_VIOLATION', { ruleIds: broken });
  }

  /**
   * The linked-carry snapshot written with a confirmation — see
   * carry-outcomes.ts. `[]` whenever no enabled must-pair link exists.
   * `enabled` must be the same read the confirm blocker judged legality
   * from: group rule writes are not serialized with the session lock, so a
   * second read could see a different rule set than the one that allowed
   * this confirm.
   */
  private async carryOutcomesJson(
    session: { code: string; groupId: string },
    pairing: { teamA: string; teamB: string },
    enabled: readonly PairRule[]
  ): Promise<string> {
    const linked = new Set(
      enabled
        .filter((r) => r.kind === 'must-pair')
        .flatMap((r) => [r.playerAId, r.playerBId])
    );
    if (linked.size === 0) return '[]';
    const [roster, levels] = await Promise.all([
      this.prisma.sessionRoster.findMany({
        where: { sessionId: session.code, active: true },
        select: { playerId: true },
      }),
      loadPlayerLevels(this.prisma, session.groupId),
    ]);
    return JSON.stringify(
      carryOutcomesForConfirm(this.teamsOf(pairing), linked, levels, roster.map((r) => r.playerId))
    );
  }

  private conflict(code: string, details?: Record<string, unknown>): ConflictException {
    return new ConflictException({ code, ...details });
  }

  private notFound(code: string): NotFoundException {
    return new NotFoundException({ code });
  }

  /**
   * Writes a court's pending pairing — reused by both `proposeExclusively`
   * branches (engine-picked and custom-mode empty), since "replace whatever
   * this court currently holds" is the same write either way: update the
   * existing pending row under its revision guard, or create the first one.
   */
  private async upsertPendingPairing(
    sessionCode: string,
    courtNumber: number,
    existingPending: { id: string; revision: number } | undefined,
    teamA: string,
    teamB: string,
    /** Every split shown on this court so far, `teamA` and `teamB` above
     *  included — reset to "[]" on a brand-new pairing row (a fresh match,
     *  or a custom-mode court cleared back to empty seats). See G3. */
    shownSplits: string
  ) {
    if (existingPending) {
      const updated = await this.prisma.pairing.updateMany({
        where: {
          id: existingPending.id,
          confirmedAt: null,
          endedAt: null,
          revision: existingPending.revision,
        },
        data: { teamA, teamB, shownSplits, pendingSince: new Date(), revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      return this.prisma.pairing.findUniqueOrThrow({ where: { id: existingPending.id } });
    }
    return this.prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber,
        matchNumber:
          (await this.prisma.pairing.count({
            where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
          })) + 1,
        teamA,
        teamB,
        shownSplits,
        pendingSince: new Date(),
      },
    });
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

  /** Strict: throws if either team has an unfilled seat. Only ever called on
   *  confirmed rows, where an empty seat would be corrupt state (see the
   *  confirm guard in `confirmPairingExclusively`). */
  private teamsOf(pairing: { teamA: string; teamB: string }): { teamA: string[]; teamB: string[] } {
    return this.parseOrThrow(() => parseTeams(pairing));
  }

  /** Tolerant: both teams as-is, empty seats included. For reading a pairing
   *  that may still be a custom-mode draft (getSession, a pending court's
   *  avoidSplit, a manual swap). */
  private seatsOf(pairing: { teamA: string; teamB: string }): { teamA: Seat[]; teamB: Seat[] } {
    return this.parseOrThrow(() => parseSeatTeams(pairing));
  }

  /** Every *occupied* seat's player id, in teamA-then-teamB order — empty
   *  seats are dropped. Tolerant, because every call site asks "who is
   *  actually on this court," which an unfilled seat never answers. */
  private playersOf(pairing: { teamA: string; teamB: string }): string[] {
    return this.parseOrThrow(() => seatedPlayers(pairing));
  }

  /** Every split already shown on a pending court, oldest first — see the
   *  `shownSplits` column comment. Never thrown by a host action, so a
   *  corrupt or pre-migration value (the column's own "[]" default covers
   *  the ordinary case) just yields no history rather than a 500: the worst
   *  outcome is the reshuffle-cycling bug this list exists to prevent, not
   *  broken state. */
  private parseShownSplits(raw: string): { teamA: Team; teamB: Team }[] {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  /** Parses one already-JSON team string, empty seats included — the two
   *  callers (`replaceIn`/`tradeIn` in `swapWithChosenPlayer`) only ever
   *  replace a seat that matches a given id, so a `null` entry just passes
   *  through untouched. */
  private oneSeatOf(raw: string): Seat[] {
    return this.parseOrThrow(() => parseSeats(raw));
  }

  /**
   * When a pending pairing will auto-confirm, or null when it won't: no
   * `pendingSince` yet (a row from before this column existed, or one an
   * undo just cleared), a seat still empty, or a seated player currently
   * resting. Mirrors `pairingConfirmBlocker`'s own skip conditions exactly,
   * so this is never shown counting down to a confirm the sweep is actually
   * going to refuse — checked here against the roster this call already
   * loaded, rather than by calling that async, DB-hitting method once per
   * court on every poll of this live-polled endpoint.
   */
  private autoStartAtFor(
    pairing: { teamA: string; teamB: string; pendingSince: Date | null },
    roster: { playerId: string; active: boolean }[]
  ): string | null {
    if (pairing.pendingSince === null) return null;
    if (emptySeatCount(pairing) > 0) return null;
    const restingIds = new Set(roster.filter((r) => !r.active).map((r) => r.playerId));
    if (this.playersOf(pairing).some((id) => restingIds.has(id))) return null;
    return new Date(pairing.pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS).toISOString();
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
          select: { code: true, ownerId: true, shuttleToolsEnabled: true, crossSessionHistory: true },
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
        const newPlayerWrites: { id: string; name: string; level: Level | null }[] = [];
        const aliasWrites = new Map<string, string[]>();
        const levelWrites = new Map<string, Level>();

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
              if (review.level && !playersById.get(playerId)!.level) {
                levelWrites.set(playerId, review.level);
              }
              resolvedIds.push(playerId);
            } else {
              const id = randomUUID();
              players = createNewPlayer(players, id, review.inputName);
              newPlayerWrites.push({ id, name: review.inputName, level: review.level ?? null });
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
              data: {
                id: player.id,
                groupId: dto.groupCode,
                name: player.name,
                aliases: '[]',
                ...levelWrite(null, player.level),
              },
            })
          )
        );
        await Promise.all(
          [...aliasWrites.entries()].map(([id, aliases]) =>
            tx.player.update({ where: { id }, data: { aliases: JSON.stringify(aliases) } })
          )
        );
        await Promise.all(
          [...levelWrites.entries()].map(([id, level]) =>
            tx.player.update({ where: { id }, data: levelWrite(null, level) })
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
            // Snapshots: a later change to the group switches never reaches this session.
            shuttleToolsEnabled: group.shuttleToolsEnabled,
            crossSessionHistory: group.crossSessionHistory,
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

    // Advanced sessions show each active court its shuttle in hand and the
    // distinct shuttles used so far. Loaded only then: this is a live poll.
    const shuttleNumbers = new Map<string, number>();
    const usedByPairing = new Map<string, string[]>();
    if (session.shuttleToolsEnabled) {
      const [identities, uses] = await Promise.all([
        this.prisma.sessionShuttle.findMany({ where: { sessionId: code } }),
        this.prisma.pairingShuttleUse.findMany({ where: { pairing: { sessionId: code } } }),
      ]);
      for (const sh of identities) shuttleNumbers.set(sh.id, sh.number);
      for (const u of uses) usedByPairing.set(u.pairingId, [...(usedByPairing.get(u.pairingId) ?? []), u.shuttleId]);
    }
    const shuttleRef = (id: string): ShuttleRef => ({ id, number: shuttleNumbers.get(id) ?? 0 });

    const courtCount = session.courtCount ?? 0;
    // Parsed once rather than inside the loop below — this is a live-polled
    // endpoint, and formatAt would otherwise re-parse the identical JSON
    // string once per court on every poll.
    const courtFormats = parseCourtFormats(session.courtFormats);
    const courtLabels = parseCourtLabels(session.courtLabels);
    const courts = Array.from({ length: courtCount }, (_, i) => {
      const courtNumber = i + 1;
      // Authoritative regardless of the court's status: the toggle only ever
      // writes while idle (see setCourtFormatExclusively), so a pending or
      // active pairing's actual team size can never disagree with this.
      const format = courtFormats[courtNumber - 1] ?? 'doubles';
      // Per-court mode, only ever different from session.mode in a custom
      // session — see effectiveCourtMode.
      const mode = effectiveCourtMode(session, courtNumber);
      const current = session.pairings
        .filter((p) => p.courtNumber === courtNumber && p.endedAt === null)
        .sort((a, b) => b.matchNumber - a.matchNumber)[0];

      if (!current) return { courtNumber, status: 'idle' as const, format, mode };

      // Tolerant: a pending custom-mode draft may still have unfilled seats,
      // and the dashboard needs to render them, not have this 500.
      const { teamA, teamB } = this.seatsOf(current);
      return current.confirmedAt
        ? {
            courtNumber,
            status: 'active' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            mode,
            teamA,
            teamB,
            startedAt: current.confirmedAt.toISOString(),
            ...(session.shuttleToolsEnabled
              ? {
                  currentShuttle: current.lastShuttleId ? shuttleRef(current.lastShuttleId) : null,
                  usedShuttles: (usedByPairing.get(current.id) ?? [])
                    .map(shuttleRef)
                    .sort((a, b) => a.number - b.number),
                }
              : {}),
          }
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            mode,
            teamA,
            teamB,
            autoStartAt: this.autoStartAtFor(current, session.roster),
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
      // Client gating only; the server enforces it on every shuttle write.
      shuttleToolsEnabled: session.shuttleToolsEnabled,
      // 'wait' in a level session, 'games' otherwise — how the waiting list
      // should be ordered to match what the engine actually does. A custom
      // session stays 'games' regardless of any individual court's mode: see
      // docs/superpowers/specs/2026-09-27-level-rework-design.md, section 3.
      queueBy: isLevelMode(session.mode) ? ('wait' as const) : ('games' as const),
      // Host-editable metadata (see SessionsService.setShuttleDetails), public
      // like the rest of this response — only writing them requires auth.
      shuttleCount: session.shuttleCount,
      shuttlePriceSatang: session.shuttlePriceSatang,
      // Per-court display names (index 0 = court 1; null = its number) and
      // the highest court the host's label editor may address, which can
      // exceed courtCount for retired courts — `courts` above is unaffected.
      courtLabels,
      editableCourtCount: editableCourtCount(session.courtCount, session.pairings, courtLabels),
      // Skew reference: the client compares this to its own Date.now() at
      // the moment the response lands, so a live court timer reads correctly
      // even when the host's device clock disagrees with the server's.
      serverNow: new Date().toISOString(),
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
   * Partner/opponent counts and games-played both come from this session
   * alone by default: players do not remember last week's partners, and
   * all-time counts made a newcomer (zero history with everyone) look like the
   * freshest partner for every regular. A group can opt back in; the choice is
   * snapshotted on `Session.crossSessionHistory` at creation. See the note on
   * `deriveHistory`, and docs/overview.md, "How the engines think — Pairing".
   */
  private async loadHistory(groupCode: string, sessionCode: string) {
    const toPairing = (p: { teamA: string; teamB: string }) => this.teamsOf(p);

    // Read first: the snapshotted flag decides whether the all-time query runs.
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      select: { createdAt: true, courtCount: true, crossSessionHistory: true },
    });
    const crossSessionHistory = session?.crossSessionHistory ?? false;

    const [allTime, thisSession, roster, finished] = await Promise.all([
      crossSessionHistory
        ? this.prisma.pairing.findMany({
            where: { session: { groupId: groupCode }, confirmedAt: { not: null } },
            select: { teamA: true, teamB: true },
          })
        : Promise.resolve(null),
      this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, confirmedAt: { not: null } },
        select: { teamA: true, teamB: true },
      }),
      this.prisma.sessionRoster.findMany({
        where: { sessionId: sessionCode },
        select: { playerId: true, gamesOffset: true, activatedAt: true },
      }),
      this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, endedAt: { not: null } },
        select: { teamA: true, teamB: true, endedAt: true },
        orderBy: { endedAt: 'asc' },
      }),
    ]);

    const history = deriveHistory((allTime ?? thisSession).map(toPairing), thisSession.map(toPairing));

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

  /**
   * The subset and order of `courtNumbers` that seats the most players —
   * same reasoning as `fillExclusively`'s own non-custom seats-maximising
   * choice below (a court is only ever 2 or 4, so trying every count of
   * doubles courts to use and greedily filling the rest with singles courts
   * is cheap and exact). Extracted so a custom session's per-mode-group fill
   * gets the same guarantee: filling courts in plain court-number order can
   * under-seat when a singles court comes before a doubles court and there
   * are not enough players left over to also fill the doubles court.
   */
  private chooseSeatingOrder(
    courtNumbers: number[],
    session: { courtFormats: string | null },
    availableCount: number
  ): number[] {
    const doublesCourts = courtNumbers.filter((n) => formatAt(session.courtFormats, n) === 'doubles');
    const singlesCourts = courtNumbers.filter((n) => formatAt(session.courtFormats, n) === 'singles');

    let bestSeated = 0;
    let bestDoublesUsed = 0;
    let bestSinglesUsed = 0;
    for (let doublesUsed = 0; doublesUsed <= doublesCourts.length; doublesUsed++) {
      const remaining = availableCount - doublesUsed * 4;
      if (remaining < 0) break;
      const singlesUsed = Math.min(singlesCourts.length, Math.floor(remaining / 2));
      const seated = doublesUsed * 4 + singlesUsed * 2;
      if (seated > bestSeated) {
        bestSeated = seated;
        bestDoublesUsed = doublesUsed;
        bestSinglesUsed = singlesUsed;
      }
    }

    return [...doublesCourts.slice(0, bestDoublesUsed), ...singlesCourts.slice(0, bestSinglesUsed)];
  }

  /**
   * Carry-game inputs for a level-mode propose/fill — only ever needed when
   * at least one court being planned is effectively `level`. Cheap enough
   * (three small queries) to call unconditionally from those two call sites.
   */
  private async loadCarryEligibility(
    session: { groupId: string; code: string }
  ): Promise<{ carryEligible: Set<string>; carriedTonight: Set<string> }> {
    const [roster, levels, levelSetAt, confirmed] = await Promise.all([
      this.prisma.sessionRoster.findMany({
        where: { sessionId: session.code, active: true },
        select: { playerId: true },
      }),
      loadPlayerLevels(this.prisma, session.groupId),
      loadLevelSetAt(this.prisma, session.groupId),
      this.prisma.pairing.findMany({
        where: { sessionId: session.code, confirmedAt: { not: null } },
        select: { id: true, teamA: true, teamB: true, confirmedAt: true, carryOutcomes: true },
      }),
    ]);

    return computeCarryEligibility({
      activeRosterIds: roster.map((r) => r.playerId),
      levels,
      levelSetAt,
      confirmedPairingsTonight: confirmed.map((p) => ({
        playerIds: this.playersOf(p),
        confirmedAt: p.confirmedAt!.getTime(),
        carryOutcomes: this.carryOutcomesOf(p),
      })),
    });
  }

  /** A corrupt snapshot must not read as a completed carry — fail visibly. */
  private carryOutcomesOf(pairing: { id: string; carryOutcomes: string }) {
    try {
      return parseCarryOutcomes(pairing.carryOutcomes);
    } catch (error) {
      if (error instanceof InvalidCarryOutcomesError) {
        throw new InternalServerErrorException({
          code: 'INVALID_SESSION_STATE',
          detail: `pairing ${pairing.id}: ${error.message}`,
        });
      }
      throw error;
    }
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

    // A per-court mode (custom sessions only) governs this branch, not the
    // session-wide mode: a custom session's court set to a non-custom mode
    // must reach the engine below, exactly like a non-custom session's
    // court does.
    const requestedMode = effectiveCourtMode(session, courtNumber);

    // Custom mode proposes empty seats and stops — the engine picks nobody.
    // Reshuffling a custom court is this same call again, which is what
    // makes it double as "clear the court": the write below always replaces
    // whatever seats existed with a fresh set of empties. No history, no
    // ratings, no engine call — the host is about to do that work by hand.
    if (requestedMode === 'custom') {
      const size = courtSizeFor(formatAt(session.courtFormats, courtNumber));
      const half = size / 2;
      const emptyTeam: Seat[] = Array(half).fill(null);
      const teamA = JSON.stringify(emptyTeam);
      const teamB = JSON.stringify(emptyTeam);
      const pairing = await this.upsertPendingPairing(sessionCode, courtNumber, existingPending, teamA, teamB, '[]');
      return {
        ok: true as const,
        pairing: {
          id: pairing.id,
          courtNumber: pairing.courtNumber,
          matchNumber: pairing.matchNumber,
          revision: pairing.revision,
          teamA: emptyTeam,
          teamB: emptyTeam,
        },
      };
    }

    const history = await this.loadHistory(session.groupId, sessionCode);

    // A partly-filled custom draft is not a split worth avoiding — there is
    // no completed pairing yet to avoid reproducing, and `teamsOf` would
    // throw on its empty seats besides.
    const currentSplit =
      existingPending && emptySeatCount(existingPending) === 0
        ? this.teamsOf(existingPending)
        : undefined;

    // Every split this exact pending court has already shown, oldest first —
    // not just the one on screen right now. A reshuffle that only ever
    // avoided the current split could bounce between two of a 4-player
    // court's three possible splits forever, since excluding just one always
    // leaves an alternative to fall back on (G3, real-session report:
    // 12|34 -> 14|23 -> 12|34). Always appended, duplicates included: the
    // engine's own exclusion (oldest-first) relies on array position to know
    // which split was shown most recently, and skipping a re-shown split here
    // would let it drift to the front and get dropped as if it were stale.
    const previouslyShown: { teamA: Team; teamB: Team }[] = existingPending
      ? this.parseShownSplits(existingPending.shownSplits)
      : [];
    const avoidSplits = currentSplit ? [...previouslyShown, currentSplit] : previouslyShown;

    const ratings = requestedMode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const levels = await loadPlayerLevels(this.prisma, session.groupId);
    const queueBy: 'games' | 'wait' = requestedMode === 'level' ? 'wait' : 'games';
    const carry = requestedMode === 'level' ? await this.loadCarryEligibility(session) : undefined;

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
    //
    // Co-planned courts are also limited to whichever idle courts share this
    // court's effective mode — in a non-custom session every court shares
    // session.mode already, so this filter is a no-op there; in a custom
    // session it keeps another court's different mode from leaking into
    // this one's search.
    const idleCourtNumbers = Array.from({ length: session.courtCount ?? 1 }, (_, i) => i + 1).filter(
      (n) =>
        (n === courtNumber || !nonEnded.some((p) => p.courtNumber === n)) &&
        effectiveCourtMode(session, n) === requestedMode
    );
    const orderedCourtNumbers = [
      courtNumber,
      ...idleCourtNumbers.filter((n) => n !== courtNumber),
    ];
    const sizes: CourtSize[] = orderedCourtNumbers.map((n) =>
      courtSizeFor(formatAt(session.courtFormats, n))
    );

    const ruled = await this.engineRulesFor(session, new Set(rosterPlayerIds), available);

    let result: ReturnType<typeof generateRound>;
    try {
      result = this.runGenerateRound(
        ruled.pool,
        sizes,
        history,
        undefined,
        avoidSplits.length > 0 ? avoidSplits : undefined,
        ratings,
        levels,
        requestedMode === 'level',
        queueBy,
        carry?.carryEligible,
        carry?.carriedTonight,
        ruled.rules,
        'requested'
      );
    } catch (error) {
      if (error instanceof NoLegalRuleMatchError) return this.rulesBlocked(error.ruleIds);
      if (error instanceof PairRuleSearchLimitError) throw this.searchLimit();
      throw error;
    }
    const proposed = result.courts.find((c) => c.court === 1);
    if (!proposed) {
      // Enough people, but a must-pair partner busy elsewhere is what left
      // this court short — that is the rule's doing, not a head count.
      if (ruled.pool.length < sizes[0] && available.length >= sizes[0]) {
        return this.rulesBlocked(ruled.strandedRuleIds);
      }
      return {
        ok: false as const,
        reason: 'not-enough-players' as const,
        available: available.length,
        format: formatAt(session.courtFormats, courtNumber),
      };
    }
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    const pairing = await this.upsertPendingPairing(
      sessionCode,
      courtNumber,
      existingPending,
      teamA,
      teamB,
      JSON.stringify(avoidSplits)
    );

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

  confirmPairing(
    sessionCode: string,
    id: string,
    expectedRevision?: number,
    shuttle?: { kind: 'new' | 'existing'; shuttleId?: string }
  ) {
    return this.lock.run(sessionCode, () =>
      this.confirmPairingExclusively(sessionCode, id, expectedRevision, shuttle)
    );
  }

  /** The next display number: max over every identity ever opened, voided or not. */
  private async nextShuttleNumber(tx: Prisma.TransactionClient, sessionCode: string): Promise<number> {
    const top = await tx.sessionShuttle.aggregate({
      where: { sessionId: sessionCode },
      _max: { number: true },
    });
    return (top._max.number ?? 0) + 1;
  }

  /** Whether another active (confirmed, unfinished) game currently holds this shuttle. */
  private async shuttleHeldElsewhere(
    tx: Prisma.TransactionClient,
    sessionCode: string,
    shuttleId: string,
    exceptPairingId: string
  ): Promise<boolean> {
    const held = await tx.pairing.findFirst({
      where: {
        sessionId: sessionCode,
        confirmedAt: { not: null },
        endedAt: null,
        lastShuttleId: shuttleId,
        id: { not: exceptPairingId },
      },
      select: { id: true },
    });
    return held !== null;
  }

  /**
   * Resolves a host's choice to the shuttle a game starts with, opening a new
   * numbered identity when asked. Runs inside the caller's transaction so an
   * opened identity cannot outlive a confirmation that then fails.
   */
  private async startingShuttleId(
    tx: Prisma.TransactionClient,
    sessionCode: string,
    pairingId: string,
    choice: ShuttleChoice
  ): Promise<string> {
    if (choice.kind === 'new') {
      const created = await tx.sessionShuttle.create({
        data: { sessionId: sessionCode, number: await this.nextShuttleNumber(tx, sessionCode) },
      });
      return created.id;
    }
    const shuttle = await tx.sessionShuttle.findUnique({ where: { id: choice.shuttleId } });
    // Foreign and voided identities do not exist as far as this session knows.
    if (!shuttle || shuttle.sessionId !== sessionCode || shuttle.voidedAt !== null) {
      throw this.notFound('SHUTTLE_NOT_FOUND');
    }
    if (!shuttle.usable || (await this.shuttleHeldElsewhere(tx, sessionCode, shuttle.id, pairingId))) {
      throw this.conflict('SHUTTLE_UNAVAILABLE');
    }
    return shuttle.id;
  }

  /**
   * The default for a confirm that cannot ask (the 60-second auto-confirm):
   * the shuttle this court last finished a game with if it is still usable
   * and idle, otherwise a freshly opened one.
   */
  private async autoShuttleChoice(
    tx: Prisma.TransactionClient,
    sessionCode: string,
    pairing: { id: string; courtNumber: number }
  ): Promise<ShuttleChoice> {
    const previous = await tx.pairing.findFirst({
      where: { sessionId: sessionCode, courtNumber: pairing.courtNumber, endedAt: { not: null } },
      orderBy: { matchNumber: 'desc' },
      select: { lastShuttleId: true },
    });
    if (previous?.lastShuttleId) {
      const shuttle = await tx.sessionShuttle.findUnique({ where: { id: previous.lastShuttleId } });
      if (
        shuttle &&
        shuttle.sessionId === sessionCode &&
        shuttle.usable &&
        shuttle.voidedAt === null &&
        !(await this.shuttleHeldElsewhere(tx, sessionCode, shuttle.id, pairing.id))
      ) {
        return { kind: 'existing', shuttleId: shuttle.id };
      }
    }
    return { kind: 'new' };
  }

  /**
   * Whether a pending pairing can be confirmed right now — shared by the
   * manual confirm endpoint (which throws the matching conflict) and the
   * auto-confirm sweep (which just leaves a blocked pairing pending). One
   * copy of these two checks is what stops the manual and automatic paths
   * from silently drifting apart.
   */
  private async pairingConfirmBlocker(
    sessionCode: string,
    pairing: { teamA: string; teamB: string }
  ): Promise<
    | { blocked: false; enabledRules: PairRule[] }
    | { blocked: true; code: 'PAIRING_INCOMPLETE'; details: { emptySeats: number } }
    | { blocked: true; code: 'PLAYER_UNAVAILABLE'; details: { playerIds: string[] } }
    | { blocked: true; code: 'PAIR_RULE_VIOLATION'; details: { ruleIds: string[] } }
  > {
    // A custom-mode draft the host hasn't finished seating. Checked before
    // availability below: an incomplete team's `playersOf` would otherwise
    // silently answer "who's here" from a partial roster, and the more basic
    // fault — this isn't even a full match yet — deserves to surface first.
    // Everything downstream of confirm (deriveHistory, loadRatings, stats,
    // export's finishedMatches) relies on a confirmed row never having an
    // empty seat; this is the one place that guarantee is enforced.
    const empty = emptySeatCount(pairing);
    if (empty > 0) {
      return { blocked: true, code: 'PAIRING_INCOMPLETE', details: { emptySeats: empty } };
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
      return {
        blocked: true,
        code: 'PLAYER_UNAVAILABLE',
        details: { playerIds: unavailable.map((r) => r.playerId) },
      };
    }

    // Rules are read now, not when the match was proposed: a rule added while
    // this sat pending must stop it starting, manual or automatic alike.
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    const enabled = await this.loadEnabledRules(session);
    const active = new Set(
      (
        await this.prisma.sessionRoster.findMany({
          where: { sessionId: sessionCode, active: true },
          select: { playerId: true },
        })
      ).map((r) => r.playerId)
    );
    const { teamA, teamB } = this.teamsOf(pairing);
    const broken = violatedRules(teamA, teamB, applicableRules(enabled, active));
    if (broken.length > 0) {
      return { blocked: true, code: 'PAIR_RULE_VIOLATION', details: { ruleIds: broken } };
    }

    return { blocked: false, enabledRules: enabled };
  }

  private async confirmPairingExclusively(
    sessionCode: string,
    id: string,
    expectedRevision?: number,
    shuttleInput?: { kind: 'new' | 'existing'; shuttleId?: string }
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

    const blocker = await this.pairingConfirmBlocker(sessionCode, pairing);
    if (blocker.blocked) {
      throw this.conflict(blocker.code, blocker.details);
    }

    const carryOutcomes = await this.carryOutcomesJson(session, pairing, blocker.enabledRules);
    const guard = {
      id,
      confirmedAt: null,
      endedAt: null,
      revision: expectedRevision ?? pairing.revision,
    };

    if (!session.shuttleToolsEnabled) {
      // An ordinary session has no shuttle prompt: a payload naming one is a
      // client that thinks the session is advanced, which must not be ignored.
      if (shuttleInput !== undefined) throw this.conflict('SHUTTLE_TRACKING_DISABLED');
      const updated = await this.prisma.pairing.updateMany({
        where: guard,
        data: { confirmedAt: new Date(), carryOutcomes, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      return this.prisma.pairing.findUniqueOrThrow({ where: { id } });
    }

    if (shuttleInput === undefined) throw this.badRequest('SHUTTLE_CHOICE_REQUIRED');
    const choice = parseShuttleChoice(shuttleInput);
    if (!choice) throw this.badRequest('INVALID_SHUTTLE_CHOICE');

    // One transaction: opening the identity, linking the use, and confirming
    // stand or fall together, so a stale confirm leaves no orphan shuttle.
    await this.prisma.$transaction(async (tx) => {
      const shuttleId = await this.startingShuttleId(tx, sessionCode, id, choice);
      const updated = await tx.pairing.updateMany({
        where: guard,
        data: {
          confirmedAt: new Date(),
          carryOutcomes,
          revision: { increment: 1 },
          shuttleLogKnown: true,
          lastShuttleId: shuttleId,
        },
      });
      if (updated.count !== 1) throw this.conflict('PAIRING_STALE');
      await tx.pairingShuttleUse.create({ data: { pairingId: id, shuttleId } });
    });
    return this.prisma.pairing.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Sweep entry point, called on a timer by `AutoConfirmScheduler`
   * (`auto-confirm.ts`) — see the spec's §3. Finds every pairing that has
   * sat pending for at least `AUTO_CONFIRM_DELAY_MS` and confirms each one
   * whose lineup is still eligible, one at a time, under that pairing's
   * session lock so it can never race a manual confirm or edit.
   *
   * `now` is a parameter, not `new Date()` inline, so tests can drive it
   * without waiting on a real clock. Returns the ids it confirmed.
   */
  async autoConfirmDue(now: Date = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - AUTO_CONFIRM_DELAY_MS);
    const due = await this.prisma.pairing.findMany({
      where: { confirmedAt: null, endedAt: null, pendingSince: { not: null, lte: cutoff } },
    });

    const confirmed: string[] = [];
    for (const row of due) {
      try {
        const ok = await this.lock.run(row.sessionId, () =>
          this.autoConfirmOneExclusively(row.id, row.revision, row.pendingSince)
        );
        if (ok) confirmed.push(row.id);
      } catch (error) {
        // One corrupt or unlucky row must never stop the rest of the sweep.
        console.error(`[auto-confirm] failed to confirm pairing ${row.id}`, error);
      }
    }
    return confirmed;
  }

  /**
   * Re-checks everything the outer query took on faith, now that it holds
   * the session lock: the row can have been confirmed, finished, edited, or
   * deleted (a group delete does not take this lock — see
   * `GroupsService.buildDeleteGroupOps`) in the gap between that query and
   * this write. `pendingSinceAtQuery` is compared by value rather than
   * trusted as still current, because an edit can rewrite `pendingSince` to
   * a new `Date` without this call noticing from `revision` alone twice in
   * the same tick.
   */
  private async autoConfirmOneExclusively(
    id: string,
    expectedRevision: number,
    pendingSinceAtQuery: Date | null
  ): Promise<boolean> {
    const pairing = await this.prisma.pairing.findUnique({ where: { id } });
    if (!pairing) return false;
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) return false;
    if (pairing.revision !== expectedRevision) return false;
    if (
      pairing.pendingSince === null ||
      pendingSinceAtQuery === null ||
      pairing.pendingSince.getTime() !== pendingSinceAtQuery.getTime()
    ) {
      return false;
    }

    const blocker = await this.pairingConfirmBlocker(pairing.sessionId, pairing);
    if (blocker.blocked) return false;

    const confirmedAt = new Date(pairing.pendingSince.getTime() + AUTO_CONFIRM_WALK_ON_MS);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: pairing.sessionId } });
    const carryOutcomes = await this.carryOutcomesJson(session, pairing, blocker.enabledRules);
    const guard = { id, confirmedAt: null, endedAt: null, revision: expectedRevision };
    if (!session.shuttleToolsEnabled) {
      const updated = await this.prisma.pairing.updateMany({
        where: guard,
        data: { confirmedAt, carryOutcomes, revision: { increment: 1 } },
      });
      return updated.count === 1;
    }

    // Cannot prompt: take the court's last idle shuttle or open a new one, in
    // the same transaction as the confirmation (and under the session lock,
    // so two courts can never be handed the same shuttle or number).
    return this.prisma.$transaction(async (tx) => {
      const choice = await this.autoShuttleChoice(tx, pairing.sessionId, pairing);
      const shuttleId = await this.startingShuttleId(tx, pairing.sessionId, id, choice);
      const updated = await tx.pairing.updateMany({
        where: guard,
        data: {
          confirmedAt,
          carryOutcomes,
          revision: { increment: 1 },
          shuttleLogKnown: true,
          lastShuttleId: shuttleId,
        },
      });
      if (updated.count !== 1) return false;
      await tx.pairingShuttleUse.create({ data: { pairingId: id, shuttleId } });
      return true;
    });
  }

  /** Advanced-only gate shared by every shuttle write. */
  private async advancedSession(sessionCode: string) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (!session.shuttleToolsEnabled) throw this.conflict('SHUTTLE_TRACKING_DISABLED');
    return session;
  }

  /**
   * Live change of the shuttle in hand on an active game: open a new one or
   * take an existing idle one, optionally retiring the one put down. The use
   * is added at most once however often the host goes back and forth.
   */
  switchShuttle(
    sessionCode: string,
    pairingId: string,
    dto: { choice: { kind: 'new' | 'existing'; shuttleId?: string }; expectedRevision: number; retirePrevious?: boolean }
  ) {
    return this.lock.run(sessionCode, () => this.switchShuttleExclusively(sessionCode, pairingId, dto));
  }

  private async switchShuttleExclusively(
    sessionCode: string,
    pairingId: string,
    dto: { choice: { kind: 'new' | 'existing'; shuttleId?: string }; expectedRevision: number; retirePrevious?: boolean }
  ) {
    const pairing = await this.pairingInSession(sessionCode, pairingId);
    const session = await this.advancedSession(sessionCode);
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    if (pairing.confirmedAt === null) throw this.conflict('PAIRING_CONFIRMATION_REQUIRED');
    if (pairing.endedAt !== null) throw this.conflict('PAIRING_ENDED');
    const choice = parseShuttleChoice(dto.choice);
    if (!choice) throw this.badRequest('INVALID_SHUTTLE_CHOICE');

    return this.prisma.$transaction(async (tx) => {
      const shuttleId = await this.startingShuttleId(tx, sessionCode, pairingId, choice);
      const updated = await tx.pairing.updateMany({
        where: { id: pairingId, confirmedAt: { not: null }, endedAt: null, revision: dto.expectedRevision },
        data: { lastShuttleId: shuttleId, shuttleLogKnown: true, revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw this.conflict('PAIRING_STALE');
      await tx.pairingShuttleUse.upsert({
        where: { pairingId_shuttleId: { pairingId, shuttleId } },
        create: { pairingId, shuttleId },
        update: {},
      });
      if (dto.retirePrevious && pairing.lastShuttleId && pairing.lastShuttleId !== shuttleId) {
        await tx.sessionShuttle.update({ where: { id: pairing.lastShuttleId }, data: { usable: false } });
      }
      return tx.pairing.findUniqueOrThrow({ where: { id: pairingId } });
    });
  }

  /**
   * Replaces a finished game's shuttle set (including after the session
   * ended). A retired shuttle may be named — it really was played — but a
   * duplicate, foreign or voided id may not. Never touches the winner, score,
   * timestamps, the physical nightly count, or another game's uses.
   */
  correctShuttleUse(
    sessionCode: string,
    pairingId: string,
    dto: { shuttleIds: string[]; openNew: boolean; expectedRevision: number }
  ) {
    return this.lock.run(sessionCode, () => this.correctShuttleUseExclusively(sessionCode, pairingId, dto));
  }

  private async correctShuttleUseExclusively(
    sessionCode: string,
    pairingId: string,
    dto: { shuttleIds: string[]; openNew: boolean; expectedRevision: number }
  ) {
    const pairing = await this.pairingInSession(sessionCode, pairingId);
    await this.advancedSession(sessionCode);
    if (pairing.confirmedAt === null || pairing.endedAt === null) throw this.conflict('PAIRING_NOT_FINISHED');
    if (new Set(dto.shuttleIds).size !== dto.shuttleIds.length) throw this.badRequest('DUPLICATE_SHUTTLE_ID');

    return this.prisma.$transaction(async (tx) => {
      const found = await tx.sessionShuttle.findMany({ where: { id: { in: dto.shuttleIds }, sessionId: sessionCode, voidedAt: null } });
      if (found.length !== dto.shuttleIds.length) throw this.notFound('SHUTTLE_NOT_FOUND');

      const ids = [...dto.shuttleIds];
      if (dto.openNew) {
        const created = await tx.sessionShuttle.create({
          data: { sessionId: sessionCode, number: await this.nextShuttleNumber(tx, sessionCode) },
        });
        ids.push(created.id);
      }
      // The last shuttle is the court's next-game suggestion: dropping it from
      // the log drops the suggestion too.
      const lastShuttleId = pairing.lastShuttleId && ids.includes(pairing.lastShuttleId) ? pairing.lastShuttleId : null;
      const updated = await tx.pairing.updateMany({
        where: { id: pairingId, confirmedAt: { not: null }, endedAt: { not: null }, revision: dto.expectedRevision },
        data: { shuttleLogKnown: true, lastShuttleId, revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw this.conflict('PAIRING_STALE');
      await tx.pairingShuttleUse.deleteMany({ where: { pairingId } });
      if (ids.length > 0) {
        await tx.pairingShuttleUse.createMany({ data: ids.map((shuttleId) => ({ pairingId, shuttleId })) });
      }
      return tx.pairing.findUniqueOrThrow({ where: { id: pairingId } });
    });
  }

  /** Retire (usable=false) or restore a shuttle. A shuttle in a live hand cannot be retired standalone. */
  setShuttleUsable(sessionCode: string, shuttleId: string, usable: boolean) {
    return this.lock.run(sessionCode, async () => {
      await this.advancedSession(sessionCode);
      const shuttle = await this.prisma.sessionShuttle.findUnique({ where: { id: shuttleId } });
      if (!shuttle || shuttle.sessionId !== sessionCode || shuttle.voidedAt !== null) throw this.notFound('SHUTTLE_NOT_FOUND');
      if (!usable && (await this.shuttleHeldElsewhere(this.prisma, sessionCode, shuttleId, ''))) {
        throw this.conflict('SHUTTLE_IN_USE');
      }
      const updated = await this.prisma.sessionShuttle.update({ where: { id: shuttleId }, data: { usable } });
      return { id: updated.id, number: updated.number, usable: updated.usable };
    });
  }

  /**
   * Logically removes a wrongly opened shuttle. Only an identity no game
   * references (as a use or as its last) can go; its number stays reserved.
   */
  voidShuttle(sessionCode: string, shuttleId: string) {
    return this.lock.run(sessionCode, async () => {
      await this.advancedSession(sessionCode);
      const shuttle = await this.prisma.sessionShuttle.findUnique({ where: { id: shuttleId } });
      if (!shuttle || shuttle.sessionId !== sessionCode || shuttle.voidedAt !== null) throw this.notFound('SHUTTLE_NOT_FOUND');
      const referenced =
        (await this.prisma.pairingShuttleUse.count({ where: { shuttleId } })) > 0 ||
        (await this.prisma.pairing.count({ where: { lastShuttleId: shuttleId } })) > 0;
      if (referenced) throw this.conflict('SHUTTLE_IN_USE');
      const updated = await this.prisma.sessionShuttle.update({ where: { id: shuttleId }, data: { voidedAt: new Date() } });
      return { id: updated.id, number: updated.number, voided: true };
    });
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
    // This also makes an empty-seat check unnecessary here: confirm refuses
    // while any seat is null (PAIRING_INCOMPLETE), so `confirmedAt !== null`
    // already guarantees every seat on this row is filled.
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

    // Tolerant: a custom-mode draft may still have an unfilled seat, and the
    // named-seat lookup below still has to work when it does.
    const { teamA, teamB } = this.seatsOf(pairing);
    const onThisCourt = new Set([...teamA, ...teamB].filter((s): s is string => s !== null));
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

    // Auto-pick asks the engine to choose the replacement, which assumes
    // every other seat on this court is already filled. A court with a
    // genuinely empty seat belongs to the seats/autopair flow (custom mode),
    // not this one — naming who fills *this* seat says nothing about who
    // should fill that one.
    if (teamA.includes(null) || teamB.includes(null)) {
      throw this.conflict('PAIRING_INCOMPLETE');
    }
    const filledTeamA = teamA as string[];
    const filledTeamB = teamB as string[];

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
    const courtMode = effectiveCourtMode(session, pairing.courtNumber);
    const history = await this.loadHistory(session.groupId, pairing.sessionId);
    const ratings = courtMode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const levels = await loadPlayerLevels(this.prisma, session.groupId);

    const swapIn = (candidate: string): [string[], string[]] => {
      const replace = (team: string[]): string[] =>
        team.map((id) => (id === dto.playerId ? candidate : id));
      return [replace(filledTeamA), replace(filledTeamB)];
    };

    // Only a substitute who leaves the court legal is a candidate at all.
    const rules = await this.loadApplicableRules(session, new Set(rosterPlayerIds));
    const legalPool = pool.filter((candidate) => violatedRules(...swapIn(candidate), rules).length === 0);
    if (legalPool.length === 0) {
      return this.rulesBlocked([...new Set(pool.flatMap((c) => violatedRules(...swapIn(c), rules)))]);
    }

    // The playing-pool choice follows normal rotation first: fewest games,
    // then longest wait — the order `selectSittingOut` and the waiting list
    // use. Pairing quality only breaks ties between people level on both.
    const [{ substitute }] = legalPool
      .map((candidate) => {
        const [candidateA, candidateB] = swapIn(candidate);
        return {
          substitute: candidate,
          games: history.gamesPlayedThisSession.get(candidate) ?? 0,
          waitingSince: history.waitingSince?.get(candidate) ?? 0,
          assignment: { teamA: candidateA, teamB: candidateB },
        };
      })
      .sort(
        (one, other) =>
          (courtMode === 'level'
            ? (one.waitingSince ?? 0) - (other.waitingSince ?? 0)
            : one.games - other.games || one.waitingSince - other.waitingSince) ||
          compareArrangements(
            [one.assignment],
            [other.assignment],
            history.partnerCounts,
            history.opponentCounts,
            ratings,
            { partner: 0, opponent: 0 },
            history.recentGroupKeys ?? null,
            courtMode === 'level' ? levels : undefined
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
        pendingSince: new Date(),
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

    const replaceIn = (raw: string, out: string, into: string): Seat[] => {
      const team = this.oneSeatOf(raw);
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
    const tradeIn = (raw: string, x: string, y: string): Seat[] => {
      const team = this.oneSeatOf(raw);
      const at = (id: Seat) => (id === x ? y : id === y ? x : id);
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
    const farTeamA = other ? replaceIn(other.teamA, incomingId, dto.playerId) : undefined;
    const farTeamB = other ? replaceIn(other.teamB, incomingId, dto.playerId) : undefined;

    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: pairing.sessionId } });
    const rules = await this.loadApplicableRules(session, new Set(rosterPlayerIds));
    this.assertCourtLegal(newTeamA, newTeamB, rules);
    if (farTeamA && farTeamB) this.assertCourtLegal(farTeamA, farTeamB, rules);

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
          pendingSince: new Date(),
          revision: { increment: 1 },
        },
      });
      if (near.count !== 1) throw this.conflict('PAIRING_STALE');

      if (other) {
        const far = await tx.pairing.updateMany({
          where: { id: other.id, confirmedAt: null, endedAt: null, revision: other.revision },
          data: {
            teamA: JSON.stringify(farTeamA),
            teamB: JSON.stringify(farTeamB),
            pendingSince: new Date(),
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

  async setSeat(sessionCode: string, pairingId: string, dto: SetSeatDto) {
    const target = await this.pairingInSession(sessionCode, pairingId);
    return this.lock.run(target.sessionId, () => this.setSeatExclusively(sessionCode, pairingId, dto));
  }

  /**
   * Custom mode's seat-by-seat editor. Deliberately not gated on
   * `session.mode === 'custom'`: switching mode never rewrites a pending
   * pairing (see `setModeExclusively`), so a half-filled draft can outlive a
   * switch back to variety or balanced, and this — along with `autoPair` — is
   * how the host keeps editing it rather than being stuck with a court
   * nothing can act on.
   *
   * Eligibility deliberately ignores queue position (games played, wait
   * time): the host is placing someone by hand, on purpose, which is exactly
   * what a custom mode is for. It still refuses a resting player and a
   * player already seated elsewhere — those are correctness constraints, not
   * fairness ones.
   */
  private async setSeatExclusively(sessionCode: string, pairingId: string, dto: SetSeatDto) {
    const pairing = await this.pairingInSession(sessionCode, pairingId);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) {
      throw this.conflict('PAIRING_NOT_PENDING');
    }

    const seats = this.seatsOf(pairing);
    const team = dto.team === 'A' ? seats.teamA : seats.teamB;
    if (dto.index >= team.length) {
      throw this.badRequest('SEAT_OUT_OF_RANGE');
    }

    const incomingId = dto.playerId ?? null;

    if (incomingId === null) {
      // Vacating an already-empty seat is a no-op, not an error — the 30s
      // poll or a double-tap can replay this request harmlessly.
      if (team[dto.index] === null) {
        return { ok: true as const, pairing: this.seatViewOf(pairing, seats) };
      }
    } else {
      const roster = await this.prisma.sessionRoster.findFirst({
        where: { sessionId: sessionCode, playerId: incomingId },
      });
      if (!roster) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
      if (!roster.active) {
        throw this.conflict('PLAYER_UNAVAILABLE', { playerIds: [incomingId] });
      }
      if (team[dto.index] !== null) {
        throw this.conflict('SEAT_OCCUPIED');
      }
      const nonEnded = await this.prisma.pairing.findMany({
        where: { sessionId: sessionCode, endedAt: null, id: { not: pairingId } },
      });
      const elsewhere = nonEnded.find((p) => this.playersOf(p).includes(incomingId));
      if (elsewhere) {
        throw this.conflict('PLAYER_ALREADY_ON_COURT', { courtNumber: elsewhere.courtNumber });
      }
    }

    const nextTeam = [...team];
    nextTeam[dto.index] = incomingId;
    if (incomingId !== null) {
      const full = dto.team === 'A' ? { teamA: nextTeam, teamB: seats.teamB } : { teamA: seats.teamA, teamB: nextTeam };
      this.assertCourtLegal(full.teamA, full.teamB, await this.loadApplicableRules(session));
    }
    const column = dto.team === 'A' ? { teamA: JSON.stringify(nextTeam) } : { teamB: JSON.stringify(nextTeam) };

    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: dto.expectedRevision ?? pairing.revision,
      },
      data: { ...column, pendingSince: new Date(), revision: { increment: 1 } },
    });
    if (write.count !== 1) throw this.conflict('PAIRING_STALE');

    const updated = await this.prisma.pairing.findUniqueOrThrow({ where: { id: pairingId } });
    return { ok: true as const, pairing: this.seatViewOf(updated, this.seatsOf(updated)) };
  }

  private seatViewOf(
    pairing: { id: string; courtNumber: number; matchNumber: number; revision: number },
    seats: { teamA: Seat[]; teamB: Seat[] }
  ) {
    return {
      id: pairing.id,
      courtNumber: pairing.courtNumber,
      matchNumber: pairing.matchNumber,
      revision: pairing.revision,
      teamA: seats.teamA,
      teamB: seats.teamB,
    };
  }

  async autoPair(sessionCode: string, pairingId: string, expectedRevision?: number) {
    const target = await this.pairingInSession(sessionCode, pairingId);
    return this.lock.run(target.sessionId, () =>
      this.autoPairExclusively(sessionCode, pairingId, expectedRevision)
    );
  }

  /**
   * Fills only this court's empty seats, touching no other court and moving
   * no already-seated player — see `completeCourt` in the engine for how.
   * Like `setSeat`, not gated on custom mode for the same reason (a
   * half-filled draft can outlive a mode switch).
   *
   * Deliberately calls `completeCourt` with no ratings, in every session
   * mode: see the note by `ratingsForMode` — a hidden balance term would
   * pull against the seats the host just placed by hand.
   */
  private async autoPairExclusively(sessionCode: string, pairingId: string, expectedRevision?: number) {
    const pairing = await this.pairingInSession(sessionCode, pairingId);
    const session = await this.prisma.session.findUniqueOrThrow({ where: { code: sessionCode } });
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    if (pairing.confirmedAt !== null || pairing.endedAt !== null) {
      throw this.conflict('PAIRING_NOT_PENDING');
    }

    const seats = this.seatsOf(pairing);
    if (emptySeatCount(pairing) === 0) {
      return { ok: true as const, filled: 0, pairing: this.seatViewOf(pairing, seats) };
    }

    const roster = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, active: true },
    });
    const nonEnded = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, endedAt: null, id: { not: pairingId } },
    });
    const reserved = new Set(nonEnded.flatMap((p) => this.playersOf(p)));
    const seatedHere = new Set(this.playersOf(pairing));
    const pool = roster
      .map((r) => r.playerId)
      .filter((id) => !reserved.has(id) && !seatedHere.has(id));

    const applicable = await this.loadApplicableRules(session, new Set(roster.map((r) => r.playerId)));
    const { stranded } = rulesForParticipants(applicable, new Set([...seatedHere, ...pool]));
    const seatedStranded = [...seatedHere].filter((id) => stranded.has(id));
    if (seatedStranded.length > 0) {
      return this.rulesBlocked([...new Set(seatedStranded.map((id) => stranded.get(id)!))]);
    }
    const usablePool = pool.filter((id) => !stranded.has(id));
    const { rules } = rulesForParticipants(applicable, new Set([...seatedHere, ...usablePool]));

    const history = await this.loadHistory(session.groupId, sessionCode);
    let result: ReturnType<typeof completeCourt>;
    try {
      result = this.runCompleteCourt(seats, usablePool, history, undefined, rules);
    } catch (error) {
      if (error instanceof NoLegalRuleMatchError) return this.rulesBlocked(error.ruleIds);
      throw error;
    }
    if (result === null) {
      const empty = emptySeatCount(pairing);
      if (usablePool.length < empty && pool.length >= empty) {
        return this.rulesBlocked([...new Set(stranded.values())]);
      }
      return { ok: false as const, reason: 'not-enough-players' as const, available: pool.length };
    }

    const write = await this.prisma.pairing.updateMany({
      where: {
        id: pairingId,
        confirmedAt: null,
        endedAt: null,
        revision: expectedRevision ?? pairing.revision,
      },
      data: {
        teamA: JSON.stringify(result.teamA),
        teamB: JSON.stringify(result.teamB),
        pendingSince: new Date(),
        revision: { increment: 1 },
      },
    });
    if (write.count !== 1) throw this.conflict('PAIRING_STALE');

    const updated = await this.prisma.pairing.findUniqueOrThrow({ where: { id: pairingId } });
    return {
      ok: true as const,
      filled: emptySeatCount(pairing),
      pairing: this.seatViewOf(updated, this.seatsOf(updated)),
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
    const [played, anchors] = await Promise.all([
      this.prisma.pairing.findMany({
        where: {
          session: { groupId: groupCode },
          confirmedAt: { not: null },
          endedAt: { not: null },
          winner: { not: null },
        },
        orderBy: { confirmedAt: 'asc' },
        select: { teamA: true, teamB: true, winner: true, confirmedAt: true },
      }),
      loadRatingAnchors(this.prisma, groupCode),
    ]);

    const tracks = computeRatingTracks(
      played.map((p) => ({
        ...this.teamsOf(p),
        winner: p.winner as 'A' | 'B',
        // Non-null: the `confirmedAt: { not: null }` filter above guarantees
        // it. Needed whenever `anchors` includes a timed reset (a level set
        // mid-session) — see engines/elo.ts's RatingAnchor.
        at: p.confirmedAt!.getTime(),
      })),
      anchors
    );

    // For pairing, unlike a stats display, there is no "never played" state
    // to preserve — the engine needs a number for every player on the court,
    // tonight, including one who has never played a match yet. `anchors`
    // fills that in with each player's seed; a real computed rating (from
    // actually having played) always wins where one exists.
    const seeds = new Map([...anchors].map(([id, anchor]) => [id, anchor.rating]));
    return {
      singles: new Map([...seeds, ...tracks.singles]),
      doubles: new Map([...seeds, ...tracks.doubles]),
    };
  }

  /**
   * Ratings are the *balanced* objective and nothing else's. Variety compares
   * partner-then-opponent lexicographically, and custom deliberately does the
   * same (see `completeCourt` in the engine): the host is placing people by
   * hand, and a hidden rating term would pull against the seats they just
   * set. One place, so a fourth mode can't add a fourth copy of this check.
   */
  private ratingsForMode(session: { mode: string; groupId: string }) {
    return session.mode === 'balanced' ? this.loadRatings(session.groupId) : undefined;
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

    // Growing brings courts back into view under their default numbers,
    // which must not duplicate a name another court already carries.
    if (dto.courtCount > (session.courtCount ?? 0)) {
      const labels = parseCourtLabels(session.courtLabels);
      const pairings = await this.prisma.pairing.findMany({
        where: { sessionId: code },
        select: { courtNumber: true },
      });
      if (hasDuplicateCourtLabels(labels, editableCourtCount(dto.courtCount, pairings, labels))) {
        throw this.conflict('COURT_LABEL_CONFLICT');
      }
    }

    const updated = await this.prisma.session.update({
      where: { code },
      data: { courtCount: dto.courtCount },
    });
    return { code: updated.code, courtCount: updated.courtCount };
  }

  /** Host-only: the group's rules and which of them this session has switched off. */
  async getSessionRules(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    const disabled = this.parseDisabledOrThrow(session.disabledRuleIds);
    const rules = await this.prisma.playerRule.findMany({
      where: { groupId: session.groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ids = new Set(rules.map((r) => r.id));
    return {
      rules: rules.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        playerAId: r.playerAId,
        playerBId: r.playerBId,
        kind: r.kind,
        createdAt: r.createdAt,
      })),
      disabledRuleIds: disabled.filter((id) => ids.has(id)),
    };
  }

  /** Read-modify-write under the session lock, so two switches never lose each other. */
  toggleSessionRule(code: string, ruleId: string, enabled: boolean) {
    return this.lock.run(code, async () => {
      const session = await this.prisma.session.findUnique({ where: { code } });
      if (!session) throw this.notFound('SESSION_NOT_FOUND');
      const rule = await this.prisma.playerRule.findFirst({ where: { id: ruleId, groupId: session.groupId } });
      if (!rule) throw this.notFound('RULE_NOT_FOUND');
      const disabled = this.parseDisabledOrThrow(session.disabledRuleIds).filter((id) => id !== ruleId);
      if (!enabled) disabled.push(ruleId);
      await this.prisma.session.update({ where: { code }, data: { disabledRuleIds: JSON.stringify(disabled) } });
      return { ruleId, enabled, disabledRuleIds: disabled };
    });
  }

  private parseDisabledOrThrow(raw: string | null): string[] {
    try {
      return parseDisabledRuleIds(raw);
    } catch (error) {
      if (error instanceof InvalidDisabledRuleIdsError) {
        throw new InternalServerErrorException({ code: 'INVALID_SESSION_STATE', detail: error.message });
      }
      throw error;
    }
  }

  setCourtLabel(code: string, courtNumber: number, dto: SetCourtLabelDto) {
    return this.lock.run(code, () => this.setCourtLabelExclusively(code, courtNumber, dto));
  }

  /**
   * Presentation only — never touches a pairing — so, like shuttle details,
   * allowed on an ended session and in any court state. The target may be a
   * retired court (above courtCount) that still has a match or a label, so
   * its name in past results stays correctable. Visible names, numeric
   * defaults included, must stay unique across that whole editable range.
   */
  private async setCourtLabelExclusively(code: string, courtNumber: number, dto: SetCourtLabelDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const labels = parseCourtLabels(session.courtLabels);
    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: code },
      select: { courtNumber: true },
    });
    const range = editableCourtCount(session.courtCount, pairings, labels);
    if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > range) {
      throw this.badRequest('INVALID_COURT_NUMBER');
    }

    const label = normalizeCourtLabel(dto.label);
    const courtLabels = withLabelAt(session.courtLabels, courtNumber, label);
    if (hasDuplicateCourtLabels(parseCourtLabels(courtLabels), range)) {
      throw this.conflict('COURT_LABEL_CONFLICT');
    }

    await this.prisma.session.update({ where: { code }, data: { courtLabels } });
    return { code, courtNumber, label };
  }

  /**
   * Host-editable session metadata: total shuttlecocks used tonight and the
   * price per shuttle, both counted/corrected after the fact rather than
   * during play. Deliberately allowed on an ended session — unlike every
   * other mutation in this service, this one does NOT check
   * `session.endedAt`. It still touches nothing else (no games, no roster,
   * no reopening), so it cannot be used to work around the ended-session
   * guard elsewhere.
   */
  setShuttleDetails(code: string, dto: SetShuttleDetailsDto) {
    return this.lock.run(code, () => this.setShuttleDetailsExclusively(code, dto));
  }

  private async setShuttleDetailsExclusively(code: string, dto: SetShuttleDetailsDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    // Partial update: a field key absent from the body (dto.<field> ===
    // undefined) is left untouched. An explicit `null` in the body survives
    // whitelist+transform and clears the field back to "not recorded" — see
    // SetShuttleDetailsDto.
    const hasShuttleCount = dto.shuttleCount !== undefined;
    const hasShuttlePriceSatang = dto.shuttlePriceSatang !== undefined;

    const updated =
      hasShuttleCount || hasShuttlePriceSatang
        ? await this.prisma.session.update({
            where: { code },
            data: {
              ...(hasShuttleCount ? { shuttleCount: dto.shuttleCount } : {}),
              ...(hasShuttlePriceSatang ? { shuttlePriceSatang: dto.shuttlePriceSatang } : {}),
            },
          })
        : session;

    return {
      code: updated.code,
      shuttleCount: updated.shuttleCount,
      shuttlePriceSatang: updated.shuttlePriceSatang,
    };
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
   * Host-only: every roster and waitlist player's level, for the dashboard
   * badge. Never folded into the @Public session read — a level is host-only
   * (C1, decision Q6). The ±1 band itself is a mode ('level'), not a
   * separate toggle — see session-mode.ts.
   */
  async getLevels(code: string): Promise<Record<string, Level | null>> {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const levels = await loadPlayerLevels(this.prisma, session.groupId);
    const [roster, waitlist] = await Promise.all([
      this.prisma.sessionRoster.findMany({ where: { sessionId: code }, select: { playerId: true } }),
      this.prisma.waitlist.findMany({ where: { sessionId: code }, select: { playerId: true } }),
    ]);

    const result: Record<string, Level | null> = {};
    for (const { playerId } of [...roster, ...waitlist]) {
      result[playerId] = levels.get(playerId) ?? null;
    }
    return result;
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

  setCourtMode(code: string, courtNumber: number, dto: SetCourtModeDto) {
    return this.lock.run(code, () => this.setCourtModeExclusively(code, courtNumber, dto));
  }

  /**
   * Unlike the format toggle, allowed in any court state — a court's mode
   * changes only what the *next* propose/reshuffle does, and (like the
   * session-wide mode switch) never rewrites a pending pairing.
   */
  private async setCourtModeExclusively(code: string, courtNumber: number, dto: SetCourtModeDto) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    this.assertCourtNumber(session.courtCount, courtNumber);

    let courtModes: string;
    try {
      courtModes = withModeAt(session.courtModes, courtNumber, dto.mode);
    } catch (error) {
      if (error instanceof InvalidCourtNumberError) throw this.badRequest('INVALID_COURT_NUMBER');
      throw error;
    }
    const updated = await this.prisma.session.update({
      where: { code },
      data: { courtModes },
    });
    return {
      code: updated.code,
      courtNumber,
      mode: modeAt(updated.courtModes, courtNumber),
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

      // The game's log is kept, but it only takes its last shuttle back in
      // hand when that shuttle is still usable and idle: restoring must never
      // pull a shuttle off another court or block a score correction.
      let lastShuttleId = latest.lastShuttleId;
      if (lastShuttleId) {
        const shuttle = await this.prisma.sessionShuttle.findUnique({ where: { id: lastShuttleId } });
        const held = await this.shuttleHeldElsewhere(this.prisma, sessionCode, lastShuttleId, latest.id);
        if (!shuttle || !shuttle.usable || shuttle.voidedAt !== null || held) lastShuttleId = null;
      }
      const restored = await this.prisma.pairing.updateMany({
        where: { id: latest.id, confirmedAt: { not: null }, endedAt: { not: null }, revision: latest.revision },
        data: {
          endedAt: null,
          scoreA: null,
          scoreB: null,
          winner: null,
          lastShuttleId,
          revision: { increment: 1 },
        },
      });
      if (restored.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      return { ok: true as const, undone: 'finish' as const };
    }

    // The carry snapshot and the shuttle log belong to the confirmation being
    // undone; the next confirm takes a fresh one. The shuttle itself stays in
    // the session's inventory — it was physically opened — and can be chosen
    // again, so numbers are never reused.
    await this.prisma.$transaction(async (tx) => {
      const unconfirmed = await tx.pairing.updateMany({
        where: { id: latest.id, confirmedAt: { not: null }, endedAt: null, revision: latest.revision },
        data: {
          confirmedAt: null,
          pendingSince: null,
          carryOutcomes: '[]',
          shuttleLogKnown: false,
          lastShuttleId: null,
          revision: { increment: 1 },
        },
      });
      if (unconfirmed.count !== 1) {
        throw this.conflict('PAIRING_STALE');
      }
      await tx.pairingShuttleUse.deleteMany({ where: { pairingId: latest.id } });
    });
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

    // Custom mode: courts still set to 'custom' get an empty draft, exactly
    // like a single custom `propose`; courts set to another mode are
    // grouped by that mode and run through the engine below, alongside a
    // non-custom session's own courts.
    if (isCustomMode(session.mode)) {
      if (idleCourts.length === 0) {
        return { ok: false as const, reason: 'not-enough-players' as const, filled: [] as number[] };
      }

      const customCourts = idleCourts.filter((n) => effectiveCourtMode(session, n) === 'custom');
      const engineCourts = idleCourts.filter((n) => effectiveCourtMode(session, n) !== 'custom');
      // Group the non-custom idle courts by their own mode, processed in
      // order of each group's lowest court number, so filling is
      // deterministic and every court still only ever runs its own mode's
      // objective in one generateRound call.
      const modeGroups = new Map<SessionMode, number[]>();
      for (const n of engineCourts) {
        const mode = effectiveCourtMode(session, n);
        const group = modeGroups.get(mode) ?? [];
        group.push(n);
        modeGroups.set(mode, group);
      }
      const orderedGroups = [...modeGroups.entries()].sort(
        (a, b) => Math.min(...a[1]) - Math.min(...b[1])
      );

      const filled: number[] = [];

      await this.prisma.$transaction(async (tx) => {
        for (const courtNumber of customCourts) {
          const size = courtSizeFor(formatAt(session.courtFormats, courtNumber));
          const emptyTeam = JSON.stringify(Array(size / 2).fill(null));
          const matchNumber =
            (await tx.pairing.count({
              where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
            })) + 1;
          await tx.pairing.create({
            data: {
              sessionId: sessionCode,
              courtNumber,
              matchNumber,
              teamA: emptyTeam,
              teamB: emptyTeam,
              pendingSince: new Date(),
            },
          });
          filled.push(courtNumber);
        }
      });

      let remainingRoster = roster.map((r) => r.playerId).filter((id) => !reserved.has(id));
      const activeIds = new Set(roster.map((r) => r.playerId));
      const blocked: FillBlocked[] = [];
      const inconclusive: number[] = [];

      for (const [mode, courtsInGroup] of orderedGroups) {
        const group = await this.fillEngineGroup(session, mode, courtsInGroup, remainingRoster, activeIds);
        filled.push(...group.filled);
        blocked.push(...group.blocked);
        inconclusive.push(...group.inconclusive);
        remainingRoster = remainingRoster.filter((id) => !group.seated.has(id));
      }

      if (filled.length === 0 && (blocked.length > 0 || inconclusive.length > 0)) {
        return this.fillOutcome(filled, blocked, inconclusive);
      }
      return { ok: true as const, filled, blocked, inconclusive };
    }

    const available = roster.map((r) => r.playerId).filter((id) => !reserved.has(id));

    // This call has no single court to favour, unlike `proposeExclusively`,
    // so it seats as many players as it can rather than merely filling as
    // many courts as it can — see `chooseSeatingOrder` for why a
    // smallest-first prefix of idle courts is provably wrong here.
    if (this.chooseSeatingOrder(idleCourts, session, available.length).length === 0) {
      return this.fillOutcome([], [], []);
    }

    const group = await this.fillEngineGroup(
      session,
      session.mode as SessionMode,
      idleCourts,
      available,
      new Set(roster.map((r) => r.playerId))
    );
    return this.fillOutcome(group.filled, group.blocked, group.inconclusive);
  }

  /**
   * `ok` only when something was filled. Nothing filled is reported by its
   * actual cause — a rule, an inconclusive search, or a head count — and a
   * partial fill always lists what it could not do rather than claiming
   * every court succeeded.
   */
  private fillOutcome(filled: number[], blocked: FillBlocked[], inconclusive: number[]) {
    if (filled.length > 0) return { ok: true as const, filled, blocked, inconclusive };
    const reason =
      blocked.length > 0
        ? ('pair-rules-blocked' as const)
        : inconclusive.length > 0
          ? ('pair-rule-search-limit' as const)
          : ('not-enough-players' as const);
    return { ok: false as const, reason, filled, blocked, inconclusive };
  }

  /**
   * One `generateRound` call over the courts sharing one mode, written in a
   * single transaction. Rules use the 'partial' policy: the most seats that
   * can be filled legally are, and every chosen court left out is reported
   * as blocked (proven) or inconclusive (search limit) — never silently
   * dropped. Court numbers come from the engine's court index, never
   * renumbered.
   */
  private async fillEngineGroup(
    session: Session,
    mode: SessionMode,
    courtNumbers: number[],
    candidates: string[],
    activeIds: ReadonlySet<string>
  ): Promise<{ filled: number[]; blocked: FillBlocked[]; inconclusive: number[]; seated: Set<string> }> {
    const ruled = await this.engineRulesFor(session, activeIds, candidates);
    const seatsIn = (ns: number[]) =>
      ns.reduce((sum, n) => sum + courtSizeFor(formatAt(session.courtFormats, n)), 0);
    const couldSeat = this.chooseSeatingOrder(courtNumbers, session, candidates.length);
    const chosen = this.chooseSeatingOrder(courtNumbers, session, ruled.pool.length);
    const blocked: FillBlocked[] = [];
    // A must-pair partner busy elsewhere shrank the pool below what these
    // courts could otherwise seat.
    if (seatsIn(chosen) < seatsIn(couldSeat)) {
      for (const n of couldSeat) {
        if (!chosen.includes(n)) blocked.push({ courtNumber: n, ruleIds: ruled.strandedRuleIds });
      }
    }
    if (chosen.length === 0) return { filled: [], blocked, inconclusive: [], seated: new Set() };

    const sizes: CourtSize[] = chosen.map((n) => courtSizeFor(formatAt(session.courtFormats, n)));
    const level = isLevelMode(mode);
    const history = await this.loadHistory(session.groupId, session.code);
    const ratings = mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const levels = await loadPlayerLevels(this.prisma, session.groupId);
    const carry = level ? await this.loadCarryEligibility(session) : undefined;

    let result: ReturnType<typeof generateRound>;
    try {
      result = this.runGenerateRound(
        ruled.pool,
        sizes,
        history,
        undefined,
        undefined,
        ratings,
        levels,
        level,
        level ? 'wait' : 'games',
        carry?.carryEligible,
        carry?.carriedTonight,
        ruled.rules,
        'partial'
      );
    } catch (error) {
      if (error instanceof NoLegalRuleMatchError) {
        blocked.push(...chosen.map((courtNumber) => ({ courtNumber, ruleIds: error.ruleIds })));
        return { filled: [], blocked, inconclusive: [], seated: new Set() };
      }
      if (error instanceof PairRuleSearchLimitError) {
        return { filled: [], blocked, inconclusive: chosen, seated: new Set() };
      }
      throw error;
    }

    const filled = await this.prisma.$transaction(async (tx) => {
      const written: number[] = [];
      for (const assignment of result.courts) {
        const courtNumber = chosen[assignment.court - 1];
        const matchNumber =
          (await tx.pairing.count({
            where: { sessionId: session.code, courtNumber, confirmedAt: { not: null } },
          })) + 1;
        await tx.pairing.create({
          data: {
            sessionId: session.code,
            courtNumber,
            matchNumber,
            teamA: JSON.stringify(assignment.teamA),
            teamB: JSON.stringify(assignment.teamB),
            pendingSince: new Date(),
          },
        });
        written.push(courtNumber);
      }
      return written;
    });

    // Only rules can leave a court chosen for its seat count unfilled.
    const unfilled = chosen.filter((n) => !filled.includes(n));
    if (unfilled.length > 0) {
      const touching = rulesTouching(result.sittingOut, ruled.rules);
      const ruleIds = touching.length > 0 ? touching : ruled.rules.map((r) => r.id);
      blocked.push(...unfilled.map((courtNumber) => ({ courtNumber, ruleIds })));
    }

    return {
      filled,
      blocked,
      inconclusive: [],
      seated: new Set(result.courts.flatMap((c) => [...c.teamA, ...c.teamB])),
    };
  }

  setRosterActive(sessionCode: string, playerId: string, dto: SetRosterActiveDto) {
    return this.lock.run(sessionCode, () =>
      this.setRosterActiveExclusively(sessionCode, playerId, dto)
    );
  }

  /**
   * Rotation-fairness credit for a player who is (re)joining the active pool
   * mid-session: brings them level with whoever is furthest ahead so they
   * queue alongside everyone else instead of winning every draw until they
   * catch up. `Math.max` with `currentOffset` so this can only ever add
   * credit, never take it away — toggling someone off and back on, or a
   * walk-in joining, must never lower a player into a free turn.
   *
   * Shared by `setRosterActiveExclusively` (a returning player) and
   * `addWalkInExclusively` (someone joining for the first time tonight) — see
   * B14 in docs/archive/plans/2026-09-05-review-and-v2-backlog.md for why
   * both paths must use identical arithmetic.
   */
  private rotationCredit(
    gamesPlayedThisSession: Map<string, number>,
    activeOtherIds: string[],
    ownId: string,
    currentOffset: number
  ): number {
    const highest = activeOtherIds.reduce(
      (max, id) => Math.max(max, gamesPlayedThisSession.get(id) ?? 0),
      0
    );
    const own = gamesPlayedThisSession.get(ownId) ?? 0;
    return Math.max(currentOffset, highest - own + currentOffset);
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
      gamesOffset = this.rotationCredit(
        history.gamesPlayedThisSession,
        others.map((o) => o.playerId),
        playerId,
        entry.gamesOffset
      );
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

    // Resting or returning a player doesn't rewrite the courts they're
    // seated on (see the module doc on `setRosterActiveExclusively`), but it
    // does change whether that court is eligible to auto-confirm — bringing
    // someone back who was resting for 10 minutes must not hand them an
    // auto-confirm backdated to before they returned.
    const openPairings = await this.prisma.pairing.findMany({
      where: { sessionId: sessionCode, confirmedAt: null, endedAt: null },
    });
    const affected = openPairings.filter((p) => this.playersOf(p).includes(playerId));
    if (affected.length > 0) {
      await this.prisma.pairing.updateMany({
        where: { id: { in: affected.map((p) => p.id) } },
        data: { pendingSince: new Date() },
      });
    }

    return { playerId: updated.playerId, active: updated.active };
  }

  /**
   * Marks a roster player as a walk-in (C3 D7) or clears it. Billing only —
   * it touches no rotation state. Allowed after the session ends, because
   * the bill is settled then (same exception as setShuttleDetails).
   */
  setRosterWalkIn(sessionCode: string, playerId: string, dto: SetRosterWalkInDto) {
    return this.lock.run(sessionCode, () => this.setRosterWalkInExclusively(sessionCode, playerId, dto));
  }

  private async setRosterWalkInExclusively(sessionCode: string, playerId: string, dto: SetRosterWalkInDto) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    const entry = await this.prisma.sessionRoster.findUnique({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
    });
    if (!entry) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
    const updated = await this.prisma.sessionRoster.update({ where: { id: entry.id }, data: { walkIn: dto.walkIn } });
    return { playerId: updated.playerId, walkIn: updated.walkIn };
  }

  addWalkIn(sessionCode: string, dto: AddWalkInDto) {
    return this.lock.run(sessionCode, () => this.addWalkInExclusively(sessionCode, dto));
  }

  /**
   * Adds someone who is not on tonight's pasted roster to a session already
   * under way — either an existing group player (`playerId`) or a brand-new
   * one (`name`). Must credit `gamesOffset` exactly like a returning player
   * (`rotationCredit`, shared with `setRosterActiveExclusively`) or the
   * walk-in wins every rotation draw until they catch up — see B14 in
   * docs/archive/plans/2026-09-05-review-and-v2-backlog.md.
   *
   * Deliberately does not touch the Waitlist table (a walk-in who happens to
   * be on tonight's waitlist just gets a second, independent roster row; the
   * waitlist row stays as a record) or any open Pairing (a brand-new roster
   * row cannot already be seated on a court, so there is nothing to rewrite —
   * unlike setRosterActiveExclusively's resting/returning path).
   */
  private async addWalkInExclusively(sessionCode: string, dto: AddWalkInDto) {
    if (Boolean(dto.playerId) === Boolean(dto.name)) {
      throw this.badRequest('ROSTER_ADD_INVALID_INPUT');
    }

    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');

    let playerId: string;
    let newPlayerName: string | null = null;
    if (dto.playerId) {
      const player = await this.prisma.player.findUnique({ where: { id: dto.playerId } });
      if (!player || player.groupId !== session.groupId) {
        throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
      }
      playerId = player.id;
    } else {
      playerId = randomUUID();
      newPlayerName = dto.name!;
    }

    const existing = await this.prisma.sessionRoster.findUnique({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
    });
    if (existing) throw this.conflict('ROSTER_DUPLICATE');

    const history = await this.loadHistory(session.groupId, sessionCode);
    const others = await this.prisma.sessionRoster.findMany({
      where: { sessionId: sessionCode, active: true },
      select: { playerId: true },
    });
    const gamesOffset = this.rotationCredit(
      history.gamesPlayedThisSession,
      others.map((o) => o.playerId),
      playerId,
      0
    );

    // Every read that can throw (the duplicate check, loadHistory, the roster
    // scan above) happens before any write. loadHistory in particular can
    // surface a corrupt confirmed pairing in tonight's session (or, with
    // the session's crossSessionHistory snapshot on, anywhere in the group's history) — so the Player create below must
    // not happen until we know we're past that risk. When it's a brand-new
    // player, the Player row and its SessionRoster row are written together
    // in one transaction (same precedent as `createSession`) so a failure
    // between them can never orphan a Player with no roster entry.
    if (newPlayerName !== null) {
      await this.prisma.$transaction([
        this.prisma.player.create({
          data: {
            id: playerId,
            groupId: session.groupId,
            name: newPlayerName,
            aliases: '[]',
            ...levelWrite(null, dto.level ?? null),
          },
        }),
        this.prisma.sessionRoster.create({
          data: {
            sessionId: sessionCode,
            playerId,
            active: true,
            gamesOffset,
            activatedAt: new Date(),
            walkIn: true,
          },
        }),
      ]);
    } else {
      await this.prisma.sessionRoster.create({
        data: {
          sessionId: sessionCode,
          playerId,
          active: true,
          gamesOffset,
          activatedAt: new Date(),
          walkIn: true,
        },
      });
    }

    return { playerId };
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

  /**
   * Host-only, tonight-scoped player list for the dashboard's toggle panel
   * (C1a): every roster player's level, resting state, this-session played
   * /won/lost, and their rating as a difference from the level's seed
   * (`ratingDelta`) — the host reads "P +50", not a bare 1350 that means
   * nothing without the seed in their head. `ratingDelta` is null with no
   * level (no seed to diff against), 0 the moment a level is freshly set
   * with no games yet on top of it (see engines/elo.ts's RatingAnchor and
   * `loadRatings` below for the reset-on-set rule this reflects).
   */
  async getPlayerPanel(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const finishedMatch = { confirmedAt: { not: null }, endedAt: { not: null } } as const;
    const [roster, players, anchors, ratings, pairings] = await Promise.all([
      this.prisma.sessionRoster.findMany({ where: { sessionId: code } }),
      this.prisma.player.findMany({ where: { rosterEntries: { some: { sessionId: code } } } }),
      loadRatingAnchors(this.prisma, session.groupId),
      this.loadRatings(session.groupId),
      this.prisma.pairing.findMany({ where: { sessionId: code, ...finishedMatch } }),
    ]);

    const nameById = new Map(players.map((p) => [p.id, p.name]));

    const played = new Map<string, number>();
    const won = new Map<string, number>();
    const lost = new Map<string, number>();
    for (const p of pairings) {
      const { teamA, teamB } = this.teamsOf(p);
      for (const id of [...teamA, ...teamB]) played.set(id, (played.get(id) ?? 0) + 1);
      if (p.winner === 'A' || p.winner === 'B') {
        const winners = p.winner === 'A' ? teamA : teamB;
        const losers = p.winner === 'A' ? teamB : teamA;
        for (const id of winners) won.set(id, (won.get(id) ?? 0) + 1);
        for (const id of losers) lost.set(id, (lost.get(id) ?? 0) + 1);
      }
    }

    const levelById = new Map(players.map((p) => [p.id, asLevel(p.level)]));

    return roster.map((r) => {
      const level = levelById.get(r.playerId) ?? null;
      const anchor = anchors.get(r.playerId);
      return {
        playerId: r.playerId,
        name: nameById.get(r.playerId) ?? 'Unknown',
        level,
        resting: !r.active,
        played: played.get(r.playerId) ?? 0,
        won: won.get(r.playerId) ?? 0,
        lost: lost.get(r.playerId) ?? 0,
        ratingDelta:
          level === null || !anchor
            ? null
            : Math.round((ratings.doubles.get(r.playerId) ?? anchor.rating) - anchor.rating),
      };
    });
  }

  /**
   * The public shuttle log and totals for an advanced session's finished games.
   * One row per match (never per player), oldest confirmation first with court
   * and match number as tie-breakers; `shuttles` is null for an unknown log and
   * [] for a known empty one. Carries no revisions — those are owner-only.
   */
  private async shuttleSummaryFor(
    sessionCode: string,
    finished: readonly { id: string; courtNumber: number; matchNumber: number; confirmedAt: Date | null; endedAt: Date | null; shuttleLogKnown: boolean }[]
  ) {
    const [identities, uses] = await Promise.all([
      this.prisma.sessionShuttle.findMany({ where: { sessionId: sessionCode } }),
      this.prisma.pairingShuttleUse.findMany({ where: { pairing: { sessionId: sessionCode } } }),
    ]);
    const numberById = new Map(identities.map((sh) => [sh.id, sh.number]));
    const usesByPairing = new Map<string, string[]>();
    for (const u of uses) {
      const list = usesByPairing.get(u.pairingId) ?? [];
      list.push(u.shuttleId);
      usesByPairing.set(u.pairingId, list);
    }
    const refsOf = (pairingId: string): ShuttleRef[] =>
      (usesByPairing.get(pairingId) ?? [])
        .map((id) => ({ id, number: numberById.get(id) ?? 0 }))
        .sort((a, b) => a.number - b.number);

    const shuttleLog = [...finished]
      .sort(
        (a, b) =>
          (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0) ||
          a.courtNumber - b.courtNumber ||
          a.matchNumber - b.matchNumber
      )
      .map((p) => ({
        pairingId: p.id,
        courtNumber: p.courtNumber,
        matchNumber: p.matchNumber,
        shuttles: p.shuttleLogKnown ? refsOf(p.id) : null,
      }));
    const accounting = deriveShuttleAccounting(
      finished.map((p) => ({
        confirmedAt: p.confirmedAt,
        endedAt: p.endedAt,
        shuttleLogKnown: p.shuttleLogKnown,
        shuttleIds: usesByPairing.get(p.id) ?? [],
      }))
    );
    return {
      shuttleLog,
      shuttleAccounting: {
        recordedFinishedShuttles: accounting.recordedFinishedShuttles,
        unknownFinishedMatches: accounting.unknownFinishedMatches,
        finishedMatches: accounting.finishedMatches,
      },
    };
  }

  /**
   * Owner-only: every identity (voided included, flagged) and each finished
   * game's editable shuttle set with its revision, for the correction editor
   * and the confirm picker. An ordinary session answers a disabled, empty
   * shape so the summary can still verify ownership before showing the
   * physical-count editor.
   */
  async getShuttleInventory(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    if (!session.shuttleToolsEnabled) {
      return { enabled: false as const, identities: [], games: [], heldShuttleIds: [], lastShuttleByCourt: [] };
    }

    const [identities, finished, uses, live] = await Promise.all([
      this.prisma.sessionShuttle.findMany({ where: { sessionId: code }, orderBy: { number: 'asc' } }),
      this.prisma.pairing.findMany({
        where: { sessionId: code, confirmedAt: { not: null }, endedAt: { not: null } },
        orderBy: [{ confirmedAt: 'asc' }, { courtNumber: 'asc' }, { matchNumber: 'asc' }],
      }),
      this.prisma.pairingShuttleUse.findMany({ where: { pairing: { sessionId: code } } }),
      this.prisma.pairing.findMany({
        where: { sessionId: code, confirmedAt: { not: null }, endedAt: null, lastShuttleId: { not: null } },
        select: { lastShuttleId: true },
      }),
    ]);
    // Each court's suggestion: the last shuttle of its most recent finished game.
    const lastByCourt = new Map<number, string>();
    for (const p of [...finished].sort((a, b) => a.matchNumber - b.matchNumber)) {
      if (p.lastShuttleId) lastByCourt.set(p.courtNumber, p.lastShuttleId);
      else lastByCourt.delete(p.courtNumber);
    }
    const numberById = new Map(identities.map((sh) => [sh.id, sh.number]));
    return {
      enabled: true as const,
      identities: identities.map((sh) => ({ id: sh.id, number: sh.number, usable: sh.usable, voided: sh.voidedAt !== null })),
      /** Shuttles in a live hand right now: not idle, so not offered to another court. */
      heldShuttleIds: live.map((p) => p.lastShuttleId!),
      lastShuttleByCourt: [...lastByCourt.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([courtNumber, shuttleId]) => ({ courtNumber, shuttleId })),
      games: finished.map((p) => ({
        pairingId: p.id,
        revision: p.revision,
        shuttleIds: p.shuttleLogKnown
          ? uses
              .filter((u) => u.pairingId === p.id)
              .map((u) => u.shuttleId)
              .sort((a, b) => (numberById.get(a) ?? 0) - (numberById.get(b) ?? 0))
          : null,
      })),
    };
  }

  async getSummary(code: string) {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');

    const finishedMatch = { confirmedAt: { not: null }, endedAt: { not: null } } as const;
    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: code, ...finishedMatch },
      orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
    });

    // Advanced sessions publish a read-only chronological shuttle log. An
    // ordinary session (the snapshot, not the group's current switch) omits it.
    const shuttleSummary = session.shuttleToolsEnabled
      ? await this.shuttleSummaryFor(code, pairings)
      : null;

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
    const totalSeconds = new Map<string, number>();
    const matches = new Map<string, SessionMatch[]>();
    const partnerIds = new Map<string, Set<string>>();
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
      // finishedMatch above guarantees both timestamps are set; clamped
      // against a clock-adjusted row producing a negative duration.
      const durationSeconds = Math.max(
        0,
        Math.round((p.endedAt!.getTime() - p.confirmedAt!.getTime()) / 1000)
      );

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
          totalSeconds.set(id, (totalSeconds.get(id) ?? 0) + durationSeconds);

          const fRow = formatRow(id)[format];
          fRow.played += 1;
          if (teamResult === 'win') fRow.won += 1;
          if (teamResult === 'loss') fRow.lost += 1;

          // Null for a singles team: `find` has no other member to return,
          // so this already generalizes correctly — the old `?? id` fallback
          // is what silently made a singles player their own partner instead.
          const partnerId = team.find((otherId) => otherId !== id) ?? null;
          if (partnerId !== null) {
            if (!partnerIds.has(id)) partnerIds.set(id, new Set());
            partnerIds.get(id)!.add(partnerId);
          }
          const entry: SessionMatch = {
            matchNumber: p.matchNumber,
            courtNumber: p.courtNumber,
            partnerName: partnerId === null ? null : nameById.get(partnerId) ?? 'Unknown',
            opponentNames: opponents.map((opponentId) => nameById.get(opponentId) ?? 'Unknown'),
            scoreA: p.scoreA,
            scoreB: p.scoreB,
            result: teamResult,
            durationSeconds,
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
        shuttleCount: session.shuttleCount,
        shuttlePriceSatang: session.shuttlePriceSatang,
        courtLabels: parseCourtLabels(session.courtLabels),
      },
      ...shuttleSummary,
      players: [...played.entries()]
        .map(([playerId, count]) => {
          const formats = byFormat.get(playerId);
          return {
            playerId,
            name: nameById.get(playerId) ?? 'Unknown',
            played: count,
            won: won.get(playerId) ?? 0,
            lost: lost.get(playerId) ?? 0,
            totalSeconds: totalSeconds.get(playerId) ?? 0,
            distinctPartners: partnerIds.get(playerId)?.size ?? 0,
            singles: formats && formats.singles.played > 0 ? formats.singles : null,
            doubles: formats && formats.doubles.played > 0 ? formats.doubles : null,
            matches: matches.get(playerId) ?? [],
          };
        })
        .sort((a, b) => b.played - a.played),
    };
  }
}
