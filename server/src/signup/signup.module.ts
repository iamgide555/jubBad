import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LiffIdentityModule } from '../line/liff-identity.module.js';
import { LineModule } from '../line/line.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { UsersModule } from '../users/users.module.js';
import { SignupController } from './signup.controller.js';
import { signupReadiness } from './readiness.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [AuthModule, UsersModule, PlansModule, LineModule, LiffIdentityModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule implements OnApplicationBootstrap {
  /** One line at boot so a half-configured deploy says what is missing instead of quietly offering less. */
  onApplicationBootstrap(): void {
    const { missing } = signupReadiness();
    const log = new Logger('SignupReadiness');
    if (missing.length === 0) log.log('sign-up settings: all set');
    else log.warn(`sign-up settings missing: ${missing.map((m) => `${m.name} (${m.effect})`).join('; ')}`);
  }
}
