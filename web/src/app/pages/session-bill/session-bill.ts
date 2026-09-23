import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BillConfig, BillModel, BillResponse, RoundingStep } from '../../core/bill.model';
import { buildBillText, formatBaht } from '../../core/bill-text';
import { copyToClipboard } from '../../core/share-link';
import { formatShuttlePriceInput, parseShuttlePriceInput } from '../../core/shuttle-money';

type MoneyField =
  | 'courtFeeSatang' | 'perGameRateSatang' | 'entryFeeSatang' | 'capSatang'
  | 'buffetPriceSatang' | 'hostFeeSatang' | 'walkInFeeSatang';
const NULLABLE: ReadonlySet<MoneyField> = new Set(['courtFeeSatang', 'capSatang']);

@Component({
  selector: 'app-session-bill',
  imports: [RouterLink],
  templateUrl: './session-bill.html',
  styleUrl: './session-bill.css',
})
export class SessionBill {
  private readonly http = inject(HttpClient);
  protected readonly sessionCode = inject(ActivatedRoute).snapshot.paramMap.get('sessionCode')!;
  private readonly base = `${environment.apiBaseUrl}/sessions/${this.sessionCode}`;

  protected readonly bill = signal<BillResponse | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly clipboardFallback = signal<string | null>(null);

  protected readonly config = computed(() => this.bill()?.config ?? null);
  protected readonly names = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.name])));
  protected readonly walkIn = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.walkIn])));
  protected readonly billed = computed(() => {
    const rows = new Map((this.bill()?.result.rows ?? []).filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
    return (this.bill()?.players ?? []).filter((p) => rows.has(p.playerId)).map((p) => rows.get(p.playerId)!);
  });
  protected readonly removed = computed(() => (this.bill()?.result.rows ?? []).filter((r) => r.status === 'removed'));
  protected readonly addable = computed(() => {
    const inBill = new Set((this.bill()?.result.rows ?? []).map((r) => r.playerId));
    return (this.bill()?.players ?? []).filter((p) => !inBill.has(p.playerId));
  });
  protected readonly models: BillModel[] = ['fair', 'perGame', 'buffet'];
  protected readonly roundings: RoundingStep[] = [1, 5, 10];
  protected readonly baht = formatBaht;
  protected readonly moneyText = formatShuttlePriceInput;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.bill.set(await firstValueFrom(this.http.get<BillResponse>(`${this.base}/bill`)));
    } catch {
      this.loadFailed.set(true);
    }
  }

  protected async save(patch: Partial<BillConfig>): Promise<void> {
    const current = this.config();
    if (!current) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      this.bill.set(
        await firstValueFrom(this.http.post<BillResponse>(`${this.base}/bill-config`, { ...current, ...patch }))
      );
    } catch {
      this.error.set($localize`:@@bill.saveFailed:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`);
    } finally {
      this.saving.set(false);
    }
  }

  protected onMoney(field: MoneyField, text: string): void {
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok) {
      this.error.set($localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`);
      return;
    }
    void this.save({ [field]: parsed.value ?? (NULLABLE.has(field) ? null : 0) });
  }

  protected onOverride(playerId: string, text: string): void {
    const c = this.config();
    if (!c) return;
    const rest = c.overrides.filter((o) => o.playerId !== playerId);
    if (text.trim() === '') {
      void this.save({ overrides: rest });
      return;
    }
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok || parsed.value === null) {
      this.error.set($localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`);
      return;
    }
    void this.save({ overrides: [...rest, { playerId, amountSatang: parsed.value }] });
  }

  protected overrideText(playerId: string): string {
    const o = this.config()?.overrides.find((x) => x.playerId === playerId);
    return o ? formatShuttlePriceInput(o.amountSatang) : '';
  }

  protected add(playerId: string): void {
    const c = this.config()!;
    void this.save({ addedIds: [...c.addedIds, playerId], removedIds: c.removedIds.filter((id) => id !== playerId) });
  }

  protected remove(playerId: string): void {
    const c = this.config()!;
    if (c.addedIds.includes(playerId)) void this.save({ addedIds: c.addedIds.filter((id) => id !== playerId) });
    else void this.save({ removedIds: [...c.removedIds, playerId] });
  }

  protected restore(playerId: string): void {
    const c = this.config()!;
    void this.save({ removedIds: c.removedIds.filter((id) => id !== playerId) });
  }

  protected async toggleWalkIn(playerId: string): Promise<void> {
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.post(`${this.base}/roster/${playerId}/walk-in`, { walkIn: !this.walkIn().get(playerId) })
      );
      await this.load();
    } catch {
      this.error.set($localize`:@@bill.saveFailed:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`);
    }
  }

  protected async copy(): Promise<void> {
    const b = this.bill();
    if (!b) return;
    const text = buildBillText(b);
    this.clipboardFallback.set(null);
    if (await copyToClipboard(text)) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } else {
      this.error.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
      this.clipboardFallback.set(text);
    }
  }
}
