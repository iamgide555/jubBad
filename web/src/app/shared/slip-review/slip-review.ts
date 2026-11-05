import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { formatBaht } from '../../core/bill-text';
import type { SlipHostConflict, SlipHostPanel, SlipPaidRow, SlipWaiting } from '../../core/slip-host.model';
import { SlipReviewApi } from '../../core/slip-review-api';

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
  /**
   * The slip is already รอยืนยัน for its linked sender (unpaid, owing exactly the slip's amount) and the host has not
   * opened it up: the card shows one line naming who it pays instead of the covers list and the sender dropdown.
   */
  matched: { name: string; amountSatang: number } | null;
}

const CONFLICT_TEXT: Record<SlipHostConflict, () => string> = {
  SLIP_AMOUNT_REQUIRED: () => $localize`:@@slipReview.err.amountRequired:กรอกยอดที่ตรวจจากสลิปก่อนยืนยัน`,
  SLIP_AMOUNT_INVALID: () => $localize`:@@slipReview.err.amountInvalid:กรอกยอดเงินมากกว่า 0 และทศนิยมไม่เกิน 2 ตำแหน่ง`,
  SLIP_AMOUNT_MISMATCH: () => $localize`:@@slipReview.err.amountMismatch:ยอดสลิปน้อยกว่ายอดรวมคนที่เลือก`,
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
  readonly hideTitle = input(false);
  /** The panel's rows. Anyone owing nothing is left out of the status list. */
  readonly rows = input.required<readonly SlipReviewRow[]>();
  /**
   * The group's saved pay-account name: the one "update saved name" rewrites, shown as the old name in its
   * confirmation. Null when the group saves none; there is then nothing to update and the button is not offered.
   */
  readonly savedName = input<string | null>(null);
  /**
   * The collector's own LINE page: the one who receives the money confirms slips and ticks, but never links LINE
   * accounts, picks who sent a slip, or rewrites the saved pay-account name; those stay the host's.
   */
  readonly collectorMode = input(false);

  private readonly api = inject(SlipReviewApi);
  private readonly nameDialog = viewChild<ElementRef<HTMLDialogElement>>('nameDialog');
  private readonly imageDialog = viewChild<ElementRef<HTMLDialogElement>>('imageDialog');
  private readonly closeDialog = viewChild<ElementRef<HTMLDialogElement>>('closeDialog');
  private readonly slipDialog = viewChild<ElementRef<HTMLDialogElement>>('slipDialog');
  /** The slip-paid person whose slip is open in the dialog. */
  protected readonly slipView = signal<Person | null>(null);
  protected readonly failedImages = signal<ReadonlySet<string>>(new Set());
  protected readonly canClose = computed(() => !this.closed() ? !!this.data()?.collection?.canClose : (this.data()?.collection?.imageCount ?? 0) > 0);
  protected readonly enlargedImage = signal<string | null>(null);
  protected readonly closed = computed(() => !!this.data()?.collection?.closedAt);
  /** Resolved image URLs by image id. An image is requested once; a `blob:` URL is revoked when the view goes away. */
  protected readonly imageUrls = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requestedImages = new Set<string>();
  private destroyed = false;
  private readonly amountDraft = signal<Record<string, string>>({});
  private seq = 0;
  private readonly locked = new Set<string>();

  protected readonly baht = formatBaht;
  protected readonly clock = clock;
  protected readonly uid = `sr${++reviewCount}`;

  protected readonly data = signal<SlipHostPanel | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly refreshing = signal(false);
  protected readonly refreshedAt = signal<string | null>(null);
  /** Action keys with a request in flight; a second tap on the same one does nothing. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  protected readonly errors = signal<Record<string, string>>({});
  private readonly coversDraft = signal<Record<string, string[]>>({});
  private readonly senderDraft = signal<Record<string, string | null>>({});
  /** Matched slips the host opened with เปลี่ยนคน: the full covers list shows again. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
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
    const all: Person[] = [...billed.map((r) => ({ playerId: r.playerId, name: r.name, paid: paid.get(r.playerId) ?? null, pending: !paid.has(r.playerId) && (this.data()?.waiting ?? []).some(s => s.linkedPlayerId === r.playerId && s.amountSatang === r.amountSatang) })), ...extra];
    // Whoever paid first at the top, then slips waiting to be confirmed, then the unpaid; ties keep bill order.
    const group = (p: Person) => (p.paid ? 0 : p.pending ? 1 : 2);
    const at = (p: Person) => (p.paid ? Date.parse(p.paid.at) || 0 : 0);
    return all.sort((a, b) => group(a) - group(b) || at(a) - at(b));
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
      const linkedRow = this.linkedMatch(slip, unpaidIds) ? unpaid.find((r) => r.playerId === slip.linkedPlayerId) : undefined;
      const matched =
        linkedRow && !this.expanded().has(slip.id) && !hasOwn(this.coversDraft(), slip.id)
          ? { name: linkedRow.name, amountSatang: linkedRow.amountSatang }
          : null;
      const chosen = new Set(this.coversDraft()[slip.id] ?? this.defaultCovers(slip, unpaidIds));
      const covers = unpaid.filter((r) => chosen.has(r.playerId)).map((r) => r.playerId);
      const draft = this.senderDraft();
      const senderId = this.collectorMode() ? null : hasOwn(draft, slip.id) ? draft[slip.id] : slip.reason === 'unmapped' && !slip.linkedPlayerId && covers.length === 1 ? covers[0] : null;
      const reviewedAmount = this.amountDraft()[slip.id] ?? (slip.amountSatang === null ? '' : (slip.amountSatang / 100).toFixed(2));
      const numeric = Number(reviewedAmount);
      const reviewedSatang = /^\d+(?:\.\d{1,2})?$/.test(reviewedAmount) && Number.isSafeInteger(Math.round(numeric * 100)) && numeric > 0 ? Math.round(numeric * 100) : null;
      const selectedTotal = unpaid.filter(r => covers.includes(r.playerId)).reduce((sum, r) => sum + r.amountSatang, 0);
      return {
        slip, reviewedAmount, reviewedSatang, selectedTotal,
        difference: reviewedSatang === null ? null : selectedTotal - reviewedSatang,
        canResolve: covers.length > 0 && reviewedSatang !== null && selectedTotal <= reviewedSatang && !this.closed() && this.busy().size === 0,
        covers,
        senderId,
        // Only a slip whose account may be unlinked can replace a link; a linked account is refused by the server instead.
        senderWarning: senderId !== null && (slip.reason === 'unmapped' || slip.reason === 'stale') && linked.has(senderId),
        canFixName:
          !this.collectorMode() &&
          slip.reason === 'receiver' &&
          slip.receiverName !== null &&
          !!this.savedName() &&
          !this.namesUpdated().has(slip.id),
        nameUpdated: this.namesUpdated().has(slip.id),
        matched,
      };
    });
  });

  /**
   * Who a waiting slip is ticked for before the host touches it. The sender's own player when the status page already
   * shows them รอยืนยัน (linked, unpaid, owing exactly the slip's amount); otherwise the one unpaid person owing that
   * amount. With an even split many people owe the same, so without the linked sender the host had to tick by hand.
   */
  private defaultCovers(slip: SlipWaiting, unpaidIds: Set<string>): string[] {
    if (this.linkedMatch(slip, unpaidIds)) return [slip.linkedPlayerId!];
    return slip.candidatePlayerIds.length === 1 && unpaidIds.has(slip.candidatePlayerIds[0]) ? [slip.candidatePlayerIds[0]] : [];
  }

  /** The status page's รอยืนยัน rule: a linked sender, unpaid, owing exactly the slip's amount. */
  private linkedMatch(slip: SlipWaiting, unpaidIds: Set<string>): boolean {
    const linked = slip.linkedPlayerId;
    return !!linked && slip.amountSatang !== null && unpaidIds.has(linked) && slip.candidatePlayerIds.includes(linked);
  }

  /** เปลี่ยนคน on a matched card: show the full covers list (still ticked for the linked sender). */
  protected expand(id: string): void {
    this.expanded.update((s) => new Set(s).add(id));
  }

  /** Skipped slips, latest skip first; empty from an older API. */
  protected readonly skipped = computed(() => this.data()?.skipped ?? []);

  /** Unpaid people who owe money: the choices for "this slip covers". */
  protected readonly coverOptions = computed(() => this.billed().filter((r) => !this.paidById().has(r.playerId)));

  constructor() {
    effect(() => {
      this.code();
      this.rows();
      untracked(() => void this.load());
    });
    // A waiting slip's picture is shown at once; a paid slip's only when its dialog opens.
    effect(() => {
      const waiting = this.data()?.waiting ?? [];
      untracked(() => {
        for (const w of waiting) if (w.imageId) this.loadImage(w.imageId);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const url of this.imageUrls().values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
  }

  private loadImage(id: string): void {
    if (this.requestedImages.has(id)) return;
    this.requestedImages.add(id);
    this.api.image(this.code(), id).subscribe({
      next: (url) => {
        if (this.destroyed) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          return;
        }
        this.imageUrls.update((m) => new Map(m).set(id, url));
      },
      error: () => this.imageFailed(id),
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
    this.refreshing.set(true);
    const mine = ++this.seq;
    try {
      const data = await firstValueFrom(this.api.panel(this.code()));
      if (mine !== this.seq) return;
      this.data.set(data);
      this.loadFailed.set(false);
      this.refreshedAt.set(clock(new Date().toISOString()));
    } catch {
      if (mine === this.seq) this.loadFailed.set(true);
    } finally {
      if (mine === this.seq) this.refreshing.set(false);
    }
  }

  protected refresh(): void {
    if (this.refreshing() || this.busy().size > 0) return;
    void this.load();
  }

  /**
   * A slip-paid row opens its slip instead of unticking: the slip mark is evidence a stray tap must not erase (a
   * re-tick would only come back as the host's, and the slip itself cannot be sent again). Undo is a deliberate
   * button inside that dialog, offered only while collection is open; the server sends the undone slip back to the
   * waiting list so a mistaken undo can be reviewed again. Unpaid and host-ticked rows still toggle on tap.
   */
  protected toggle(person: Person): void {
    if (person.paid?.source === 'slip') {
      if (person.paid.imageId) this.loadImage(person.paid.imageId);
      this.slipView.set(person);
      this.slipDialog()?.nativeElement.showModal();
      return;
    }
    this.flip(person);
  }

  protected closeSlip(): void { this.slipDialog()?.nativeElement.close(); }

  /** The amount the bill asks of this person now, or null when they are no longer on it. */
  protected owed(playerId: string): number | null {
    return this.rows().find((r) => r.playerId === playerId)?.amountSatang ?? null;
  }

  protected undoSlip(): void {
    const person = this.slipView();
    this.closeSlip();
    // Closed collection: view only (the server refuses too).
    if (person?.paid && !this.closed()) this.flip(person);
  }

  private flip(person: Person): void {
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
    const url = this.imageUrls().get(id);
    if (!url) return;
    this.enlargedImage.set(url);
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
    if (!card.canResolve || this.busy().size > 0) return;
    const { id } = card.slip;
    void this.act(`w:${id}`, `w:${id}`, () =>
      this.api.resolve(this.code(), id, { coversPlayerIds: card.covers, senderPlayerId: card.senderId, reviewedAmountSatang: card.reviewedSatang! })
    );
  }

  protected dismiss(card: WaitingCard): void {
    const { id } = card.slip;
    void this.act(`w:${id}`, `w:${id}`, () => this.api.dismiss(this.code(), id));
  }

  protected restore(id: string): void {
    void this.act(`s:${id}`, `s:${id}`, () => this.api.restore(this.code(), id));
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
