import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { LoginThrottle } from '../../auth/login-throttle.js';
import { LiffIdentity } from './liff-identity.js';
import type { LiffUser } from './slip-payments.service.js';
import { SLIP_FAILURE_THROTTLE } from './slip-throttles.js';

/**
 * The LINE-viewer half of every public slip route (the pay page's and the collector's): who LINE says the caller is,
 * and the failure budgets that turn a guesser into a 429. Every refusal is the same bare 404.
 */
@Injectable()
export class SlipViewerGate {
  constructor(
    private readonly liff: LiffIdentity,
    @Inject(SLIP_FAILURE_THROTTLE) private readonly throttle: LoginThrottle
  ) {}

  /**
   * Who is asking, or a thrown 404 (429 once throttled). A request whose access token LINE does not confirm counts
   * against its address; the returned key is the viewer's own budget for this session.
   */
  async viewer(req: Request, code: string): Promise<{ user: LiffUser; key: string }> {
    const ipKey = `slip-ip:${req.ip ?? 'unknown'}`;
    this.limit(ipKey);

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
  known(user: LiffUser, code: string): { user: LiffUser; key: string } {
    const key = `slip:${code}:${user.userId}`;
    this.limit(key);
    return { user, key };
  }

  /** A spent budget is 429. */
  limit(key: string): void {
    if (!this.throttle.check(key)) throw tooMany();
  }

  /** The viewer got past LINE but not the page's gates: counts against them, and answers like every other failure. */
  fail(key: string): never {
    this.throttle.recordFailure(key);
    throw new NotFoundException();
  }

  /** Clears the key's failures. */
  succeed(key: string): void {
    this.throttle.recordSuccess(key);
  }
}

/** A repeated ?token= arrives as an array: not a token. */
export function payToken(token: unknown): string | undefined {
  return typeof token === 'string' ? token : undefined;
}

export function tooMany(): HttpException {
  return new HttpException('', HttpStatus.TOO_MANY_REQUESTS);
}
