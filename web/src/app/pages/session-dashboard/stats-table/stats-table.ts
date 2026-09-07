import { Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { httpResource } from '@angular/common/http';
import { absoluteUrl, copyToClipboard } from '../../../core/share-link';
import { environment } from '../../../../environments/environment';
import type { PlayerStat } from '../../../core/stats.model';

@Component({
  selector: 'app-stats-table',
  imports: [RouterLink],
  templateUrl: './stats-table.html',
  styleUrl: './stats-table.css',
})
export class StatsTable {
  readonly sessionCode = input.required<string>();
  readonly groupCode = input.required<string>();
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

  /** The row whose link was just copied, so only that row confirms. */
  protected readonly sharedPlayerId = signal<string | null>(null);
  protected readonly shareFailed = signal(false);

  /**
   * A player's card is public, but this table is the only link to it anywhere
   * in the app — and this table is on an admin-only screen. Without a way to
   * get the URL out, the page may as well be private.
   */
  protected async sharePlayer(playerId: string): Promise<void> {
    this.shareFailed.set(false);
    const ok = await copyToClipboard(absoluteUrl(`/g/${this.groupCode()}/p/${playerId}`));
    if (!ok) {
      this.shareFailed.set(true);
      return;
    }
    this.sharedPlayerId.set(playerId);
    setTimeout(() => {
      if (this.sharedPlayerId() === playerId) this.sharedPlayerId.set(null);
    }, 2000);
  }

  protected shareLabel(name: string): string {
    return $localize`:@@stats.sharePlayerLabel:คัดลอกลิงก์ของ ${name}:name:`;
  }
}
