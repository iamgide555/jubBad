import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { LineClient } from './line-client.js';
import { LineController } from './line.controller.js';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';
import { LineSummaryController } from './line-summary.controller.js';
import { LineSummaryService } from './line-summary.service.js';
import { LineWebhookController } from './line-webhook.controller.js';
import { LineWebhookService } from './line-webhook.service.js';

// Must not import GroupsModule: GroupsModule imports this one (a deleted group
// asks the bot to leave), so the dependency runs one way.
@Module({
  imports: [PlansModule],
  controllers: [LineController, LineSummaryController, LineWebhookController],
  providers: [LineClient, LineLinkService, LineRosterService, LineSummaryService, LineWebhookService],
  exports: [LineClient, LineLinkService, LineRosterService, LineSummaryService],
})
export class LineModule {}
