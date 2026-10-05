import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type { CourtFormat, CourtMode, CourtState, LineupEntry, Seat } from './live-session.model';
import type { Session } from './session.model';
import { levelsErrorMessage } from './group-levels.model';
import type { Level } from '../../../../engines/levels.ts';
import type { PairRule } from './pair-rule.model';
import { checkoutErrorMessage, type CheckoutModel, type CheckoutPreview, type CheckoutReceipt } from './checkout.model';
import type { ShuttleChoice, ShuttleInventory } from './shuttle.model';

/** A court fill-all could not seat because of pair rules. */
export interface BlockedCourt {
  courtNumber: number;
  ruleIds: string[];
}

export interface SessionRules {
  rules: PairRule[];
  disabledRuleIds: string[];
}

interface ProposeResponse {
  ok: boolean;
  reason?: string;
  /** Only on a `not-enough-players` reason: how many are free, and the
   *  court's own format — enough for the panel to say "switch to singles"
   *  rather than just "not enough players" when that would actually help. */
  available?: number;
  format?: CourtFormat;
  ruleIds?: string[];
}

interface SwapResponse {
  ok: boolean;
  reason?: string;
}

/**
 * Every mutating action reports the same shape, so no caller can accidentally
 * drop a failure. `reason` is a domain outcome the server returned as a 200
 * (nobody free to sub in); `error` is a request that failed outright, carrying
 * a message meant for the host — the pairing-lifecycle 409s, mostly.
 */
export interface ActionResult {
  ok: boolean;
  reason?: string;
  error?: string;
  /** The server's stable error code, so a caller can tell "the screen is out of date"
   *  (PAIRING_*) from "that choice was refused". Only the writes that opt into
   *  `refreshOnError` (confirm-with-shuttle, switch, retire) carry it. */
  code?: string;
  /** Carried through from a `not-enough-players` propose response only. */
  available?: number;
  format?: CourtFormat;
  /** The pair rules behind a `pair-rules-blocked` reason or a
   *  PAIR_RULE_VIOLATION error. */
  ruleIds?: string[];
  /** Fill-all only, even on success: courts the rules kept empty, and
   *  courts the rule search gave up on. Present only when non-empty. */
  blocked?: BlockedCourt[];
  inconclusive?: number[];
}

interface MutationResponse {
  ok?: boolean;
  reason?: string;
  available?: number;
  format?: CourtFormat;
  ruleIds?: string[];
  blocked?: BlockedCourt[];
  inconclusive?: number[];
}

/** Keeps "nothing was blocked" out of the result so callers test presence. */
function fillDetails(response: MutationResponse): Pick<ActionResult, 'blocked' | 'inconclusive'> {
  return {
    ...(response.blocked?.length ? { blocked: response.blocked } : {}),
    ...(response.inconclusive?.length ? { inconclusive: response.inconclusive } : {}),
  };
}

/**
 * The server answers a rejected mutation with a stable `code`, never with prose.
 * Anything unmapped falls back to the per-action message so a new server code
 * can never leak an untranslated string into the host's screen.
 */
function messageForCode(code: string): string | null {
  switch (code) {
    case 'SESSION_ENDED':
      return $localize`:@@err.code.sessionEnded:ก๊วนนี้จบไปแล้ว`;
    case 'SESSION_NOT_FOUND':
      return $localize`:@@err.code.sessionNotFound:ไม่พบก๊วนนี้`;
    case 'SESSION_HAS_UNFINISHED_PAIRINGS':
      return $localize`:@@err.code.sessionHasUnfinishedPairings:ยังมีแมตช์ที่ยังไม่จบ กรุณาบันทึกผลให้ครบก่อน`;
    case 'COURT_ACTIVE':
      return $localize`:@@err.code.courtActive:คอร์ทนี้มีแมตช์อยู่แล้ว`;
    case 'PLAYER_UNAVAILABLE':
      return $localize`:@@err.code.playerUnavailable:มีผู้เล่นในแมตช์นี้พักอยู่ กรุณาเปลี่ยนตัวหรือสุ่มใหม่`;
    case 'SWAP_SAME_PLAYER':
      return $localize`:@@err.code.swapSamePlayer:เลือกคนเดิม ไม่ได้เปลี่ยนตัว`;
    case 'COURT_IN_USE':
      return $localize`:@@err.code.courtInUse:ยังมีแมตช์เล่นอยู่บนคอร์ทที่จะตัดออก กรุณาบันทึกผลก่อน`;
    case 'INVALID_COURT_NUMBER':
      return $localize`:@@err.code.invalidCourtNumber:หมายเลขคอร์ทไม่ถูกต้อง`;
    case 'COURT_LABEL_CONFLICT':
      return $localize`:@@err.code.courtLabelConflict:ชื่อคอร์ทนี้ซ้ำกับคอร์ทอื่น`;
    case 'INVALID_SESSION_STATE':
      return $localize`:@@err.code.invalidSessionState:ข้อมูลก๊วนนี้ผิดปกติ จัดคู่ต่อไม่ได้ กรุณาแจ้งผู้ดูแล`;
    case 'PAIRING_STALE':
    case 'ROSTER_STALE':
      return $localize`:@@err.code.stale:ข้อมูลถูกแก้ไขจากอุปกรณ์อื่นแล้ว กรุณาลองใหม่อีกครั้ง`;
    case 'PAIRING_NOT_FOUND':
      return $localize`:@@err.code.pairingNotFound:ไม่พบแมตช์นี้`;
    case 'PAIRING_ENDED':
      return $localize`:@@err.code.pairingEnded:แมตช์นี้จบไปแล้ว`;
    case 'PAIRING_CONFIRMED':
      return $localize`:@@err.code.pairingConfirmed:แมตช์นี้ยืนยันไปแล้ว`;
    case 'PAIRING_CONFIRMATION_REQUIRED':
      return $localize`:@@err.code.pairingConfirmationRequired:ต้องยืนยันแมตช์ก่อนบันทึกผล`;
    case 'PAIRING_NOT_PENDING':
      return $localize`:@@err.code.pairingNotPending:เปลี่ยนตัวได้เฉพาะแมตช์ที่ยังไม่ยืนยัน`;
    case 'PAIRING_PLAYER_NOT_FOUND':
      return $localize`:@@err.code.pairingPlayerNotFound:ไม่พบผู้เล่นคนนี้ในแมตช์`;
    case 'ROSTER_PLAYER_NOT_FOUND':
      return $localize`:@@err.code.rosterPlayerNotFound:ไม่พบผู้เล่นคนนี้ในก๊วน`;
    case 'ROSTER_DUPLICATE':
      return $localize`:@@err.code.rosterDuplicate:ผู้เล่นคนนี้อยู่ในก๊วนแล้ว`;
    case 'INCOMPLETE_SCORES':
      return $localize`:@@err.code.incompleteScores:กรุณากรอกคะแนนให้ครบทั้งสองฝั่ง`;
    case 'INVALID_SCORE':
      return $localize`:@@err.code.invalidScore:คะแนนไม่ถูกต้อง`;
    case 'INVALID_WINNER':
      return $localize`:@@err.code.invalidWinner:ผู้ชนะไม่ถูกต้อง`;
    case 'WINNER_REQUIRED_FOR_SCORES':
      return $localize`:@@err.code.winnerRequired:กรุณาเลือกผู้ชนะเมื่อกรอกคะแนน`;
    case 'WINNER_SCORE_MISMATCH':
      return $localize`:@@err.code.winnerScoreMismatch:ผู้ชนะไม่ตรงกับคะแนนที่กรอก`;
    case 'PAIRING_INCOMPLETE':
      return $localize`:@@err.code.pairingIncomplete:ยังมีที่ว่างในคอร์ท ใส่ผู้เล่นให้ครบก่อนยืนยัน`;
    case 'SEAT_OCCUPIED':
      return $localize`:@@err.code.seatOccupied:ที่นั่งนี้มีคนอยู่แล้ว`;
    case 'SEAT_OUT_OF_RANGE':
      return $localize`:@@err.code.seatOutOfRange:ไม่พบที่นั่งนี้ในคอร์ท`;
    case 'PAIR_RULE_VIOLATION':
      return $localize`:@@err.code.pairRuleViolation:เปลี่ยนไม่ได้ เพราะขัดกับกฎการจับคู่`;
    case 'PAIR_RULE_SEARCH_LIMIT':
      return $localize`:@@err.code.pairRuleSearchLimit:กฎการจับคู่ซับซ้อนเกินไป หาคู่ไม่ทัน ลองใหม่หรือปิดกฎบางข้อคืนนี้`;
    case 'RULE_NOT_FOUND':
      return $localize`:@@err.code.ruleNotFound:ไม่พบกฎนี้ อาจถูกลบไปแล้ว`;
    case 'SHUTTLE_CHOICE_REQUIRED':
    case 'INVALID_SHUTTLE_CHOICE':
      return $localize`:@@err.code.shuttleChoiceRequired:กรุณาเลือกลูกแบดก่อนยืนยันแมตช์`;
    case 'SHUTTLE_UNAVAILABLE':
      return $localize`:@@err.code.shuttleUnavailable:ลูกแบดลูกนี้ใช้ไม่ได้หรือถูกใช้อยู่ที่คอร์ทอื่น`;
    case 'SHUTTLE_NOT_FOUND':
      return $localize`:@@err.code.shuttleNotFound:ไม่พบลูกแบดลูกนี้`;
    case 'SHUTTLE_IN_USE':
      return $localize`:@@err.code.shuttleInUse:ลูกแบดลูกนี้ยังถูกใช้อยู่ ปิดการใช้งานไม่ได้`;
    case 'SHUTTLE_TRACKING_DISABLED':
      return $localize`:@@err.code.shuttleTrackingDisabled:ก๊วนนี้ไม่ได้เปิดการจดลูกแบด`;
    case 'PLAYER_ALREADY_ON_COURT':
      return $localize`:@@err.code.playerAlreadyOnCourt:ผู้เล่นคนนี้อยู่ในคอร์ทอื่นแล้ว`;
    case 'PLAYER_ALREADY_QUEUED':
      return $localize`:@@err.code.playerAlreadyQueued:ผู้เล่นคนนี้อยู่ในคิวล่วงหน้าแล้ว`;
    case 'LINEUP_NOT_FOUND':
      return $localize`:@@err.code.lineupNotFound:ไม่พบคิวนี้แล้ว`;
    case 'LEVEL_LADDER_STALE':
    case 'LEVEL_UNKNOWN':
      return levelsErrorMessage(code);
    default:
      return checkoutErrorMessage(code);
  }
}

@Injectable()
export class LiveSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;
  private readonly sessionCode: string;

  readonly sessionResource: ReturnType<typeof httpResource<Session>>;
  /**
   * Dependent resources consume this instead of polling a second endpoint
   * blindly. A successful mutation is the moment stats and other derived
   * views become stale.
   */
  readonly mutationVersion = signal(0);

  readonly courts = computed<CourtState[]>(() => {
    if (this.sessionResource.error()) return [];
    return this.sessionResource.value()?.courts ?? [];
  });

  readonly restingPlayerIds = computed(() => {
    if (this.sessionResource.error()) return [];
    return this.sessionResource.value()?.restingPlayerIds ?? [];
  });

  /** Lineups the host set for upcoming matches, next-to-play first. */
  readonly lineupQueue = computed<LineupEntry[]>(() => {
    if (this.sessionResource.error()) return [];
    return this.sessionResource.value()?.lineupQueue ?? [];
  });

  readonly mode = computed<Session['mode']>(() => this.sessionResource.value()?.mode ?? 'variety');

  /** Whether this session tracks numbered shuttles (its creation-time snapshot of the group switch). */
  readonly shuttleTools = computed(() => !this.sessionResource.error() && this.sessionResource.value()?.shuttleToolsEnabled === true);

  /** Per-court display names — resolve with labelForCourt. */
  readonly courtLabels = computed<(string | null)[]>(() => this.sessionResource.value()?.courtLabels ?? []);

  /**
   * How far the client's clock is ahead of the server's, in ms — recomputed
   * each time a fresh response lands. A live court timer adds this to
   * `Date.now()` so a host's phone running a few minutes fast does not show
   * an inflated elapsed time.
   */
  readonly serverSkewMs = computed(() => {
    const serverNow = this.sessionResource.value()?.serverNow;
    return serverNow ? Date.now() - new Date(serverNow).getTime() : 0;
  });

  readonly waitingPlayerIds = computed(() => {
    if (this.sessionResource.error()) return [];
    const session = this.sessionResource.value();
    if (!session) return [];
    const reserved = new Set<string>();
    for (const court of this.courts()) {
      if (court.status === 'idle') continue;
      for (const id of [...court.teamA, ...court.teamB]) {
        if (id !== null) reserved.add(id);
      }
    }
    // Resting players are waiting for nothing — they are not in the queue.
    const resting = new Set(session.restingPlayerIds);
    return session.rosterPlayerIds.filter((id) => !reserved.has(id) && !resting.has(id));
  });

  /** Players already lined up for a later match: still waiting, but spoken for. */
  readonly queuedPlayerIds = computed(
    () =>
      new Set(
        this.lineupQueue().flatMap((e) => [...e.teamA, ...e.teamB].filter((id): id is string => id !== null))
      )
  );

  constructor(route: ActivatedRoute) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.sessionResource = httpResource<Session>(() => `${this.base}/sessions/${this.sessionCode}`);
  }

  refresh(): void {
    this.sessionResource.reload();
  }

  /**
   * `refreshOnError` re-reads the session after a failed request. Opt-in:
   * only the writes whose failure usually means the screen is out of date
   * (a confirm that lost to auto-confirm, a stale shuttle switch) want the
   * server's truth back; every other failure leaves the poll alone.
   */
  private async post<T extends MutationResponse>(
    path: string,
    body: unknown,
    fallbackError: string,
    refreshOnError = false
  ): Promise<ActionResult> {
    try {
      const response = await firstValueFrom(
        this.http.post<T>(`${this.base}/sessions/${this.sessionCode}/${path}`, body)
      );
      this.sessionResource.reload();
      if (response?.ok === false) {
        return {
          ok: false,
          reason: response.reason,
          available: response.available,
          format: response.format,
          ruleIds: response.ruleIds,
          ...fillDetails(response),
        };
      }
      this.mutationVersion.update((version) => version + 1);
      return { ok: true, ...(response ? fillDetails(response) : {}) };
    } catch (err) {
      if (refreshOnError) this.sessionResource.reload();
      const code =
        err instanceof HttpErrorResponse && typeof err.error?.code === 'string'
          ? err.error.code
          : null;
      const ruleIds =
        err instanceof HttpErrorResponse && Array.isArray(err.error?.ruleIds)
          ? (err.error.ruleIds as string[])
          : undefined;
      return {
        ok: false,
        error: (code && messageForCode(code)) || fallbackError,
        ...(code && refreshOnError ? { code } : {}),
        ...(ruleIds ? { ruleIds } : {}),
      };
    }
  }

  proposeMatch(courtNumber: number): Promise<ActionResult> {
    return this.post<ProposeResponse>(
      `courts/${courtNumber}/propose`,
      {},
      $localize`:@@err.propose:เริ่มแมตช์ไม่สำเร็จ`
    );
  }

  swapPlayer(pairingId: string, playerId: string, withPlayerId?: string): Promise<ActionResult> {
    return this.post<SwapResponse>(
      `pairings/${pairingId}/swap`,
      withPlayerId === undefined ? { playerId } : { playerId, withPlayerId },
      $localize`:@@err.swap:เปลี่ยนตัวไม่สำเร็จ`
    );
  }

  /**
   * Custom mode's seat editor: names a player into one seat, or vacates it
   * when `playerId` is omitted. Not gated on the session being in custom
   * mode — see the server-side comment on `setSeat` — so this keeps working
   * on a half-filled draft left over after switching modes.
   */
  setSeat(pairingId: string, team: 'A' | 'B', index: number, playerId?: string): Promise<ActionResult> {
    return this.post(
      `pairings/${pairingId}/seats`,
      { team, index, playerId: playerId ?? null },
      $localize`:@@err.setSeat:ใส่ผู้เล่นไม่สำเร็จ`
    );
  }

  /** Adds a lineup to the end of the queue. A seat is a player id or null (left for the engine). */
  addLineup(teamA: Seat[], teamB: Seat[]): Promise<ActionResult> {
    return this.post('queue', { teamA, teamB }, $localize`:@@err.addLineup:เพิ่มคิวล่วงหน้าไม่สำเร็จ`);
  }

  replaceLineup(id: string, teamA: Seat[], teamB: Seat[]): Promise<ActionResult> {
    return this.post(`queue/${id}`, { teamA, teamB }, $localize`:@@err.editLineup:แก้คิวล่วงหน้าไม่สำเร็จ`, true);
  }

  moveLineup(id: string, direction: 'up' | 'down'): Promise<ActionResult> {
    return this.post(`queue/${id}/move`, { direction }, $localize`:@@err.moveLineup:ย้ายคิวไม่สำเร็จ`, true);
  }

  async removeLineup(id: string): Promise<ActionResult> {
    try {
      await firstValueFrom(this.http.delete(`${this.base}/sessions/${this.sessionCode}/queue/${id}`));
      this.sessionResource.reload();
      return { ok: true };
    } catch {
      this.sessionResource.reload();
      return { ok: false, error: $localize`:@@err.removeLineup:ลบคิวล่วงหน้าไม่สำเร็จ` };
    }
  }

  /** Fills only this court's empty seats from the normal rotation pool,
   *  leaving every seated player exactly where they are. */
  autoPair(pairingId: string): Promise<ActionResult> {
    return this.post(
      `pairings/${pairingId}/autopair`,
      {},
      $localize`:@@err.autoPair:เติมอัตโนมัติไม่สำเร็จ`
    );
  }

  /** `shuttle` is the host's choice on an advanced session; omitted, the body is empty as before. */
  confirmMatch(pairingId: string, shuttle?: ShuttleChoice): Promise<ActionResult> {
    return this.post(
      `pairings/${pairingId}/confirm`,
      shuttle ? { shuttle } : {},
      $localize`:@@err.confirm:ยืนยันแมตช์ไม่สำเร็จ`,
      // A confirm usually fails here because the 60s auto-confirm got there first.
      shuttle !== undefined
    );
  }

  /**
   * Changes the shuttle in hand on an active game, optionally retiring the one
   * put down in the same action. `expectedRevision` makes a stale tab fail
   * loudly instead of overwriting a winner tap.
   */
  switchShuttle(
    pairingId: string,
    choice: ShuttleChoice,
    expectedRevision: number,
    retirePrevious?: boolean
  ): Promise<ActionResult> {
    return this.post(
      `pairings/${pairingId}/shuttles/switch`,
      retirePrevious ? { choice, expectedRevision, retirePrevious } : { choice, expectedRevision },
      $localize`:@@err.switchShuttle:เปลี่ยนลูกแบดไม่สำเร็จ`,
      true
    );
  }

  /** The desired state, not a flip. A shuttle in a live hand cannot be retired here. */
  setShuttleUsable(shuttleId: string, usable: boolean): Promise<ActionResult> {
    return this.post(
      `shuttles/${shuttleId}/usable`,
      { usable },
      $localize`:@@err.shuttleUsable:เปลี่ยนสถานะลูกแบดไม่สำเร็จ`,
      true
    );
  }

  /** Early checkout (E). Owner-only, never on the public poll. A quote changes nothing. */
  previewCheckout(playerId: string, model: CheckoutModel): Promise<CheckoutPreview> {
    return firstValueFrom(
      this.http.post<CheckoutPreview>(`${this.base}/sessions/${this.sessionCode}/checkouts/${playerId}/preview`, { model })
    );
  }

  /** The same `idempotencyKey` on a network retry returns the same receipt; it never settles twice. */
  async confirmCheckout(
    playerId: string,
    model: CheckoutModel,
    snapshotHash: string,
    idempotencyKey: string
  ): Promise<CheckoutReceipt> {
    const receipt = await firstValueFrom(
      this.http.post<CheckoutReceipt>(`${this.base}/sessions/${this.sessionCode}/checkouts/${playerId}/confirm`, {
        model,
        snapshotHash,
        idempotencyKey,
      })
    );
    this.sessionResource.reload();
    return receipt;
  }

  getCheckouts(): Promise<CheckoutReceipt[]> {
    return firstValueFrom(this.http.get<CheckoutReceipt[]>(`${this.base}/sessions/${this.sessionCode}/checkouts`));
  }

  undoCheckout(checkoutId: string): Promise<ActionResult> {
    return this.post(
      `checkouts/${checkoutId}/undo`,
      {},
      $localize`:@@err.undoCheckout:ยกเลิกการเช็คเอาต์ไม่สำเร็จ`,
      true
    );
  }

  /** Owner-only; read on demand (picker, summary editor), never on the poll. */
  getShuttleInventory(): Promise<ShuttleInventory> {
    return firstValueFrom(this.http.get<ShuttleInventory>(`${this.base}/sessions/${this.sessionCode}/shuttles`));
  }

  finishMatch(
    pairingId: string,
    scoreA: number | null,
    scoreB: number | null,
    winner: 'A' | 'B' | null
  ): Promise<ActionResult> {
    return this.post(
      `pairings/${pairingId}/finish`,
      { scoreA, scoreB, winner },
      $localize`:@@err.finish:บันทึกผลไม่สำเร็จ`
    );
  }

  /** `active` is the desired state, not a flip — two taps in flight are safe. */
  setPlayerActive(playerId: string, active: boolean): Promise<ActionResult> {
    return this.post(
      `roster/${playerId}/active`,
      { active },
      $localize`:@@err.setActive:เปลี่ยนสถานะผู้เล่นไม่สำเร็จ`
    );
  }

  /**
   * Manual escape hatch for when two courts finish out of sync: credits every
   * waiting player except the one with the fewest games up to the on-court
   * max, so the next draw is forced to include that player instead. Rotation
   * weight only — never touches the real games-played stat.
   */
  deprioritizeWaiting(): Promise<ActionResult> {
    return this.post(
      'roster/deprioritize-waiting',
      {},
      $localize`:@@err.deprioritizeWaiting:จัดคิวใหม่ไม่สำเร็จ`
    );
  }

  /** Adds someone not on tonight's pasted roster — an existing group player
   *  (`playerId`) or a brand-new one (`name`) — to a running session. */
  addWalkIn(
    input: { playerId: string } | { name: string; level?: Level; expectedLadderRevision?: number }
  ): Promise<ActionResult> {
    return this.post('roster', input, $localize`:@@err.addWalkIn:เพิ่มผู้เล่นไม่สำเร็จ`);
  }

  undoCourt(courtNumber: number): Promise<ActionResult> {
    return this.post(
      `courts/${courtNumber}/undo`,
      {},
      $localize`:@@err.undo:ย้อนกลับไม่สำเร็จ`
    );
  }

  fillCourts(): Promise<ActionResult> {
    return this.post('courts/fill', {}, $localize`:@@err.fill:จัดคู่ไม่สำเร็จ`);
  }

  setMode(mode: Session['mode']): Promise<ActionResult> {
    return this.post('mode', { mode }, $localize`:@@err.mode:เปลี่ยนโหมดไม่สำเร็จ`);
  }

  /** Host-only: read separately from the public session poll (a level is
   *  never on it — see Session.mode's doc comment). */
  getLevels(): Promise<Record<string, Level | null>> {
    return firstValueFrom(
      this.http.get<Record<string, Level | null>>(
        `${this.base}/sessions/${this.sessionCode}/levels`
      )
    );
  }

  /**
   * Host-only, like levels: never on the public session poll. Null until the
   * first load lands; a failed refresh keeps the last good copy.
   */
  readonly sessionRules = signal<SessionRules | null>(null);

  readonly enabledRules = computed<PairRule[]>(() => {
    const state = this.sessionRules();
    if (!state) return [];
    const off = new Set(state.disabledRuleIds);
    return state.rules.filter((r) => !off.has(r.id));
  });

  getSessionRules(): Promise<SessionRules> {
    return firstValueFrom(
      this.http.get<SessionRules>(`${this.base}/sessions/${this.sessionCode}/rules`)
    );
  }

  async loadSessionRules(): Promise<void> {
    try {
      this.sessionRules.set(await this.getSessionRules());
    } catch {
      // Explanations degrade to rule-less messages; the server still enforces.
    }
  }

  /** `enabled` is the desired state for tonight only; the group rule is untouched. */
  async toggleSessionRule(ruleId: string, enabled: boolean): Promise<ActionResult> {
    const result = await this.post(
      `rules/${ruleId}/toggle`,
      { enabled },
      $localize`:@@err.toggleRule:เปลี่ยนกฎคืนนี้ไม่สำเร็จ`
    );
    if (result.ok) await this.loadSessionRules();
    return result;
  }

  /** Idle-only; the server refuses with COURT_ACTIVE while a match is pending or active. */
  setCourtFormat(courtNumber: number, format: CourtFormat): Promise<ActionResult> {
    return this.post(
      `courts/${courtNumber}/format`,
      { format },
      $localize`:@@err.courtFormat:เปลี่ยนรูปแบบคอร์ทไม่สำเร็จ`
    );
  }

  /** Allowed in any court state — a court's mode only ever changes what the
   *  next propose/reshuffle does. */
  setCourtMode(courtNumber: number, mode: CourtMode): Promise<ActionResult> {
    return this.post(
      `courts/${courtNumber}/mode`,
      { mode },
      $localize`:@@err.courtMode:เปลี่ยนโหมดคอร์ทไม่สำเร็จ`
    );
  }

  /** Allowed in any court and session state; a blank label resets the court
   *  to its number. */
  setCourtLabel(courtNumber: number, label: string): Promise<ActionResult> {
    return this.post(
      `courts/${courtNumber}/label`,
      { label },
      $localize`:@@err.courtLabel:เปลี่ยนชื่อคอร์ทไม่สำเร็จ`
    );
  }

  /**
   * Court bookings often change part-way through the evening, so the count is
   * editable rather than fixed at import. The server refuses to shrink past a
   * court that is still playing.
   */
  setCourtCount(courtCount: number): Promise<ActionResult> {
    return this.post(
      'court-count',
      { courtCount },
      $localize`:@@err.courtCount:เปลี่ยนจำนวนคอร์ทไม่สำเร็จ`
    );
  }

  endSession(): Promise<ActionResult> {
    return this.post('end', {}, $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
  }

  /**
   * Shuttle count and price-per-shuttle are independent, purely-informational
   * fields — no total-cost or bill-splitting logic anywhere reads them. Both
   * halves of `dto` are optional: the caller includes only the key(s) the
   * host actually changed (an explicit `null` to clear one), and this method
   * forwards the object as-is rather than filling in the other side, so a
   * one-field edit here can never clobber a concurrent edit to the other
   * field from another tab. Available on an ended session's dashboard too —
   * this endpoint has no session-active guard on the server.
   */
  setShuttleDetails(dto: {
    shuttleCount?: number | null;
    shuttlePriceSatang?: number | null;
  }): Promise<ActionResult> {
    return this.post(
      'shuttle-details',
      dto,
      $localize`:@@err.shuttleDetails:บันทึกข้อมูลลูกแบดไม่สำเร็จ`
    );
  }
}
