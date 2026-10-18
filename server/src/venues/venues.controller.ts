import { Controller, Get, Query } from '@nestjs/common';
import { VenuesService } from './venues.service.js';

/**
 * Authenticated (no @Public): the list is shared across hosts but is for hosts
 * only. OwnershipGuard lets this one path through because it names no group.
 */
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get('search')
  search(@Query('q') q?: string) {
    return this.venues.search(typeof q === 'string' ? q : '');
  }
}
