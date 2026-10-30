import { Injectable } from '@nestjs/common';
import { MAX_ATTEMPTS, WINDOW_MS } from '../../auth/login-throttle.js';

/**
 * Two in-memory `LoginThrottle` instances, shared by the pay-page controller and the upload middleware (provided in
 * SessionsModule, so a spec can swap them):
 *  - failures: bad LINE tokens against `slip-ip:<address>`, bad pay links and unavailable pages against
 *    `slip:<session>:<user>`;
 *  - uploads: every upload that reaches the body parser, against `slip-up:<session>:<user>`.
 */
export const SLIP_FAILURE_THROTTLE = 'SLIP_FAILURE_THROTTLE';
export const SLIP_UPLOAD_THROTTLE = 'SLIP_UPLOAD_THROTTLE';

/** Uploads one verified viewer may start per session within the window; the throttle's own limit and window. */
export const UPLOADS_PER_WINDOW = MAX_ATTEMPTS;
export const UPLOAD_WINDOW_MS = WINDOW_MS;

/** Uploads being processed (body read, decoded, OCR'd) at once across the whole server; beyond this: 429. */
export const MAX_IN_FLIGHT_UPLOADS = 6;

/**
 * The server-wide count of uploads being processed. `take` is synchronous and hands back a release that is safe to call
 * more than once, so a caller registers it on the response in the same step it takes the slot.
 */
@Injectable()
export class SlipUploadSlots {
  private held = 0;

  /** Slots held right now; specs read it to prove no path leaks one. */
  get inFlight(): number {
    return this.held;
  }

  take(): (() => void) | null {
    if (this.held >= MAX_IN_FLIGHT_UPLOADS) return null;
    this.held += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= 1;
    };
  }
}
