import { Component, ElementRef, effect, input, output, signal, viewChild } from '@angular/core';
import { PaymentPanel } from '../payment-panel/payment-panel';
import type { BillResponse } from '../../core/bill.model';

/**
 * The payment card's shared bottom sheet, opened from the bill page, summary banner, or right after จบรอบ.
 * The parent owns `open` and flips it off on `closed`. The panel normally mounts only while open, but stays
 * alive through a pending method update so closing cannot lose its response and leave the bill stale.
 * An idle closed sheet costs no request. Closing sends nothing.
 */
@Component({
  selector: 'app-payment-sheet',
  imports: [PaymentPanel],
  templateUrl: './payment-sheet.html',
  styleUrl: './payment-sheet.css',
})
export class PaymentSheet {
  readonly open = input.required<boolean>();
  readonly sessionCode = input.required<string>();
  readonly refreshKey = input<unknown>(null);
  readonly onBillPage = input(false);
  readonly settingsRequested = output<void>();
  readonly billChanged = output<BillResponse>();
  readonly billRefreshRequested = output<void>();
  readonly pendingChanged = output<boolean>();
  protected readonly methodPending = signal(false);

  protected setMethodPending(pending: boolean): void {
    this.methodPending.set(pending);
    this.pendingChanged.emit(pending);
  }
  /** The host closed the sheet: the header's close button, Escape, the backdrop, or the panel's link out to the bill. */
  readonly closed = output<void>();
  /** The card went into the LINE group. */
  readonly sent = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const open = this.open();
      const dialog = this.dialogEl()?.nativeElement;
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    });
  }

  /** A browser-initiated close (Escape) syncs back to the parent. */
  protected onDialogClose(): void {
    if (this.open()) this.closed.emit();
  }

  /**
   * A tap on the dimmed backdrop closes the sheet. The dialog has no padding and its card fills it, so a click
   * whose target is the dialog element itself can only have landed on the backdrop.
   */
  protected onDialogClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && this.open()) this.closed.emit();
  }
}
