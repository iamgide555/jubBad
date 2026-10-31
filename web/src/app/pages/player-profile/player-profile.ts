import { Location } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import { Odometer } from '../../core/motion/odometer';
import type { FormatRecord, PlayerProfile as Profile } from '../../core/player-stats.model';

@Component({
  selector: 'app-player-profile',
  imports: [RouterLink, Odometer],
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

  /**
   * The group's plan does not include player stats (403 PLAN_REQUIRED). A public visitor reaches
   * this with a link a host once copied, so it gets a plain message, not a blank page or "not found".
   */
  protected readonly planLocked = computed(() => {
    const err = this.profileResource.error();
    return (
      err instanceof HttpErrorResponse &&
      err.status === 403 &&
      (err.error as { code?: unknown } | null)?.code === 'PLAN_REQUIRED'
    );
  });

  protected readonly notFound = computed(
    () => this.profileResource.error() !== undefined && !this.planLocked()
  );

  /** Whole percent — a casual group does not need decimal places. */
  protected readonly winPercent = computed(() => {
    const rate = this.profile()?.winRate;
    return rate == null ? null : Math.round(rate * 100);
  });

  protected partnerPercent(rate: number | null): number | null {
    return rate == null ? null : Math.round(rate * 100);
  }

  protected formatPercent(record: FormatRecord | null): number | null {
    return record?.winRate == null ? null : Math.round(record.winRate * 100);
  }

  /**
   * This page is public, so a player can hold a link to it. The back link goes
   * to the group's admin screen, which they cannot open — following it would
   * bounce them to a login page they have no token for and leave them stranded.
   * Shown only to someone who can actually use it.
   */
  protected readonly canGoBack = signal(false);

  /**
   * The plan-locked page has no public place to send a visitor (the group home is host-only and
   * the public dashboard's token is not known here), so a visitor goes back in history — offered
   * only when there is a page to go back to; a link opened straight from LINE has none.
   */
  protected readonly hasHistory = typeof window !== 'undefined' && window.history.length > 1;
  private readonly location = inject(Location);

  protected goBack(event: Event): void {
    event.preventDefault();
    this.location.back();
  }

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
