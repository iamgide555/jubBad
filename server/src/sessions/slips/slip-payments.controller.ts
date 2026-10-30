import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ResolveWaitingSlipDto } from '../dto/resolve-waiting-slip.dto.js';
import { SetPlayerLinkDto } from '../dto/set-player-link.dto.js';
import { SlipPlayerDto } from '../dto/slip-player.dto.js';
import {
  SlipPaymentsService,
  type DuplicateSlip,
  type LinkRow,
  type PaidRow,
  type WaitingSlip,
} from './slip-payments.service.js';

/** Everything the bill screen needs about slips and paid marks in one read. */
export interface SlipPaymentsPanel {
  paid: PaidRow[];
  waiting: WaitingSlip[];
  duplicates: DuplicateSlip[];
  links: LinkRow[];
}

/**
 * The host's side of slip payments. Owner routes (no @Public): OwnershipGuard covers /sessions/:code/... and refuses a
 * non-owner with 404. The service's own refusals (409 conflicts, 404 for a slip that is gone) pass through.
 */
@Controller('sessions')
export class SlipPaymentsController {
  constructor(private readonly slips: SlipPaymentsService) {}

  @Get(':code/payments')
  async panel(@Param('code') code: string): Promise<SlipPaymentsPanel> {
    const [paid, waiting, duplicates, links] = await Promise.all([
      this.slips.getPaid(code),
      this.slips.listWaiting(code),
      this.slips.listDuplicates(code),
      this.slips.listLinks(code),
    ]);
    return { paid, waiting, duplicates, links };
  }

  @Post(':code/payments/tick')
  @HttpCode(200)
  async tick(@Param('code') code: string, @Body() dto: SlipPlayerDto): Promise<{ ok: true }> {
    await this.slips.tick(code, dto.playerId);
    return { ok: true };
  }

  @Post(':code/payments/untick')
  @HttpCode(200)
  async untick(@Param('code') code: string, @Body() dto: SlipPlayerDto): Promise<{ ok: true }> {
    await this.slips.untick(code, dto.playerId);
    return { ok: true };
  }

  @Post(':code/payments/waiting/:id/resolve')
  @HttpCode(200)
  async resolve(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: ResolveWaitingSlipDto
  ): Promise<{ ok: true }> {
    await this.slips.resolveWaiting(code, id, {
      coversPlayerIds: dto.coversPlayerIds,
      senderPlayerId: dto.senderPlayerId ?? null,
    });
    return { ok: true };
  }

  @Post(':code/payments/waiting/:id/dismiss')
  @HttpCode(200)
  async dismiss(@Param('code') code: string, @Param('id') id: string): Promise<{ ok: true }> {
    await this.slips.dismissWaiting(code, id);
    return { ok: true };
  }

  @Post(':code/payments/waiting/:id/update-name')
  @HttpCode(200)
  async updateName(@Param('code') code: string, @Param('id') id: string): Promise<{ ok: true }> {
    await this.slips.updateSavedReceiverName(code, id);
    return { ok: true };
  }

  @Post(':code/payments/duplicates/:id/dismiss')
  @HttpCode(200)
  async dismissDuplicate(@Param('code') code: string, @Param('id') id: string): Promise<{ ok: true }> {
    await this.slips.dismissDuplicate(code, id);
    return { ok: true };
  }

  @Post(':code/payments/links')
  @HttpCode(200)
  async setLink(@Param('code') code: string, @Body() dto: SetPlayerLinkDto): Promise<{ ok: true }> {
    await this.slips.setLink(code, dto.playerId, dto.lineUserId);
    return { ok: true };
  }
}
