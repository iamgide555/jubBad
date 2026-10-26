import { Controller, Get, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { PlansService } from './plans.service.js';

@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /**
   * The signed-in user's own plan, group count and cap. Not @Public (AuthGuard
   * applies) and it names no group, so OwnershipGuard passes this one path.
   */
  @Get('me')
  me(@Req() req: AuthenticatedRequest) {
    return this.plans.describeCaller(req.user);
  }
}
