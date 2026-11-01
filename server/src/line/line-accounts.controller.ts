import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { LineAccountsService } from './line-accounts.service.js';
import { LinkLineAccountDto } from './link-line-account.dto.js';

/**
 * A group's LINE accounts (owner routes, no @Public; OwnershipGuard covers /groups/:code/... and refuses a non-owner
 * with 404). Not plan-gated: viewing, linking and unlinking work on a free or lapsed plan. The browser names an
 * account by its id, never by LINE user id.
 */
@Controller('groups')
export class LineAccountsController {
  constructor(private readonly accounts: LineAccountsService) {}

  @Get(':code/line/accounts')
  list(@Param('code') code: string) {
    return this.accounts.list(code);
  }

  @Put(':code/line/accounts/:accountId/player')
  async link(@Param('code') code: string, @Param('accountId') accountId: string, @Body() dto: LinkLineAccountDto) {
    await this.accounts.link(code, accountId, dto.playerId);
    return { ok: true };
  }

  @Delete(':code/line/accounts/:accountId/player')
  async unlink(@Param('code') code: string, @Param('accountId') accountId: string) {
    await this.accounts.unlink(code, accountId);
    return { ok: true };
  }
}
