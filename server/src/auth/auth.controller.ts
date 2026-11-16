import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveSessionUser } from './auth.guard.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordResetService } from './password-reset.service.js';
import { Public } from './public.decorator.js';
import { packSession, SESSION_COOKIE } from './session.js';
import { sessionCookieOptions } from './session-cookie.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UsersService } from '../users/users.service.js';

/**
 * Every route on this controller is @Public() by necessity — a caller with no
 * cookie has to be able to reach the endpoint that gives them one, the client's
 * route guard has to be able to ask whether it is signed in without being
 * refused for not being signed in, and a locked-out host has no cookie at all
 * when asking for a reset.
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly usersService: UsersService,
    private readonly throttle: LoginThrottle,
    private readonly passwordResetService: PasswordResetService
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
    // Throttling section of docs/archive/plans/2026-09-12-b12-per-user-login.md.
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
    res.cookie(SESSION_COOKIE, packSession(user.id, user.tokenVersion), sessionCookieOptions());
    return { authenticated: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { authenticated: false } {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
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

  /**
   * Records that someone asked for a reset, and reports whether the address
   * actually matches an account. This is a deliberate reversal of the safer
   * default: an anti-enumeration response ("we'll notify the admin either
   * way") was the original design, but the owner asked for a plain answer
   * instead (2026-09-12) — this app's whole user base is a handful of known
   * hosts, not a public signup surface, so the clearer feedback was judged
   * worth more than the enumeration protection here. (Since 2026-11-16 anyone can sign up, so
   * the address-exists answer is a little less contained than that premise; the IP throttle is what
   * limits it, and the owner has not asked to change it.) Still throttled by IP,
   * and still grants nothing by itself: the only thing that produces a
   * working reset link is an admin acting on the request from the console.
   */
  @Post('forgot')
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request
  ): Promise<{ received: true; exists: boolean }> {
    const ipKey = `forgot:${req.ip ?? 'unknown'}`;
    if (!this.throttle.check(ipKey)) {
      throw new HttpException('ลองใหม่อีกครั้งภายหลัง', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.throttle.recordFailure(ipKey);

    const user = await this.usersService.findByEmail(dto.email);
    // Recorded regardless of a match — a host's own typo is still a real
    // event worth the admin seeing, per PasswordResetService#recordRequest.
    await this.passwordResetService.recordRequest(dto.email);
    return { received: true, exists: user !== null };
  }

  /**
   * A locked-out host has no cookie, so this has to be @Public() — the token
   * itself, 256 bits and single-use, is the only credential here.
   */
  @Post('reset/:token')
  async resetPassword(
    @Param('token') token: string,
    @Body() dto: ResetPasswordDto
  ): Promise<{ ok: true }> {
    const ok = await this.passwordResetService.consume(token, dto.password);
    if (!ok) {
      throw new UnauthorizedException('ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว');
    }
    return { ok: true };
  }
}
