import { Module } from '@nestjs/common';
import { BillController } from './bill.controller.js';
import { BillService } from './bill.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [SessionsController, BillController],
  providers: [SessionsService, BillService],
  exports: [SessionsService],
})
export class SessionsModule {}
