import { Module } from '@nestjs/common';
import { BillController } from './bill.controller.js';
import { BillService } from './bill.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [SessionsController, BillController, CheckoutController],
  providers: [SessionsService, BillService, CheckoutService],
  exports: [SessionsService],
})
export class SessionsModule {}
