import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { PayAccount } from './pay-account.service';
import type { PaymentCardPanel, PaymentSendOutcome } from './payment-card.model';

/** Owner-only reads and actions behind the payment panel. */
@Injectable({ providedIn: 'root' })
export class PaymentCardService {
  private readonly http = inject(HttpClient);

  private url(sessionCode: string, action = ''): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(sessionCode)}/payment-card${action}`;
  }

  panel(sessionCode: string): Observable<PaymentCardPanel> {
    return this.http.get<PaymentCardPanel>(this.url(sessionCode));
  }

  /**
   * Stores tonight's account, freezes the amounts and mints a fresh share link. A partial account is a 400.
   * `expectedHash` is the `contentHash` of the panel the host is looking at: a card that moved since is a 409
   * PAYMENT_CHANGED, so a confirm never freezes amounts the host has not seen.
   */
  confirm(sessionCode: string, account: PayAccount, expectedHash: string): Observable<PaymentCardPanel> {
    return this.http.post<PaymentCardPanel>(this.url(sessionCode, '/confirm'), { ...account, expectedHash });
  }

  /** One `sendId` per attempt: a retry of an attempt with no definite answer reuses it, so LINE drops a repeat. */
  send(sessionCode: string, sendId: string): Observable<PaymentSendOutcome> {
    return this.http.post<{ outcome: PaymentSendOutcome }>(this.url(sessionCode, '/send'), { sendId }).pipe(map((r) => r.outcome));
  }
}

/**
 * An unconfirmed account edit, kept so closing the sheet loses nothing. In memory only, keyed by session code:
 * a reload drops it, and a confirmed account lives on the session instead.
 */
@Injectable({ providedIn: 'root' })
export class PaymentDraftService {
  private readonly drafts = signal<Record<string, PayAccount>>({});

  get(sessionCode: string): PayAccount | null {
    return this.drafts()[sessionCode] ?? null;
  }

  set(sessionCode: string, account: PayAccount): void {
    this.drafts.update((all) => ({ ...all, [sessionCode]: account }));
  }

  clear(sessionCode: string): void {
    this.drafts.update(({ [sessionCode]: _gone, ...rest }) => rest);
  }
}
