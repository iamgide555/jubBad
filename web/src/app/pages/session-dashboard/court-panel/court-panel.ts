import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import type { CourtState } from '../../../core/live-session.model';
import type { Player } from '../../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-court-panel',
  imports: [FormsModule],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();
  readonly players = input<Player[]>([]);

  readonly scoreA = signal<number | null>(null);
  readonly scoreB = signal<number | null>(null);
  readonly notEnoughPlayers = signal(false);
  readonly noSubstitute = signal(false);
  readonly busy = signal(false);
  /** A rejected request — mostly the pairing-lifecycle 409s. */
  readonly actionError = signal<string | null>(null);

  constructor(protected liveSession: LiveSessionService) {}

  protected readonly court = computed<CourtState>(
    () => this.liveSession.courts()[this.courtNumber() - 1] ?? { status: 'idle' }
  );

  protected readonly ended = computed(() => {
    if (this.liveSession.sessionResource.error()) return false;
    return this.liveSession.sessionResource.value()?.endedAt != null;
  });

  protected teamNames(ids: [string, string]): string[] {
    return resolvePlayerNames(ids, this.players());
  }

  /**
   * In TS rather than an `i18n-aria-label` attribute: the label interpolates a
   * player name, so it has to be a binding, and Angular only extracts static
   * attributes.
   */
  protected swapLabel(name: string): string {
    return $localize`:@@court.swapOut:เปลี่ยน ${name}:name: ออก`;
  }

  protected async startOrReshuffle(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.proposeMatch(this.courtNumber());
      this.notEnoughPlayers.set(!result.ok && result.reason === 'not-enough-players');
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  protected async swap(pairingId: string, playerId: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.swapPlayer(pairingId, playerId);
      this.noSubstitute.set(!result.ok && result.reason === 'no-substitute');
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirm(): Promise<void> {
    const c = this.court();
    if (c.status !== 'pending' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.confirmMatch(c.pairingId);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /** `winner: null` frees the court for a match abandoned without a result. */
  protected async finish(winner: 'A' | 'B' | null): Promise<void> {
    const c = this.court();
    if (c.status !== 'active' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const scores = winner === null ? [null, null] : [this.scoreA(), this.scoreB()];
      const result = await this.liveSession.finishMatch(c.pairingId, scores[0], scores[1], winner);
      this.actionError.set(result.error ?? null);
      if (!result.ok) return;
      this.scoreA.set(null);
      this.scoreB.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}
