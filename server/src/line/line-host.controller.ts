import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { LineHostService } from './line-host.service.js';
import { SetLineHostDto } from './set-line-host.dto.js';

/**
 * A group's side of the host's own LINE link (their one-to-one chat with the bot). Owner routes
 * (no @Public): OwnershipGuard covers /groups/:code/... and refuses a non-owner with 404.
 */
@Controller('groups')
export class LineHostController {
  constructor(private readonly host: LineHostService) {}

  @Get(':code/line/host')
  status(@Param('code') code: string) {
    return this.host.status(code);
  }

  /** Host plan only. Only for an owner whose LINE account is not linked yet; linking also switches this group on. */
  @Post(':code/line/host/code')
  createCode(@Param('code') code: string) {
    return this.host.createCode(code);
  }

  /** Switch DM capture on or off for this group. Off is always allowed. */
  @Put(':code/line/host')
  async setEnabled(@Param('code') code: string, @Body() dto: SetLineHostDto) {
    return { enabled: await this.host.setEnabled(code, dto.enabled) };
  }

  /** Unlinks the owner's whole LINE account, for every group. Always allowed, on any plan. */
  @Delete(':code/line/host')
  async unlink(@Param('code') code: string) {
    await this.host.unlinkOwnerOf(code);
    return { unlinked: true };
  }
}
