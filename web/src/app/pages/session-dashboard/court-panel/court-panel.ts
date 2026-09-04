import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import type { Player } from '../../../../../../fuzzy-match.ts';

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

  protected readonly court = computed(
    () => this.liveSession.courts()[this.courtNumber() - 1]
  );

  protected teamNames(ids: [string, string]): string[] {
    return resolvePlayerNames(ids, this.players());
  }

  protected startOrReshuffle(): void {
    const success = this.liveSession.proposeMatch(this.courtNumber());
    this.notEnoughPlayers.set(!success);
  }

  protected confirm(): void {
    this.liveSession.confirmMatch(this.courtNumber());
  }

  protected finish(): void {
    this.liveSession.finishMatch(this.courtNumber(), this.scoreA(), this.scoreB());
    this.scoreA.set(null);
    this.scoreB.set(null);
  }
}
