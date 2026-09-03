import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';

@Component({
  selector: 'app-session-dashboard',
  imports: [],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard {
  private readonly sessionCode: string;
  readonly rosterNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    const byId = new Map(players.map((p) => [p.id, p.name]));
    return session.rosterPlayerIds.map((id) => byId.get(id) ?? id);
  });

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
  }
}
