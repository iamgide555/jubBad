import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import type { SlipHostConflict, SlipHostPanel, SlipPaidRow, SlipWaiting } from '../../core/slip-host.model';
import { SlipHostService } from '../../core/slip-host.service';

/** One row of tonight's bill, as the payment panel shows it. */
export interface SlipReviewRow {
  playerId: string;
  name: string;
  amountSatang: number;
  absent: boolean;
}

interface Person {
  playerId: string;
  /** Null when nobody knows this person's name (a paid mark whose player left the bill). */
  name: string | null;
  paid: SlipPaidRow | null;
  pending: boolean;
}

interface WaitingCard {
  slip: SlipWaiting;
  reviewedAmount: string;
  reviewedSatang: number | null;
  selectedTotal: number;
  difference: number | null;
  canResolve: boolean;
  /** The unpaid people this slip can cover, in bill order. */
  covers: string[];
  senderId: string | null;
  /** Picking this sender would replace the LINE account already linked to that player. */
  senderWarning: boolean;
  /** The saved-name fix applies: a receiver mismatch with a name read from the slip. */
  canFixName: boolean;
  nameUpdated: boolean;
}

const CONFLICT_TEXT: Record<SlipHostConflict, () => string> = {
  SLIP_AMOUNT_REQUIRED: () => $localize`:@@slipReview.err.amountRequired:กรอกยอดที่ตรวจจากสลิปก่อนยืนยัน`,
  SLIP_AMOUNT_INVALID: () => $localize`:@@slipReview.err.amountInvalid:กรอกยอดเงินมากกว่า 0 และทศนิยมไม่เกิน 2 ตำแหน่ง`,
  SLIP_AMOUNT_MISMATCH: () => $localize`:@@slipReview.err.amountMismatch:ยอดสลิปต้องเท่ากับยอดรวมคนที่เลือก`,
  PLAYER_ALREADY_PAID: () => $localize`:@@slipReview.err.alreadyPaid:มีคนที่ชำระแล้ว ลองตรวจรายชื่ออีกครั้ง`,
  COLLECTION_CLOSED: () => $localize`:@@slipReview.err.closed:เก็บเงินครบแล้ว แก้ไขการชำระเงินไม่ได้`,
  COLLECTION_NOT_READY: () => $localize`:@@slipReview.err.notReady:ยังปิดการเก็บเงินไม่ได้ ตรวจยอดและรายการรอตรวจก่อน`,
  COVERS_REQUIRED: () => $localize`:@@slipReview.err.coversRequired:เลือกคนที่สลิปนี้จ่ายให้อย่างน้อย 1 คน`,
  PLAYER_NOT_ON_BILL: () => $localize`:@@slipReview.err.notOnBill:มีคนที่ไม่อยู่ในบิลแล้ว ลองดูรายชื่ออีกครั้ง`,
  ACCOUNT_ALREADY_LINKED: () => $localize`:@@slipReview.err.accountLinked:บัญชี LINE นี้ผูกกับคนอื่นอยู่แล้ว`,
  PLAYER_NOT_IN_GROUP: () => $localize`:@@slipReview.err.notInGroup:คนนี้ไม่ได้อยู่ในก๊วนนี้แล้ว`,
  NAME_UPDATE_NOT_APPLICABLE: () => $localize`:@@slipReview.err.nameNotApplicable:เปลี่ยนชื่อผู้รับจากสลิปนี้ไม่ได้`,
  PAY_ACCOUNT_INVALID: () => $localize`:@@slipReview.err.accountInvalid:ชื่อผู้รับบนสลิปใช้ไม่ได้ ไปแก้ในการตั้งค่าบัญชีรับเงิน`,
};

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** "20:15" in local time, or null for a timestamp that does not parse. */
function clock(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

let reviewCount = 0;

/**
 * The host's side of slip payments on a confirmed payment card: who has paid (and how), the slips held for a
 * decision, duplicate slips, and the LINE accounts linked to players. It loads its own data and re-reads it after
 * every action and whenever the card's rows change, so the page never guesses what the server now says. All it
 * keeps is view state (what is ticked, which action is running); the rules live on the server.
 *
 * The "sender is" pick is pre-filled with the single ticked person only for an `unmapped` slip, the one reason that
 * proves the sender's account is not linked yet. Any other pick the host makes stands until they change it.
 */
@Component({
  selector: 'app-slip-review',
  templateUrl: './slip-review.html',
  styleUrl: './slip-review.css',
})
export class SlipReview {
  readonly code = input.required<string>();
  /** The panel's rows. Anyone owing nothing is left out of the status list. */
  readonly rows = input.required<readonly SlipReviewRow[]>();
  /**
   * The group's saved pay-account name: the one "update saved name" rewrites, shown as the old name in its
   * confirmation. Null when the group saves none; there is then nothing to update and the button is not offered.
   */
  readonly savedName = input<string | null>(null);

  private readonly api = inject(SlipHostService);
  private readonly nameDialog = viewChild<ElementRef<HTMLDialogElement>>('nameDialog');
  private readonly imageDialog = viewChild<ElementRef<HTMLDialogElement>>('imageDialog');
  private readonly closeDialog = viewChild<ElementRef<HTMLDialogElement>>('closeDialog');
  protected readonly failedImages = signal<ReadonlySet<string>>(new Set());
  protected readonly canClose = computed(() => !this.closed() ? !!this.data()?.collection?.canClose : (this.data()?.collection?.imageCount ?? 0) > 0);
  protected readonly enlargedImage = signal<string | null>(null);
  protected readonly closed = computed(() => !!this.data()?.collection?.closedAt);
  protected readonly imageUrl = (id: string) => this.api.imageUrl(this.code(), id);
  private readonly amountDraft = signal<Record<string, string>>({});
  private seq = 0;
  private readonly locked = new Set<string>();

  protected readonly baht = formatBaht;
  protected readonly clock = clock;
  protected readonly uid = `sr${++reviewCount}`;

  protected readonly data = signal<SlipHostPanel | null>(null);
  protected readonly loadFailed = signal(false);
  /** Action keys with a request in flight; a second tap on the same one does nothing. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  protected readonly errors = signal<Record<string, string>>({});
  private readonly coversDraft = signal<Record<string, string[]>>({});
  private readonly senderDraft = signal<Record<string, string | null>>({});
  protected readonly namesUpdated = signal<ReadonlySet<string>>(new Set());
  protected readonly nameConfirm = signal<{ slipId: string; oldName: string | null; newName: string } | null>(null);

  private readonly billed = computed(() => this.rows().filter((r) => r.amountSatang > 0));
  private readonly paidById = computed(() => new Map((this.data()?.paid ?? []).map((p) => [p.playerId, p])));

  protected readonly people = computed<Person[]>(() => {
    const paid = this.paidById();
    const billed = this.billed();
    const shown = new Set(billed.map((r) => r.playerId));
    const known = new Map(this.rows().map((r) => [r.playerId, r.name]));
    const linkNames = new Map((this.data()?.links ?? []).map((l) => [l.playerId, l.displayName]));
    const extra = [...paid.values()]
      .filter((p) => !shown.has(p.playerId))
      .map((p) => ({ playerId: p.playerId, name: known.get(p.playerId) ?? linkNames.get(p.playerId) ?? null, paid: p, pending: false }));
    return [...billed.map((r) => ({ playerId: r.playerId, name: r.name, paid: paid.get(r.playerId) ?? null, pending: !paid.has(r.playerId) && (this.data()?.waiting ?? []).some(s => s.linkedPlayerId === r.playerId && s.amountSatang === r.amountSatang) })), ...extra];
  });
  protected readonly billedCount = computed(() => this.billed().length);
  protected readonly paidCount = computed(() => this.billed().filter((r) => this.paidById().has(r.playerId)).length);
  protected readonly reviewCount = computed(() => (this.data()?.waiting.length ?? 0) + (this.data()?.duplicates.length ?? 0));

  private readonly names = computed(() => new Map(this.rows().map((r) => [r.playerId, r.name])));

  protected readonly cards = computed<WaitingCard[]>(() => {
    const data = this.data();
    if (!data) return [];
    const unpaid = this.billed().filter((r) => !this.paidById().has(r.playerId));
    const unpaidIds = new Set(unpaid.map((r) => r.playerId));
    const linked = new Set(data.links.map((l) => l.playerId));
    return data.waiting.map((slip) => {
      const only = slip.candidatePlayerIds.length === 1 && unpaidIds.has(slip.candidatePlayerIds[0]) ? [slip.candidatePlayerIds[0]] : [];
      const chosen = new Set(this.coversDraft()[slip.id] ?? only);
      const covers = unpaid.filter((r) => chosen.has(r.playerId)).map((r) => r.playerId);
      const draft = this.senderDraft();
      const senderId = hasOwn(draft, slip.id) ? draft[slip.id] : slip.reason === 'unmapped' && !slip.linkedPlayerId && covers.length === 1 ? covers[0] : null;
      const reviewedAmount = this.amountDraft()[slip.id] ?? (slip.amountSatang === null ? '' : (slip.amountSatang / 100).toFixed(2));
      const numeric = Number(reviewedAmount);
      const reviewedSatang = /^\d+(?:\.\d{1,2})?$/.test(reviewedAmount) && Number.isSafeInteger(Math.round(numeric * 100)) && numeric > 0 ? Math.round(numeric * 100) : null;
      const selectedTotal = unpaid.filter(r => covers.includes(r.playerId)).reduce((sum, r) => sum + r.amountSatang, 0);
      return {
        slip, reviewedAmount, reviewedSatang, selectedTotal,
        difference: reviewedSatang === null ? null : selectedTotal - reviewedSatang,
        canResolve: covers.length > 0 && reviewedSatang !== null && selectedTotal === reviewedSatang && !this.closed(),
        covers,
        senderId,
        // Only a slip whose account may be unlinked can replace a link; a linked account is refused by the server instead.
        senderWarning: senderId !== null && (slip.reason === 'unmapped' || slip.reason === 'stale') && linked.has(senderId),
        canFixName:
          slip.reason === 'receiver' &&
          slip.receiverName !== null &&
          !!this.savedName() &&
          !this.namesUpdated().has(slip.id),
        nameUpdated: this.namesUpdated().has(slip.id),
      };
    });
  });

  /** Unpaid people who owe money: the choices for "this slip covers". */
  protected readonly coverOptions = computed(() => this.billed().filter((r) => !this.paidById().has(r.playerId)));

  constructor() {
    effect(() => {
      this.code();
      this.rows();
      untracked(() => void this.load());
    });
  }

  protected nameOf(playerId: string): string | null {
    return this.names().get(playerId) ?? null;
  }

  protected duplicateOriginals(playerIds: string[]): string {
    return playerIds
      .map((id) => this.names().get(id))
      .filter((n): n is string => !!n)
      .join(', ');
  }

  /** Also the retry. A read that is not the latest one is dropped, so an old answer never overwrites a newer one. */
  protected async load(): Promise<void> {
    const mine = ++this.seq;
    try {
      const data = await firstValueFrom(this.api.panel(this.code()));
      if (mine !== this.seq) return;
      this.data.set(data);
      this.loadFailed.set(false);
    } catch {
      if (mine === this.seq) this.loadFailed.set(true);
    }
  }

  protected toggle(person: Person): void {
    const code = this.code();
    const call = () => (person.paid ? this.api.untick(code, person.playerId) : this.api.tick(code, person.playerId));
    void this.act(`tick:${person.playerId}`, 'people', call);
  }

  protected toggleCover(card: WaitingCard, playerId: string): void {
    const now = new Set(card.covers);
    if (now.has(playerId)) now.delete(playerId);
    else now.add(playerId);
    const ordered = this.coverOptions()
      .map((r) => r.playerId)
      .filter((id) => now.has(id));
    this.coversDraft.update((m) => ({ ...m, [card.slip.id]: ordered }));
  }

  protected setSender(card: WaitingCard, value: string): void {
    this.senderDraft.update((m) => ({ ...m, [card.slip.id]: value === '' ? null : value }));
  }

  protected setAmount(card: WaitingCard, value: string): void {
    this.amountDraft.update(m => ({ ...m, [card.slip.id]: value.trim() }));
  }

  protected imageFailed(id: string): void {
    this.failedImages.update(s => new Set(s).add(id));
  }

  protected enlarge(id: string): void {
    this.enlargedImage.set(this.imageUrl(id));
    this.imageDialog()?.nativeElement.showModal();
  }

  protected closeImage(): void { this.imageDialog()?.nativeElement.close(); }

  protected askClose(): void {
    if (this.canClose()) this.closeDialog()?.nativeElement.showModal();
  }

  protected cancelClose(): void { this.closeDialog()?.nativeElement.close(); }

  protected confirmClose(): void {
    this.closeDialog()?.nativeElement.close();
    if (!this.canClose()) return;
    void this.act('close', 'collection', () => this.api.closeCollection(this.code()));
  }

  protected resolve(card: WaitingCard): void {
    if (!card.canResolve) return;
    const { id } = card.slip;
    void this.act(`w:${id}`, `w:${id}`, () =>
      this.api.resolve(this.code(), id, { coversPlayerIds: card.covers, senderPlayerId: card.senderId, reviewedAmountSatang: card.reviewedSatang! })
    );
  }

  protected dismiss(card: WaitingCard): void {
    const { id } = card.slip;
    void this.act(`w:${id}`, `w:${id}`, () => this.api.dismiss(this.code(), id));
  }

  protected askUpdateName(card: WaitingCard): void {
    if (!card.canFixName || card.slip.receiverName === null) return;
    this.nameConfirm.set({ slipId: card.slip.id, oldName: this.savedName() || null, newName: card.slip.receiverName });
    this.nameDialog()?.nativeElement.showModal();
  }

  protected cancelUpdateName(): void {
    this.nameDialog()?.nativeElement.close();
  }

  protected async confirmUpdateName(): Promise<void> {
    const pending = this.nameConfirm();
    this.nameDialog()?.nativeElement.close();
    if (!pending) return;
    const { slipId } = pending;
    const done = await this.act(`w:${slipId}`, `w:${slipId}`, () => this.api.updateName(this.code(), slipId));
    if (done) this.namesUpdated.update((s) => new Set(s).add(slipId));
  }

  protected acknowledge(id: string): void {
    void this.act(`d:${id}`, `d:${id}`, () => this.api.dismissDuplicate(this.code(), id));
  }

  protected unlink(playerId: string): void {
    void this.act(`l:${playerId}`, 'links', () => this.api.setLink(this.code(), playerId, null));
  }

  /**
   * Runs one request under a lock on `key` (a second tap while it runs does nothing), then re-reads the panel whatever
   * the answer, because a refusal usually means the server moved on. Returns whether the request succeeded.
   */
  private async act(key: string, errorKey: string, call: () => Observable<unknown>): Promise<boolean> {
    if ((this.closed() && key !== 'close') || this.locked.has(key)) return false;
    this.locked.add(key);
    this.busy.set(new Set(this.locked));
    this.setError(errorKey, null);
    let ok = false;
    try {
      await firstValueFrom(call());
      ok = true;
    } catch (e) {
      this.setError(errorKey, this.messageFor(e));
    }
    try {
      await this.load();
    } finally {
      this.locked.delete(key);
      this.busy.set(new Set(this.locked));
    }
    return ok;
  }

  private setError(key: string, message: string | null): void {
    this.errors.update(({ [key]: _old, ...rest }) => (message === null ? rest : { ...rest, [key]: message }));
  }

  /** A short Thai sentence for a refusal; never a status or a code. */
  private messageFor(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const code = (e.error as { code?: unknown } | null)?.code;
      if ((e.status === 409 || e.status === 400) && typeof code === 'string' && hasOwn(CONFLICT_TEXT, code)) return CONFLICT_TEXT[code as SlipHostConflict]();
      if (e.status === 404) return $localize`:@@slipReview.err.gone:ไม่พบรายการนี้แล้ว อาจมีคนจัดการไปแล้ว`;
    }
    return $localize`:@@slipReview.err.generic:ทำไม่สำเร็จ ลองใหม่อีกครั้ง`;
  }
}
