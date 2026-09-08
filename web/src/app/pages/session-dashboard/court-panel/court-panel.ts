import { Component, computed, inject, input, signal } from '@angular/core';
import { CdkDrag, CdkDragPlaceholder, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import { SwapSelectionService, type SwapPick } from '../../../core/swap-selection.service';
import type { CourtState } from '../../../core/live-session.model';
import type { Player } from '../../../../../../engines/fuzzy-match.ts';

@Component({
  selector: 'app-court-panel',
  imports: [FormsModule, CdkDrag, CdkDragPlaceholder, CdkDropList],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();
  readonly players = input<Player[]>([]);

  readonly scoreA = signal<number | null>(null);
  readonly scoreB = signal<number | null>(null);
  readonly notEnoughPlayers = signal(false);
  readonly noSubstitute = signal(false);
  readonly busy = signal(false);
  /** A rejected request — mostly the pairing-lifecycle 409s. */
  readonly actionError = signal<string | null>(null);

  protected readonly selection = inject(SwapSelectionService);

  constructor(protected liveSession: LiveSessionService) {}

  /**
   * The pending pairing's id, or null when there is nothing to swap. Drag and
   * drop targets read this rather than re-narrowing the court union in the
   * template at every use.
   */
  protected readonly pendingPairingId = computed<string | null>(() => {
    const c = this.court();
    return c.status === 'pending' ? c.pairingId : null;
  });

  protected pickFor(playerId: string): SwapPick {
    return {
      playerId,
      name: resolvePlayerNames([playerId], this.players())[0],
      pairingId: this.pendingPairingId(),
    };
  }

  /** True for a slot that would receive whoever is currently held. */
  protected isTarget(playerId: string): boolean {
    const held = this.selection.selection();
    return held !== null && held.playerId !== playerId && this.pendingPairingId() !== null;
  }

  protected readonly court = computed<CourtState>(
    () => this.liveSession.courts()[this.courtNumber() - 1] ?? { status: 'idle' }
  );

  protected readonly ended = computed(() => {
    if (this.liveSession.sessionResource.error()) return false;
    return this.liveSession.sessionResource.value()?.endedAt != null;
  });

  protected teamNames(ids: [string, string]): string[] {
    return resolvePlayerNames(ids, this.players());
  }

  /**
   * A player rested after this proposal was made is still standing in it — the
   * server refuses the confirm, and without this the host only finds out by
   * tapping. Named on screen so the fix (swap that name, or reshuffle) is
   * obvious. Active matches are untouched: those players are on court.
   */
  protected readonly restingInProposal = computed<string[]>(() => {
    const c = this.court();
    if (c.status !== 'pending') return [];
    const resting = new Set(this.liveSession.sessionResource.value()?.restingPlayerIds ?? []);
    const inProposal = [...c.teamA, ...c.teamB].filter((id) => resting.has(id));
    return resolvePlayerNames(inProposal, this.players());
  });

  /**
   * In TS rather than an `i18n-aria-label` attribute: the label interpolates a
   * player name, so it has to be a binding, and Angular only extracts static
   * attributes.
   */
  protected swapLabel(name: string): string {
    return $localize`:@@court.swapOut:เปลี่ยน ${name}:name: ออก`;
  }

  protected async startOrReshuffle(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.proposeMatch(this.courtNumber());
      this.notEnoughPlayers.set(!result.ok && result.reason === 'not-enough-players');
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Tapping a name still means "swap this player out, you choose who for" —
   * the quickest gesture stays on the quickest control. Choosing the
   * replacement is a deliberate second action: pick someone up first, then
   * tap or drop them onto the player they replace.
   */
  protected async swap(pairingId: string, playerId: string): Promise<void> {
    const held = this.selection.selection();
    if (held !== null) {
      if (held.playerId === playerId) {
        this.selection.clear();
        return;
      }
      await this.applyManualSwap(pairingId, playerId, held);
      return;
    }
    await this.runSwap(pairingId, playerId);
  }

  /**
   * Puts a player down onto the slot `playerId` occupies. The request always
   * names the court being dropped on; when the held player came from another
   * court the server trades the two, so the far court does not need a second
   * call that could half-apply.
   */
  private async applyManualSwap(
    pairingId: string,
    playerId: string,
    held: SwapPick
  ): Promise<void> {
    this.selection.clear();
    await this.runSwap(pairingId, playerId, held.playerId);
  }

  private async runSwap(
    pairingId: string,
    playerId: string,
    withPlayerId?: string
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.swapPlayer(pairingId, playerId, withPlayerId);
      this.noSubstitute.set(!result.ok && result.reason === 'no-substitute');
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /** Picks a player up, or puts them back if they were already held. */
  protected pickUp(playerId: string): void {
    this.selection.toggle(this.pickFor(playerId));
  }

  protected pickLabel(name: string): string {
    return $localize`:@@court.pickUp:เลือก ${name}:name: เพื่อสลับตำแหน่ง`;
  }

  protected async dropOn(playerId: string, event: CdkDragDrop<string>): Promise<void> {
    const held = event.item.data as SwapPick | undefined;
    const pairingId = this.pendingPairingId();
    if (!held || pairingId === null || held.playerId === playerId) {
      this.selection.clear();
      return;
    }
    await this.applyManualSwap(pairingId, playerId, held);
  }

  /**
   * Reverses this court's last step — a mis-tapped winner, or a confirm the
   * host did not mean. Offered on every state because the mistake is only
   * noticed after the court has already moved on.
   */
  protected async undo(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.undoCourt(this.courtNumber());
      if (!result.ok && result.reason === 'players-busy') {
        this.actionError.set(
          $localize`:@@court.undoBusy:ผู้เล่นลงคอร์ทอื่นแล้ว ย้อนกลับไม่ได้`
        );
        return;
      }
      if (!result.ok && result.reason === 'nothing-to-undo') {
        this.actionError.set($localize`:@@court.nothingToUndo:ไม่มีอะไรให้ย้อนกลับ`);
        return;
      }
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirm(): Promise<void> {
    const c = this.court();
    if (c.status !== 'pending' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.confirmMatch(c.pairingId);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }

  /** `winner: null` frees the court for a match abandoned without a result. */
  protected async finish(winner: 'A' | 'B' | null): Promise<void> {
    const c = this.court();
    if (c.status !== 'active' || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const scores = winner === null ? [null, null] : [this.scoreA(), this.scoreB()];
      const result = await this.liveSession.finishMatch(c.pairingId, scores[0], scores[1], winner);
      this.actionError.set(result.error ?? null);
      if (!result.ok) return;
      this.scoreA.set(null);
      this.scoreB.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}
