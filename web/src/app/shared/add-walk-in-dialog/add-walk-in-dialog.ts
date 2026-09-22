import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { exactPlayerMatch, searchCandidates } from '../../core/roster-review';
import type { Player } from '../../../../../engines/fuzzy-match.ts';

/**
 * Search-or-create sheet for adding a walk-in to a running session. Follows
 * ShuttleDetailsDialog's shape: HTTP-free, only emits a choice — the
 * dashboard makes the actual POST and reports back via `saving`/`error`, the
 * same division of responsibility that keeps this component testable
 * without a mocked backend.
 */
@Component({
  selector: 'app-add-walk-in-dialog',
  imports: [FormsModule],
  templateUrl: './add-walk-in-dialog.html',
  styleUrl: './add-walk-in-dialog.css',
})
export class AddWalkInDialog {
  readonly players = input<Player[]>([]);
  readonly excludedIds = input<ReadonlySet<string>>(new Set());
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly add = output<{ playerId: string } | { name: string }>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  protected readonly query = signal('');

  protected readonly results = computed(() =>
    searchCandidates(this.query(), this.players(), this.excludedIds())
  );

  /** A literal exact match against a player already excluded (on tonight's
   *  roster, resting or active) — distinct from "no match at all". The host's
   *  most likely reason to type an existing player's exact name is to bring a
   *  resting one back, not to create a duplicate. */
  protected readonly excludedExactMatch = computed(() => {
    const match = exactPlayerMatch(this.query(), this.players());
    return match && this.excludedIds().has(match.id) ? match : null;
  });

  /** Only offered when nothing in `results()` is an exact, case-folded match
   *  — a fuzzy or partial hit is a suggestion, not a reason to hide "add as
   *  new" the way `roster-review.ts`'s manual-add field already treats it. */
  protected readonly showAddNew = computed(() => {
    const trimmed = this.query().trim();
    if (!trimmed) return false;
    if (this.excludedExactMatch()) return false;
    return !this.results().some((r) => r.rank === 'exact');
  });

  open(): void {
    this.query.set('');
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  close(): void {
    this.isOpen.set(false);
    this.dialogEl().nativeElement.close();
  }

  protected onDialogClose(): void {
    this.isOpen.set(false);
  }

  protected onCancelAttempt(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  protected onQueryInput(text: string): void {
    this.query.set(text);
  }

  protected pick(playerId: string): void {
    this.add.emit({ playerId });
  }

  protected addNew(): void {
    const name = this.query().trim();
    if (!name) return;
    this.add.emit({ name });
  }
}
