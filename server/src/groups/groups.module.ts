import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';

@Module({
  controllers: [GroupsController],
  providers: [GroupsService],
  // Exported for the admin module, which reuses buildDeleteGroupOps to
  // delete several groups and a user in one transaction.
  exports: [GroupsService],
})
export class GroupsModule {}
