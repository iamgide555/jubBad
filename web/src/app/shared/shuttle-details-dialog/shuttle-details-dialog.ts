import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  formatShuttleCountInput,
  formatShuttlePriceInput,
  parseShuttleCountInput,
  parseShuttlePriceInput,
} from '../../core/shuttle-money';

export interface ShuttleDetailsPatch {
  shuttleCount?: number | null;
  shuttlePriceSatang?: number | null;
}

/**
 * A shared modal for recording/editing shuttle count and price-per-shuttle,
 * reused from two places: the session dashboard's end-session flow, and the
 * public summary page's host-only edit button. Follows admin.ts's
 * create-user dialog — the only other native `<dialog>` in this app.
 *
 * Deliberately owns no HTTP: it only emits the parsed patch on confirm. The
 * two callers differ in what happens next (the dashboard also ends the
 * session and navigates; the summary page just saves and reloads), and
 * keeping this component HTTP-free makes "the public summary page can never
 * end a session" true by construction rather than by a mode flag. It also
 * does not guard against a double-submit itself — signal inputs do not
 * update synchronously within one tick, so a guard living here could be
 * raced. Each caller keeps its own busy signal and guards there.
 */
@Component({
  selector: 'app-shuttle-details-dialog',
  imports: [FormsModule],
  templateUrl: './shuttle-details-dialog.html',
  styleUrl: './shuttle-details-dialog.css',
})
export class ShuttleDetailsDialog {
  readonly shuttleCount = input<number | null>(null);
  readonly shuttlePriceSatang = input<number | null>(null);
  readonly heading = input($localize`:@@shuttle.title:ลูกแบดที่ใช้`);
  readonly intro = input<string | null>(null);
  readonly confirmLabel = input($localize`:@@shuttle.save:บันทึก`);
  readonly saving = input(false);
  readonly error = input<string | null>(null);

  readonly confirm = output<ShuttleDetailsPatch>();

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  // `null` means "no unsaved edit — show the committed value"; any string
  // (including '') means the host has touched that field. Same trick as the
  // court score inputs and the editor this replaces: a plain signal never
  // derived from the `shuttleCount`/`shuttlePriceSatang` inputs, so a
  // reopen or a background value change cannot silently overwrite it.
  protected readonly isOpen = signal(false);
  protected readonly countDraft = signal<string | null>(null);
  protected readonly priceDraft = signal<string | null>(null);
  protected readonly localError = signal<string | null>(null);

  protected readonly countText = computed(
    () => this.countDraft() ?? formatShuttleCountInput(this.shuttleCount())
  );
  protected readonly priceText = computed(
    () => this.priceDraft() ?? formatShuttlePriceInput(this.shuttlePriceSatang())
  );

  /** Resets both drafts to "untouched" every time — a fresh form each open. */
  open(): void {
    this.countDraft.set(null);
    this.priceDraft.set(null);
    this.localError.set(null);
    this.isOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  close(): void {
    this.isOpen.set(false);
    this.dialogEl().nativeElement.close();
  }

  /** Syncs state back for a browser-initiated close (Escape fires 'cancel' then 'close'). */
  protected onDialogClose(): void {
    this.isOpen.set(false);
  }

  /** Escape should not be a back door around a disabled Cancel button while saving. */
  protected onCancelAttempt(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  protected onCountInput(text: string): void {
    this.countDraft.set(text);
  }

  protected onPriceInput(text: string): void {
    this.priceDraft.set(text);
  }

  /**
   * Only a field the host actually touched (its draft is non-null) is ever
   * included in the emitted patch — an untouched field is genuinely absent,
   * matching the server's omit-means-unchanged contract. May emit `{}` if
   * nothing was touched; the caller decides what that means.
   */
  protected submit(): void {
    this.localError.set(null);
    const patch: ShuttleDetailsPatch = {};

    const countDraft = this.countDraft();
    if (countDraft !== null) {
      const parsed = parseShuttleCountInput(countDraft);
      if (!parsed.ok) {
        this.localError.set(
          $localize`:@@shuttle.countInvalid:จำนวนลูกแบดต้องเป็นจำนวนเต็มไม่ติดลบ`
        );
        return;
      }
      patch.shuttleCount = parsed.value;
    }

    const priceDraft = this.priceDraft();
    if (priceDraft !== null) {
      const parsed = parseShuttlePriceInput(priceDraft);
      if (!parsed.ok) {
        this.localError.set(
          $localize`:@@shuttle.priceInvalid:ราคาต่อลูกต้องไม่ติดลบ และมีทศนิยมไม่เกิน 2 ตำแหน่ง`
        );
        return;
      }
      patch.shuttlePriceSatang = parsed.value;
    }

    this.confirm.emit(patch);
  }
}
