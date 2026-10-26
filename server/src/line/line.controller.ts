import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';

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

  /** Always allowed, including on a free or lapsed plan, so a host can always disconnect. */
  @Delete(':code/line')
  async unlink(@Param('code') code: string) {
    await this.link.unlink(code);
    return { unlinked: true };
  }
}
