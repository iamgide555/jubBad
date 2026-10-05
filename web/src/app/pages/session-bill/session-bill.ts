import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BillConfig, BillModel, BillResponse, RoundingStep } from '../../core/bill.model';
import { buildBillText, formatBaht } from '../../core/bill-text';
import { copyToClipboard } from '../../core/share-link';
import { formatShuttleCountInput, formatShuttlePriceInput, parseShuttleCountInput, parseShuttlePriceInput } from '../../core/shuttle-money';
import { BillSettings } from '../../shared/bill-settings/bill-settings';
import { Icon } from '../../shared/icon/icon';

@Component({
  selector: 'app-session-bill',
  imports: [RouterLink, Icon, BillSettings],
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
  /** A ตามลูกแบด receipt is frozen on the basis it was quoted under, so the basis cannot change while one is active. */
  protected readonly chargeLocked = computed(() => this.settled().some((r) => r.model === 'perShuttle'));
  protected readonly names = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.name])));
  protected readonly walkIn = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.walkIn])));
  protected readonly billed = computed(() => {
    const rows = new Map((this.bill()?.result.rows ?? []).filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
    return (this.bill()?.players ?? []).filter((p) => rows.has(p.playerId)).map((p) => rows.get(p.playerId)!);
  });
  protected readonly removed = computed(() => (this.bill()?.result.rows ?? []).filter((r) => r.status === 'removed'));
  /** Early checkouts: read-only, frozen at what they paid; never removable, overridable or addable here. */
  protected readonly settled = computed(() => this.bill()?.settled ?? []);
  protected readonly addable = computed(() => {
    const inBill = new Set([
      ...(this.bill()?.result.rows ?? []).map((r) => r.playerId),
      ...this.settled().map((s) => s.playerId),
    ]);
    return (this.bill()?.players ?? []).filter((p) => !inBill.has(p.playerId));
  });
  /** perShuttle exists only on a session that tracked shuttles; an ordinary session keeps the original three. */
  protected readonly models = computed<BillModel[]>(() =>
    this.bill()?.session.shuttleToolsEnabled ? ['fair', 'perGame', 'perShuttle', 'buffet'] : ['fair', 'perGame', 'buffet']
  );
  protected readonly baht = formatBaht;
  protected readonly moneyText = formatShuttlePriceInput;
  /** Placeholder for the count: the count the bill is using when none was typed (derived from the games). */
  protected readonly countPlaceholder = computed(() => {
    const n = this.bill()?.accounting.effectiveCount;
    return n === null || n === undefined ? '—' : String(n);
  });
  /** Title on a disabled walk-in chip: an override bypasses the walk-in fee and discount entirely. */
  protected readonly walkInOverriddenHint = $localize`:@@bill.walkInOverridden:แก้ยอดเองแล้ว ค่า walk-in ไม่มีผลกับคนนี้`;

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
    } catch (e) {
      const locked = e instanceof HttpErrorResponse && e.status === 409 && e.error?.code === 'SHUTTLE_CHARGE_LOCKED';
      this.error.set(
        locked
          ? $localize`:@@bill.chargeLockedError:เปลี่ยนวิธีคิดค่าลูกไม่ได้ เพราะมีคนเช็คเอาต์ไปแล้ว ยกเลิกเช็คเอาต์ก่อน`
          : $localize`:@@bill.saveFailed:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`
      );
    } finally {
      this.saving.set(false);
    }
  }

  /** Count and price are session fields shared with the summary page; each edit sends only what changed. */
  protected async saveShuttleDetails(patch: { shuttleCount?: number | null; shuttlePriceSatang?: number | null }): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.http.post(`${this.base}/shuttle-details`, patch));
      await this.load();
    } catch {
      this.error.set($localize`:@@bill.shuttleDetailsFailed:บันทึกข้อมูลลูกแบดไม่สำเร็จ ลองใหม่อีกครั้ง`);
    } finally {
      this.saving.set(false);
    }
  }

  protected onInvalid(kind: 'amount' | 'count'): void {
    this.error.set(
      kind === 'count'
        ? $localize`:@@bill.badCount:ใส่จำนวนลูกเป็นเลขจำนวนเต็ม`
        : $localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`
    );
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

  /**
   * Excludes a billed player. An added no-show who still has no games is just
   * un-added (back to the "add" list). Anyone who actually played -- including
   * someone added as a no-show who then played -- must go into removedIds,
   * since the engine bills every player with games unless they are removed;
   * dropping them from addedIds alone would silently change nothing.
   */
  protected remove(playerId: string): void {
    const c = this.config()!;
    const played = (this.bill()?.result.rows.find((r) => r.playerId === playerId)?.games ?? 0) > 0;
    const addedIds = c.addedIds.filter((id) => id !== playerId);
    if (!played && c.addedIds.includes(playerId)) {
      void this.save({ addedIds });
      return;
    }
    const removedIds = c.removedIds.includes(playerId) ? c.removedIds : [...c.removedIds, playerId];
    void this.save({ addedIds, removedIds, absentIds: c.absentIds.filter((id) => id !== playerId) });
  }

  /**
   * Toggles "registered but did not come" (fair only): the player pays an
   * equal court share and no shuttles. Pressing it again undoes it.
   */
  protected toggleAbsent(playerId: string): void {
    const c = this.config()!;
    const absentIds = c.absentIds.includes(playerId)
      ? c.absentIds.filter((id) => id !== playerId)
      : [...c.absentIds, playerId];
    void this.save({ absentIds, removedIds: c.removedIds.filter((id) => id !== playerId) });
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

  /**
   * The shuttle-accounting panel for a session that tracked shuttles: what
   * was billed, where it came from, and — only when every finished game has a
   * recorded log and at least one is finished — how the physical count differs.
   */
  protected readonly shuttlePanel = computed(() => {
    const b = this.bill();
    if (!b || !b.session.shuttleToolsEnabled) return null;
    const a = b.accounting;
    const complete = a.unknownFinishedMatches === 0 && a.finishedMatches > 0;
    return {
      ...a,
      difference: complete && a.physicalCount !== null ? a.physicalCount - a.recordedFinishedShuttles : null,
      fallback:
        a.allocation === 'legacy-unknown' ? ('unknown' as const) : a.allocation === 'legacy-no-uses' ? ('no-uses' as const) : null,
    };
  });

  protected signed(n: number): string {
    return n > 0 ? `+${n}` : `${n}`;
  }

  protected async copy(): Promise<void> {
    const b = this.bill();
    // Checked again here, not only on the button: nothing may reach the
    // clipboard, or the fallback text box, while a required input is missing.
    if (!b || !b.readyToCopy) return;
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
