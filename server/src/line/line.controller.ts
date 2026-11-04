import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';
import { UpdateLineSettingsDto } from './update-line-settings.dto.js';

/** Owner routes (no @Public): OwnershipGuard covers /groups/:code/... and refuses a non-owner with 404. */
@Controller('groups')
export class LineController {
  constructor(
    private readonly link: LineLinkService,
    private readonly roster: LineRosterService
  ) {}

  @Get(':code/line')
  status(@Param('code') code: string) {
    return this.link.status(code);
  }

  /** For the start screen: the newest captured roster, or { roster: null } so start falls back to manual paste. */
  @Get(':code/line/latest-roster')
  async latestRoster(@Param('code') code: string) {
    return { roster: await this.roster.latest(code) };
  }

  @Post(':code/line/code')
  createCode(@Param('code') code: string) {
    return this.link.createCode(code);
  }

  /** Group card routing and end-of-session summary default. Paid and linked only. */
  @Patch(':code/line')
  async setSummaryDefault(@Param('code') code: string, @Body() dto: UpdateLineSettingsDto) {
    if (dto.summaryDefault === undefined && dto.rosterOnly === undefined) throw new BadRequestException();
    if (dto.rosterOnly !== undefined) await this.link.setRosterOnly(code, dto.rosterOnly);
    if (dto.summaryDefault !== undefined) await this.link.setSummaryDefault(code, dto.summaryDefault);
    const { summaryDefault, rosterOnly } = await this.link.status(code);
    return { summaryDefault, rosterOnly };
  }

  /** Always allowed, including on a free or lapsed plan, so a host can always disconnect. */
  @Delete(':code/line')
  async unlink(@Param('code') code: string) {
    await this.link.unlink(code);
    return { unlinked: true };
  }
}
