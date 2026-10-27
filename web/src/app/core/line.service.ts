import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { LatestRoster, LineHostStatus, LineLinkCode, LineStatus, LineSummaryOutcome, LineSummaryState } from './line.model';

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

  /** Owner-only. Paid and linked groups only; the server answers 403 / 409 otherwise. */
  setSummaryDefault(groupCode: string, on: boolean): Observable<{ summaryDefault: boolean }> {
    return this.http.patch<{ summaryDefault: boolean }>(this.base(groupCode), { summaryDefault: on });
  }

  private readonly hostBase = `${environment.apiBaseUrl}/line/host`;

  /** The signed-in host's own LINE link (their chat with the bot), whichever group page asks. */
  hostStatus(): Observable<LineHostStatus> {
    return this.http.get<LineHostStatus>(this.hostBase);
  }

  /** Host plan only: 403 on a free plan, 409 when already linked, 503 when the bot is not set up. */
  hostCreateCode(): Observable<LineLinkCode> {
    return this.http.post<LineLinkCode>(`${this.hostBase}/code`, {});
  }

  /** Always allowed, on any plan. */
  hostUnlink(): Observable<{ unlinked: true }> {
    return this.http.delete<{ unlinked: true }>(this.hostBase);
  }

  private summaryUrl(sessionCode: string): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(sessionCode)}/line-summary`;
  }

  /** Whether the summary card can go out for this session, and whether it already has. Owner-only. */
  summaryState(sessionCode: string): Observable<LineSummaryState> {
    return this.http.get<LineSummaryState>(this.summaryUrl(sessionCode));
  }

  /** Always 200 with an outcome, so the page can say what happened. */
  sendSummary(sessionCode: string): Observable<{ outcome: LineSummaryOutcome }> {
    return this.http.post<{ outcome: LineSummaryOutcome }>(this.summaryUrl(sessionCode), {});
  }
}
