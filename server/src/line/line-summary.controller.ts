import { Controller, Get, Param, Post } from '@nestjs/common';
import { LineSummaryService, type LineSummaryOutcome, type LineSummaryState } from './line-summary.service.js';

/** Owner routes (no @Public): OwnershipGuard covers /sessions/:code/... and refuses a non-owner with 404. */
@Controller('sessions')
export class LineSummaryController {
  constructor(private readonly summary: LineSummaryService) {}

  @Get(':code/line-summary')
  state(@Param('code') code: string): Promise<LineSummaryState> {
    return this.summary.state(code);
  }

  /** Always answers 200 with the outcome, so the page can say what happened instead of a bare error. */
  @Post(':code/line-summary')
  async send(@Param('code') code: string): Promise<{ outcome: LineSummaryOutcome }> {
    return { outcome: await this.summary.send(code) };
  }
}
