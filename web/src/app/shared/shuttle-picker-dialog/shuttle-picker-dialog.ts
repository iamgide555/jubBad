import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import type { ShuttleChoice, ShuttleRef } from '../../core/shuttle.model';

/**
 * Picks the shuttle for a game: on confirm (reuse the court's last, open new,
 * or take another idle one) and on a live switch (same choices, optionally
 * retiring the one put down). HTTP-free like AddRuleDialog — it only emits the
 * choice; the court panel makes the write and reports back through
 * `saving`/`error`, so a stale or refused choice never looks saved.
 */
@Component({
  selector: 'app-shuttle-picker-dialog',
  imports: [],
  templateUrl: './shuttle-picker-dialog.html',
  styleUrl: './shuttle-picker-dialog.css',
})
export class ShuttlePickerDialog {
  readonly mode = input<'confirm' | 'switch'>('confirm');
  readonly courtLabel = input('');
  /** Confirm: the court's reusable last shuttle. Switch: the one currently in hand (shown, not offered). */
  readonly lastShuttle = input<ShuttleRef | null>(null);
  /** Other usable, idle shuttles the host can take. */
  readonly options = input<readonly ShuttleRef[]>([]);
  /** Switch mode: start with "put the old one away for good" ticked. */
  readonly retireByDefault = input(false);
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly choose = output<{ choice: ShuttleChoice; retirePrevious: boolean }>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  /** What the host has explicitly chosen; null until they touch the dialog. */
  private readonly userKind = signal<'last' | 'new' | 'pick' | null>(null);
  protected readonly pickedChip = signal<string | null>(null);
  private readonly userRetire = signal<boolean | null>(null);

  protected readonly canReuseLast = computed(() => this.mode() === 'confirm' && this.lastShuttle() !== null);

  /**
   * Defaults are derived, not copied at open(): the court panel sets this
   * dialog's inputs and opens it in the same tick, before the inputs have
   * propagated, so anything computed once at open() would read stale values.
   */
  protected readonly picked = computed<'last' | 'new' | 'pick'>(
    () => this.userKind() ?? (this.canReuseLast() ? 'last' : 'new')
  );
  protected readonly retire = computed(
    () => this.userRetire() ?? (this.mode() === 'switch' && this.retireByDefault())
  );

  open(): void {
    this.userKind.set(null);
    this.pickedChip.set(null);
    this.userRetire.set(null);
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

  protected setKind(kind: 'last' | 'new'): void {
    this.userKind.set(kind);
    this.pickedChip.set(null);
  }

  protected pickChip(id: string): void {
    this.pickedChip.set(id);
    this.userKind.set('pick');
  }

  protected setRetire(value: boolean): void {
    this.userRetire.set(value);
  }

  protected readonly canSubmit = computed(
    () => !this.saving() && (this.picked() !== 'pick' || this.pickedChip() !== null)
  );

  protected submit(): void {
    if (!this.canSubmit()) return;
    const kind = this.picked();
    let choice: ShuttleChoice;
    if (kind === 'last') choice = { kind: 'existing', shuttleId: this.lastShuttle()!.id };
    else if (kind === 'pick') choice = { kind: 'existing', shuttleId: this.pickedChip()! };
    else choice = { kind: 'new' };
    this.choose.emit({ choice, retirePrevious: this.mode() === 'switch' && this.retire() });
  }
}
