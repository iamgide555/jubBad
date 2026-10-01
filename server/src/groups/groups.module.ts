import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { GroupLevelsService } from './group-levels.service.js';
import { GroupsService } from './groups.service.js';

@Module({
  controllers: [GroupsController],
  providers: [GroupsService, GroupLevelsService],
  // Exported for the admin module, which reuses buildDeleteGroupOps to
  // delete several groups and a user in one transaction.
  exports: [GroupsService, GroupLevelsService],
})
export class GroupsModule {}
