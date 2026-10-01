import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module.js';
import { BillController } from './bill.controller.js';
import { BillService } from './bill.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [GroupsModule],
  controllers: [SessionsController, BillController],
  providers: [SessionsService, BillService],
  exports: [SessionsService],
})
export class SessionsModule {}
