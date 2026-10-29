import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import type { PayAccount } from '../../core/pay-account.service';
import type { PaymentCardPanel, PaymentSendOutcome } from '../../core/payment-card.model';
import { PaymentCardService, PaymentDraftService } from '../../core/payment-card.service';
import { BankField } from '../bank-field/bank-field';

type Field = keyof PayAccount;

/** Gives each mounted panel its own input ids, so a sheet and the bill screen can coexist. */
let panelCount = 0;

const sameAccount = (a: PayAccount, b: PayAccount) => a.bank === b.bank && a.number === b.number && a.name === b.name;

/**
 * The payment card's confirm step: who owes what, the receiving account for tonight, and the Confirm and
 * Send actions. One component for the bill screen and the bottom sheet after จบรอบ (`compact`). It renders
 * nothing when the group has no LINE target, and never offers Confirm or Send while an amount is undefined
 * or the session is still open.
 *
 * The three account fields start from an unconfirmed draft kept in memory (so closing the sheet loses
 * nothing), else tonight's confirmed account, else the group default. A confirmed card is only sendable
 * while the fields still match what was confirmed: an edit asks for another Confirm first.
 *
 * `refreshKey` is any value; whenever it changes the panel reads itself again (the bill screen passes the
 * bill, which is replaced after every settings save). What the host has typed survives the re-read.
 *
 * Reads, Confirm and Send share one sequence number: whatever started last owns the screen, so an older
 * answer can never overwrite a newer one. A Confirm that was overtaken by a newer read throws its own answer
 * away and re-reads, because only a fresh read can say which amounts are current. After a failed read the
 * amounts on screen may be old, so Confirm and Send stay off until a read succeeds.
 */
@Component({
  selector: 'app-payment-panel',
  imports: [BankField, RouterLink],
  templateUrl: './payment-panel.html',
  styleUrl: './payment-panel.css',
})
export class PaymentPanel {
  readonly sessionCode = input.required<string>();
  /** The bottom-sheet layout: no heading of its own, and a link out to the bill settings when something is missing. */
  readonly compact = input(false);
  readonly refreshKey = input<unknown>(null);
  /** The host followed the link to the bill settings, so the sheet around the panel should close. */
  readonly closed = output<void>();
  /** The card went into the LINE group. */
  readonly sent = output<void>();

  private readonly cards = inject(PaymentCardService);
  private readonly drafts = inject(PaymentDraftService);

  protected readonly data = signal<PaymentCardPanel | null>(null);
  /** The latest read failed, so what is on screen may be out of date. */
  protected readonly readFailed = signal(false);
  protected readonly ids = {
    bank: `pc${++panelCount}-bank`,
    number: `pc${panelCount}-number`,
    name: `pc${panelCount}-name`,
  };
  protected readonly bank = signal('');
  protected readonly number = signal('');
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly outcome = signal<PaymentSendOutcome | null>(null);
  protected readonly confirmingResend = signal(false);

  /** Session code the fields were last filled for, so they are filled once and a re-read never overwrites typing. */
  private filledFor: string | null = null;
  private seq = 0;

  /** Trimmed, exactly what Confirm would send. */
  private readonly typed = computed<PayAccount>(() => ({
    bank: this.bank().trim(),
    number: this.number().trim(),
    name: this.name().trim(),
  }));
  protected readonly hasAnyField = computed(() => {
    const a = this.typed();
    return a.bank !== '' || a.number !== '' || a.name !== '';
  });
  private readonly complete = computed(() => {
    const a = this.typed();
    return a.bank !== '' && a.number !== '' && a.name !== '';
  });
  /** The fields are not the group default (including emptied ones), so there is something to put back. */
  protected readonly differsFromGroup = computed(() => {
    const group = this.data()?.groupAccount;
    return !!group && !sameAccount(this.typed(), group);
  });
  /** Confirmed, but the fields were changed afterwards: the card on file has the old account. */
  protected readonly editedSinceConfirm = computed(() => {
    const p = this.data();
    return !!p && p.confirmed && !p.stale && !!p.account && !sameAccount(this.typed(), p.account);
  });
  /** Confirmed, current, and matching the fields: the one state in which a send is allowed. */
  private readonly sendable = computed(() => {
    const p = this.data();
    return !!p && p.ready && p.ended && p.rows.length > 0 && p.confirmed && !p.stale && !this.editedSinceConfirm();
  });
  /** Retry is offered whenever a read failed, except for a group that has no payment card at all. */
  protected readonly showRetry = computed(() => this.readFailed() && this.data()?.target !== null);
  protected readonly canSendToGroup = computed(() => this.sendable() && this.data()?.target === 'group');
  protected readonly shareUrl = computed(() => (this.sendable() && this.data()?.target === 'host' ? this.data()!.shareUrl : null));
  /** Amounts are defined, the night is over and someone owes: the account fields and actions apply. */
  protected readonly actionable = computed(() => {
    const p = this.data();
    return !!p && p.ended && p.ready && p.rows.length > 0;
  });
  protected readonly missing = computed(() =>
    (this.data()?.warnings ?? []).filter((w) => !this.data()!.notices.includes(w)).map((w) => this.missingText(w))
  );
  protected readonly noticeTexts = computed(() => (this.data()?.notices ?? []).map((n) => this.noticeText(n)));
  protected readonly lastSentLabel = computed(() => {
    const iso = this.data()?.lastSentAt;
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return $localize`:@@pay.card.sentPlain:ส่งแล้ว`;
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    return $localize`:@@pay.card.sentAt:ส่งแล้ว ${time}:time:`;
  });

  protected readonly amountText = (satang: number): string =>
    satang === 0 ? $localize`:@@pay.card.nothingToPay:ไม่ต้องโอน` : `${formatBaht(satang)}฿`;
  protected readonly baht = formatBaht;

  constructor() {
    effect(() => {
      this.sessionCode();
      this.refreshKey();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const code = this.sessionCode();
    const seq = ++this.seq;
    try {
      const panel = await firstValueFrom(this.cards.panel(code));
      // A later read, Confirm or Send started after this one: its answer is the newer truth.
      if (seq !== this.seq) return;
      this.data.set(panel);
      this.readFailed.set(false);
      if (this.filledFor !== code) {
        this.filledFor = code;
        this.fill(this.drafts.get(code) ?? panel.account ?? panel.groupAccount);
      }
    } catch {
      if (seq === this.seq) this.readFailed.set(true);
    }
  }

  protected edit(field: Field, value: string): void {
    this[field].set(value);
    this.drafts.set(this.sessionCode(), { bank: this.bank(), number: this.number(), name: this.name() });
    this.error.set(null);
    this.outcome.set(null);
    this.confirmingResend.set(false);
  }

  protected useGroupAccount(): void {
    this.fill(this.data()?.groupAccount ?? null);
    this.drafts.clear(this.sessionCode());
    this.error.set(null);
    this.outcome.set(null);
  }

  protected async confirm(): Promise<void> {
    if (this.busy() || this.readFailed() || !this.hasAnyField()) return;
    this.error.set(null);
    this.outcome.set(null);
    this.confirmingResend.set(false);
    if (!this.complete()) {
      this.error.set(this.incompleteText());
      return;
    }
    this.busy.set(true);
    const seq = ++this.seq;
    try {
      const panel = await firstValueFrom(this.cards.confirm(this.sessionCode(), this.typed()));
      this.drafts.clear(this.sessionCode());
      if (seq === this.seq) {
        this.data.set(panel);
        this.readFailed.set(false);
        if (panel.account) this.fill(panel.account);
      } else {
        // A read started while this was in flight, so the answer may predate the amounts it shows.
        void this.load();
      }
    } catch (err) {
      this.error.set(this.confirmError(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected sendClicked(): void {
    if (this.busy() || this.readFailed()) return;
    if (this.data()?.lastSentAt) this.confirmingResend.set(true);
    else void this.send();
  }

  protected async send(): Promise<void> {
    if (this.busy() || this.readFailed()) return;
    this.confirmingResend.set(false);
    this.error.set(null);
    this.outcome.set(null);
    this.busy.set(true);
    ++this.seq;
    try {
      let outcome: PaymentSendOutcome;
      try {
        outcome = await firstValueFrom(this.cards.send(this.sessionCode(), crypto.randomUUID()));
      } catch {
        outcome = 'failed';
      }
      this.outcome.set(outcome);
      if (outcome === 'sent') {
        // Marked sent at once, so the button already reads "send again" (and asks first) while the re-read runs.
        this.data.update((p) => (p ? { ...p, lastSentAt: new Date().toISOString() } : p));
        this.sent.emit();
      }
      // The card moved on under the host, or the send time changed: show the server's current state.
      // Busy until it lands, so a quick second tap cannot slip past the resend prompt.
      if (outcome === 'sent' || outcome === 'stale' || outcome === 'not-confirmed') await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  protected outcomeText(outcome: PaymentSendOutcome): string {
    switch (outcome) {
      case 'sent':
        return $localize`:@@pay.card.outcomeSent:ส่งแล้ว`;
      case 'quota':
        return $localize`:@@pay.card.outcomeQuota:โควต้าข้อความ LINE ของเดือนนี้หมดแล้ว ส่งเข้ากลุ่มไม่ได้`;
      case 'failed':
        return $localize`:@@pay.card.outcomeFailed:ส่งไม่สำเร็จ ลองอีกครั้ง`;
      case 'unavailable':
        return $localize`:@@pay.card.outcomeUnavailable:ตอนนี้ส่งเข้าไลน์ไม่ได้ ตรวจการเชื่อมต่อ LINE ของก๊วน`;
      case 'busy':
        return $localize`:@@pay.card.outcomeBusy:เพิ่งส่งไปเมื่อครู่ รอสักครู่แล้วลองใหม่`;
      case 'stale':
        return $localize`:@@pay.card.outcomeStale:ยอดเปลี่ยนไปแล้ว กดยืนยันยอดอีกครั้ง`;
      case 'not-confirmed':
        return $localize`:@@pay.card.outcomeNotConfirmed:ยังไม่ได้ยืนยันยอด กดยืนยันยอดก่อน`;
    }
  }

  private confirmError(err: unknown): string {
    const code = err instanceof HttpErrorResponse ? (err.error as { code?: unknown } | null)?.code : undefined;
    switch (code) {
      case 'PAY_ACCOUNT_INVALID':
        return $localize`:@@pay.account.invalid:ตรวจบัญชีรับเงินอีกครั้ง ต้องกรอกครบทั้งสามช่อง และเลขบัญชีเป็นตัวเลข 6 หลักขึ้นไป`;
      case 'PAYMENT_NOT_READY':
        // The inputs changed under the host (another tab): show what is missing now.
        void this.load();
        return $localize`:@@pay.card.confirmNotReady:ยืนยันยอดไม่ได้ ยังมียอดที่ไม่ครบ`;
      case 'PAYMENT_NO_ACCOUNT':
        return this.incompleteText();
      case 'PAYMENT_UNAVAILABLE':
        return $localize`:@@pay.card.confirmUnavailable:ใบเก็บเงินใช้ไม่ได้ในตอนนี้ ตรวจการเชื่อมต่อ LINE ของก๊วน`;
      default:
        return $localize`:@@pay.card.confirmFailed:ยืนยันไม่สำเร็จ ลองอีกครั้ง`;
    }
  }

  private incompleteText(): string {
    return $localize`:@@pay.card.incomplete:กรอกให้ครบทั้งสามช่อง`;
  }

  private missingText(code: string): string {
    switch (code) {
      case 'MISSING_COURT_FEE':
        return $localize`:@@pay.card.missingCourtFee:ยังไม่ได้ใส่ค่าสนาม`;
      case 'MISSING_SHUTTLE_COUNT':
        return $localize`:@@pay.card.missingShuttleCount:ยังไม่ได้ใส่จำนวนลูก`;
      case 'MISSING_SHUTTLE_PRICE':
        return $localize`:@@pay.card.missingShuttlePrice:ยังไม่ได้ใส่ราคาลูก`;
      case 'UNKNOWN_SHUTTLE_USE':
        return $localize`:@@pay.card.unknownShuttleUse:มีเกมที่ไม่ได้บันทึกลูก`;
      default:
        // A blocking warning added to the server later still has to be named as something.
        return $localize`:@@pay.card.missingOther:ยังมีข้อมูลที่ขาดในหน้าคิดเงิน`;
    }
  }

  private noticeText(code: string): string {
    switch (code) {
      case 'EXCESS_CREDIT':
        return $localize`:@@pay.card.noticeExcess:ยอดที่เช็คเอาต์ไปแล้วเกินต้นทุน ต้องคืนเงินเองนอกแอป`;
      case 'UNCOVERED_COST':
        return $localize`:@@pay.card.noticeUncovered:มีส่วนที่ขาดซึ่งไม่มีใครเหลือจ่าย ดูรายละเอียดในหน้าคิดเงิน`;
      case 'UNRETURNED_SURCHARGE':
        return $localize`:@@pay.card.noticeSurcharge:ค่า walk-in บางส่วนไม่มีใครรับคืนได้ ดูรายละเอียดในหน้าคิดเงิน`;
      default:
        return $localize`:@@pay.card.noticeOther:ดูรายละเอียดในหน้าคิดเงิน`;
    }
  }

  private fill(account: PayAccount | null): void {
    this.bank.set(account?.bank ?? '');
    this.number.set(account?.number ?? '');
    this.name.set(account?.name ?? '');
  }
}
