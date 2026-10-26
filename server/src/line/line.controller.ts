import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { LineLinkService } from './line-link.service.js';

/** Owner routes (no @Public): OwnershipGuard covers /groups/:code/... and refuses a non-owner with 404. */
@Controller('groups')
export class LineController {
  constructor(private readonly link: LineLinkService) {}

  @Get(':code/line')
  status(@Param('code') code: string) {
    return this.link.status(code);
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
