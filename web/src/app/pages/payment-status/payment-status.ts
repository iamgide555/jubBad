import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { LiffClient } from '../../core/liff-client';
import type { PaymentStatusView } from '../../core/slip-pay.model';
import { SlipPayService } from '../../core/slip-pay.service';

/** Collectors can read bill status without claiming a player or receiving host permissions. */
@Component({
  selector: 'app-payment-status',
  templateUrl: './payment-status.html',
  styleUrl: './payment-status.css',
})
export class PaymentStatus {
  private readonly api = inject(SlipPayService);
  private readonly liff = inject(LiffClient);
  private readonly params = inject(ActivatedRoute).snapshot.paramMap;
  private readonly code = this.params.get('sessionCode') ?? '';
  private readonly token = this.params.get('token') ?? '';
  private liffReady = false;
  private loading = false;

  protected readonly baht = formatBaht;
  protected readonly phase = signal<'loading' | 'login' | 'ready' | 'error' | 'unavailable'>('loading');
  protected readonly view = signal<PaymentStatusView | null>(null);
  protected readonly rows = computed(() => {
    const rows = this.view()?.rows ?? [];
    return [...rows.filter((r) => !r.paid), ...rows.filter((r) => r.paid)];
  });
  protected readonly paidCount = computed(() => this.rows().filter((r) => r.paid).length);
  protected readonly unpaidCount = computed(() => this.rows().length - this.paidCount());

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.phase.set('loading');
    // Hide prior results during refresh: a failed request must not look like current payment state.
    this.view.set(null);
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
      this.view.set(await firstValueFrom(this.api.status(this.code, this.token, accessToken)));
      this.phase.set('ready');
    } catch (error) {
      this.phase.set(error instanceof HttpErrorResponse && error.status === 404 ? 'unavailable' : 'error');
    } finally {
      this.loading = false;
    }
  }
}
