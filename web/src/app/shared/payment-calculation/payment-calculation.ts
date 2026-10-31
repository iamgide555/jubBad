import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BillModel, BillResponse, SplitMode } from '../../core/bill.model';
import { formatBaht } from '../../core/bill-text';

let instanceCount = 0;
@Component({
  selector: 'app-payment-calculation',
  templateUrl: './payment-calculation.html',
  styleUrl: './payment-calculation.css',
})
export class PaymentCalculation {
  readonly sessionCode = input.required<string>();
  readonly refreshKey = input<unknown>(null);
  readonly locked = input(false);
  readonly changed = output<BillResponse>();
  readonly changing = output<boolean>();
  readonly uncertain = output<void>();
  private readonly http = inject(HttpClient);
  private destroyed = false;
  private code: string | null = null;
  private sequence = 0;
  private pendingRefresh = false;
  /** An unanswered mutation needs a verified snapshot before the parent may trust payment state. */
  private needsResync = false;
  protected readonly selectId = `payment-calculation-${++instanceCount}`;
  protected readonly bill = signal<BillResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly readFailed = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly unavailable = computed(
    () => this.locked() || this.saving() || this.loading() || this.readFailed() || !this.bill(),
  );
  protected readonly models = computed<BillModel[]>(() =>
    this.bill()?.session.shuttleToolsEnabled
      ? ['fair', 'perGame', 'perShuttle', 'buffet']
      : ['fair', 'perGame', 'buffet'],
  );
  protected readonly money = (value: number | null) =>
    value === null ? $localize`:@@pay.calc.unspecified:ยังไม่ระบุ` : `${formatBaht(value)}฿`;
  protected readonly count = (value: number | null) =>
    value === null ? $localize`:@@pay.calc.unspecified:ยังไม่ระบุ` : String(value);
  protected readonly split = (mode: SplitMode) =>
    mode === 'equal'
      ? $localize`:@@pay.calc.equal:หารเท่า`
      : $localize`:@@pay.calc.byGames:ตามจำนวนเกม`;
  protected readonly modelLabel = (model: BillModel) =>
    ({
      fair: $localize`:@@pay.calc.fair:หารตามจริง`,
      perGame: $localize`:@@pay.calc.perGame:คิดต่อเกม`,
      buffet: $localize`:@@pay.calc.buffet:บุฟเฟ่ต์`,
      perShuttle: $localize`:@@pay.calc.perShuttle:ตามลูกแบด`,
    })[model];

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.sequence++;
    });
    effect(() => {
      const code = this.sessionCode();
      this.refreshKey();
      untracked(() => {
        if (code !== this.code) {
          this.sequence++;
          this.code = code;
          this.bill.set(null);
          this.pendingRefresh = false;
          this.needsResync = false;
          if (this.saving()) {
            this.saving.set(false);
            this.changing.emit(false);
          }
        }
        if (this.saving()) this.pendingRefresh = true;
        else void this.load();
      });
    });
  }

  protected async load(): Promise<void> {
    if (this.saving() || this.destroyed) return;
    const code = this.sessionCode();
    const sequence = ++this.sequence;
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await firstValueFrom(this.http.get<BillResponse>(this.url(code, 'bill')));
      if (!this.current(sequence, code)) return;
      this.bill.set(data);
      this.readFailed.set(false);
      if (this.needsResync) {
        this.needsResync = false;
        this.changed.emit(data);
      }
    } catch {
      if (this.current(sequence, code)) {
        this.readFailed.set(true);
        this.error.set(
          $localize`:@@pay.calc.loadFailed:โหลดรายละเอียดวิธีคิดเงินไม่สำเร็จ ลองใหม่อีกครั้ง`,
        );
      }
    } finally {
      if (this.current(sequence, code)) this.loading.set(false);
    }
  }

  protected async selectMethod(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const model = select.value as BillModel;
    const snapshot = this.bill();
    // Restore immediately: the server's successful response owns the selected method.
    select.value = snapshot?.config.model ?? '';
    if (
      this.unavailable() ||
      !snapshot ||
      !this.models().includes(model) ||
      model === snapshot.config.model
    )
      return;
    const code = this.sessionCode();
    const sequence = ++this.sequence;
    this.saving.set(true);
    this.error.set(null);
    this.changing.emit(true);
    try {
      const data = await firstValueFrom(
        this.http.post<BillResponse>(this.url(code, 'bill-method'), { model }),
      );
      if (!this.current(sequence, code)) return;
      this.bill.set(data);
      this.changed.emit(data);
    } catch {
      if (!this.current(sequence, code)) return;
      this.error.set(
        $localize`:@@pay.calc.saveFailed:เปลี่ยนวิธีคิดเงินไม่สำเร็จ ลองเลือกใหม่อีกครั้ง`,
      );
      // The server may have saved the method and revoked payment confirmation before
      // the connection failed. Keep the parent locked until a fresh bill resolves it.
      try {
        const data = await firstValueFrom(this.http.get<BillResponse>(this.url(code, 'bill')));
        if (!this.current(sequence, code)) return;
        this.bill.set(data);
        this.readFailed.set(false);
        this.needsResync = false;
        this.changed.emit(data);
      } catch {
        if (!this.current(sequence, code)) return;
        this.readFailed.set(true);
        this.needsResync = true;
        this.uncertain.emit();
      }
    } finally {
      if (this.current(sequence, code)) {
        this.saving.set(false);
        this.changing.emit(false);
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          void this.load();
        }
      }
    }
  }
  private current(sequence: number, code: string): boolean {
    return !this.destroyed && sequence === this.sequence && code === this.sessionCode();
  }
  private url(code: string, endpoint: string): string {
    return `${environment.apiBaseUrl}/sessions/${encodeURIComponent(code)}/${endpoint}`;
  }
}
