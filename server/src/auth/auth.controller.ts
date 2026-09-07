import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ADMIN_COOKIE, ADMIN_TOKEN, matchesToken } from './admin.guard.js';
import { LoginThrottle } from './login-throttle.js';
import { Public } from './public.decorator.js';
import { LoginDto } from './dto/login.dto.js';

/** Thirty days: the host should not re-authenticate before every session. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * All three routes are @Public() by necessity — a caller with no cookie has to
 * be able to reach the endpoint that gives them one, and the client's route
 * guard has to be able to ask whether it is signed in without being refused for
 * not being signed in.
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(ADMIN_TOKEN) private readonly adminToken: string,
    private readonly throttle: LoginThrottle
  ) {}

  @Post('login')
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): { authenticated: true } {
    const address = req.ip ?? 'unknown';

    if (!this.throttle.check(address)) {
      throw new HttpException('ลองใหม่อีกครั้งภายหลัง', HttpStatus.TOO_MANY_REQUESTS);
    }

    if (!matchesToken(dto.token, this.adminToken)) {
      this.throttle.recordFailure(address);
      throw new UnauthorizedException('โทเคนไม่ถูกต้อง');
    }

    this.throttle.recordSuccess(address);
    res.cookie(ADMIN_COOKIE, this.adminToken, this.cookieOptions());
    return { authenticated: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { authenticated: false } {
    res.clearCookie(ADMIN_COOKIE, this.cookieOptions());
    return { authenticated: false };
  }

  @Get('me')
  me(@Req() req: Request): { authenticated: boolean } {
    return { authenticated: matchesToken(req.cookies?.[ADMIN_COOKIE], this.adminToken) };
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      /**
       * Lax is what makes a separate CSRF token unnecessary: the browser will
       * not attach this cookie to a cross-site POST, so another origin cannot
       * drive the API using the host's own session.
       */
      sameSite: 'lax' as const,
      /**
       * Only in production. Cloudflare terminates TLS so the browser sees
       * HTTPS and honours it there; over plain-http local dev a Secure cookie
       * is treated inconsistently between browsers and would silently not be
       * stored.
       */
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: MAX_AGE_MS,
    };
  }
}
