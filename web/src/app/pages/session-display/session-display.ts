import { Component, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import type { Group } from '../../core/group.model';
import type { Player } from '../../../../../fuzzy-match.ts';

@Component({
  selector: 'app-session-display',
  imports: [],
  providers: [LiveSessionService],
  templateUrl: './session-display.html',
  styleUrl: './session-display.css',
})
export class SessionDisplay {
  protected readonly session = computed(() => {
    if (this.liveSession.sessionResource.error()) return undefined;
    return this.liveSession.sessionResource.value();
  });

  readonly sessionExists = computed(() => this.session() !== undefined);

  private readonly groupResource = httpResource<Group>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}` : undefined;
  });

  private readonly playersResource = httpResource<Player[]>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}/players` : undefined;
  });

  private readonly players = computed<Player[]>(() => {
    if (this.playersResource.error()) return [];
    return this.playersResource.value() ?? [];
  });

  readonly header = computed(() => {
    const session = this.session();
    if (!session) return '';
    const group = this.groupResource.error() ? undefined : this.groupResource.value();
    if (group?.name) return group.name;
    return session.venue ? `${session.date} · ${session.venue}` : (session.date ?? '');
  });

  readonly courtLines = computed(() => {
    const players = this.players();
    return this.liveSession.courts().map((court, i) => {
      if (court.status !== 'active') {
        return { courtNumber: i + 1, text: 'waiting' };
      }
      const [a1, a2] = resolvePlayerNames(court.teamA, players);
      const [b1, b2] = resolvePlayerNames(court.teamB, players);
      return { courtNumber: i + 1, text: `${a1} + ${a2} vs ${b1} + ${b2}` };
    });
  });

  readonly waitingNames = computed(() =>
    resolvePlayerNames(this.liveSession.waitingPlayerIds(), this.players())
  );

  constructor(protected liveSession: LiveSessionService) {}

  refresh(): void {
    this.liveSession.refresh();
  }
}
