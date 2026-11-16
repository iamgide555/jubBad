import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { UsersModule } from '../users/users.module.js';
import { SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [UsersModule, PlansModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
