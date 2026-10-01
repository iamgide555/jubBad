import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';
import { CheckoutPreviewDto } from './dto/checkout-preview.dto.js';
import { ConfirmCheckoutDto } from './dto/confirm-checkout.dto.js';

/** Owner-only (no @Public): money never reaches the display, a co-host or public pages. */
@Controller('sessions')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post(':code/checkouts/:playerId/preview')
  preview(@Param('code') code: string, @Param('playerId') playerId: string, @Body() dto: CheckoutPreviewDto) {
    return this.checkoutService.preview(code, playerId, dto.model);
  }

  @Post(':code/checkouts/:playerId/confirm')
  confirm(@Param('code') code: string, @Param('playerId') playerId: string, @Body() dto: ConfirmCheckoutDto) {
    return this.checkoutService.confirm(code, playerId, dto);
  }

  @Get(':code/checkouts')
  list(@Param('code') code: string) {
    return this.checkoutService.list(code);
  }

  @Post(':code/checkouts/:checkoutId/undo')
  undo(@Param('code') code: string, @Param('checkoutId') checkoutId: string) {
    return this.checkoutService.undo(code, checkoutId);
  }
}
