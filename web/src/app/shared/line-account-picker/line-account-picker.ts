import { Component, ElementRef, LOCALE_ID, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { formatPostedAt } from '../../core/line.model';
import type { LineAccountRow } from '../../core/line-accounts.service';
import { LineAvatar } from '../line-avatar/line-avatar';

/**
 * Pick one LINE account to link to a player. HTTP-free, like AddRuleDialog: the caller passes the accounts that are
 * still unlinked, and gets the chosen account's id back. Tapping an account closes the dialog and emits.
 */
@Component({
  selector: 'app-line-account-picker',
  imports: [LineAvatar],
  templateUrl: './line-account-picker.html',
  styleUrl: './line-account-picker.css',
})
export class LineAccountPicker {
  /** Only accounts with no player; the caller filters. */
  readonly accounts = input<readonly LineAccountRow[]>([]);

  readonly picked = output<string>();
  readonly closed = output<void>();

  private readonly locale = inject(LOCALE_ID);
  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly isOpen = signal(false);
  protected readonly query = signal('');
  protected readonly filterLabel = $localize`:@@lineAccountPicker.filterLabel:ค้นหาชื่อ LINE`;

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLocaleLowerCase();
    if (!q) return this.accounts();
    return this.accounts().filter((a) => (a.displayName ?? '').toLocaleLowerCase().includes(q));
  });

  open(): void {
    this.query.set('');
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  close(): void {
    this.dialogEl().nativeElement.close();
  }

  /** Native close (Esc, the close button, a pick, or close()) lands here once, whichever way the dialog went. */
  protected onDialogClose(): void {
    this.isOpen.set(false);
    this.closed.emit();
  }

  protected pick(account: LineAccountRow): void {
    this.close();
    this.picked.emit(account.id);
  }

  protected seen(account: LineAccountRow): string {
    return formatPostedAt(account.lastSeenAt, new Date(), this.locale);
  }
}
