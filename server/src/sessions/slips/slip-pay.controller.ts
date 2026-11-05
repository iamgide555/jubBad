import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/public.decorator.js';
import { SlipCoverDto } from '../dto/slip-cover.dto.js';
import { SlipPlayerDto } from '../dto/slip-player.dto.js';
import { PaymentCardService } from '../payment-card.service.js';
import type { SlipViewerRequest } from './slip-upload.middleware.js';
import { SlipViewerGate, payToken } from './slip-viewer-gate.js';
import {
  SlipPaymentsService,
  type ClaimOutcome,
  type CoverOutcome,
  type UnclaimOutcome,
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
    private readonly cards: PaymentCardService,
    private readonly gate: SlipViewerGate
  ) {}

  @Public()
  @Get(':code/slip-pay')
  async view(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<PayPageView> {
    const { user, key } = await this.gate.viewer(req, code);
    const view = await this.slips.payPageView(code, payToken(token), user);
    if (!view) this.gate.fail(key);
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
    const { key } = await this.gate.viewer(req, code);
    const view = await this.slips.paymentStatusView(code, payToken(token));
    if (!view) this.gate.fail(key);
    return view;
  }

  /**
   * Whether the viewer collects this bill, so the status page knows to show the collector's panel. Gated like the
   * status read; past the gate, "no" is the normal answer for every player on the bill, so it is never counted.
   */
  @Public()
  @Get(':code/slip-pay/role')
  @Header('Cache-Control', 'no-store')
  async role(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<{ collector: boolean }> {
    const { user, key } = await this.gate.viewer(req, code);
    const role = await this.slips.collectorRole(code, payToken(token), user);
    if (!role) this.gate.fail(key);
    return { collector: role.collector };
  }

  /** Only called after LINE's picker reports success; changes sent metadata, never payment marks. */
  @Public()
  @Post(':code/payment-share-card/sent')
  @HttpCode(200)
  async recordShare(@Param('code') code: string, @Query('token') token: unknown, @Req() req: Request): Promise<{ok:true}> {
    const {key} = await this.gate.viewer(req,code);
    try { await this.cards.recordShare(code,payToken(token)); }
    catch (error) { if (error instanceof NotFoundException) this.gate.fail(key); throw error; }
    this.gate.succeed(key);
    return {ok:true};
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
    this.gate.limit(key);
    const found = await this.slips.payPageConfig(code, payToken(token));
    if (!found) this.gate.fail(key);
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
    const { user, key } = await this.gate.viewer(req, code);
    const outcome = await this.slips.claimForPayPage(code, payToken(token), user, dto.playerId);
    if (outcome === null) this.gate.fail(key);
    return { outcome };
  }

  /** The sender of a slip for more than their share says who it covers; paid at once under the host's cap. */
  @Public()
  @Post(':code/slip-pay/cover')
  @HttpCode(200)
  async cover(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request,
    @Body() dto: SlipCoverDto
  ): Promise<{ outcome: CoverOutcome }> {
    const { user, key } = await this.gate.viewer(req, code);
    const outcome = await this.slips.coverForPayPage(code, payToken(token), user, dto.playerIds);
    if (outcome === null) this.gate.fail(key);
    if (outcome === 'paid') this.gate.succeed(key);
    return { outcome };
  }

  /** "Not my name": undoes the viewer's own pick so they can choose again, while the pick is still theirs to change. */
  @Public()
  @Post(':code/slip-pay/unclaim')
  @HttpCode(200)
  async unclaim(
    @Param('code') code: string,
    @Query('token') token: unknown,
    @Req() req: Request
  ): Promise<{ outcome: UnclaimOutcome }> {
    const { user, key } = await this.gate.viewer(req, code);
    const outcome = await this.slips.unclaimForPayPage(code, payToken(token), user);
    if (outcome === null) this.gate.fail(key);
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
    const { user, key } = this.gate.known(req.slipViewer, code);
    // Only a caller who passed both gates is told about their body: a bad link is a bare 404 whatever was sent.
    const pay = payToken(token);
    if (pay === undefined) this.gate.fail(key);
    const image: unknown = req.body;
    if (!Buffer.isBuffer(image) || image.length === 0) {
      throw new BadRequestException({ code: 'SLIP_IMAGE_REQUIRED' });
    }
    const result = await this.slips.submitSlip(code, pay, user, image);
    if (result.kind === 'unavailable') this.gate.fail(key);
    // A paid slip is the one outcome that clears the viewer's failures; the others are neither failures nor successes.
    if (result.kind === 'paid') this.gate.succeed(key);
    return { outcome: result.kind };
  }
}
