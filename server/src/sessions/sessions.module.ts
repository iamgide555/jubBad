import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
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
import { LiffIdentity } from './slips/liff-identity.js';
import { SlipOcr } from './slips/slip-ocr.js';
import { SlipPaymentsService } from './slips/slip-payments.service.js';
import { SlipPayController } from './slips/slip-pay.controller.js';
import { SlipPaymentsController } from './slips/slip-payments.controller.js';
import { SlipReader } from './slips/slip-reader.js';
import { SlipUploadMiddleware } from './slips/slip-upload.middleware.js';

@Module({
  imports: [GroupsModule, LineModule, PlansModule, VenuesModule],
  controllers: [
    SessionsController,
    BillController,
    CheckoutController,
    PaymentCardController,
    SlipPayController,
    SlipPaymentsController,
  ],
  providers: [
    SessionLock,
    SessionsService,
    BillService,
    CheckoutService,
    PaymentCardService,
    SlipOcr,
    SlipReader,
    SlipPaymentsService,
    LiffIdentity,
  ],
  exports: [SessionsService],
})
export class SessionsModule implements NestModule {
  /** The upload's raw image parser lives here, not in main.ts, so every app built from AppModule gets it. */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(SlipUploadMiddleware)
      .forRoutes({ path: 'sessions/:code/slip-pay/upload', method: RequestMethod.POST });
  }
}
