import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { PaymentStatusView, SlipPayClaimOutcome, SlipPayConfig, SlipPayUploadResult, SlipPayView } from './slip-pay.model';

/**
 * Public routes behind the player pay page. The pay token (query) says which
 * session's bill the link is for; the viewer's LINE access token (header) is
 * their identity, which the server verifies with LINE. Any refusal is a bare
 * 404 and a throttled caller gets 429. Neither token is ever logged here.
 */
@Injectable({ providedIn: 'root' })
export class SlipPayService {
  private readonly http = inject(HttpClient);

  /** The token is encoded with encodeURIComponent, so it can carry any character and still reach the server whole. */
  private url(code: string, token: string, path = ''): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(code)}/slip-pay${path}?token=${encodeURIComponent(token)}`;
  }

  private headers(accessToken: string): HttpHeaders {
    return new HttpHeaders({ 'X-Line-Access-Token': accessToken });
  }

  /** No LINE header: LIFF has to be initialised with this id before any LINE identity exists. */
  config(code: string, token: string): Observable<SlipPayConfig> {
    return this.http.get<SlipPayConfig>(this.url(code, token, '/config'));
  }

  view(code: string, token: string, accessToken: string): Observable<SlipPayView> {
    return this.http.get<SlipPayView>(this.url(code, token), {
      headers: this.headers(accessToken),
    });
  }

  status(code: string, token: string, accessToken: string): Observable<PaymentStatusView> {
    return this.http.get<PaymentStatusView>(this.url(code, token, '/status'), {
      headers: this.headers(accessToken),
    });
  }

  claim(code: string, token: string, accessToken: string, playerId: string): Observable<{ outcome: SlipPayClaimOutcome }> {
    return this.http.post<{ outcome: SlipPayClaimOutcome }>(
      this.url(code, token, '/claim'),
      { playerId },
      { headers: this.headers(accessToken) },
    );
  }

  /** The image goes up as the raw request body; the browser sets the File's own content type. */
  upload(code: string, token: string, accessToken: string, file: File): Observable<SlipPayUploadResult> {
    return this.http.post<SlipPayUploadResult>(this.url(code, token, '/upload'), file, {
      headers: this.headers(accessToken),
    });
  }
}
