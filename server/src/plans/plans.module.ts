import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';
import { TrialService } from './trial.service.js';

// Depends only on PrismaService (global PrismaModule), so any module can
// import it without a cycle.
@Module({
  controllers: [PlansController],
  providers: [PlansService, TrialService],
  exports: [PlansService, TrialService],
})
export class PlansModule {}
