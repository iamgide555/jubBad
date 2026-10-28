import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, type ActivatedRouteSnapshot } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LiffClient } from '../../core/liff-client';
import type { LineShareCard } from '../../core/line.model';
import { LineService } from '../../core/line.service';

type Phase = 'loading' | 'missing' | 'error' | 'login' | 'unavailable' | 'ready' | 'done';

/**
 * The code is in the path (`/line-share/abc123`) once LIFF has redirected, but
 * LIFF first opens the endpoint as `/line-share?liff.state=%2Fabc123` and only
 * `liff.init()` on that page sends it on, so read both. Angular already decodes
 * the query value; one leading slash is the path LIFF appended.
 */
function sessionCodeFrom(snapshot: ActivatedRouteSnapshot): string {
  const fromPath = snapshot.paramMap.get('sessionCode');
  if (fromPath) return fromPath;
  const state = snapshot.queryParamMap.get('liff.state') ?? '';
  return state.startsWith('/') ? state.slice(1) : state;
}

/**
 * The page behind the "ส่งเข้ากลุ่ม" button on the summary card the bot DMs the
 * host. LINE opens it through liff.line.me; the LIFF share picker then sends the
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
  private readonly sessionCode = sessionCodeFrom(inject(ActivatedRoute).snapshot);

  protected readonly phase = signal<Phase>('loading');
  protected readonly data = signal<LineShareCard | null>(null);
  protected readonly opening = signal(false);
  protected readonly sendFailed = signal(false);

  constructor() {
    void this.load();
  }

  /** Card first (a missing summary never needs LIFF), then LIFF, then log in if needed. */
  private async load(): Promise<void> {
    if (!this.sessionCode) {
      this.phase.set('missing');
      return;
    }
    let data: LineShareCard;
    try {
      data = await firstValueFrom(this.line.shareCard(this.sessionCode));
    } catch (e) {
      this.phase.set(e instanceof HttpErrorResponse && e.status === 404 ? 'missing' : 'error');
      return;
    }
    this.data.set(data);
    try {
      await this.liff.init(data.liffId);
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
    const data = this.data();
    if (!data || this.opening()) return;
    this.opening.set(true);
    this.sendFailed.set(false);
    this.liff.share([data.card]).then(
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

  protected again(): void {
    this.phase.set('ready');
  }
}
