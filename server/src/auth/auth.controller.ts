import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveSessionUser } from './auth.guard.js';
import { LoginThrottle } from './login-throttle.js';
import { Public } from './public.decorator.js';
import { packSession, SESSION_COOKIE } from './session.js';
import { LoginDto } from './dto/login.dto.js';
import { UsersService } from '../users/users.service.js';

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
    private readonly usersService: UsersService,
    private readonly throttle: LoginThrottle
  ) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ authenticated: true }> {
    const ipKey = `ip:${req.ip ?? 'unknown'}`;
    // Namespaced separately from the IP bucket so a pool of source addresses
    // cannot each get a fresh budget against the same account — see the
    // Throttling section of docs/2026-09-12-b12-per-user-login.md.
    const emailKey = `email:${dto.email.trim().toLowerCase()}`;

    if (!this.throttle.check(ipKey) || !this.throttle.check(emailKey)) {
      throw new HttpException('ลองใหม่อีกครั้งภายหลัง', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.usersService.verifyCredentials(dto.email, dto.password);
    if (!user) {
      this.throttle.recordFailure(ipKey);
      this.throttle.recordFailure(emailKey);
      // Deliberately does not say which half was wrong — telling them apart is
      // exactly what would let a caller enumerate which emails have accounts.
      throw new UnauthorizedException('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }

    this.throttle.recordSuccess(ipKey);
    this.throttle.recordSuccess(emailKey);
    res.cookie(SESSION_COOKIE, packSession(user.id, user.tokenVersion), this.cookieOptions());
    return { authenticated: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { authenticated: false } {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { authenticated: false };
  }

  @Get('me')
  async me(
    @Req() req: Request
  ): Promise<{ authenticated: boolean; role?: string; email?: string }> {
    const user = await resolveSessionUser(req, this.usersService);
    if (!user) return { authenticated: false };
    return { authenticated: true, role: user.role, email: user.email };
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      /**
       * Signed rather than plain: the cookie's payload is `userId:tokenVersion`
       * (session.ts), and a client that could forge or edit it could pick any
       * user id. cookie-parser verifies the signature against SESSION_SECRET
       * before AuthGuard ever sees the value.
       */
      signed: true,
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
