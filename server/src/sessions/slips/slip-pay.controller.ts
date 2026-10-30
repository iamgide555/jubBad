import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
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
import type { SlipViewerRequest } from './slip-upload.middleware.js';
import { SLIP_FAILURE_THROTTLE } from './slip-throttles.js';
import {
  SlipPaymentsService,
  type ClaimOutcome,
  type LiffUser,
  type PayPageView,
  type PaymentStatusView,
  type SubmitOutcome,
} from './slip-payments.service.js';

/**
 * What the upload says back: the outcome kind only. A held slip's reason is for the host; telling the sender which
 * check held it would tell a forger what to fix.
 */
export interface SlipUploadResult {
  outcome: Exclude<SubmitOutcome['kind'], 'unavailable'>;
}

/**
 * The pay page's routes. All @Public: there is no JubBad login, the caller proves who they are with a LINE access token
 * (header `X-Line-Access-Token`, checked with LINE) and that they hold tonight's link with the confirm's pay token
 * (`?token=`). Every failure of either, an unavailable page, or an unknown session is the same bare 404, so nothing
 * tells a guesser which half was wrong; a caller who keeps failing gets 429.
 *
 * The counters are in memory like the login throttle's (two shared instances, see slip-throttles.ts): a single
 * container, and a reset on deploy is the right trade. The upload is guarded earlier, by SlipUploadMiddleware, which
 * verifies the viewer and meters uploads before any body is read.
 */
@Controller('sessions')
export class SlipPayController {
  constructor(
    private readonly slips: SlipPaymentsService,
    private readonly liff: LiffIdentity,
    @Inject(SLIP_FAILURE_THROTTLE) private readonly throttle: LoginThrottle
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
  @Get(':code/slip-pay/status')
  @Header('Cache-Control', 'no-store')
  async status(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<PaymentStatusView> {
    const { key } = await this.viewer(req, code);
    const view = await this.slips.paymentStatusView(code, payToken(token));
    if (!view) this.fail(key);
    return view;
  }

  /**
   * The LIFF id, for a page that has to `liff.init` before it has any LINE identity (so it cannot use the identity-gated
   * view). Same gates as the page minus the viewer; a gated-out request counts against its address, success never does.
   */
  @Public()
  @Get(':code/slip-pay/config')
  async config(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<{ liffId: string }> {
    const key = `slip-cfg:${req.ip ?? 'unknown'}`;
    if (!this.throttle.check(key)) throw tooMany();
    const found = await this.slips.payPageConfig(code, payToken(token));
    if (!found) this.fail(key);
    return { liffId: found.liffId };
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

  /** The body is parsed by SlipUploadMiddleware (raw `image/*`, 8 MB) after its checks; anything else arrives here without one. */
  @Public()
  @Post(':code/slip-pay/upload')
  @HttpCode(200)
  async upload(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: SlipViewerRequest
  ): Promise<SlipUploadResult> {
    // The middleware already checked the address, verified the token with LINE and spent the viewer's upload budget;
    // without a viewer it refused to read the body and this is the uniform 404.
    if (!req.slipViewer) throw new NotFoundException();
    const { user, key } = this.known(req.slipViewer, code);
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
    return { outcome: result.kind };
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

    return this.known(user, code);
  }

  /** The viewer's own failure budget for this session: spent means 429. */
  private known(user: LiffUser, code: string): { user: LiffUser; key: string } {
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
