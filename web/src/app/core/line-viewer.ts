import { Injectable, inject } from '@angular/core';
import { LiffClient } from './liff-client';
import { SignupService, type SignupInfo } from './signup.service';

/** The tab remembers when it last restarted LINE login, so a persistent refusal cannot loop (see `restart`). */
const RESTARTED_KEY = 'jubbad.line.restartedAt';
const RESTART_COOLDOWN_MS = 60_000;

/** `redirecting`: the page left for LINE login and comes back here; nothing more to do on this load. */
export type ViewerStart =
  | { kind: 'ready'; accessToken: string; botAddUrl: string | null }
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
  private info: SignupInfo | null = null;

  /** Safe to call again to retry: the server is asked once and LIFF's own init runs only once it has worked. */
  async start(): Promise<ViewerStart> {
    if (this.info === null) {
      try {
        this.info = await this.api.info();
      } catch {
        return { kind: 'error' };
      }
    }
    const { liffId, botAddUrl } = this.info;
    if (liffId === null) return { kind: 'unavailable' };
    if (!this.liffReady) {
      try {
        await this.liff.init(liffId);
      } catch {
        return { kind: 'error' };
      }
      this.liffReady = true;
    }
    if (!this.liff.isLoggedIn()) return this.login();
    const accessToken = this.liff.getAccessToken();
    return accessToken ? { kind: 'ready', accessToken, botAddUrl } : { kind: 'error' };
  }

  /**
   * The server refused the access token (expired or revoked), and LIFF would hand the same one back: end the LINE
   * session here and log in again, which returns to this page with a fresh token.
   */
  async restart(): Promise<ViewerStart> {
    // One restart a minute per tab. If LINE keeps handing back a token the server refuses (a wrong channel id, a clock
    // problem), logging out and in again would bounce between LINE and this page for ever; the second time round the
    // page says it failed and lets the person decide. Where the browser will not remember, a restart is still allowed.
    if (this.restartedRecently()) return { kind: 'error' };
    this.rememberRestart();
    try {
      this.liff.logout();
    } catch {
      return { kind: 'error' };
    }
    return this.login();
  }

  private restartedRecently(): boolean {
    try {
      const at = Number(sessionStorage.getItem(RESTARTED_KEY));
      return Number.isFinite(at) && at > 0 && Date.now() - at < RESTART_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  private rememberRestart(): void {
    try {
      sessionStorage.setItem(RESTARTED_KEY, String(Date.now()));
    } catch {
      // Private mode: no memory, so no loop guard; the server-side address throttle still bounds it.
    }
  }

  private login(): ViewerStart {
    try {
      // LINE brings the viewer straight back here, logged in; the access token only exists after that.
      this.liff.login(window.location.href);
    } catch {
      return { kind: 'error' };
    }
    return { kind: 'redirecting' };
  }
}
