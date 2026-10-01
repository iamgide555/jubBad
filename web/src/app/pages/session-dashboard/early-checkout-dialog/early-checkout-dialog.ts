import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { buildCheckoutText } from '../../../core/checkout-text';
import {
  CHECKOUT_MODELS,
  checkoutErrorMessage,
  courtName,
  modelLabel,
  type CheckoutModel,
  type CheckoutPreview,
  type CheckoutReceipt,
} from '../../../core/checkout.model';
import { LiveSessionService } from '../../../core/live-session.service';
import { formatShuttlePriceInput, parseShuttlePriceInput } from '../../../core/shuttle-money';
import { copyToClipboard } from '../../../core/share-link';

export interface CheckoutPlayer {
  id: string;
  name: string;
  /** Court label while the player is on a pending or active court (must be cleared first); else null. */
  courtLabel: string | null;
}

export interface SettledPlayer {
  receipt: CheckoutReceipt;
  name: string;
}

/**
 * Early checkout for a leaver (host feedback E): pick the player, see an itemized
 * quote under one of three models, copy it, then settle with a separate confirm.
 * A quote changes nothing; only the confirm tap freezes the amount and locks the
 * player. Settled leavers are listed here too, each with a confirm-to-undo.
 */
@Component({
  selector: 'app-early-checkout-dialog',
  imports: [RouterLink],
  templateUrl: './early-checkout-dialog.html',
  styleUrl: './early-checkout-dialog.css',
})
export class EarlyCheckoutDialog {
  private readonly live = inject(LiveSessionService);
  protected readonly sessionCode = inject(ActivatedRoute, { optional: true })?.snapshot.paramMap.get('sessionCode') ?? null;

  /** Roster players who can still be checked out. */
  readonly players = input<readonly CheckoutPlayer[]>([]);
  readonly settled = input<readonly SettledPlayer[]>([]);
  /** Fires after a settlement or an undo, so the dashboard re-reads receipts and the roster. */
  readonly changed = output<void>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly models = CHECKOUT_MODELS;
  protected readonly modelLabel = modelLabel;
  protected readonly isOpen = signal(false);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly model = signal<CheckoutModel>('perGame');
  protected readonly preview = signal<CheckoutPreview | null>(null);
  protected readonly loading = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The quote was blocked only because no shuttle price is set. */
  protected readonly needsPrice = signal(false);
  protected readonly priceText = signal('');
  protected readonly receipt = signal<CheckoutReceipt | null>(null);
  protected readonly copied = signal(false);
  protected readonly fallbackText = signal<string | null>(null);
  protected readonly undoTarget = signal<string | null>(null);
  protected readonly undoBusy = signal(false);

  /**
   * One key per attempt at one quote. A retry after a network failure reuses it, so a
   * request that actually landed returns its receipt instead of settling a second time.
   * A fresh quote (different hash) is a new attempt and gets a new key.
   */
  private attempt: { playerId: string; model: CheckoutModel; hash: string; key: string } | null = null;

  /** Narrows the leaver list; shown once the roster is long enough that scrolling is slower than typing. */
  protected readonly query = signal('');
  protected readonly showSearch = computed(() => this.players().length > 8);
  protected readonly visiblePlayers = computed(() => {
    const q = this.query().trim().toLowerCase();
    return q === '' ? this.players() : this.players().filter((p) => p.name.toLowerCase().includes(q));
  });

  /**
   * A 0-baht quote is almost always "no rate set yet", and a receipt cannot be edited once saved,
   * so it needs an explicit second acknowledgement (0 can be legitimate: a free night, no games).
   */
  protected readonly zeroAck = signal(false);
  protected readonly isZeroQuote = computed(() => this.preview()?.amountSatang === 0);

  protected readonly selected = computed(() => this.players().find((p) => p.id === this.selectedId()) ?? null);
  protected readonly selectedName = computed(() => this.selected()?.name ?? '');
  protected readonly canConfirm = computed(
    () =>
      this.preview() !== null &&
      !this.loading() &&
      !this.confirming() &&
      this.receipt() === null &&
      (!this.isZeroQuote() || this.zeroAck())
  );

  open(playerId?: string): void {
    this.reset();
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
    if (playerId) void this.pick(playerId);
  }

  close(): void {
    this.isOpen.set(false);
    this.dialogEl().nativeElement.close();
  }

  protected onDialogClose(): void {
    this.isOpen.set(false);
  }

  protected onCancelAttempt(event: Event): void {
    if (this.confirming() || this.undoBusy()) event.preventDefault();
  }

  private reset(): void {
    this.selectedId.set(null);
    this.query.set('');
    this.zeroAck.set(false);
    this.model.set('perGame');
    this.preview.set(null);
    this.error.set(null);
    this.needsPrice.set(false);
    this.receipt.set(null);
    this.copied.set(false);
    this.fallbackText.set(null);
    this.undoTarget.set(null);
    this.attempt = null;
  }

  protected back(): void {
    this.reset();
  }

  protected async pick(playerId: string): Promise<void> {
    const court = this.players().find((p) => p.id === playerId)?.courtLabel ?? null;
    this.selectedId.set(playerId);
    this.receipt.set(null);
    this.error.set(null);
    if (court) {
      // Not auto-edited: a pending lineup is the host's to change, a live game must finish.
      this.preview.set(null);
      this.error.set(checkoutErrorMessage('PLAYER_ON_COURT', court));
      return;
    }
    await this.loadPreview();
  }

  protected async setModel(model: CheckoutModel): Promise<void> {
    if (this.confirming() || this.receipt() !== null) return;
    this.model.set(model);
    await this.loadPreview();
  }

  private errorOf(err: unknown): { code: string | null; courtNumber?: number } {
    if (err instanceof HttpErrorResponse && typeof err.error?.code === 'string') {
      return { code: err.error.code, courtNumber: err.error.courtNumber };
    }
    return { code: null };
  }

  protected async loadPreview(): Promise<void> {
    const playerId = this.selectedId();
    if (!playerId) return;
    this.loading.set(true);
    this.error.set(null);
    this.zeroAck.set(false);
    this.needsPrice.set(false);
    this.copied.set(false);
    this.fallbackText.set(null);
    try {
      this.preview.set(await this.live.previewCheckout(playerId, this.model()));
    } catch (err) {
      this.preview.set(null);
      const { code, courtNumber } = this.errorOf(err);
      this.needsPrice.set(code === 'MISSING_SHUTTLE_PRICE');
      this.error.set(
        checkoutErrorMessage(code, courtNumber ? courtName(`${courtNumber}`) : undefined) ??
          $localize`:@@checkout.err.preview:คำนวณยอดไม่สำเร็จ ลองใหม่อีกครั้ง`
      );
    } finally {
      this.loading.set(false);
    }
  }

  /** Sets the per-shuttle price right here (so a quote is not blocked) and re-quotes. */
  protected async savePrice(): Promise<void> {
    const parsed = parseShuttlePriceInput(this.priceText());
    if (!parsed.ok || parsed.value === null) {
      this.error.set($localize`:@@checkout.err.priceInvalid:ราคาไม่ถูกต้อง ใส่เป็นบาท เช่น 80 หรือ 80.50`);
      return;
    }
    const result = await this.live.setShuttleDetails({ shuttlePriceSatang: parsed.value });
    if (!result.ok) {
      this.error.set(result.error ?? $localize`:@@checkout.err.priceSave:บันทึกราคาไม่สำเร็จ`);
      return;
    }
    this.priceText.set(formatShuttlePriceInput(parsed.value));
    await this.loadPreview();
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onZeroAck(event: Event): void {
    this.zeroAck.set((event.target as HTMLInputElement).checked);
  }

  protected onPriceInput(event: Event): void {
    this.priceText.set((event.target as HTMLInputElement).value);
  }

  protected async copyQuote(): Promise<void> {
    const source = this.receipt() ?? this.preview();
    if (!source) return;
    const text = buildCheckoutText(source, this.selectedName());
    this.fallbackText.set(null);
    if (await copyToClipboard(text)) {
      this.copied.set(true);
    } else {
      this.fallbackText.set(text);
    }
  }

  protected async confirm(): Promise<void> {
    const preview = this.preview();
    if (!preview || !this.canConfirm()) return;
    const reuse =
      this.attempt !== null &&
      this.attempt.playerId === preview.playerId &&
      this.attempt.model === preview.model &&
      this.attempt.hash === preview.snapshotHash;
    if (!reuse) {
      this.attempt = { playerId: preview.playerId, model: preview.model, hash: preview.snapshotHash, key: crypto.randomUUID() };
    }
    this.confirming.set(true);
    this.error.set(null);
    try {
      const receipt = await this.live.confirmCheckout(preview.playerId, preview.model, preview.snapshotHash, this.attempt!.key);
      this.receipt.set(receipt);
      this.copied.set(false);
      this.fallbackText.set(null);
      this.changed.emit();
    } catch (err) {
      const { code } = this.errorOf(err);
      if (code === null) {
        // No answer: the request may have landed. Keep the key so a retry cannot settle twice.
        this.error.set($localize`:@@checkout.err.network:ไม่ได้รับคำตอบ ยังไม่รู้ว่าบันทึกแล้วหรือไม่ กดยืนยันอีกครั้งได้ จะไม่คิดเงินซ้ำ`);
      } else {
        // The server answered no: drop the attempt, show why, and re-quote if the numbers moved.
        this.attempt = null;
        this.error.set(
          checkoutErrorMessage(code) ?? $localize`:@@checkout.err.confirm:ยืนยันเช็คเอาต์ไม่สำเร็จ`
        );
        if (code === 'CHECKOUT_STALE') await this.loadPreview();
        if (code === 'CHECKOUT_STALE') this.error.set(checkoutErrorMessage(code));
        if (code === 'PLAYER_CHECKED_OUT') this.changed.emit();
      }
    } finally {
      this.confirming.set(false);
    }
  }

  protected askUndo(checkoutId: string): void {
    this.undoTarget.set(checkoutId);
    this.error.set(null);
  }

  protected cancelUndo(): void {
    this.undoTarget.set(null);
  }

  protected async confirmUndo(): Promise<void> {
    const id = this.undoTarget();
    if (!id) return;
    this.undoBusy.set(true);
    const result = await this.live.undoCheckout(id);
    this.undoBusy.set(false);
    this.undoTarget.set(null);
    if (!result.ok) {
      this.error.set(result.error ?? $localize`:@@err.undoCheckout:ยกเลิกการเช็คเอาต์ไม่สำเร็จ`);
    } else {
      this.error.set(null);
    }
    this.changed.emit();
  }

  /** Baht text for an amount, whole when there are no satang. */
  protected baht(satang: number): string {
    return formatShuttlePriceInput(satang) || '0';
  }
}
