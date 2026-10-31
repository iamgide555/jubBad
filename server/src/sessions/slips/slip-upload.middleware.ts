import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { LoginThrottle } from '../../auth/login-throttle.js';
import { LiffIdentity } from './liff-identity.js';
import type { LiffUser } from './slip-payments.service.js';
import { SLIP_FAILURE_THROTTLE, SLIP_UPLOAD_THROTTLE, SlipUploadSlots } from './slip-throttles.js';

/** The largest slip image accepted; a phone screenshot is well under this. */
export const SLIP_UPLOAD_LIMIT = '8mb';

/** A request the middleware verified: who LINE says the caller is. Absent when it did not (the controller answers 404). */
export interface SlipViewerRequest extends Request {
  slipViewer?: LiffUser;
}

const UPLOAD_PATH = /^\/sessions\/([^/?#]+)\/slip-pay\/upload(?:[/?#]|$)/;

/**
 * Guards the pay page's upload, in this order, before a single body byte is read:
 *  1. the caller's address is not blocked (429);
 *  2. a LINE access token is sent and LINE confirms it (otherwise nothing is read and the controller answers the
 *     uniform 404; a rejected token counts against the address, a missing one does not);
 *  3. the viewer still has upload budget for this session (429);
 *  4. fewer than MAX_IN_FLIGHT_UPLOADS uploads are being processed server-wide (429).
 * Only then does it spend one use of the viewer's budget and read the body as a raw `image/*`, 8 MB at most (413
 * beyond that). Any other content type is left unparsed, so the controller sees no body and answers 400. The slot
 * is held until the response is finished or the connection closes.
 */
@Injectable()
export class SlipUploadMiddleware implements NestMiddleware {
  private readonly parse = raw({ type: 'image/*', limit: SLIP_UPLOAD_LIMIT });

  constructor(
    private readonly liff: LiffIdentity,
    @Inject(SLIP_FAILURE_THROTTLE) private readonly failures: LoginThrottle,
    @Inject(SLIP_UPLOAD_THROTTLE) private readonly uploads: LoginThrottle,
    private readonly slots: SlipUploadSlots
  ) {}

  async use(req: SlipViewerRequest, res: Response, next: NextFunction): Promise<void> {
    const ipKey = `slip-ip:${req.ip ?? 'unknown'}`;
    if (!this.failures.check(ipKey)) return tooMany(res);

    const header = req.headers['x-line-access-token'];
    // No token costs LINE nothing, so it is not counted against the address.
    if (typeof header !== 'string' || header === '') return next();
    const user = await this.liff.verify(header).catch(() => null);
    if (!user) this.failures.recordFailure(ipKey);
    // The client may have gone while LINE was being asked (up to seconds). Its close event has already fired, so a
    // listener attached now would never run: take no slot, spend no budget, and let the dead request be.
    // (Not `req.destroyed`: a request whose body an earlier parser read to the end is destroyed too, and is alive.)
    if (res.destroyed || res.closed || res.writableEnded || req.socket?.destroyed) return;
    if (!user) return next();
    req.slipViewer = user;

    const budgetKey = `slip-up:${sessionCodeOf(req)}:${user.userId}`;
    if (!this.uploads.check(budgetKey)) return tooMany(res);

    // From the slot to the parser there is no await: taking it and registering its release are one step, so it is
    // freed on every path (finish, abort during the body read, 413, an error in a later handler).
    const release = this.slots.take();
    if (!release) return tooMany(res);
    // One use of the budget per upload that reaches the parser (the throttle counts "failures"; here it counts uses).
    this.uploads.recordFailure(budgetKey);
    res.once('finish', release);
    res.once('close', release);
    this.parse(req, res, next);
  }
}

function sessionCodeOf(req: Request): string {
  const match = UPLOAD_PATH.exec(req.originalUrl ?? req.url);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function tooMany(res: Response): void {
  res.status(429).json({ statusCode: 429, message: '' });
}
