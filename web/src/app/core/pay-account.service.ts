import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** The group's default account for the payment card. Bank is the display name as plain text. */
export interface PayAccount {
  bank: string;
  number: string;
  name: string;
}

/** Owner-only, any plan: a lapsed host can still read and clear it. */
@Injectable({ providedIn: 'root' })
export class PayAccountService {
  private readonly http = inject(HttpClient);

  private url(groupCode: string): string {
    return `${environment.apiBaseUrl}/groups/${encodeURIComponent(groupCode)}/pay-account`;
  }

  /** Null when no account is saved. */
  get(groupCode: string): Observable<PayAccount | null> {
    return this.http.get<{ account: PayAccount | null }>(this.url(groupCode)).pipe(map((r) => r.account));
  }

  /** The account and who may manage its payments in LINE (a player id), both null when unset. */
  getWithCollector(groupCode: string): Observable<{ account: PayAccount | null; collectorPlayerId: string | null }> {
    return this.http
      .get<{ account: PayAccount | null; collectorPlayerId?: string | null }>(this.url(groupCode))
      .pipe(map((r) => ({ account: r.account, collectorPlayerId: r.collectorPlayerId ?? null })));
  }

  /**
   * Sets who manages the payments in LINE; null clears it. A 409 `COLLECTOR_INVALID` is a player who is not in the
   * group or has no LINE linked, `PAY_ACCOUNT_REQUIRED` a group with no saved account.
   */
  setCollector(groupCode: string, playerId: string | null): Observable<string | null> {
    return this.http
      .put<{ collectorPlayerId: string | null }>(`${environment.apiBaseUrl}/groups/${encodeURIComponent(groupCode)}/pay-collector`, { playerId })
      .pipe(map((r) => r.collectorPlayerId));
  }

  /** Null clears it (the server reads three blank fields as "no account"). A partial account is a 400. */
  set(groupCode: string, account: PayAccount | null): Observable<PayAccount | null> {
    const body = account ?? { bank: '', number: '', name: '' };
    return this.http.put<{ account: PayAccount | null }>(this.url(groupCode), body).pipe(map((r) => r.account));
  }
}
