import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { CollectorSlipService, type CollectorManageView } from '../../core/collector-slip.service';
import { LiffClient } from '../../core/liff-client';
import type { PaymentStatusView } from '../../core/slip-pay.model';
import { SlipPayService } from '../../core/slip-pay.service';
import { SlipReviewApi } from '../../core/slip-review-api';
import { SlipReview } from '../../shared/slip-review/slip-review';

/**
 * The LINE page behind ดูสถานะการจ่าย. Whoever opens it can read bill status without claiming a player or receiving
 * host permissions; the bill's collector, once LINE has verified them, gets the payment panel to manage it instead.
 */
@Component({
  selector: 'app-payment-status',
  imports: [SlipReview],
  providers: [CollectorSlipService, { provide: SlipReviewApi, useExisting: CollectorSlipService }],
  templateUrl: './payment-status.html',
  styleUrl: './payment-status.css',
})
export class PaymentStatus {
  private readonly api = inject(SlipPayService);
  private readonly liff = inject(LiffClient);
  private readonly collector = inject(CollectorSlipService);
  private readonly params = inject(ActivatedRoute).snapshot.paramMap;
  protected readonly code = this.params.get('sessionCode') ?? '';
  private readonly token = this.params.get('token') ?? '';
  private liffReady = false;
  private loading = false;

  protected readonly baht = formatBaht;
  protected readonly phase = signal<'loading' | 'login' | 'ready' | 'manage' | 'error' | 'unavailable'>('loading');
  protected readonly view = signal<PaymentStatusView | null>(null);
  /** What the collector manages; set instead of `view` when the viewer is the bill's collector. */
  protected readonly manageView = signal<CollectorManageView | null>(null);
  protected readonly sessionDate = computed(() => this.view()?.sessionDate ?? this.manageView()?.date ?? null);
  /** Who still owes at the top, then waiting slips, then the paid in the server's order (earliest payer first). */
  protected readonly rows = computed(() => {
    const rows = this.view()?.rows ?? [];
    return [...rows.filter((r) => !r.paid && !r.pending), ...rows.filter((r) => !r.paid && r.pending), ...rows.filter((r) => r.paid)];
  });
  protected readonly paidCount = computed(() => this.rows().filter((r) => r.paid).length);
  protected readonly unpaidCount = computed(() => this.rows().filter(r => !r.paid && !r.pending).length);

  protected readonly pendingCount = computed(() => this.rows().filter(r => !r.paid && r.pending).length);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.phase.set('loading');
    // Hide prior results during refresh: a failed request must not look like current payment state.
    this.view.set(null);
    this.manageView.set(null);
    try {
      if (!this.code || !this.token) {
        this.phase.set('unavailable');
        return;
      }
      if (!this.liffReady) {
        const { liffId } = await firstValueFrom(this.api.config(this.code, this.token));
        await this.liff.init(liffId);
        this.liffReady = true;
      }
      if (!this.liff.isLoggedIn()) {
        this.phase.set('login');
        this.liff.login(window.location.href);
        return;
      }
      const accessToken = this.liff.getAccessToken();
      if (!accessToken) {
        this.phase.set('error');
        return;
      }
      if (await this.isCollector(accessToken)) {
        this.collector.configure(this.token, accessToken);
        this.manageView.set(await firstValueFrom(this.collector.manage(this.code)));
        this.phase.set('manage');
        return;
      }
      this.view.set(await firstValueFrom(this.api.status(this.code, this.token, accessToken)));
      this.phase.set('ready');
    } catch (error) {
      this.phase.set(error instanceof HttpErrorResponse && error.status === 404 ? 'unavailable' : 'error');
    } finally {
      this.loading = false;
    }
  }

  /**
   * Most failed role reads are not a reason to hide the status: the viewer just gets the read-only list. A 404 or 429
   * is rethrown (load() shows unavailable or the retryable error): the role read runs the same gate as the status
   * read, so the status read would only be refused again, and each refusal counts against the viewer's budget.
   */
  private async isCollector(accessToken: string): Promise<boolean> {
    try {
      return (await firstValueFrom(this.api.role(this.code, this.token, accessToken))).collector;
    } catch (error) {
      if (error instanceof HttpErrorResponse && (error.status === 404 || error.status === 429)) throw error;
      return false;
    }
  }
}
