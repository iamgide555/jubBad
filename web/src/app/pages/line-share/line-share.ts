import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, type ActivatedRouteSnapshot, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { LiffClient } from '../../core/liff-client';
import type { LineShareCard, PaymentShareCard } from '../../core/line.model';
import { LineService } from '../../core/line.service';

type Phase = 'loading' | 'missing' | 'error' | 'login' | 'unavailable' | 'ready' | 'done';

interface RouteTarget {
  kind: 'summary' | 'pay' | 'slip';
  code: string;
  /** Only for `pay` and `slip`; never logged or shown. */
  token: string | null;
}

/**
 * The summary code is in the path (`/line-share/abc123`) once LIFF has
 * redirected, but LIFF first opens the endpoint as
 * `/line-share?liff.state=%2Fabc123` and only `liff.init()` on that page sends
 * it on, so read both. Angular already decodes the query value; one leading
 * slash is the path LIFF appended. The payment card is the same with
 * `/pay/<code>/<token>` in place of `/<code>`; a pay link missing either part
 * has no code, so the page says it is missing. A bare `/pay` is one segment,
 * like any summary code, and is read as one. A player's slip link is the same
 * with `/slip/<code>/<token>`; that page is a different component, so this one
 * only recognises it and hands over (see the constructor).
 */
function routeTargetFrom(snapshot: ActivatedRouteSnapshot): RouteTarget {
  const code = snapshot.paramMap.get('sessionCode');
  const token = snapshot.paramMap.get('token');
  if (code && token) return { kind: 'pay', code, token };
  if (code) return { kind: 'summary', code, token: null };
  // LIFF can append its own query or fragment to the state it carries (a return from LINE login adds
  // `?liff.hback=2`), and that must never end up inside the code or the token.
  const state = (snapshot.queryParamMap.get('liff.state') ?? '').split(/[?#]/)[0];
  const path = state.startsWith('/') ? state.slice(1) : state;
  const parts = path.split('/');
  if ((parts[0] === 'pay' || parts[0] === 'slip') && parts.length > 1) {
    return { kind: parts[0], code: parts.length === 3 ? parts[1] : '', token: parts.length === 3 ? parts[2] : null };
  }
  return { kind: 'summary', code: path, token: null };
}

/**
 * The page behind the "ส่งเข้ากลุ่ม" button on the summary card the bot DMs the
 * host, and behind the payment panel's link for a host whose LINE group has no
 * bot. LINE opens it through liff.line.me; the LIFF share picker then sends the
 * card as the host, which the bot could not do from inside a group it is not in.
 */
@Component({
  selector: 'app-line-share',
  templateUrl: './line-share.html',
  styleUrl: './line-share.css',
})
export class LineShare {
  private readonly line = inject(LineService);
  private readonly liff = inject(LiffClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute).snapshot;
  private readonly target = routeTargetFrom(this.route);

  protected readonly kind = this.target.kind;
  protected readonly baht = formatBaht;

  protected readonly phase = signal<Phase>('loading');
  protected readonly summary = signal<LineShareCard | null>(null);
  protected readonly payment = signal<PaymentShareCard | null>(null);
  protected readonly loaded = computed(() => this.summary() !== null || this.payment() !== null);
  protected readonly opening = signal(false);
  protected readonly sendFailed = signal(false);
  private loading = false;

  constructor() {
    const { kind, code, token } = this.target;
    if (kind === 'slip' && code && token) {
      // A player's slip link, as LIFF first opens it. It is not a card to share: the slip page loads
      // its own data and starts LIFF itself, so go there and leave this URL out of the history.
      const queryParams = Object.fromEntries(
        this.route.queryParamMap.keys.filter((k) => k !== 'liff.state').map((k) => [k, this.route.queryParamMap.get(k)!]),
      );
      void this.router.navigate(['/line-share', 'slip', code, token], { replaceUrl: true, queryParams });
      return;
    }
    void this.load();
  }

  /** Re-read before retrying LIFF: an old payment link may have been revoked since the error. */
  protected async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.phase.set('loading');
    this.summary.set(null);
    this.payment.set(null);
    this.sendFailed.set(false);
    try {
      await this.loadCard();
    } finally {
      this.loading = false;
    }
  }

  /** Card first (a missing summary never needs LIFF), then LIFF, then log in if needed. */
  private async loadCard(): Promise<void> {
    const { kind, code, token } = this.target;
    if (!code || (kind !== 'summary' && !token)) {
      this.phase.set('missing');
      return;
    }
    let liffId: string;
    try {
      if (kind === 'pay') {
        const card = await firstValueFrom(this.line.paymentShareCard(code, token!));
        this.payment.set(card);
        liffId = card.liffId;
      } else {
        const card = await firstValueFrom(this.line.shareCard(code));
        this.summary.set(card);
        liffId = card.liffId;
      }
    } catch (e) {
      this.phase.set(e instanceof HttpErrorResponse && e.status === 404 ? 'missing' : 'error');
      return;
    }
    try {
      await this.liff.init(liffId);
    } catch {
      this.phase.set('error');
      return;
    }
    if (!this.liff.isLoggedIn()) {
      // Once: LINE brings the host straight back here, logged in.
      this.phase.set('login');
      this.liff.login(window.location.href);
      return;
    }
    this.phase.set(this.liff.canShare() ? 'ready' : 'unavailable');
  }

  /**
   * Must call `share` straight from the tap, with nothing awaited first:
   * browsers block a popup that is not opened inside the user's gesture.
   */
  protected pick(): void {
    const messages = this.messages();
    if (messages === null || this.opening()) return;
    this.opening.set(true);
    this.sendFailed.set(false);
    this.liff.share(messages).then(
      (result) => {
        this.opening.set(false);
        if (result === 'sent') this.phase.set('done');
      },
      () => {
        this.opening.set(false);
        this.sendFailed.set(true);
      },
    );
  }

  /** What the tap shares: the payment card's messages, or the summary card alone. Null until it is loaded. */
  private messages(): unknown[] | null {
    if (this.kind === 'pay') return this.payment()?.messages ?? null;
    const summary = this.summary();
    return summary === null ? null : [summary.card];
  }

  protected again(): void {
    this.phase.set('ready');
  }
}
