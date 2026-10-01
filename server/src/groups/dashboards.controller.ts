import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { GroupDashboardService } from './group-dashboard.service.js';

@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboard: GroupDashboardService) {}

  /**
   * Public: the page a host pins in LINE. The unguessable share token is the
   * credential (same trust model as the session summary link); revoking it
   * 404s this at once. Read-only and participation-only by construction — see
   * dashboard-standings.ts.
   */
  @Public()
  @Get(':token')
  get(@Param('token') token: string) {
    return this.dashboard.get(token);
  }
}
