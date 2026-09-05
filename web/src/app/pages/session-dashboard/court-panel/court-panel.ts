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

  protected async startOrReshuffle(): Promise<void> {
    const success = await this.liveSession.proposeMatch(this.courtNumber());
    this.notEnoughPlayers.set(!success);
  }

  protected async confirm(): Promise<void> {
    const c = this.court();
    if (c.status !== 'pending') return;
    await this.liveSession.confirmMatch(c.pairingId);
  }

  protected async finish(winner: 'A' | 'B'): Promise<void> {
    const c = this.court();
    if (c.status !== 'active') return;
    await this.liveSession.finishMatch(c.pairingId, this.scoreA(), this.scoreB(), winner);
    this.scoreA.set(null);
    this.scoreB.set(null);
  }
}
