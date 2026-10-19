import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { GroupPlan } from './plan';

@Injectable({ providedIn: 'root' })
export class PlanService {
  private readonly http = inject(HttpClient);

  /** The group owner's plan (an admin viewing a host's group sees the host's). */
  forGroup(groupCode: string): Observable<GroupPlan> {
    return this.http.get<GroupPlan>(`${environment.apiBaseUrl}/groups/${groupCode}/plan`);
  }
}
