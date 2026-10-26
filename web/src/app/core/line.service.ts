import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { LatestRoster, LineLinkCode, LineStatus } from './line.model';

/** Owner-only routes for linking a group to its LINE group and reading the roster the bot kept. */
@Injectable({ providedIn: 'root' })
export class LineService {
  private readonly http = inject(HttpClient);

  private base(groupCode: string): string {
    return `${environment.apiBaseUrl}/groups/${encodeURIComponent(groupCode)}/line`;
  }

  status(groupCode: string): Observable<LineStatus> {
    return this.http.get<LineStatus>(this.base(groupCode));
  }

  createCode(groupCode: string): Observable<LineLinkCode> {
    return this.http.post<LineLinkCode>(`${this.base(groupCode)}/code`, {});
  }

  unlink(groupCode: string): Observable<{ unlinked: true }> {
    return this.http.delete<{ unlinked: true }>(this.base(groupCode));
  }

  /** `{ roster: null }` when the group is unlinked, nothing was captured, or the plan is not paid. */
  latestRoster(groupCode: string): Observable<{ roster: LatestRoster | null }> {
    return this.http.get<{ roster: LatestRoster | null }>(`${this.base(groupCode)}/latest-roster`);
  }
}
