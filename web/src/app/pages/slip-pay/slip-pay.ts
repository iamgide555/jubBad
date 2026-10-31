import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { LiffClient } from '../../core/liff-client';
import type { SlipPayClaimOutcome, SlipPayClaimable, SlipPayView } from '../../core/slip-pay.model';
import { SlipPayService } from '../../core/slip-pay.service';

type Phase = 'loading' | 'login' | 'unavailable' | 'error' | 'ready';
/** A short message under the form; never a raw outcome string or HTTP code. */
type Notice = 'duplicate' | 'notSlip' | 'rate' | 'tooBig' | 'generic';
type ClaimNote = 'taken' | 'accountLinked' | 'notOnBill' | 'rate' | 'generic';

const CLAIM_NOTE: Record<Exclude<SlipPayClaimOutcome, 'linked'>, ClaimNote> = {
  'player-taken': 'taken',
  'account-already-linked': 'accountLinked',
  'not-on-bill': 'notOnBill',
};

/**
 * The player's pay page, opened from the payment card's send-slip button inside
 * LINE. LIFF gives the viewer's LINE identity (an access token the server
 * verifies with LINE); the pay token in the path says which session's bill it
 * is. First visit: pick your name once. After that: pick a photo and it is sent
 * at once. The server retains the private photo until the host closes collection.
 */
@Component({
  selector: 'app-slip-pay',
  templateUrl: './slip-pay.html',
  styleUrl: './slip-pay.css',
})
export class SlipPay {
  private readonly api = inject(SlipPayService);
  private readonly liff = inject(LiffClient);
  private readonly snapshot = inject(ActivatedRoute).snapshot;
  /** Neither is ever rendered or logged. */
  private readonly code = this.snapshot.paramMap.get('sessionCode') ?? '';
  private readonly token = this.snapshot.paramMap.get('token') ?? '';
  private accessToken = '';
  private liffReady = false;
  private loading = false;

  protected readonly baht = formatBaht;

  protected readonly phase = signal<Phase>('loading');
  protected readonly view = signal<SlipPayView | null>(null);
  /** The viewer chose "I'm paying for someone else". */
  protected readonly skipped = signal(false);
  protected readonly claiming = signal(false);
  protected readonly claimNote = signal<ClaimNote | null>(null);
  protected readonly uploading = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** Set once a slip is accepted or handed to the host; the page then stops offering to send. */
  protected readonly result = signal<'paid' | 'waiting' | null>(null);
  protected readonly cashNote = signal(false);

  /** Which body to show once the view has loaded. */
  protected readonly screen = computed<'closed' | 'result' | 'paid' | 'claim' | 'send' | null>(() => {
    const v = this.view();
    if (v === null) return null;
    if (v.collectionClosed) return 'closed';
    if (this.result() !== null) return 'result';
    if (v.alreadyPaid && v.amountSatang !== null) return 'paid';
    if (v.playerName === null && v.claimable.length > 0 && !this.skipped()) return 'claim';
    return 'send';
  });

  constructor() {
    void this.load();
  }

  /** Also the retry: re-reads everything that failed, and runs LIFF's init only once. */
  protected async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.phase.set('loading');
    try {
      await this.start();
    } finally {
      this.loading = false;
    }
  }

  private async start(): Promise<void> {
    if (!this.code || !this.token) {
      this.phase.set('unavailable');
      return;
    }
    if (!this.liffReady) {
      let liffId: string;
      try {
        liffId = (await firstValueFrom(this.api.config(this.code, this.token))).liffId;
      } catch (e) {
        this.phase.set(isStatus(e, 404) ? 'unavailable' : 'error');
        return;
      }
      try {
        await this.liff.init(liffId);
      } catch {
        this.phase.set('error');
        return;
      }
      this.liffReady = true;
    }
    if (!this.liff.isLoggedIn()) {
      // Once: LINE brings the player straight back here, logged in. The access token only exists after that.
      this.phase.set('login');
      this.liff.login(window.location.href);
      return;
    }
    const accessToken = this.liff.getAccessToken();
    if (!accessToken) {
      this.phase.set('error');
      return;
    }
    this.accessToken = accessToken;
    const outcome = await this.refresh();
    if (outcome === 'ok') this.phase.set('ready');
    else this.phase.set(outcome === 'gone' ? 'unavailable' : 'error');
  }

  private async refresh(): Promise<'ok' | 'gone' | 'failed'> {
    try {
      this.view.set(await firstValueFrom(this.api.view(this.code, this.token, this.accessToken)));
      return 'ok';
    } catch (e) {
      return isStatus(e, 404) ? 'gone' : 'failed';
    }
  }

  protected async claim(player: SlipPayClaimable): Promise<void> {
    if (this.claiming() || this.view()?.collectionClosed) return;
    this.claiming.set(true);
    this.claimNote.set(null);
    try {
      const { outcome } = await firstValueFrom(this.api.claim(this.code, this.token, this.accessToken, player.playerId));
      // Whatever the outcome, the list may have changed under the viewer: read it again.
      const read = await this.refresh();
      if (read === 'gone') this.phase.set('unavailable');
      else if (read === 'failed') this.claimNote.set('generic');
      else if (outcome !== 'linked') this.claimNote.set(CLAIM_NOTE[outcome] ?? 'generic');
    } catch (e) {
      if (isStatus(e, 404)) this.phase.set('unavailable');
      else this.claimNote.set(isStatus(e, 429) ? 'rate' : 'generic');
    } finally {
      this.claiming.set(false);
    }
  }

  protected skip(): void {
    this.skipped.set(true);
  }

  protected showCashNote(): void {
    this.cashNote.set(true);
  }

  /** A photo was chosen: send it at once, no second confirmation. */
  protected async picked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared so choosing the same photo again still fires `change`.
    input.value = '';
    if (!file || this.uploading() || this.view()?.collectionClosed) return;
    this.uploading.set(true);
    this.notice.set(null);
    try {
      const { outcome } = await firstValueFrom(this.api.upload(this.code, this.token, this.accessToken, file));
      switch (outcome) {
        case 'paid':
        case 'waiting':
          this.result.set(outcome);
          break;
        case 'duplicate':
          this.notice.set('duplicate');
          break;
        case 'not-slip':
          this.notice.set('notSlip');
          break;
        default:
          this.notice.set('generic');
      }
    } catch (e) {
      if (isStatus(e, 404)) this.phase.set('unavailable');
      else if (isStatus(e, 429)) this.notice.set('rate');
      else if (isStatus(e, 413)) this.notice.set('tooBig');
      else if (isStatus(e, 400)) this.notice.set('notSlip');
      else this.notice.set('generic');
    } finally {
      this.uploading.set(false);
    }
  }
}

function isStatus(e: unknown, status: number): boolean {
  return e instanceof HttpErrorResponse && e.status === status;
}
