import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module.js';
import { LineModule } from '../line/line.module.js';
import { LoginThrottle } from '../auth/login-throttle.js';
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
import { SlipImagesModule } from './slips/slip-images.module.js';
import { SlipReader } from './slips/slip-reader.js';
import { SLIP_FAILURE_THROTTLE, SLIP_UPLOAD_THROTTLE, SlipUploadSlots } from './slips/slip-throttles.js';
import { SlipUploadMiddleware } from './slips/slip-upload.middleware.js';

@Module({
  imports: [SlipImagesModule, GroupsModule, LineModule, PlansModule, VenuesModule],
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
    SlipUploadSlots,
    { provide: SLIP_FAILURE_THROTTLE, useFactory: () => new LoginThrottle() },
    { provide: SLIP_UPLOAD_THROTTLE, useFactory: () => new LoginThrottle() },
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
