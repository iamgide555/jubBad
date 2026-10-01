import { Body, Controller, Param, Post } from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';
import { CheckoutPreviewDto } from './dto/checkout-preview.dto.js';

/** Owner-only (no @Public): money never reaches the display, a co-host or public pages. */
@Controller('sessions')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post(':code/checkouts/:playerId/preview')
  preview(@Param('code') code: string, @Param('playerId') playerId: string, @Body() dto: CheckoutPreviewDto) {
    return this.checkoutService.preview(code, playerId, dto.model);
  }
}
