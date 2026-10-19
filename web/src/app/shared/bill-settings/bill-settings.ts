import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { PlanLock } from '../plan-lock/plan-lock';
import type { BillConfig, BillModel, RoundingStep } from '../../core/bill.model';
import {
  formatShuttleCountInput,
  formatShuttlePriceInput,
  parseShuttleCountInput,
  parseShuttlePriceInput,
} from '../../core/shuttle-money';

type MoneyField =
  | 'courtFeeSatang' | 'perGameRateSatang' | 'entryFeeSatang' | 'capSatang'
  | 'buffetPriceSatang' | 'startingFeeSatang' | 'hostFeeSatang' | 'walkInFeeSatang' | 'perPlayerShuttleSatang';
const NULLABLE: ReadonlySet<MoneyField> = new Set(['courtFeeSatang', 'capSatang', 'perPlayerShuttleSatang']);

/**
 * The bill settings for one model, used by the bill page and by the early-checkout
 * dialog so that what a host sets mid-night is exactly what the end-of-night bill
 * reads, and the two forms cannot drift apart.
 *
 * `bill` shows everything the bill page has (court fee, shuttle count, the
 * fair-split options and the rest). `checkout` shows only what an early leaver is
 * charged under for the model on screen: never `fair`, so no court fee or splits.
 *
 * It owns no state and saves nothing: every edit is emitted for the parent to
 * persist, exactly as the bill page always did (one change event per field).
 */
@Component({
  selector: 'app-bill-settings',
  imports: [NgTemplateOutlet, PlanLock],
  templateUrl: './bill-settings.html',
})
export class BillSettings {
  readonly config = input.required<BillConfig>();
  readonly session = input.required<{ shuttleCount: number | null; shuttlePriceSatang: number | null }>();
  readonly variant = input<'bill' | 'checkout'>('bill');
  /** checkout only: the model being quoted. The bill page follows `config().model`. */
  readonly model = input<BillModel | null>(null);
  readonly saving = input(false);
  /** A shuttle receipt freezes the basis it was quoted under, so the basis cannot change while one is active. */
  readonly chargeLocked = input(false);
  readonly countPlaceholder = input('—');
  /**
   * Whether the group's plan includes the host and walk-in fees. Defaults to true:
   * an unknown plan never locks a host out, and the server still refuses.
   */
  readonly paid = input(true);

  readonly configChange = output<Partial<BillConfig>>();
  readonly shuttlePriceChange = output<number | null>();
  readonly shuttleCountChange = output<number | null>();
  readonly invalid = output<'amount' | 'count'>();

  protected readonly roundings: RoundingStep[] = [1, 5, 10];
  protected readonly moneyText = formatShuttlePriceInput;
  protected readonly countText = formatShuttleCountInput;

  protected readonly isCheckout = computed(() => this.variant() === 'checkout');
  protected readonly effectiveModel = computed<BillModel>(() =>
    this.isCheckout() ? (this.model() ?? this.config().model) : this.config().model
  );
  /** The shuttle price is a cost input for these; for per-game it would be noise in the checkout form. */
  protected readonly showShuttlePrice = computed(() => {
    if (!this.isCheckout()) return true;
    const m = this.effectiveModel();
    return m === 'perShuttle' || (m === 'buffet' && !this.config().buffetShuttlesIncluded);
  });
  /** Placeholder for the per-player charge: blank follows the session shuttle price. */
  protected readonly chargePlaceholder = computed(() => {
    const p = this.session().shuttlePriceSatang;
    return p === null ? '—' : formatShuttlePriceInput(p);
  });

  /**
   * On the free plan the server refuses a save that carries a non-zero fee, so
   * a fee is locked while it is 0. One already above 0 (set while the plan was
   * paid) stays editable, so the host can clear it and is never stuck with it.
   */
  protected readonly hostFeeLocked = computed(() => !this.paid() && this.config().hostFeeSatang === 0);
  protected readonly walkInFeeLocked = computed(() => !this.paid() && this.config().walkInFeeSatang === 0);

  protected onMoney(field: MoneyField, text: string): void {
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok) {
      this.invalid.emit('amount');
      return;
    }
    this.configChange.emit({ [field]: parsed.value ?? (NULLABLE.has(field) ? null : 0) });
  }

  protected onShuttlePrice(text: string): void {
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok) {
      this.invalid.emit('amount');
      return;
    }
    this.shuttlePriceChange.emit(parsed.value);
  }

  protected onShuttleCount(text: string): void {
    const parsed = parseShuttleCountInput(text);
    if (!parsed.ok) {
      this.invalid.emit('count');
      return;
    }
    this.shuttleCountChange.emit(parsed.value);
  }

  protected patch(change: Partial<BillConfig>): void {
    this.configChange.emit(change);
  }
}
