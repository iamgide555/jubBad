import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
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

@Injectable()
export class LiveSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;
  private readonly sessionCode: string;

  readonly sessionResource: ReturnType<typeof httpResource<Session>>;

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
      return response?.ok === false
        ? { ok: false, reason: response.reason }
        : { ok: true };
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse && typeof err.error?.message === 'string'
          ? err.error.message
          : fallbackError;
      return { ok: false, error: message };
    }
  }

  proposeMatch(courtNumber: number): Promise<ActionResult> {
    return this.post<ProposeResponse>(
      `courts/${courtNumber}/propose`,
      {},
      $localize`:@@err.propose:เริ่มแมตช์ไม่สำเร็จ`
    );
  }

  swapPlayer(pairingId: string, playerId: string): Promise<ActionResult> {
    return this.post<SwapResponse>(
      `pairings/${pairingId}/swap`,
      { playerId },
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

  endSession(): Promise<ActionResult> {
    return this.post('end', {}, $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
  }
}
