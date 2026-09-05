import { Component, computed, input, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import type { PlayerStat } from '../../../core/stats.model';

@Component({
  selector: 'app-stats-table',
  templateUrl: './stats-table.html',
  styleUrl: './stats-table.css',
})
export class StatsTable {
  readonly sessionCode = input.required<string>();
  protected readonly scope = signal<'session' | 'all'>('session');

  private readonly statsResource = httpResource<PlayerStat[]>(
    () => `${environment.apiBaseUrl}/sessions/${this.sessionCode()}/stats?scope=${this.scope()}`
  );

  protected readonly stats = computed<PlayerStat[]>(() => {
    if (this.statsResource.error()) return [];
    return this.statsResource.value() ?? [];
  });

  protected setScope(scope: 'session' | 'all'): void {
    this.scope.set(scope);
  }
}
