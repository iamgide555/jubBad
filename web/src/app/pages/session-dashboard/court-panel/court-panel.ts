import { Component, computed, input } from '@angular/core';
import { LiveSessionService } from '../../../core/live-session.service';

@Component({
  selector: 'app-court-panel',
  imports: [],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();

  constructor(protected liveSession: LiveSessionService) {}

  protected readonly court = computed(
    () => this.liveSession.courts()[this.courtNumber() - 1]
  );

  protected startOrReshuffle(): void {
    this.liveSession.proposeMatch(this.courtNumber());
  }

  protected confirm(): void {
    this.liveSession.confirmMatch(this.courtNumber());
  }

  protected finish(scoreA: number | null, scoreB: number | null): void {
    this.liveSession.finishMatch(this.courtNumber(), scoreA, scoreB);
  }
}
