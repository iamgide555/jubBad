import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';

/** Mirrors server/src/line/line-accounts.service.ts LineAccountRow. The raw LINE user id never reaches the browser. */
export interface LineAccountRow {
  id: string;
  displayName: string | null;
  pictureUrl: string | null;
  source: 'roster' | 'slip' | 'claim' | 'host';
  firstSeenAt: string;
  lastSeenAt: string;
  player: { id: string; name: string; linkedBy: 'self' | 'host' } | null;
}

/** The host's view of a group's LINE accounts. Owner-only routes; not plan-gated. */
@Injectable({ providedIn: 'root' })
export class LineAccountsService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  /** Every account the group has seen, unlinked first. */
  list(groupCode: string) {
    return this.http.get<LineAccountRow[]>(`${this.base}/groups/${groupCode}/line/accounts`);
  }

  /** Points the player at this account. A 409 `ACCOUNT_ALREADY_LINKED` means another player holds it. */
  link(groupCode: string, accountId: string, playerId: string) {
    return this.http.put<{ ok: true }>(`${this.base}/groups/${groupCode}/line/accounts/${accountId}/player`, { playerId });
  }

  /** Removes the link only; the account stays listed. */
  unlink(groupCode: string, accountId: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/groups/${groupCode}/line/accounts/${accountId}/player`);
  }
}
