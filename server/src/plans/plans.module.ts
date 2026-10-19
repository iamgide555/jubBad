import { Module } from '@nestjs/common';
import { PlansService } from './plans.service.js';

// Depends only on PrismaService (global PrismaModule), so any module can
// import it without a cycle.
@Module({
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
