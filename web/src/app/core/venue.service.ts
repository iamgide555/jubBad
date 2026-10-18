import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';

export interface VenueOption {
  id: string;
  displayName: string;
}

/** `exact` is a venue whose normalized name equals the typed text; the rest are only similar. */
export interface VenueSearchResult {
  exact: VenueOption | null;
  suggestions: VenueOption[];
}

@Injectable({ providedIn: 'root' })
export class VenueService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  search(q: string) {
    return this.http.get<VenueSearchResult>(`${this.base}/venues/search`, {
      params: new HttpParams().set('q', q),
    });
  }
}
