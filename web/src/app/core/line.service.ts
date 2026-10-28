import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { LatestRoster, LineHostStatus, LineLinkCode, LineShareCard, LineStatus, LineSummaryOutcome, LineSummaryState } from './line.model';

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

  private hostBase(groupCode: string): string {
    return `${this.base(groupCode)}/host`;
  }

  /** This group's side of the host's own LINE link (their chat with the bot). */
  hostStatus(groupCode: string): Observable<LineHostStatus> {
    return this.http.get<LineHostStatus>(this.hostBase(groupCode));
  }

  /** Host plan only: 403 on a free plan, 409 when the account is already linked, 503 when the bot is not set up. */
  hostCreateCode(groupCode: string): Observable<LineLinkCode> {
    return this.http.post<LineLinkCode>(`${this.hostBase(groupCode)}/code`, {});
  }

  /** Switch DM capture on or off for this group. On: host plan and a linked account (403 / 409). Off: always allowed. */
  hostSetEnabled(groupCode: string, enabled: boolean): Observable<{ enabled: boolean }> {
    return this.http.put<{ enabled: boolean }>(this.hostBase(groupCode), { enabled });
  }

  /** Unlinks the owner's whole LINE account, for every group. Always allowed, on any plan. */
  hostUnlink(groupCode: string): Observable<{ unlinked: true }> {
    return this.http.delete<{ unlinked: true }>(this.hostBase(groupCode));
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

  /** Public: the card the LIFF page hands to LINE's share picker. 404 when it is not available. */
  shareCard(sessionCode: string): Observable<LineShareCard> {
    return this.http.get<LineShareCard>(
      `${environment.apiBaseUrl}/sessions/${encodeURIComponent(sessionCode)}/line-share-card`,
    );
  }
}
