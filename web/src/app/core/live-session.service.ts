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
    return session.rosterPlayerIds.filter((id) => !reserved.has(id));
  });

  constructor(route: ActivatedRoute) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.sessionResource = httpResource<Session>(() => `${this.base}/sessions/${this.sessionCode}`);
  }

  refresh(): void {
    this.sessionResource.reload();
  }

  async proposeMatch(courtNumber: number): Promise<boolean> {
    const response = await firstValueFrom(
      this.http.post<ProposeResponse>(
        `${this.base}/sessions/${this.sessionCode}/courts/${courtNumber}/propose`,
        {}
      )
    );
    this.sessionResource.reload();
    return response.ok;
  }

  async swapPlayer(pairingId: string, playerId: string): Promise<boolean> {
    const response = await firstValueFrom(
      this.http.post<SwapResponse>(
        `${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/swap`,
        { playerId }
      )
    );
    this.sessionResource.reload();
    return response.ok;
  }

  async confirmMatch(pairingId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/confirm`, {})
    );
    this.sessionResource.reload();
  }

  async finishMatch(
    pairingId: string,
    scoreA: number | null,
    scoreB: number | null,
    winner: 'A' | 'B'
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/finish`, {
        scoreA,
        scoreB,
        winner,
      })
    );
    this.sessionResource.reload();
  }

  async endSession(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await firstValueFrom(
        this.http.post<{ code: string; endedAt: string }>(
          `${this.base}/sessions/${this.sessionCode}/end`,
          {}
        )
      );
      this.sessionResource.reload();
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse && typeof err.error?.message === 'string'
          ? err.error.message
          : 'Could not end the session.';
      return { ok: false, error: message };
    }
  }
}
