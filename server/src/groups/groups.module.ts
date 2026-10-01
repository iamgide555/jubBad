import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { GroupLevelsService } from './group-levels.service.js';
import { DashboardsController } from './dashboards.controller.js';
import { GroupDashboardService } from './group-dashboard.service.js';
import { GroupShareService } from './group-share.service.js';
import { GroupsService } from './groups.service.js';

@Module({
  controllers: [GroupsController, DashboardsController],
  providers: [GroupsService, GroupLevelsService, GroupShareService, GroupDashboardService],
  // Exported for the admin module, which reuses buildDeleteGroupOps to
  // delete several groups and a user in one transaction.
  exports: [GroupsService, GroupLevelsService],
})
export class GroupsModule {}
