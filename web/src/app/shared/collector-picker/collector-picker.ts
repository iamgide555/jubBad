import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LineAccountsService, type LineAccountRow } from '../../core/line-accounts.service';
import { LineAvatar } from '../line-avatar/line-avatar';

interface Option {
  playerId: string;
  playerName: string;
  lineName: string;
  pictureUrl: string | null;
}

/**
 * Who may manage payments in LINE for a receiving account: one of the group's players that has a LINE account
 * linked, or nobody. Every pick asks first (a misplaced tap hands someone the money side of the bill) and only
 * `chosen` after the host agrees; this component never saves anything itself. A `value` whose LINE has been
 * unlinked since is shown as nobody with a note, the way the server already treats that bill.
 */
@Component({
  selector: 'app-collector-picker',
  imports: [LineAvatar],
  templateUrl: './collector-picker.html',
  styleUrl: './collector-picker.css',
})
export class CollectorPicker {
  readonly groupCode = input.required<string>();
  /** The current collector's player id, or null for nobody. */
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
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
  /** Set, but not among the linked players any more. */
  protected readonly stale = computed(() => {
    const v = this.value();
    return this.loaded() && v !== null && !this.options().some((o) => o.playerId === v);
  });
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
    if ((option?.playerId ?? null) === this.value()) return;
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
