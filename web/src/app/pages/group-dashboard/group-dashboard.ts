import { Component, computed, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import type { Dashboard, DashboardSession } from '../../core/dashboard.model';

/**
 * The page a host pins in LINE: past sessions (each links to the existing,
 * already-public summary) and participation-only standings. Public and
 * keyed by an unguessable token. Deliberately has no link to a player card or
 * to the host's screens — see docs/overview.md, "Group dashboard".
 */
@Component({
  selector: 'app-group-dashboard',
  imports: [RouterLink],
  templateUrl: './group-dashboard.html',
  styleUrl: './group-dashboard.css',
})
export class GroupDashboard {
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token') ?? '';

  private readonly resource = httpResource<Dashboard>(
    () => `${environment.apiBaseUrl}/dashboards/${encodeURIComponent(this.token)}`
  );

  protected readonly dashboard = computed<Dashboard | undefined>(() =>
    this.resource.error() ? undefined : this.resource.value()
  );
  protected readonly notFound = computed(() => this.resource.error() !== undefined);

  /** `date` is free text from the roster header and may be absent; the created day is the honest fallback. */
  protected dateLabel(s: DashboardSession): string {
    return s.date ?? s.createdAt.slice(0, 10);
  }
}
