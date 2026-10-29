import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import type { PayAccount } from '../../core/pay-account.service';
import type { PaymentCardPanel, PaymentSendOutcome } from '../../core/payment-card.model';
import { PaymentCardService, PaymentDraftService } from '../../core/payment-card.service';
import { BankField } from '../bank-field/bank-field';
import { Icon } from '../icon/icon';

type Field = keyof PayAccount;

/** Which delivery a tap or an outcome belongs to: the bot's post into the group, or its DM to the host. */
type Delivery = 'group' | 'dm';

/** Gives each mounted panel its own input ids, so a sheet and the bill screen can coexist. */
let panelCount = 0;

const sameAccount = (a: PayAccount, b: PayAccount) => a.bank === b.bank && a.number === b.number && a.name === b.name;

const errorCode = (err: unknown): unknown =>
  err instanceof HttpErrorResponse ? (err.error as { code?: unknown } | null)?.code : undefined;

/** "20:15" in local time, or null for a timestamp that does not parse. */
function clock(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** The one primary action of the state on screen: Send for the target once confirmed, else Confirm. */
const PRIMARY = '[data-send], [data-dm-send], [data-confirm]';

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
 * amounts on screen may be old, so Confirm and Send stay off until a read succeeds. Confirm carries the
 * `contentHash` of the read on screen, so the server refuses (PAYMENT_CHANGED) amounts the host has not seen.
 *
 * Amounts are shown only while `ready`: with an input missing they are provisional, so only what is missing
 * is shown (a to-do list, not an error). A night where nobody owes (no rows, or every row at 0) reads as
 * nothing to collect. The amounts render as a small copy of the LINE card itself (header, rows sorted by name,
 * total, account), with the card's own texts and ฿ format, so the host sees what the group will see.
 *
 * One primary action per state: fill in what is missing (sheet only), Confirm (which also locks the account),
 * or Send for the target once confirmed and current. The account fields stay folded into the preview while they
 * are the group default or the confirmed account; "แก้บัญชีคืนนี้" opens them. In the sheet the actions sit in a
 * sticky bottom bar. Focus never drops out of a dialog: busy buttons are `aria-disabled` (a guard refuses the
 * tap) rather than `disabled`, and when a state change removes the focused button focus moves to the next one.
 *
 * Send keeps the `sendId` of an attempt with no definite answer (a `failed` outcome, or no answer at all)
 * and reuses it on the next tap, so a card LINE took while the answer was lost is not posted twice; any
 * definite answer, or a change in the card, starts a new id. Every outcome re-reads the panel.
 *
 * For the `host` target the same machinery also drives "send the card to me": a per-tap request that the bot
 * DMs the card to the host's own chat (its own `sendId`, resend prompt and time). It never tells the host page
 * the card went to the group, and it never runs by itself.
 */
@Component({
  selector: 'app-payment-panel',
  imports: [BankField, Icon, RouterLink],
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
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyed = false;

  protected readonly data = signal<PaymentCardPanel | null>(null);
  protected readonly loading = signal(true);
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
  private readonly operation = signal<'confirm' | Delivery>('confirm');
  protected readonly progress = computed(() => {
    if (!this.busy()) return null;
    if (this.operation() === 'confirm') return $localize`:@@pay.card.confirming:กำลังยืนยันยอดและบัญชี…`;
    return this.operation() === 'dm'
      ? $localize`:@@pay.card.sendingDm:กำลังส่งใบเก็บเงินให้คุณทาง LINE…`
      : $localize`:@@pay.card.sendingGroup:กำลังส่งใบเก็บเงินเข้ากลุ่ม LINE…`;
  });
  protected readonly fieldErrors = signal<Partial<Record<Field, string>>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly outcome = signal<PaymentSendOutcome | null>(null);
  protected readonly confirmingResend = signal(false);
  protected readonly confirmingDmResend = signal(false);
  /** Which delivery `outcome` is the answer to, so a failure or a success reads in the right words. */
  protected readonly outcomeFor = signal<Delivery>('group');
  /** The host opened the account fields ("แก้บัญชีคืนนี้") or typed in them: keep them open. */
  protected readonly editingAccount = signal(false);
  /** A confirm just succeeded on this screen: say so until the host moves on. */
  protected readonly justConfirmed = signal(false);

  /** Session code the fields were last filled for, so they are filled once and a re-read never overwrites typing. */
  private filledFor: string | null = null;
  private seq = 0;
  /** The sendId of an attempt with no definite answer, and the card content it was for; reused by the next tap. */
  private retry: Record<Delivery, { sendId: string; contentHash: string | null; shareUrl: string | null } | null> = {
    group: null,
    dm: null,
  };

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
  /** No rows, or every row at 0 baht: nothing to collect, so no card. */
  protected readonly nothingDue = computed(() => {
    const p = this.data();
    return !!p && (p.rows.length === 0 || p.totalSatang === 0);
  });
  /** Not confirmed yet, or the confirmed card no longer stands: Confirm is the action on screen. */
  protected readonly needsConfirm = computed(() => {
    const p = this.data();
    return !!p && (!p.confirmed || p.stale || this.editedSinceConfirm());
  });
  /** A confirmed card that moved or whose account was edited: Confirm again. */
  protected readonly reconfirm = computed(() => !!this.data()?.confirmed && this.needsConfirm());
  /**
   * The fields hold a complete account the host has not touched (the group default, or the one confirmed for
   * tonight), so they fold into the preview. A draft that differs, or no account at all, keeps them open.
   */
  protected readonly accountFolded = computed(() => {
    const p = this.data();
    if (!p || this.editingAccount() || !this.complete()) return false;
    const typed = this.typed();
    return (!!p.groupAccount && sameAccount(typed, p.groupAccount)) || (!!p.account && sameAccount(typed, p.account));
  });
  /** The account block the card would print: the fields, once all three are filled in. */
  protected readonly previewAccount = computed(() => (this.complete() ? this.typed() : null));
  /** Confirmed, current, and matching the fields: the one state in which a send is allowed. */
  private readonly sendable = computed(() => {
    const p = this.data();
    return !!p && this.actionable() && p.confirmed && !p.stale && !this.editedSinceConfirm();
  });
  /** Retry is offered whenever a read failed, except for a group that has no payment card at all. */
  protected readonly showRetry = computed(() => this.readFailed() && this.data()?.target !== null);
  protected readonly canSendToGroup = computed(() => this.sendable() && this.data()?.target === 'group');
  protected readonly shareUrl = computed(() => (this.sendable() && this.data()?.target === 'host' ? this.data()!.shareUrl : null));
  /** Amounts are defined, the night is over and someone owes: the account fields and actions apply. */
  protected readonly actionable = computed(() => {
    const p = this.data();
    return !!p && p.ended && p.ready && !this.nothingDue();
  });
  protected readonly missing = computed(() =>
    (this.data()?.warnings ?? []).filter((w) => !this.data()!.notices.includes(w)).map((w) => this.missingText(w))
  );
  protected readonly noticeTexts = computed(() => (this.data()?.notices ?? []).map((n) => this.noticeText(n)));
  protected readonly lastSentLabel = computed(() => this.sentLabel(this.data()?.lastSentAt));
  /**
   * The DM's own status, never the group's "ส่งแล้ว": the card is in the host's chat, not the group yet. Only
   * while that card is the current one (a stale or edited card needs a new confirm and a new DM).
   */
  protected readonly dmStatus = computed(() => {
    const iso = this.data()?.lastDmAt;
    if (!iso || this.shareUrl() === null) return null;
    const time = clock(iso);
    return time === null
      ? $localize`:@@pay.card.dmSentPlain:ส่งให้คุณใน LINE แล้ว · ยังต้องกด "ส่งเข้ากลุ่ม" ในแชต`
      : $localize`:@@pay.card.dmSentAt:ส่งให้คุณใน LINE แล้ว ${time}:time: · ยังต้องกด "ส่งเข้ากลุ่ม" ในแชต`;
  });
  /** The DM ran out of LINE quota: the other way to send is the way now, so it opens by itself. */
  protected readonly dmQuota = computed(() => this.outcome() === 'quota' && this.outcomeFor() === 'dm');
  /** Something to tap in the action row: the link to the bill (sheet, not ready), Confirm, or a Send. */
  protected readonly hasActions = computed(() => {
    const p = this.data();
    if (!p) return false;
    if (!p.ready) return this.compact();
    return this.actionable() && (this.needsConfirm() || this.canSendToGroup() || this.shareUrl() !== null);
  });

  /** Baht sign first, as the LINE card prints it. */
  protected readonly amountText = (satang: number): string =>
    satang === 0 ? $localize`:@@pay.card.nothingToPay:ไม่ต้องโอน` : `฿${formatBaht(satang)}`;
  protected readonly baht = formatBaht;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    effect(() => {
      this.sessionCode();
      this.refreshKey();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const code = this.sessionCode();
    const seq = ++this.seq;
    this.loading.set(true);
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
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  protected edit(field: Field, value: string): void {
    this[field].set(value);
    this.drafts.set(this.sessionCode(), { bank: this.bank(), number: this.number(), name: this.name() });
    // Typing never folds the fields away under the host's thumb, even when they end up equal to the default.
    this.editingAccount.set(true);
    this.justConfirmed.set(false);
    this.error.set(null);
    this.fieldErrors.update((errors) => ({ ...errors, [field]: undefined }));
    this.outcome.set(null);
    this.confirmingResend.set(false);
    this.confirmingDmResend.set(false);
  }

  /** "แก้บัญชีคืนนี้": unfold the three fields; focus lands on their group, not on the bank list. */
  protected editAccount(): void {
    this.editingAccount.set(true);
    this.justConfirmed.set(false);
    this.refocus('[data-account-fields]');
  }

  protected useGroupAccount(): void {
    this.fill(this.data()?.groupAccount ?? null);
    this.drafts.clear(this.sessionCode());
    this.editingAccount.set(false);
    this.error.set(null);
    this.fieldErrors.set({});
    this.outcome.set(null);
    this.refocus('[data-edit-account], [data-account-fields]');
  }

  protected async confirm(): Promise<void> {
    const seen = this.data();
    if (this.busy() || this.readFailed() || !this.hasAnyField() || !seen) return;
    this.error.set(null);
    this.outcome.set(null);
    this.confirmingResend.set(false);
    this.confirmingDmResend.set(false);
    const errors = this.accountErrors();
    this.fieldErrors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.error.set(this.complete() ? Object.values(errors)[0]! : this.incompleteText());
      this.cdr.detectChanges();
      this.host.nativeElement.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
      return;
    }
    this.operation.set('confirm');
    this.loading.set(false);
    this.busy.set(true);
    this.justConfirmed.set(false);
    const seq = ++this.seq;
    try {
      const panel = await firstValueFrom(this.cards.confirm(this.sessionCode(), this.typed(), seen.contentHash));
      this.drafts.clear(this.sessionCode());
      // Every confirm mints a new share token, so a kept DM attempt would be for a card with a dead link.
      this.retry.dm = null;
      if (seq === this.seq) {
        this.data.set(panel);
        this.readFailed.set(false);
        if (panel.account) this.fill(panel.account);
      } else {
        // A read started while this was in flight, so the answer may predate the amounts it shows. Busy until
        // the re-read lands, so a second Confirm cannot freeze amounts the host has not seen yet.
        await this.load();
      }
      // The account is locked in the card now: fold it back into the preview, say so, and hand focus (and the
      // screen) to the Send that replaced the Confirm button.
      this.editingAccount.set(false);
      this.justConfirmed.set(true);
      this.busy.set(false);
      this.refocus(PRIMARY, true);
    } catch (err) {
      const code = errorCode(err);
      this.error.set(this.confirmError(code));
      // The card moved under the host (another tab): show what stands now before Confirm is usable again.
      if (code === 'PAYMENT_CHANGED' || code === 'PAYMENT_NOT_READY' || code === 'PAYMENT_NOTHING_DUE') {
        await this.load();
      }
    } finally {
      this.busy.set(false);
      // An error re-read can remove Confirm too: keep focus inside the sheet in its new state.
      this.refocus(PRIMARY);
    }
  }

  protected sendClicked(): void {
    if (this.busy() || this.readFailed()) return;
    if (this.data()?.lastSentAt) {
      this.confirmingResend.set(true);
      this.refocus('[data-resend-yes]');
    } else void this.send();
  }

  protected sendDmClicked(): void {
    if (this.busy() || this.readFailed()) return;
    if (this.data()?.lastDmAt) {
      this.confirmingDmResend.set(true);
      this.refocus('[data-dm-resend-yes]');
    } else void this.sendDm();
  }

  protected cancelResend(kind: Delivery): void {
    if (kind === 'dm') this.confirmingDmResend.set(false);
    else this.confirmingResend.set(false);
    this.refocus(kind === 'dm' ? '[data-dm-send]' : '[data-send]');
  }

  protected send(): Promise<void> {
    return this.deliver('group');
  }

  protected sendDm(): Promise<void> {
    return this.deliver('dm');
  }

  private async deliver(kind: Delivery): Promise<void> {
    if (this.busy() || this.readFailed()) return;
    this.confirmingResend.set(false);
    this.confirmingDmResend.set(false);
    this.error.set(null);
    this.outcome.set(null);
    this.outcomeFor.set(kind);
    this.operation.set(kind);
    this.loading.set(false);
    this.justConfirmed.set(false);
    this.busy.set(true);
    // Closing a resend prompt removes its focused Yes button. Keep focus on the busy Send immediately,
    // including while LINE and the subsequent panel read are still pending.
    this.refocus(PRIMARY);
    ++this.seq;
    const contentHash = this.data()?.contentHash ?? null;
    // An attempt with no definite answer may have reached LINE: retry it under the same id, unless the card changed.
    let attempt = this.retry[kind];
    // The DM card embeds the share link, which every confirm replaces, so a new link is a new card too.
    const shareUrl = this.data()?.shareUrl ?? null;
    if (attempt === null || attempt.contentHash !== contentHash || attempt.shareUrl !== shareUrl) {
      attempt = this.retry[kind] = { sendId: crypto.randomUUID(), contentHash, shareUrl };
    }
    try {
      let outcome: PaymentSendOutcome;
      try {
        const request =
          kind === 'dm'
            ? this.cards.sendDm(this.sessionCode(), attempt.sendId)
            : this.cards.send(this.sessionCode(), attempt.sendId);
        outcome = await firstValueFrom(request);
      } catch {
        outcome = 'failed';
      }
      // Any answer but `failed` is definite: the next tap is a new attempt with a new id.
      if (outcome !== 'failed') this.retry[kind] = null;
      this.outcome.set(outcome);
      if (outcome === 'sent') {
        // Marked sent at once, so the button already reads "send again" (and asks first) while the re-read runs.
        const at = new Date().toISOString();
        this.data.update((p) => (p ? (kind === 'dm' ? { ...p, lastDmAt: at } : { ...p, lastSentAt: at }) : p));
        // The host page's banner is about the group post; a DM to the host does not settle it.
        if (kind === 'group') this.sent.emit();
      }
      // Whatever happened, show the server's current state (the send time, a card moved on, a lapsed link).
      // Busy until it lands, so a quick second tap cannot slip past the resend prompt.
      await this.load();
    } finally {
      this.busy.set(false);
      // A re-read can replace Send with Confirm, or remove all actions when the card is unavailable.
      this.refocus(PRIMARY);
    }
  }

  protected outcomeText(outcome: PaymentSendOutcome): string {
    const dm = this.outcomeFor() === 'dm';
    switch (outcome) {
      case 'sent':
        // A DM's success is told by `dmStatus` (with its time and what is still left to do), never as "ส่งแล้ว".
        return dm ? (this.dmStatus() ?? '') : $localize`:@@pay.card.outcomeSent:ส่งแล้ว`;
      case 'quota':
        return dm
          ? $localize`:@@pay.card.dmQuotaOther:โควต้าข้อความ LINE ของเดือนนี้หมดแล้ว ส่งการ์ดให้คุณไม่ได้ ใช้ "เปิดใน LINE เพื่อส่ง" ใน "ส่งวิธีอื่น" แทน`
          : $localize`:@@pay.card.outcomeQuota:โควต้าข้อความ LINE ของเดือนนี้หมดแล้ว ส่งเข้ากลุ่มไม่ได้`;
      case 'failed':
        return dm
          ? $localize`:@@pay.card.dmFailed:ส่งไม่สำเร็จ ลองอีกครั้ง ถ้ายังไม่ได้ อาจเพราะบล็อกหรือลบบอทไปแล้ว ให้เพิ่มบอทเป็นเพื่อนอีกครั้ง`
          : $localize`:@@pay.card.outcomeFailed:ส่งไม่สำเร็จ ลองอีกครั้ง`;
      case 'unavailable':
        return $localize`:@@pay.card.outcomeUnavailable:ตอนนี้ส่งเข้าไลน์ไม่ได้ ตรวจการเชื่อมต่อ LINE ของก๊วน`;
      case 'busy':
        return dm
          ? $localize`:@@pay.card.dmBusy:เพิ่งส่งการ์ดให้คุณไปแล้ว ดูในแชต LINE`
          : $localize`:@@pay.card.outcomeBusyPosted:เพิ่งส่งเข้ากลุ่มไปแล้ว`;
      case 'stale':
        return $localize`:@@pay.card.outcomeStale:ยอดเปลี่ยนไปแล้ว กดยืนยันยอดอีกครั้ง`;
      case 'not-confirmed':
        return $localize`:@@pay.card.outcomeNotConfirmed:ยังไม่ได้ยืนยันยอด กดยืนยันยอดก่อน`;
    }
  }

  /**
   * The caller re-reads the panel for the codes that mean the card moved (changed, not ready, nothing due).
   * Null means no error text: for nothing due the re-read itself says it, with the empty state.
   */
  private confirmError(code: unknown): string | null {
    switch (code) {
      case 'PAY_ACCOUNT_INVALID':
        return $localize`:@@pay.account.invalid:ตรวจบัญชีรับเงินอีกครั้ง ต้องกรอกครบทั้งสามช่อง และเลขบัญชีเป็นตัวเลข 6 หลักขึ้นไป`;
      case 'PAYMENT_CHANGED':
        return $localize`:@@pay.card.confirmChanged:ยอดเปลี่ยน ตรวจยอดอีกครั้ง`;
      case 'PAYMENT_NOT_READY':
        return $localize`:@@pay.card.confirmNotReady:ยืนยันยอดไม่ได้ ยังมียอดที่ไม่ครบ`;
      case 'PAYMENT_NOTHING_DUE':
        return null;
      case 'PAYMENT_NO_ACCOUNT':
        return this.incompleteText();
      case 'PAYMENT_UNAVAILABLE':
        return $localize`:@@pay.card.confirmUnavailable:ใบเก็บเงินใช้ไม่ได้ในตอนนี้ ตรวจการเชื่อมต่อ LINE ของก๊วน`;
      default:
        return $localize`:@@pay.card.confirmFailed:ยืนยันไม่สำเร็จ ลองอีกครั้ง`;
    }
  }

  /** "ส่งแล้ว 20:15" (the group post), or the bare word for a timestamp that does not parse; null when never sent. */
  private sentLabel(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const time = clock(iso);
    if (time === null) return $localize`:@@pay.card.sentPlain:ส่งแล้ว`;
    return $localize`:@@pay.card.sentAt:ส่งแล้ว ${time}:time:`;
  }

  /**
   * Renders the state change now, then, if it removed the button that held focus (focus fell to the body),
   * focuses `selector`'s first match so a keyboard or screen-reader user stays in the panel (and the dialog).
   * With `reveal`, the target is also scrolled into view, focused or not. Synchronous detectChanges, as
   * GroupEntry.focusAfterRender does; no afterNextRender (see core/motion/reveal.directive.ts).
   */
  private refocus(selector: string, reveal = false): void {
    if (this.destroyed) return;
    this.cdr.detectChanges();
    const target = this.host.nativeElement.querySelector<HTMLElement>(selector) ?? this.host.nativeElement;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      if (target === this.host.nativeElement) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    if (reveal) target.scrollIntoView?.({ block: 'nearest' });
  }

  private incompleteText(): string {
    return $localize`:@@pay.card.incomplete:กรอกให้ครบทั้งสามช่อง`;
  }

  /** Same limits as the group settings and server; validation never discards tonight's draft. */
  private accountErrors(): Partial<Record<Field, string>> {
    const account = this.typed();
    const errors: Partial<Record<Field, string>> = {};
    const required = $localize`:@@pay.account.required:กรอกช่องนี้`;
    if (!account.bank) errors.bank = required;
    else if (account.bank.length > 40) errors.bank = $localize`:@@pay.card.bankTooLong:ชื่อธนาคารยาวได้ไม่เกิน 40 ตัวอักษร`;
    if (!account.number) errors.number = required;
    else if (!/^[0-9 -]{6,20}$/.test(account.number) || account.number.replace(/[^0-9]/g, '').length < 6) {
      errors.number = $localize`:@@pay.account.badNumber:เลขบัญชีต้องเป็นตัวเลขอย่างน้อย 6 หลัก เว้นวรรคหรือใส่ขีดได้ ยาวไม่เกิน 20 ตัวอักษร`;
    }
    if (!account.name) errors.name = required;
    else if (account.name.length > 80) errors.name = $localize`:@@pay.card.nameTooLong:ชื่อบัญชียาวได้ไม่เกิน 80 ตัวอักษร`;
    return errors;
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
