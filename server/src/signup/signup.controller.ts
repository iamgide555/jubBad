import { Body, Controller, Get, HttpException, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginThrottle } from '../auth/login-throttle.js';
import { Public } from '../auth/public.decorator.js';
import { packSession, SESSION_COOKIE } from '../auth/session.js';
import { sessionCookieOptions } from '../auth/session-cookie.js';
import { RegisterDto } from './dto/register.dto.js';
import { SignupService, type SignupInfo } from './signup.service.js';

/**
 * Self sign-up. Every route is @Public(): the caller has no account yet. The routes
 * share /auth with AuthController, which is why the boundary spec's anonymous walk
 * skips the whole /auth prefix; register.spec.ts and line-signup.spec.ts pin these.
 */
@Public()
@Controller('auth')
export class SignupController {
  /** In memory like the login throttle: one container, and a reset on deploy is the right trade. */
  private readonly throttle = new LoginThrottle();

  constructor(private readonly signup: SignupService) {}

  /**
   * Open to anyone, with no email check, so it is limited per address: every attempt that gets
   * this far counts, successful or not, which caps the accounts one address can make per window.
   */
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ authenticated: true }> {
    const key = `register:${req.ip ?? 'unknown'}`;
    if (!this.throttle.check(key)) {
      throw new HttpException('ลองใหม่อีกครั้งภายหลัง', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.throttle.recordFailure(key);

    // The hidden trap field: a person never fills it. Answered like a success so a bot learns nothing.
    if (dto.website) return { authenticated: true };

    const user = await this.signup.registerWeb(dto.email, dto.password);
    res.cookie(SESSION_COOKIE, packSession(user.id, user.tokenVersion), sessionCookieOptions());
    return { authenticated: true };
  }

  @Get('signup-info')
  info(): SignupInfo {
    return this.signup.info();
  }
}
