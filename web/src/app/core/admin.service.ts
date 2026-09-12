import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import type { Role } from './auth.service';

export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  ownedGroups: { code: string; name: string | null }[];
}

export interface AdminGroup {
  code: string;
  name: string | null;
  owner: { id: string; email: string } | null;
}

export interface ResetRequest {
  id: string;
  email: string;
  createdAt: string;
  handledAt: string | null;
}

export type GroupDisposition =
  | { action: 'reassign'; toUserId: string }
  | { action: 'delete' }
  | { action: 'unassign' };

/**
 * Every call here hits an /admin/* route. There is no client-side check in
 * front of that — the same convenience-not-boundary split as adminGuard —
 * the server's OwnershipGuard is what actually refuses a non-admin, and it
 * refuses with 404, which every method here surfaces as a plain HTTP error.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  listUsers() {
    return this.http.get<AdminUser[]>(`${this.base}/admin/users`);
  }

  createUser(email: string, password: string, role: Role = 'host') {
    return this.http.post<AdminUser>(`${this.base}/admin/users`, { email, password, role });
  }

  updateUser(id: string, changes: { email?: string; role?: Role }) {
    return this.http.put<AdminUser>(`${this.base}/admin/users/${id}`, changes);
  }

  setDisabled(id: string, disabled: boolean) {
    return this.http.post<AdminUser>(`${this.base}/admin/users/${id}/disabled`, { disabled });
  }

  deleteUser(id: string, groups: Record<string, GroupDisposition>) {
    return this.http.delete<{ deleted: true }>(`${this.base}/admin/users/${id}`, {
      body: { groups },
    });
  }

  resetUserPassword(id: string) {
    return this.http.post<{ token: string }>(`${this.base}/admin/users/${id}/reset`, {});
  }

  listGroups() {
    return this.http.get<AdminGroup[]>(`${this.base}/admin/groups`);
  }

  reassignGroupOwner(code: string, toUserId: string) {
    return this.http.post<AdminGroup>(`${this.base}/admin/groups/${code}/owner`, { toUserId });
  }

  listResetRequests() {
    return this.http.get<ResetRequest[]>(`${this.base}/admin/reset-requests`);
  }

  handleResetRequest(id: string) {
    return this.http.post<{ handled: true }>(`${this.base}/admin/reset-requests/${id}/handle`, {});
  }
}
