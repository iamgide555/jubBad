import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LineAccountsService, type LineAccountRow } from '../../core/line-accounts.service';
import { LineAvatar } from '../line-avatar/line-avatar';

interface Option {
  playerId: string;
  playerName: string;
  lineName: string;
  pictureUrl: string | null;
}

let pickerCount = 0;

/**
 * Who may manage payments in LINE for a receiving account: one of the group's players that has a LINE account
 * linked, or nobody. Every pick asks first (a misplaced tap hands someone the money side of the bill) and only
 * `chosen` after the host agrees; this component never saves anything itself. A `value` whose LINE has been
 * unlinked since, or a pick the server reports `lapsed` (its pinned LINE account is no longer the player's link),
 * is shown as nobody with a note, the way the server already treats that bill, and "nobody" stays on offer to
 * clear it even when no linked player is left. While `disabled` the options are `aria-disabled` (a guard refuses
 * the tap) rather than `disabled`, so focus never drops out to the page.
 */
@Component({
  selector: 'app-collector-picker',
  imports: [LineAvatar],
  templateUrl: './collector-picker.html',
  styleUrl: './collector-picker.css',
  host: { '[hidden]': 'unused()' },
})
export class CollectorPicker {
  readonly groupCode = input.required<string>();
  /** The current collector's player id, or null for nobody. */
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  /** The server says the saved pick no longer holds (its LINE account was unlinked or replaced); `value` is then null. */
  readonly lapsed = input(false);
  /** Render nothing while there is nobody to pick and nothing to clear (a card for a group that never uses this). */
  readonly optional = input(false);
  /** The player id (null for nobody) the host agreed to. */
  readonly chosen = output<string | null>();

  private readonly accounts = inject(LineAccountsService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private seq = 0;

  protected readonly loaded = signal(false);
  protected readonly loadFailed = signal(false);
  private readonly rows = signal<LineAccountRow[]>([]);
  /** The option waiting for a yes in the dialog. */
  protected readonly pending = signal<Option | 'none' | null>(null);

  protected readonly options = computed<Option[]>(() =>
    this.rows()
      .filter((r) => r.player !== null)
      .map((r) => ({
        playerId: r.player!.id,
        playerName: r.player!.name,
        lineName: r.displayName ?? $localize`:@@lineAccountPicker.unknownName:ไม่ทราบชื่อ`,
        pictureUrl: r.pictureUrl,
      }))
  );
  /** Set, but not among the linked players any more, or reported lapsed by the server. */
  protected readonly stale = computed(() => {
    const v = this.value();
    return this.loaded() && (this.lapsed() || (v !== null && !this.options().some((o) => o.playerId === v)));
  });
  /** "Nobody" is on offer whenever there is someone to pick or a pick to clear. */
  protected readonly offerNobody = computed(() => this.options().length > 0 || this.value() !== null || this.lapsed());
  /** `optional` and nothing to show: no linked player (or still loading), and nothing set to clear. */
  protected readonly unused = computed(
    () =>
      this.optional() &&
      !this.loadFailed() &&
      this.value() === null &&
      !this.lapsed() &&
      (!this.loaded() || this.options().length === 0)
  );
  protected readonly textId = `collector-picker-${++pickerCount}-text`;
  protected readonly pendingOption = computed(() => {
    const p = this.pending();
    return p === 'none' ? null : p;
  });

  constructor() {
    effect(() => {
      this.groupCode();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const seq = ++this.seq;
    this.loadFailed.set(false);
    try {
      const rows = await new Promise<LineAccountRow[]>((resolve, reject) =>
        this.accounts.list(this.groupCode()).subscribe({ next: resolve, error: reject })
      );
      if (seq !== this.seq) return;
      this.rows.set(rows);
      this.loaded.set(true);
    } catch {
      if (seq === this.seq) this.loadFailed.set(true);
    }
  }

  protected ask(option: Option | null): void {
    if (this.disabled()) return;
    // Nobody is already the value, except a stale pick, which "nobody" clears for good.
    if ((option?.playerId ?? null) === this.value() && !(option === null && this.stale())) return;
    this.pending.set(option ?? 'none');
    this.dialog()?.nativeElement.showModal();
  }

  protected cancel(): void {
    this.dialog()?.nativeElement.close();
  }

  protected confirm(): void {
    const p = this.pending();
    this.dialog()?.nativeElement.close();
    if (p === null) return;
    this.chosen.emit(p === 'none' ? null : p.playerId);
  }
}
