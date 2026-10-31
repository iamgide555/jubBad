import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PaymentCardPanel } from '../../core/payment-card.model';
import { PaymentCardService } from '../../core/payment-card.service';
import { SlipReview } from '../slip-review/slip-review';

@Component({
  selector: 'app-payment-status-sheet',
  imports: [SlipReview],
  templateUrl: './payment-status-sheet.html',
  styleUrl: './payment-status-sheet.css',
})
export class PaymentStatusSheet {
  readonly open = input.required<boolean>();
  readonly sessionCode = input.required<string>();
  readonly closed = output<void>();
  private readonly api = inject(PaymentCardService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly panel = signal<PaymentCardPanel | null>(null);
  protected readonly phase = signal<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  private seq = 0;

  constructor() {
    effect(() => {
      const open = this.open();
      const code = this.sessionCode();
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
      untracked(() => { if (open) void this.load(code); else ++this.seq; });
    });
  }

  protected async load(code = this.sessionCode()): Promise<void> {
    const mine = ++this.seq;
    this.panel.set(null);
    this.phase.set('loading');
    try {
      const panel = await firstValueFrom(this.api.panel(code));
      if (mine !== this.seq) return;
      if (!panel.confirmed || !panel.lastSentAt) { this.phase.set('unavailable'); return; }
      this.panel.set(panel);
      this.phase.set('ready');
    } catch (e) {
      if (mine === this.seq) this.phase.set(e instanceof HttpErrorResponse && (e.status === 403 || e.status === 404) ? 'unavailable' : 'error');
    }
  }

  protected dialogClosed(): void { if (this.open()) this.closed.emit(); }
  protected backdrop(event: MouseEvent): void { if (event.target === event.currentTarget && this.open()) this.closed.emit(); }
}
