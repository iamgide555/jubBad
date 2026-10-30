import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { SlipHostPanel, SlipResolveBody } from './slip-host.model';

type Ok = { ok: true };

/** Owner-only routes behind the bill screen's paid status and waiting-slip review (cookie auth like the other host routes). */
@Injectable({ providedIn: 'root' })
export class SlipHostService {
  private readonly http = inject(HttpClient);

  private url(sessionCode: string, path = ''): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(sessionCode)}/payments${path}`;
  }

  private waitingUrl(sessionCode: string, id: string, action: string): string {
    return this.url(sessionCode, `/waiting/${encodeURIComponent(id)}/${action}`);
  }

  panel(sessionCode: string): Observable<SlipHostPanel> {
    return this.http.get<SlipHostPanel>(this.url(sessionCode));
  }

  tick(sessionCode: string, playerId: string): Observable<Ok> {
    return this.http.post<Ok>(this.url(sessionCode, '/tick'), { playerId });
  }

  untick(sessionCode: string, playerId: string): Observable<Ok> {
    return this.http.post<Ok>(this.url(sessionCode, '/untick'), { playerId });
  }

  /** Marks every `coversPlayerIds` person paid and, when `senderPlayerId` is set, links the slip's account to that player. */
  resolve(sessionCode: string, id: string, body: SlipResolveBody): Observable<Ok> {
    return this.http.post<Ok>(this.waitingUrl(sessionCode, id, 'resolve'), body);
  }

  dismiss(sessionCode: string, id: string): Observable<Ok> {
    return this.http.post<Ok>(this.waitingUrl(sessionCode, id, 'dismiss'), {});
  }

  /** Makes the receiver name read from the slip the group's saved pay-account name. Marks no one paid. */
  updateName(sessionCode: string, id: string): Observable<Ok> {
    return this.http.post<Ok>(this.waitingUrl(sessionCode, id, 'update-name'), {});
  }

  dismissDuplicate(sessionCode: string, id: string): Observable<Ok> {
    return this.http.post<Ok>(this.url(sessionCode, `/duplicates/${encodeURIComponent(id)}/dismiss`), {});
  }

  /** `lineUserId: null` removes the player's link. */
  setLink(sessionCode: string, playerId: string, lineUserId: string | null): Observable<Ok> {
    return this.http.post<Ok>(this.url(sessionCode, '/links'), { playerId, lineUserId });
  }
}
