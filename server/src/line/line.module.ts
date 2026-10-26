import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { LineClient } from './line-client.js';
import { LineController } from './line.controller.js';
import { LineLinkService } from './line-link.service.js';

// Must not import GroupsModule: GroupsModule imports this one (a deleted group
// asks the bot to leave), so the dependency runs one way.
@Module({
  imports: [PlansModule],
  controllers: [LineController],
  providers: [LineClient, LineLinkService],
  exports: [LineClient, LineLinkService],
})
export class LineModule {}
