/**
 * Rate limits failed logins per source address.
 *
 * Nothing else in this stack limits anything — no throttler package, no nginx
 * limit_req — so without this the admin token can be attacked online at
 * whatever rate the box will answer. The token is the only thing standing in
 * front of every group's data, and it is a single shared secret that never
 * rotates, so an unlimited guess rate is the one condition that makes its
 * length the only defence.
 *
 * In-memory on purpose: a single container serves this app, and a counter that
 * resets on deploy is the right trade for having no new dependency and no
 * shared store to run.
 */
export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000;

interface Attempts {
  count: number;
  /** When the window for this address expires. */
  expiresAt: number;
}

export class LoginThrottle {
  private readonly attempts = new Map<string, Attempts>();

  /** Injectable clock so the window can be tested without waiting 15 minutes. */
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.attempts.size;
  }

  check(address: string): boolean {
    this.sweep();
    const entry = this.attempts.get(address);
    return !entry || entry.count < MAX_ATTEMPTS;
  }

  recordFailure(address: string): void {
    const entry = this.attempts.get(address);
    if (entry && entry.expiresAt > this.now()) {
      entry.count += 1;
      return;
    }
    this.attempts.set(address, { count: 1, expiresAt: this.now() + WINDOW_MS });
  }

  recordSuccess(address: string): void {
    this.attempts.delete(address);
  }

  /**
   * Drops expired entries. Called on every check rather than on a timer, so
   * there is no interval to leak in tests and the map is bounded by the number
   * of addresses seen within one window rather than for the process's life.
   */
  private sweep(): void {
    const now = this.now();
    for (const [address, entry] of this.attempts) {
      if (entry.expiresAt <= now) this.attempts.delete(address);
    }
  }
}
