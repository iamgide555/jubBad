import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollectorService } from './collector.service.js';
import { ConfirmPaymentCardDto } from './dto/confirm-payment-card.dto.js';
import { SendPaymentCardDto } from './dto/send-payment-card.dto.js';
import {
  PaymentCardService,
  type PaymentPanel,
  type PaymentSendOutcome,
  type PaymentShareCard,
} from './payment-card.service.js';

/** The collector as the host sees them: never the LINE user id, which only the bot needs. */
export interface HostCollector {
  playerId: string;
  playerName: string;
  lineName: string | null;
  pictureUrl: string | null;
}

/** The panel as the host's screen reads it: the shared panel plus where its collector settings live and who collects. */
export type HostPaymentPanel = PaymentPanel & { groupCode: string; collector: HostCollector | null };

/**
 * The panel, confirm, bot send and host DM are owner routes (no @Public): OwnershipGuard covers /sessions/:code/... and
 * refuses a non-owner with 404, and money never reaches the display or a co-host. The share read is the one
 * public route, gated by the confirm's token instead of a login (see PaymentCardService.shareCard).
 */
@Controller('sessions')
export class PaymentCardController {
  constructor(
    private readonly payments: PaymentCardService,
    private readonly collectors: CollectorService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * groupCode and collector are added here, not in PaymentCardService.panel(): panel() runs many times per slip
   * request (the pay-page gate, the waiting list, the collection) and must stay free of these extra reads.
   */
  private async forHost(code: string, panel: PaymentPanel): Promise<HostPaymentPanel> {
    const [session, collector] = await Promise.all([
      this.prisma.session.findUnique({ where: { code }, select: { groupId: true } }),
      this.collectors.forBill(code),
    ]);
    return {
      ...panel,
      groupCode: session?.groupId ?? '',
      collector: collector && {
        playerId: collector.playerId,
        playerName: collector.playerName,
        lineName: collector.lineName,
        pictureUrl: collector.pictureUrl,
      },
    };
  }

  @Get(':code/payment-card')
  async panel(@Param('code') code: string): Promise<HostPaymentPanel> {
    return this.forHost(code, await this.payments.panel(code));
  }

  @Post(':code/payment-card/confirm')
  @HttpCode(200)
  async confirm(@Param('code') code: string, @Body() dto: ConfirmPaymentCardDto): Promise<HostPaymentPanel> {
    return this.forHost(code, await this.payments.confirm(code, dto));
  }

  /** Always answers 200 with the outcome, so the panel can say what happened instead of a bare error. */
  @Post(':code/payment-card/send')
  @HttpCode(200)
  async send(@Param('code') code: string, @Body() dto: SendPaymentCardDto): Promise<{ outcome: PaymentSendOutcome }> {
    return { outcome: await this.payments.send(code, dto.sendId) };
  }

  /** The bot DMs the card to the host's own chat (`host` target); one push per tap, never automatic. */
  @Post(':code/payment-card/dm')
  @HttpCode(200)
  async sendToHost(
    @Param('code') code: string,
    @Body() dto: SendPaymentCardDto
  ): Promise<{ outcome: PaymentSendOutcome }> {
    return { outcome: await this.payments.sendToHost(code, dto.sendId) };
  }

  @Public()
  @Get(':code/payment-share-card')
  shareCard(@Param('code') code: string, @Query('token') token: unknown): Promise<PaymentShareCard> {
    // A repeated ?token= arrives as an array: not a token.
    return this.payments.shareCard(code, typeof token === 'string' ? token : undefined);
  }
}
