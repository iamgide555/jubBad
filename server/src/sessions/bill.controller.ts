import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BillService } from './bill.service.js';
import { SetBillConfigDto } from './dto/set-bill-config.dto.js';
import { SetBillMethodDto } from './dto/set-bill-method.dto.js';

/** Owner-only (no @Public): money never reaches the display or a co-host. */
@Controller('sessions')
export class BillController {
  constructor(private readonly billService: BillService) {}

  @Get(':code/bill')
  getBill(@Param('code') code: string) {
    return this.billService.getBill(code);
  }

  @Post(':code/bill-method')
  setBillMethod(@Param('code') code: string, @Body() dto: SetBillMethodDto) {
    return this.billService.setBillMethod(code, dto);
  }

  @Post(':code/bill-config')
  setBillConfig(@Param('code') code: string, @Body() dto: SetBillConfigDto) {
    return this.billService.setBillConfig(code, dto);
  }
}
