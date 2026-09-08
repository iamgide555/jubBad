import { Injectable, computed, signal } from '@angular/core';

/**
 * Who the host has picked up, ready to drop somewhere else.
 *
 * `pairingId` is null for someone waiting rather than on a court. It is what
 * tells a swap whether this is a straight substitution or a trade between two
 * courts, so it travels with the selection rather than being worked out again
 * at the far end.
 */
export interface SwapPick {
  playerId: string;
  name: string;
  pairingId: string | null;
}

/**
 * Shared by the waiting list and every court panel, which are siblings — a
 * player is picked up in one and put down in another, so the selection cannot
 * live in either.
 *
 * There is one gesture: tap a name to hold it, tap a second name to swap the
 * two. What a second tap on the *same* name means differs by surface — a court
 * takes the player off, the waiting list only puts them down — so that
 * decision belongs to the caller. This just holds the pick.
 */
@Injectable({ providedIn: 'root' })
export class SwapSelectionService {
  private readonly picked = signal<SwapPick | null>(null);

  readonly selection = this.picked.asReadonly();
  readonly active = computed(() => this.picked() !== null);

  /** Tapping the same player again puts them back down, so tap is reversible. */
  toggle(pick: SwapPick): void {
    this.picked.update((current) => (current?.playerId === pick.playerId ? null : pick));
  }

  clear(): void {
    this.picked.set(null);
  }

  isPicked(playerId: string): boolean {
    return this.picked()?.playerId === playerId;
  }
}
