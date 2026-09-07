import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { PlayerProfile as Profile } from '../../core/player-stats.model';

@Component({
  selector: 'app-player-profile',
  imports: [RouterLink],
  templateUrl: './player-profile.html',
  styleUrl: './player-profile.css',
})
export class PlayerProfile {
  protected readonly groupCode: string;
  private readonly playerId: string;

  private readonly profileResource: ReturnType<typeof httpResource<Profile>>;

  protected readonly profile = computed<Profile | undefined>(() => {
    if (this.profileResource.error()) return undefined;
    return this.profileResource.value();
  });

  protected readonly notFound = computed(
    () => this.profileResource.error() !== undefined
  );

  /** Whole percent — a casual group does not need decimal places. */
  protected readonly winPercent = computed(() => {
    const rate = this.profile()?.winRate;
    return rate == null ? null : Math.round(rate * 100);
  });

  /**
   * This page is public, so a player can hold a link to it. The back link goes
   * to the group's admin screen, which they cannot open — following it would
   * bounce them to a login page they have no token for and leave them stranded.
   * Shown only to someone who can actually use it.
   */
  protected readonly canGoBack = signal(false);

  constructor(route: ActivatedRoute) {
    const auth = inject(AuthService);
    void auth.check().then((authed) => this.canGoBack.set(authed));

    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    this.playerId = route.snapshot.paramMap.get('playerId')!;
    this.profileResource = httpResource<Profile>(
      () => `${environment.apiBaseUrl}/groups/${this.groupCode}/players/${this.playerId}/stats`
    );
  }
}
