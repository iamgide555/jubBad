import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LiffIdentityModule } from '../line/liff-identity.module.js';
import { LineModule } from '../line/line.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { UsersModule } from '../users/users.module.js';
import { SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [AuthModule, UsersModule, PlansModule, LineModule, LiffIdentityModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
