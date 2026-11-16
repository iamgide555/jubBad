import { Injectable, inject } from '@angular/core';
import { LiffClient } from './liff-client';
import { SignupService } from './signup.service';

/** `redirecting`: the page left for LINE login and comes back here; nothing more to do on this load. */
export type ViewerStart =
  | { kind: 'ready'; accessToken: string }
  | { kind: 'redirecting' }
  | { kind: 'unavailable' }
  | { kind: 'error' };

/**
 * Gets a page opened through LIFF to "who is this, per LINE": reads the LIFF id from the server, starts LIFF once,
 * sends the viewer through LINE login when they are not in yet, and hands back their access token. The server
 * verifies the token with LINE; nothing here trusts it.
 */
@Injectable({ providedIn: 'root' })
export class LineViewer {
  private readonly api = inject(SignupService);
  private readonly liff = inject(LiffClient);
  private liffReady = false;

  /** Safe to call again to retry: LIFF's own init runs only once. */
  async start(): Promise<ViewerStart> {
    let liffId: string | null;
    try {
      liffId = (await this.api.info()).liffId;
    } catch {
      return { kind: 'error' };
    }
    if (liffId === null) return { kind: 'unavailable' };
    if (!this.liffReady) {
      try {
        await this.liff.init(liffId);
      } catch {
        return { kind: 'error' };
      }
      this.liffReady = true;
    }
    if (!this.liff.isLoggedIn()) {
      // LINE brings the viewer straight back here, logged in; the access token only exists after that.
      this.liff.login(window.location.href);
      return { kind: 'redirecting' };
    }
    const accessToken = this.liff.getAccessToken();
    return accessToken ? { kind: 'ready', accessToken } : { kind: 'error' };
  }
}
