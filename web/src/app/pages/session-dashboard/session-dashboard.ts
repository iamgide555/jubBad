import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import { CourtPanel } from './court-panel/court-panel';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard {
  private readonly sessionCode: string;
  readonly rosterNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    return resolvePlayerNames(session.rosterPlayerIds, players);
  });

  readonly courtNumbers = computed(() =>
    this.liveSession.courts().map((_, i) => i + 1)
  );

  readonly waitingNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    return resolvePlayerNames(this.liveSession.waitingPlayerIds(), players);
  });

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    protected liveSession: LiveSessionService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
  }
}
