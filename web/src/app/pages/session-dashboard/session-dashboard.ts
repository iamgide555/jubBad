import { Component, computed, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import { CourtPanel } from './court-panel/court-panel';
import { StatsTable } from './stats-table/stats-table';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel, StatsTable],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard {
  protected readonly session = computed(() => {
    if (this.liveSession.sessionResource.error()) return undefined;
    return this.liveSession.sessionResource.value();
  });

  protected readonly sessionExists = computed(() => this.session() !== undefined);

  private readonly playersResource = httpResource<Player[]>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}/players` : undefined;
  });

  protected readonly players = computed<Player[]>(() => {
    if (this.playersResource.error()) return [];
    return this.playersResource.value() ?? [];
  });

  /**
   * The roster chips double as the rest control, so each one needs its id and
   * whether it is resting — not just a display name.
   */
  readonly rosterEntries = computed(() => {
    const session = this.session();
    if (!session) return [];
    const resting = new Set(session.restingPlayerIds);
    const names = resolvePlayerNames(session.rosterPlayerIds, this.players());
    return session.rosterPlayerIds.map((id, i) => ({
      id,
      name: names[i],
      resting: resting.has(id),
    }));
  });

  readonly waitlistNames = computed(() => {
    const session = this.session();
    if (!session) return [];
    return resolvePlayerNames(session.waitlistPlayerIds, this.players());
  });

  readonly courtNumbers = computed(() => this.liveSession.courts().map((_, i) => i + 1));

  readonly waitingNames = computed(() =>
    resolvePlayerNames(this.liveSession.waitingPlayerIds(), this.players())
  );

  readonly ended = computed(() => this.session()?.endedAt != null);
  readonly endSessionError = signal<string | null>(null);

  constructor(
    protected liveSession: LiveSessionService,
    private router: Router
  ) {}

  readonly rosterError = signal<string | null>(null);

  /** In TS, not an i18n attribute: the label interpolates a player name. */
  restLabel(name: string, resting: boolean): string {
    return resting
      ? $localize`:@@dashboard.bringBack:ให้ ${name}:name: กลับมาเล่น`
      : $localize`:@@dashboard.rest:ให้ ${name}:name: พัก`;
  }

  /** `resting` is the state being asked for; the API takes its inverse. */
  async toggleResting(playerId: string, resting: boolean): Promise<void> {
    this.rosterError.set(null);
    const result = await this.liveSession.setPlayerActive(playerId, !resting);
    this.rosterError.set(result.error ?? null);
  }

  async endSession(): Promise<void> {
    this.endSessionError.set(null);
    const result = await this.liveSession.endSession();
    if (!result.ok) {
      this.endSessionError.set(result.error ?? $localize`:@@err.endSession:จบก๊วนไม่สำเร็จ`);
      return;
    }
    this.router.navigateByUrl('/');
  }
}
