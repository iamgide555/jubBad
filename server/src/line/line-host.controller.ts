import { Controller, Delete, Get, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { LineHostService } from './line-host.service.js';

/**
 * The signed-in host's own LINE link (their one-to-one chat with the bot). Not @Public (AuthGuard
 * applies) and it names no group, so OwnershipGuard passes these paths; the user is always req.user.
 */
@Controller('line/host')
export class LineHostController {
  constructor(private readonly host: LineHostService) {}

  @Get()
  status(@Req() req: AuthenticatedRequest) {
    return this.host.status(req.user.id);
  }

  /** Host plan only: a free user gets the plan error. */
  @Post('code')
  createCode(@Req() req: AuthenticatedRequest) {
    return this.host.createCode(req.user.id);
  }

  /** Always allowed, including on a free or lapsed plan, so a host can always disconnect. */
  @Delete()
  async unlink(@Req() req: AuthenticatedRequest) {
    await this.host.unlink(req.user.id);
    return { unlinked: true };
  }
}
