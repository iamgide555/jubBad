import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { SlipHostPanel, SlipResolveBody } from './slip-host.model';
import { SlipHostService } from './slip-host.service';

type Ok = { ok: true };

/**
 * What `SlipReview` needs from its data source. The host screens get the cookie-authed `SlipHostService` through
 * `useExisting`; the collector's LINE page provides its own implementation (token-authed), so the review component
 * never knows which side it is on. `image` is an Observable because the collector's images need an authenticated
 * fetch (a blob URL), while the host's is a direct URL.
 */
@Injectable({ providedIn: 'root', useExisting: SlipHostService })
export abstract class SlipReviewApi {
  abstract panel(sessionCode: string): Observable<SlipHostPanel>;
  /** A URL usable in `<img src>`. A `blob:` URL is revoked by the component when it goes away. */
  abstract image(sessionCode: string, id: string): Observable<string>;
  abstract closeCollection(sessionCode: string): Observable<Ok>;
  abstract tick(sessionCode: string, playerId: string): Observable<Ok>;
  abstract untick(sessionCode: string, playerId: string): Observable<Ok>;
  abstract resolve(sessionCode: string, id: string, body: SlipResolveBody): Observable<Ok>;
  abstract dismiss(sessionCode: string, id: string): Observable<Ok>;
  abstract updateName(sessionCode: string, id: string): Observable<Ok>;
  abstract dismissDuplicate(sessionCode: string, id: string): Observable<Ok>;
  abstract setLink(sessionCode: string, playerId: string, lineUserId: string | null): Observable<Ok>;
}
