import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module.js';
import { LineModule } from '../line/line.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { BillController } from './bill.controller.js';
import { BillService } from './bill.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { PaymentCardController } from './payment-card.controller.js';
import { PaymentCardService } from './payment-card.service.js';
import { SessionLock } from './session-lock.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [GroupsModule, LineModule, PlansModule, VenuesModule],
  controllers: [SessionsController, BillController, CheckoutController, PaymentCardController],
  providers: [SessionLock, SessionsService, BillService, CheckoutService, PaymentCardService],
  exports: [SessionsService],
})
export class SessionsModule {}
