import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.js';
import { lineConfig } from './line-config.js';
import { verifyLineSignature } from './line-signature.js';
import { LineWebhookService, type LineEvent } from './line-webhook.service.js';

/**
 * @Public because LINE has no JubBad session: the request authenticates itself
 * with the channel-secret signature over the raw body instead. It addresses no
 * group by URL, so it is an explicit exception in auth.boundary.spec.ts.
 */
@Public()
@Controller('line')
export class LineWebhookController {
  constructor(private readonly webhook: LineWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-line-signature') signature: string | undefined,
    @Body() body: { events?: LineEvent[] }
  ) {
    const { secret, token } = lineConfig();
    if (!secret || !token) throw new ServiceUnavailableException({ code: 'LINE_NOT_CONFIGURED' });
    if (!req.rawBody || !verifyLineSignature(req.rawBody, signature, secret)) throw new UnauthorizedException();

    // In order; one failing event never turns into a non-2xx for the whole batch.
    for (const event of Array.isArray(body?.events) ? body.events : []) await this.webhook.handleEvent(event);
    return { ok: true };
  }
}
