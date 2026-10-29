import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { ConfirmPaymentCardDto } from './dto/confirm-payment-card.dto.js';
import { SendPaymentCardDto } from './dto/send-payment-card.dto.js';
import {
  PaymentCardService,
  type PaymentPanel,
  type PaymentSendOutcome,
  type PaymentShareCard,
} from './payment-card.service.js';

/**
 * The panel, confirm and bot send are owner routes (no @Public): OwnershipGuard covers /sessions/:code/... and
 * refuses a non-owner with 404, and money never reaches the display or a co-host. The share read is the one
 * public route, gated by the confirm's token instead of a login (see PaymentCardService.shareCard).
 */
@Controller('sessions')
export class PaymentCardController {
  constructor(private readonly payments: PaymentCardService) {}

  @Get(':code/payment-card')
  panel(@Param('code') code: string): Promise<PaymentPanel> {
    return this.payments.panel(code);
  }

  @Post(':code/payment-card/confirm')
  @HttpCode(200)
  confirm(@Param('code') code: string, @Body() dto: ConfirmPaymentCardDto): Promise<PaymentPanel> {
    return this.payments.confirm(code, dto);
  }

  /** Always answers 200 with the outcome, so the panel can say what happened instead of a bare error. */
  @Post(':code/payment-card/send')
  @HttpCode(200)
  async send(@Param('code') code: string, @Body() dto: SendPaymentCardDto): Promise<{ outcome: PaymentSendOutcome }> {
    return { outcome: await this.payments.send(code, dto.sendId) };
  }

  @Public()
  @Get(':code/payment-share-card')
  shareCard(@Param('code') code: string, @Query('token') token: unknown): Promise<PaymentShareCard> {
    // A repeated ?token= arrives as an array: not a token.
    return this.payments.shareCard(code, typeof token === 'string' ? token : undefined);
  }
}
