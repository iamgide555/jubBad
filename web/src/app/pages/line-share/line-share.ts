import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, type ActivatedRouteSnapshot } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { LiffClient } from '../../core/liff-client';
import type { LineShareCard, PaymentShareCard } from '../../core/line.model';
import { LineService } from '../../core/line.service';

type Phase = 'loading' | 'missing' | 'error' | 'login' | 'unavailable' | 'ready' | 'done';

interface RouteTarget {
  kind: 'summary' | 'pay';
  code: string;
  /** Only for `pay`; never logged or shown. */
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
 * like any summary code, and is read as one.
 */
function routeTargetFrom(snapshot: ActivatedRouteSnapshot): RouteTarget {
  const code = snapshot.paramMap.get('sessionCode');
  const token = snapshot.paramMap.get('token');
  if (code && token) return { kind: 'pay', code, token };
  if (code) return { kind: 'summary', code, token: null };
  const state = snapshot.queryParamMap.get('liff.state') ?? '';
  const path = state.startsWith('/') ? state.slice(1) : state;
  const parts = path.split('/');
  if (parts[0] === 'pay' && parts.length > 1) {
    return { kind: 'pay', code: parts.length === 3 ? parts[1] : '', token: parts.length === 3 ? parts[2] : null };
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
  private readonly target = routeTargetFrom(inject(ActivatedRoute).snapshot);

  protected readonly kind = this.target.kind;
  protected readonly baht = formatBaht;

  protected readonly phase = signal<Phase>('loading');
  protected readonly summary = signal<LineShareCard | null>(null);
  protected readonly payment = signal<PaymentShareCard | null>(null);
  protected readonly loaded = computed(() => this.summary() !== null || this.payment() !== null);
  protected readonly opening = signal(false);
  protected readonly sendFailed = signal(false);

  constructor() {
    void this.load();
  }

  /** Card first (a missing summary never needs LIFF), then LIFF, then log in if needed. */
  private async load(): Promise<void> {
    const { kind, code, token } = this.target;
    if (!code || (kind === 'pay' && !token)) {
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
