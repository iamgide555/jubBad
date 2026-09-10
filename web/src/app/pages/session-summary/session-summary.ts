import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { SessionSummary as Summary } from '../../core/session-summary.model';

@Component({
  selector: 'app-session-summary',
  imports: [RouterLink],
  templateUrl: './session-summary.html',
  styleUrl: './session-summary.css',
})
export class SessionSummary {
  protected readonly sessionCode: string;

  private readonly summaryResource: ReturnType<typeof httpResource<Summary>>;

  protected readonly summary = computed<Summary | undefined>(() => {
    if (this.summaryResource.error()) return undefined;
    return this.summaryResource.value();
  });

  protected readonly notFound = computed(
    () => this.summaryResource.error() !== undefined
  );

  /** Which player's match list is expanded, if any. */
  protected readonly expandedPlayerId = signal<string | null>(null);

  protected togglePlayer(playerId: string): void {
    this.expandedPlayerId.set(this.expandedPlayerId() === playerId ? null : playerId);
  }

  /** Whole percent — a casual group does not need decimal places. */
  protected winPercent(played: number, won: number): number | null {
    return played === 0 ? null : Math.round((won / played) * 100);
  }

  /**
   * This page is public, so anyone holding the link can open it. The back
   * link goes to the group's admin screen, which they cannot open — following
   * it would bounce them to a login page they have no token for and leave
   * them stranded. Shown only to someone who can actually use it.
   */
  protected readonly canGoBack = signal(false);

  constructor(route: ActivatedRoute) {
    const auth = inject(AuthService);
    void auth.check().then((authed) => this.canGoBack.set(authed));

    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.summaryResource = httpResource<Summary>(
      () => `${environment.apiBaseUrl}/sessions/${this.sessionCode}/summary`
    );
  }
}
