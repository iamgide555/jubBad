import { Injectable, computed, signal } from '@angular/core';

/**
 * Who the host has picked up, ready to drop somewhere else.
 *
 * `pairingId` is null for someone waiting rather than on a court. It is what
 * tells a drop whether this is a straight substitution or a trade between two
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
 * This backs both input methods. Dragging carries the same pick through CDK's
 * drag data, and tapping leaves it here between the two taps, so the drop
 * handler is identical either way and touch, mouse and keyboard cannot drift
 * apart in behaviour.
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
