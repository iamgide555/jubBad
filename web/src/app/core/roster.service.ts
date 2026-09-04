import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import type { Player, RosterNameMatch } from '../../../../engines/fuzzy-match.ts';
import type { Group } from './group.model';
import type { NameReview } from './roster-review';

export interface CreateSessionRequest {
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  rawImportText: string;
  rosterReviews: NameReview[];
  waitlistReviews: NameReview[];
}

export interface ParseRosterResponse {
  header: { isoDate: string | null; venue: string | null; courtCount: number | null };
  rosterReviews: RosterNameMatch[];
  waitlistReviews: RosterNameMatch[];
  warnings: string[];
  unrecognizedLines: string[];
}

@Injectable({ providedIn: 'root' })
export class RosterService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  getGroup(code: string) {
    return this.http.get<Group>(`${this.base}/groups/${code}`);
  }

  renameGroup(code: string, name: string) {
    return this.http.put<{ code: string; name: string | null }>(
      `${this.base}/groups/${code}`,
      { name }
    );
  }

  getPlayers(groupCode: string) {
    return this.http.get<Player[]>(`${this.base}/groups/${groupCode}/players`);
  }

  createSession(dto: CreateSessionRequest) {
    return this.http.post<{ code: string }>(`${this.base}/sessions`, dto);
  }

  parseRoster(code: string, groupName: string, rawText: string) {
    return this.http.post<ParseRosterResponse>(`${this.base}/groups/${code}/parse`, {
      groupName,
      rawText,
    });
  }
}
