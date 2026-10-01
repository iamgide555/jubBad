import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';

/**
 * Corrects which shuttles a finished game used. HTTP-free like the other
 * sheets: it only emits the set the host settled on; the summary page makes
 * the write, so a stale or refused correction never looks saved. Retired
 * shuttles stay pickable — a game really may have used one that was retired
 * afterwards — and "none" is a legitimate, recorded answer, distinct from
 * the unknown a legacy game carries.
 */
@Component({
  selector: 'app-shuttle-correction-dialog',
  imports: [],
  templateUrl: './shuttle-correction-dialog.html',
  styleUrl: './shuttle-correction-dialog.css',
})
export class ShuttleCorrectionDialog {
  /** Every unvoided shuttle in the session; `usable: false` is retired. */
  readonly shuttles = input<readonly { id: string; number: number; usable: boolean }[]>([]);
  /** The game's current set (empty for none or unknown). */
  readonly initialIds = input<readonly string[]>([]);
  /** e.g. "คอร์ท 2 · แมตช์ 3" — which game is being corrected. */
  readonly rowLabel = input('');
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly save = output<{ shuttleIds: string[]; openNew: boolean }>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  /** null until the host touches it, so the initial set can arrive after open(). */
  private readonly userPicked = signal<ReadonlySet<string> | null>(null);
  protected readonly openNewShuttle = signal(false);

  protected readonly picked = computed<ReadonlySet<string>>(() => this.userPicked() ?? new Set(this.initialIds()));
  protected readonly ordered = computed(() => [...this.shuttles()].sort((a, b) => a.number - b.number));
  protected readonly noneSelected = computed(() => this.picked().size === 0 && !this.openNewShuttle());

  open(): void {
    this.userPicked.set(null);
    this.openNewShuttle.set(false);
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

  protected toggle(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.userPicked.set(next);
  }

  protected submit(): void {
    if (this.saving()) return;
    const order = new Map(this.shuttles().map((s) => [s.id, s.number]));
    const shuttleIds = [...this.picked()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    this.save.emit({ shuttleIds, openNew: this.openNewShuttle() });
  }
}
