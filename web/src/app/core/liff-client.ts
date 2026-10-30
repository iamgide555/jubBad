import { Injectable } from '@angular/core';
import type { Liff } from '@line/liff';

/** What the SDK's share picker accepts; the card arrives from our own API as plain JSON, so it is cast to this. */
type ShareMessages = Parameters<Liff['shareTargetPicker']>[0];

/**
 * A thin seam over the LIFF SDK so the share page can be tested without it.
 *
 * The SDK is loaded with a dynamic import inside `init`, so it lands in the
 * share page's own lazy chunk and never in the main bundle, the host
 * dashboard or the venue display.
 */
@Injectable({ providedIn: 'root' })
export class LiffClient {
  private liff: Liff | null = null;

  async init(liffId: string): Promise<void> {
    const { default: liff } = await import('@line/liff');
    await liff.init({ liffId });
    this.liff = liff;
  }

  isLoggedIn(): boolean {
    return this.sdk().isLoggedIn();
  }

  /** Leaves this page for LINE login and comes back to `redirectUri`. */
  login(redirectUri: string): void {
    this.sdk().login({ redirectUri });
  }

  /** The viewer's LINE access token, which the server verifies with LINE; null when not logged in. */
  getAccessToken(): string | null {
    return this.sdk().getAccessToken() ?? null;
  }

  /** The share picker only exists inside the LINE app (and LIFF browser). */
  canShare(): boolean {
    return this.sdk().isApiAvailable('shareTargetPicker');
  }

  /** `'sent'` only when LINE reports success; closing the picker is `'cancelled'`. */
  async share(messages: unknown[]): Promise<'sent' | 'cancelled'> {
    const result = await this.sdk().shareTargetPicker(messages as ShareMessages);
    return result?.status === 'success' ? 'sent' : 'cancelled';
  }

  private sdk(): Liff {
    if (!this.liff) throw new Error('LIFF is not initialised');
    return this.liff;
  }
}
