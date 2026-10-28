import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { LineSummaryService, type LineShareCard } from './line-summary.service.js';

/**
 * The LIFF page is opened inside LINE with no JubBad login, so this one route is public. It serves only what
 * the public summary page already shows, and 404s unless the host chose the DM route (see LineSummaryService.shareCard).
 */
@Controller('sessions')
export class LineShareController {
  constructor(private readonly summary: LineSummaryService) {}

  @Public()
  @Get(':code/line-share-card')
  card(@Param('code') code: string): Promise<LineShareCard> {
    return this.summary.shareCard(code);
  }
}
