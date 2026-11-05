import { HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import { LiffClient } from '../../core/liff-client';
import type { SlipPayChoice, SlipPayClaimOutcome, SlipPayClaimable, SlipPayView } from '../../core/slip-pay.model';
import { SlipPayService } from '../../core/slip-pay.service';

type Phase = 'loading' | 'login' | 'unavailable' | 'error' | 'ready';
/** A short message under the form; never a raw outcome string or HTTP code. */
type Notice = 'duplicate' | 'alreadySent' | 'notSlip' | 'rate' | 'tooBig' | 'generic';
type ClaimNote = 'taken' | 'accountLinked' | 'notOnBill' | 'rate' | 'generic';
type CoverNote = 'exceeds' | 'alreadyPaid' | 'notOnBill' | 'rate' | 'generic';

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
  imports: [NgTemplateOutlet],
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
  protected readonly changing = signal(false);
  /** Why "not my name" did nothing: the pick is locked, or the request failed. */
  protected readonly changeNote = signal<'locked' | 'generic' | null>(null);
  protected readonly uploading = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** Set once a slip is accepted or handed to the host; the page then stops offering to send. */
  protected readonly result = signal<'paid' | 'waiting' | null>(null);
  protected readonly cashNote = signal(false);
  /** The viewer's ticks on the "who does this slip cover" list; null until they touch it (their own row is ticked). */
  private readonly picksDraft = signal<string[] | null>(null);
  protected readonly covering = signal(false);
  protected readonly coverNote = signal<CoverNote | null>(null);
  /** What a covered slip paid, for the result screen: the names and the slip amount. */
  protected readonly covered = signal<{ names: string; amountSatang: number } | null>(null);

  protected readonly choice = computed<SlipPayChoice | null>(() => this.view()?.choice ?? null);
  protected readonly picks = computed<string[]>(() => {
    const c = this.choice();
    if (!c) return [];
    const ids = new Set(c.options.map((o) => o.playerId));
    return (this.picksDraft() ?? (c.ownPlayerId ? [c.ownPlayerId] : [])).filter((id) => ids.has(id));
  });
  protected readonly picksTotal = computed(() =>
    (this.choice()?.options ?? []).filter((o) => this.picks().includes(o.playerId)).reduce((sum, o) => sum + o.amountSatang, 0)
  );
  /** Same cap as the host's review: someone picked, and the total not over the slip. */
  protected readonly canCover = computed(() => {
    const c = this.choice();
    return c !== null && this.picks().length > 0 && this.picksTotal() <= c.amountSatang && !this.covering();
  });

  /** Which body to show once the view has loaded. */
  protected readonly screen = computed<'closed' | 'result' | 'choose' | 'paid' | 'claim' | 'send' | null>(() => {
    const v = this.view();
    if (v === null) return null;
    if (v.collectionClosed) return 'closed';
    if (this.result() !== null) return 'result';
    if (v.choice) return 'choose';
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

  protected togglePick(playerId: string): void {
    const now = new Set(this.picks());
    if (now.has(playerId)) now.delete(playerId);
    else now.add(playerId);
    this.picksDraft.set((this.choice()?.options ?? []).map((o) => o.playerId).filter((id) => now.has(id)));
  }

  /** The slip pays for the picked people at once; the server holds the same cap the host is held to. */
  protected async cover(): Promise<void> {
    const c = this.choice();
    if (!c || !this.canCover()) return;
    const picked = c.options.filter((o) => this.picks().includes(o.playerId));
    this.covering.set(true);
    this.coverNote.set(null);
    try {
      const { outcome } = await firstValueFrom(this.api.cover(this.code, this.token, this.accessToken, picked.map((o) => o.playerId)));
      if (outcome === 'paid') {
        this.covered.set({ names: picked.map((o) => o.name).join(', '), amountSatang: c.amountSatang });
        this.result.set('paid');
      } else if (outcome !== 'gone') {
        this.coverNote.set(outcome === 'exceeds' ? 'exceeds' : outcome === 'already-paid' ? 'alreadyPaid' : 'notOnBill');
      }
      // Paid or not, who still owes may have changed: read the list again.
      this.picksDraft.set(null);
      const read = await this.refresh();
      if (read === 'gone') this.phase.set('unavailable');
    } catch (e) {
      if (isStatus(e, 404)) this.phase.set('unavailable');
      else this.coverNote.set(isStatus(e, 429) ? 'rate' : 'generic');
    } finally {
      this.covering.set(false);
    }
  }

  /** Leave it to the host: the slip is already in their list. */
  protected leaveToHost(): void {
    this.result.set('waiting');
  }

  /** "Not my name": drop the viewer's own pick, then the name list shows again (from the send or waiting screen). */
  protected async changeName(): Promise<void> {
    if (this.changing() || this.view()?.collectionClosed) return;
    this.changing.set(true);
    this.changeNote.set(null);
    try {
      const { outcome } = await firstValueFrom(this.api.unclaim(this.code, this.token, this.accessToken));
      const read = await this.refresh();
      if (read === 'gone') this.phase.set('unavailable');
      else if (read === 'failed') this.changeNote.set('generic');
      else if (outcome === 'locked') this.changeNote.set('locked');
      else {
        this.result.set(null);
        this.skipped.set(false);
        this.notice.set(null);
        this.cashNote.set(false);
      }
    } catch (e) {
      if (isStatus(e, 404)) this.phase.set('unavailable');
      else this.changeNote.set('generic');
    } finally {
      this.changing.set(false);
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
        case 'choose': {
          // The view now carries the choice; the screen follows it.
          this.picksDraft.set(null);
          this.coverNote.set(null);
          const read = await this.refresh();
          if (read === 'gone') this.phase.set('unavailable');
          else if (read === 'failed') this.result.set('waiting');
          break;
        }
        case 'duplicate':
          this.notice.set('duplicate');
          break;
        case 'already-sent':
          this.notice.set('alreadySent');
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
