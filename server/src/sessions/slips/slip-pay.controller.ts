import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/public.decorator.js';
import { LoginThrottle } from '../../auth/login-throttle.js';
import { SlipPlayerDto } from '../dto/slip-player.dto.js';
import { LiffIdentity } from './liff-identity.js';
import {
  SlipPaymentsService,
  type ClaimOutcome,
  type LiffUser,
  type PayPageView,
  type SubmitOutcome,
  type WaitingReason,
} from './slip-payments.service.js';

/** What the upload says back: the outcome kind, and for a held slip, why. */
export interface SlipUploadResult {
  outcome: Exclude<SubmitOutcome['kind'], 'unavailable'>;
  reason?: WaitingReason;
}

/**
 * The pay page's routes. All @Public: there is no JubBad login, the caller proves who they are with a LINE access token
 * (header `X-Line-Access-Token`, checked with LINE) and that they hold tonight's link with the confirm's pay token
 * (`?token=`). Every failure of either, an unavailable page, or an unknown session is the same bare 404, so nothing
 * tells a guesser which half was wrong; a caller who keeps failing gets 429.
 *
 * The counters are in memory like the login throttle's: a single container, and a reset on deploy is the right trade.
 */
@Controller('sessions')
export class SlipPayController {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly slips: SlipPaymentsService,
    private readonly liff: LiffIdentity
  ) {}

  @Public()
  @Get(':code/slip-pay')
  async view(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<PayPageView> {
    const { user, key } = await this.viewer(req, code);
    const view = await this.slips.payPageView(code, payToken(token), user);
    if (!view) this.fail(key);
    return view;
  }

  @Public()
  @Post(':code/slip-pay/claim')
  @HttpCode(200)
  async claim(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() dto: SlipPlayerDto
  ): Promise<{ outcome: ClaimOutcome }> {
    const { user, key } = await this.viewer(req, code);
    const outcome = await this.slips.claimForPayPage(code, payToken(token), user, dto.playerId);
    if (outcome === null) this.fail(key);
    return { outcome };
  }

  /** The body is parsed by SlipUploadMiddleware (raw `image/*`, 8 MB); anything else arrives here without one. */
  @Public()
  @Post(':code/slip-pay/upload')
  @HttpCode(200)
  async upload(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<SlipUploadResult> {
    const { user, key } = await this.viewer(req, code);
    // Only a caller who passed both gates is told about their body: a bad link is a bare 404 whatever was sent.
    const pay = payToken(token);
    if (pay === undefined) this.fail(key);
    const image: unknown = req.body;
    if (!Buffer.isBuffer(image) || image.length === 0) {
      throw new BadRequestException({ code: 'SLIP_IMAGE_REQUIRED' });
    }
    const result = await this.slips.submitSlip(code, pay, user, image);
    if (result.kind === 'unavailable') this.fail(key);
    // A paid slip is the one outcome that clears the viewer's failures; the others are neither failures nor successes.
    if (result.kind === 'paid') this.throttle.recordSuccess(key);
    return result.kind === 'waiting' ? { outcome: 'waiting', reason: result.reason } : { outcome: result.kind };
  }

  /**
   * Who is asking, or a thrown 404 (429 once throttled). A request whose access token LINE does not confirm counts
   * against its address; the returned key is the viewer's own budget for this session.
   */
  private async viewer(req: Request, code: string): Promise<{ user: LiffUser; key: string }> {
    const ipKey = `slip-ip:${req.ip ?? 'unknown'}`;
    if (!this.throttle.check(ipKey)) throw tooMany();

    const header = req.headers['x-line-access-token'];
    // No token is asked of nobody: it costs LINE nothing, so it is not counted against the address.
    if (typeof header !== 'string' || header === '') throw new NotFoundException();
    const user = await this.liff.verify(header);
    if (!user) {
      this.throttle.recordFailure(ipKey);
      throw new NotFoundException();
    }

    const key = `slip:${code}:${user.userId}`;
    if (!this.throttle.check(key)) throw tooMany();
    return { user, key };
  }

  /** The viewer got past LINE but not the page's gates: counts against them, and answers like every other failure. */
  private fail(key: string): never {
    this.throttle.recordFailure(key);
    throw new NotFoundException();
  }
}

/** A repeated ?token= arrives as an array: not a token. */
function payToken(token: unknown): string | undefined {
  return typeof token === 'string' ? token : undefined;
}

function tooMany(): HttpException {
  return new HttpException('', HttpStatus.TOO_MANY_REQUESTS);
}
