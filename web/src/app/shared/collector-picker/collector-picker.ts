import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LineAccountsService, type LineAccountRow } from '../../core/line-accounts.service';
import { LineAvatar } from '../line-avatar/line-avatar';
import { Icon } from '../icon/icon';

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
 * clear it even when no linked player is left. A compact avatar field opens the choices only on demand.
 * While saving, the trigger stays focusable with aria-disabled so focus never drops out to the page.
 */
@Component({
  selector: 'app-collector-picker',
  imports: [LineAvatar, Icon],
  templateUrl: './collector-picker.html',
  styleUrl: './collector-picker.css',
  host: {
    '[hidden]': 'unused()',
    '(document:click)': 'outside($event)',
    '(keydown)': 'onKeydown($event)',
    '(focusout)': 'onFocusout($event)',
  },
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
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly list = viewChild<ElementRef<HTMLUListElement>>('list');
  private seq = 0;

  protected readonly loaded = signal(false);
  protected readonly loadFailed = signal(false);
  private readonly rows = signal<LineAccountRow[]>([]);
  /** The option waiting for a yes in the dialog. */
  protected readonly pending = signal<Option | 'none' | null>(null);
  private readonly open = signal(false);
  protected readonly expanded = computed(() => this.open() && !this.disabled() && !this.unused());
  protected readonly above = signal(false);
  protected readonly menuHeight = signal(320);

  protected readonly options = computed<Option[]>(() =>
    this.rows()
      .filter((r) => r.player !== null)
      .map((r) => ({
        playerId: r.player!.id,
        playerName: r.player!.name,
        lineName: r.displayName ?? $localize`:@@lineAccountPicker.unknownName:ไม่ทราบชื่อ`,
        pictureUrl: r.pictureUrl,
      })),
  );
  /** Set, but not among the linked players any more, or reported lapsed by the server. */
  protected readonly stale = computed(() => {
    const v = this.value();
    return (
      this.loaded() &&
      (this.lapsed() || (v !== null && !this.options().some((o) => o.playerId === v)))
    );
  });
  /** "Nobody" is on offer whenever there is someone to pick or a pick to clear. */
  protected readonly offerNobody = computed(
    () => this.options().length > 0 || this.value() !== null || this.lapsed(),
  );
  /** `optional` and nothing to show: no linked player (or still loading), and nothing set to clear. */
  protected readonly unused = computed(
    () =>
      this.optional() &&
      !this.loadFailed() &&
      this.value() === null &&
      !this.lapsed() &&
      (!this.loaded() || this.options().length === 0),
  );
  protected readonly textId = `collector-picker-${++pickerCount}-text`;
  protected readonly selected = computed(() =>
    this.stale() ? null : (this.options().find((o) => o.playerId === this.value()) ?? null),
  );
  protected readonly pendingOption = computed(() => {
    const p = this.pending();
    return p === 'none' ? null : p;
  });

  constructor() {
    effect(() => {
      this.groupCode();
      untracked(() => {
        this.open.set(false);
        void this.load();
      });
    });
    effect(() => {
      if (this.disabled()) untracked(() => this.closeOptions(this.open()));
    });
  }

  protected async load(): Promise<void> {
    const seq = ++this.seq;
    this.loadFailed.set(false);
    try {
      const rows = await new Promise<LineAccountRow[]>((resolve, reject) =>
        this.accounts.list(this.groupCode()).subscribe({ next: resolve, error: reject }),
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
    this.closeOptions(true);
    // Nobody is already the value, except a stale pick, which "nobody" clears for good.
    if ((option?.playerId ?? null) === this.value() && !(option === null && this.stale())) return;
    this.pending.set(option ?? 'none');
    this.dialog()?.nativeElement.showModal();
  }

  protected cancel(): void {
    this.dialog()?.nativeElement.close();
  }

  protected toggle(): void {
    if (this.disabled()) return;
    if (this.expanded()) this.closeOptions(true);
    else this.showOptions();
  }

  protected outside(event: Event): void {
    if (!this.expanded() || this.element.nativeElement.contains(event.target as Node)) return;
    this.closeOptions();
  }

  protected onFocusout(event: FocusEvent): void {
    if (this.expanded() && !this.element.nativeElement.contains(event.relatedTarget as Node | null))
      this.closeOptions();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.disabled() || this.pending() !== null || event.isComposing) return;
    if (
      event.target !== this.trigger()?.nativeElement &&
      !this.list()?.nativeElement.contains(event.target as Node)
    )
      return;
    if (event.key === 'Escape' && this.expanded()) {
      event.preventDefault();
      event.stopPropagation();
      this.closeOptions(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!this.expanded()) {
      this.showOptions(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : 'selected');
      return;
    }
    const options = this.optionButtons();
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    this.focusOption(options[next]);
  }

  protected dialogClosed(): void {
    this.pending.set(null);
    this.trigger()?.nativeElement.focus();
  }

  private closeOptions(restoreFocus = false): void {
    this.open.set(false);
    if (restoreFocus) this.trigger()?.nativeElement.focus();
  }

  private showOptions(position: 'selected' | 'first' | 'last' = 'selected'): void {
    const rect = this.trigger()?.nativeElement.getBoundingClientRect();
    if (rect) {
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const below = Math.max(0, top + height - rect.bottom);
      const above = Math.max(0, rect.top - top);
      const desired = Math.min(320, height / 2);
      const opensAbove = below < desired && above > below;
      this.above.set(opensAbove);
      this.menuHeight.set(Math.max(0, Math.min(desired, (opensAbove ? above : below) - 8)));
    }
    this.open.set(true);
    // Angular may schedule rendering after the event's microtasks. Focus only once [hidden] has been removed.
    afterNextRender(
      () => {
        if (!this.expanded()) return;
        const options = this.optionButtons();
        const option =
          position === 'first'
            ? options[0]
            : position === 'last'
              ? options.at(-1)
              : (options.find((o) => o.getAttribute('aria-pressed') === 'true') ?? options[0]);
        if (option) this.focusOption(option);
      },
      { injector: this.injector },
    );
  }

  private optionButtons(): HTMLButtonElement[] {
    return [
      ...(this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>(
        '[data-collector-option]',
      ) ?? []),
    ];
  }

  private focusOption(option: HTMLButtonElement): void {
    option.focus({ preventScroll: true });
    option.scrollIntoView?.({ block: 'nearest' });
  }

  protected confirm(): void {
    const p = this.pending();
    this.dialog()?.nativeElement.close();
    if (p === null) return;
    this.chosen.emit(p === 'none' ? null : p.playerId);
  }
}
