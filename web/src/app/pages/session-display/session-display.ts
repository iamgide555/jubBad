import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';

@Component({
  selector: 'app-session-display',
  imports: [],
  providers: [LiveSessionService],
  templateUrl: './session-display.html',
  styleUrl: './session-display.css',
})
export class SessionDisplay {
  private readonly sessionCode: string;

  readonly sessionExists = computed(
    () => this.rosterService.getSession(this.sessionCode) !== null
  );

  readonly header = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return '';
    const group = this.rosterService.getGroup(session.groupCode);
    if (group?.name) return group.name;
    return session.venue ? `${session.date} · ${session.venue}` : (session.date ?? '');
  });

  readonly courtLines = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    const players = session ? this.rosterService.getPlayers(session.groupCode) : [];
    return this.liveSession.courts().map((court, i) => {
      if (court.status !== 'active') {
        return { courtNumber: i + 1, text: 'waiting' };
      }
      const [a1, a2] = resolvePlayerNames(court.teamA, players);
      const [b1, b2] = resolvePlayerNames(court.teamB, players);
      return { courtNumber: i + 1, text: `${a1} + ${a2} vs ${b1} + ${b2}` };
    });
  });

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

  refresh(): void {
    this.liveSession.refresh();
  }
}
