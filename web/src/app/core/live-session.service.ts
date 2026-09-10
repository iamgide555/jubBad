import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type { CourtState } from './live-session.model';
import type { Session } from './session.model';

interface ProposeResponse {
  ok: boolean;
  reason?: string;
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
    default:
      return null;
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

  readonly waitingPlayerIds = computed(() => {
    if (this.sessionResource.error()) return [];
    const session = this.sessionResource.value();
    if (!session) return [];
    const reserved = new Set<string>();
    for (const court of this.courts()) {
      if (court.status === 'idle') continue;
      reserved.add(court.teamA[0]);
      reserved.add(court.teamA[1]);
      reserved.add(court.teamB[0]);
      reserved.add(court.teamB[1]);
    }
    // Resting players are waiting for nothing — they are not in the queue.
    const resting = new Set(session.restingPlayerIds);
    return session.rosterPlayerIds.filter((id) => !reserved.has(id) && !resting.has(id));
  });

  constructor(route: ActivatedRoute) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.sessionResource = httpResource<Session>(() => `${this.base}/sessions/${this.sessionCode}`);
  }

  refresh(): void {
    this.sessionResource.reload();
  }

  private async post<T extends { ok?: boolean; reason?: string }>(
    path: string,
    body: unknown,
    fallbackError: string
  ): Promise<ActionResult> {
    try {
      const response = await firstValueFrom(
        this.http.post<T>(`${this.base}/sessions/${this.sessionCode}/${path}`, body)
      );
      this.sessionResource.reload();
      if (response?.ok === false) return { ok: false, reason: response.reason };
      this.mutationVersion.update((version) => version + 1);
      return { ok: true };
    } catch (err) {
      const code =
        err instanceof HttpErrorResponse && typeof err.error?.code === 'string'
          ? err.error.code
          : null;
      return { ok: false, error: (code && messageForCode(code)) || fallbackError };
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

  confirmMatch(pairingId: string): Promise<ActionResult> {
    return this.post(`pairings/${pairingId}/confirm`, {}, $localize`:@@err.confirm:ยืนยันแมตช์ไม่สำเร็จ`);
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

  setMode(mode: 'variety' | 'balanced'): Promise<ActionResult> {
    return this.post('mode', { mode }, $localize`:@@err.mode:เปลี่ยนโหมดไม่สำเร็จ`);
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
}
