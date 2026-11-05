import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, throwError, type Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { SlipHostPanel, SlipResolveBody } from './slip-host.model';
import type { SlipReviewApi } from './slip-review-api';

type Ok = { ok: true };

/** One row of the bill the collector manages, as the manage read gives it. */
export interface CollectorManageRow {
  playerId: string;
  name: string;
  amountSatang: number;
  absent: boolean;
}

/** The manage read in full: the page's rows and header, and everything `SlipReview` shows. */
export interface CollectorManageView extends SlipHostPanel {
  groupName: string;
  date: string | null;
  accountName: string;
  rows: CollectorManageRow[];
}

/**
 * The bill's collector reaches the payment panel from the LINE page, with no JubBad login. Every call carries the
 * card token in the query and the viewer's LINE access token in a header; the server answers anything but the
 * collector with a bare 404. Provided by the page that uses it, not by root, because it holds those two tokens.
 * Neither is ever logged here. Linking accounts and rewriting the saved name stay the host's, so those two refuse.
 */
@Injectable()
export class CollectorSlipService implements SlipReviewApi {
  private readonly http = inject(HttpClient);
  private token = '';
  private accessToken = '';

  configure(token: string, accessToken: string): void {
    this.token = token;
    this.accessToken = accessToken;
  }

  private url(code: string, path = ''): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(code)}/slip-pay/manage${path}?token=${encodeURIComponent(this.token)}`;
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({ 'X-Line-Access-Token': this.accessToken });
  }

  private post(code: string, path: string, body: object): Observable<Ok> {
    return this.http.post<Ok>(this.url(code, path), body, { headers: this.headers() });
  }

  private waiting(id: string, action: string): string {
    return `/waiting/${encodeURIComponent(id)}/${action}`;
  }

  manage(code: string): Observable<CollectorManageView> {
    return this.http.get<CollectorManageView>(this.url(code), { headers: this.headers() });
  }

  /** The panel part of the manage read. The server already sends no linked accounts; the empty list is kept here too. */
  panel(code: string): Observable<SlipHostPanel> {
    return this.manage(code).pipe(
      map((m) => ({ collection: m.collection, paid: m.paid, waiting: m.waiting, duplicates: m.duplicates, links: [] })),
    );
  }

  /** `<img src>` cannot send the LINE header, so the image is fetched with it and shown as a blob URL (revoked by the review). */
  image(code: string, id: string): Observable<string> {
    return this.http
      .get(this.url(code, `/images/${encodeURIComponent(id)}`), { headers: this.headers(), responseType: 'blob' })
      .pipe(map((blob) => URL.createObjectURL(blob)));
  }

  closeCollection(code: string): Observable<Ok> {
    return this.post(code, '/close', { confirmDeleteImages: true });
  }

  tick(code: string, playerId: string): Observable<Ok> {
    return this.post(code, '/tick', { playerId });
  }

  untick(code: string, playerId: string): Observable<Ok> {
    return this.post(code, '/untick', { playerId });
  }

  resolve(code: string, id: string, body: SlipResolveBody): Observable<Ok> {
    return this.post(code, this.waiting(id, 'resolve'), body);
  }

  dismiss(code: string, id: string): Observable<Ok> {
    return this.post(code, this.waiting(id, 'dismiss'), {});
  }

  restore(code: string, id: string): Observable<Ok> {
    return this.post(code, this.waiting(id, 'restore'), {});
  }

  dismissDuplicate(code: string, id: string): Observable<Ok> {
    return this.post(code, `/duplicates/${encodeURIComponent(id)}/dismiss`, {});
  }

  /** The collector's page never offers this; the server has no route for it. */
  updateName(_code: string, _id: string): Observable<Ok> {
    return throwError(() => new Error('Not available to the collector'));
  }

  /** The collector's page never offers this; the server has no route for it. */
  setLink(_code: string, _playerId: string, _lineUserId: string | null): Observable<Ok> {
    return throwError(() => new Error('Not available to the collector'));
  }
}
