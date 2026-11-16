import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginThrottle } from '../auth/login-throttle.js';
import { Public } from '../auth/public.decorator.js';
import { packSession, SESSION_COOKIE } from '../auth/session.js';
import { sessionCookieOptions } from '../auth/session-cookie.js';
import { LiffIdentity, type LiffUser } from '../line/liff-identity.js';
import { CredentialsDto } from './dto/credentials.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SignupService, type LineStatus, type SignupInfo } from './signup.service.js';

const TOKEN_HEADER = 'x-line-access-token';
const TOO_MANY = 'ลองใหม่อีกครั้งภายหลัง';

/**
 * Self sign-up. Every route is @Public(): the caller has no account yet. The routes
 * share /auth with AuthController, which is why the boundary spec's anonymous walk
 * skips the whole /auth prefix; register.spec.ts and line-signup.spec.ts pin these.
 *
 * The LINE routes take the viewer's LIFF access token in a header and ask LINE who it belongs to
 * (the same check as the slip pay page). A token LINE refuses is 401; LINE not answering is the
 * 503 `LiffIdentity.verify` throws, which says nothing about the caller and is never counted.
 */
@Public()
@Controller('auth')
export class SignupController {
  /** In memory like the login throttle: one container, and a reset on deploy is the right trade. */
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly signup: SignupService,
    private readonly liff: LiffIdentity
  ) {}

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
    if (!this.throttle.check(key)) throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
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

  @Post('line/status')
  @HttpCode(200)
  async lineStatus(@Req() req: Request): Promise<LineStatus> {
    return this.signup.lineStatus(await this.viewer(req));
  }

  @Post('line/signup')
  async lineSignup(
    @Body() dto: CredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ authenticated: true; trialUntil: string | null; botFriend: boolean | null }> {
    const line = await this.viewer(req);
    const { user, trialUntil, botFriend } = await this.signup.registerLine(line, dto.email, dto.password);
    res.cookie(SESSION_COOKIE, packSession(user.id, user.tokenVersion), sessionCookieOptions());
    return { authenticated: true, trialUntil: trialUntil?.toISOString() ?? null, botFriend };
  }

  /** Does not sign the browser in: the page runs in LINE's own browser, not on the host's devices. */
  @Post('line/link')
  @HttpCode(200)
  async lineLink(@Body() dto: CredentialsDto, @Req() req: Request): Promise<{ linked: true; trialUntil: string | null }> {
    const line = await this.viewer(req);
    const ipKey = this.ipKey(req);
    const emailKey = `email:${dto.email.trim().toLowerCase()}`;
    if (!this.throttle.check(emailKey)) throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);

    const result = await this.signup.linkLine(line, dto.email, dto.password);
    if (result === 'bad-credentials') {
      this.throttle.recordFailure(ipKey);
      this.throttle.recordFailure(emailKey);
      // One answer for a wrong email and a wrong password, as login does.
      throw new UnauthorizedException({ code: 'BAD_CREDENTIALS', message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (result === 'account-linked') throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
    if (result === 'line-taken') throw new ConflictException({ code: 'LINE_ALREADY_LINKED' });
    this.throttle.recordSuccess(ipKey);
    this.throttle.recordSuccess(emailKey);
    return { linked: true, trialUntil: result.trialUntil?.toISOString() ?? null };
  }

  private ipKey(req: Request): string {
    return `line:${req.ip ?? 'unknown'}`;
  }

  /** Who the access token belongs to, per LINE. A missing or refused token is a 401 and counts against the address. */
  private async viewer(req: Request): Promise<LiffUser> {
    const ipKey = this.ipKey(req);
    if (!this.throttle.check(ipKey)) throw new HttpException(TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    const header = req.headers[TOKEN_HEADER];
    const token = typeof header === 'string' ? header : '';
    const user = token === '' ? null : await this.liff.verify(token);
    if (!user) {
      this.throttle.recordFailure(ipKey);
      throw new UnauthorizedException();
    }
    return user;
  }
}
