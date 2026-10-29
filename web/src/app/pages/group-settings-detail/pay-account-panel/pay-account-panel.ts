import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PayAccountService, type PayAccount } from '../../../core/pay-account.service';
import { BankField } from '../../../shared/bank-field/bank-field';

/** Digits, spaces and dashes, 6-20 characters, at least 6 of them digits: mirrors the server. */
const NUMBER_PATTERN = /^[0-9 -]{6,20}$/;
const MIN_DIGITS = 6;

/**
 * The group's default account for the payment card: bank, account number, account name. All
 * three or none; saving with all three blank (or the clear button) removes it. Owner-only and on
 * every plan, with no LINE link needed, so a lapsed host can still read and clear it. The server
 * stores the Thai bank name as plain text and checks the same rules again.
 */
@Component({
  selector: 'app-pay-account-panel',
  imports: [BankField],
  templateUrl: './pay-account-panel.html',
  styleUrl: './pay-account-panel.css',
})
export class PayAccountPanel implements OnInit {
  readonly groupCode = input.required<string>();

  private readonly payAccounts = inject(PayAccountService);

  protected readonly loaded = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly bank = signal('');
  protected readonly number = signal('');
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<'saved' | 'cleared' | null>(null);
  protected readonly confirmingClear = signal(false);
  protected readonly fieldErrors = signal<Partial<Record<'bank' | 'number' | 'name', string>>>({});
  /** Something is on screen or saved to take away. */
  protected readonly canClear = computed(
    () => this.bank().trim() !== '' || this.number().trim() !== '' || this.name().trim() !== ''
  );

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      this.fill(await firstValueFrom(this.payAccounts.get(this.groupCode())));
      this.loaded.set(true);
    } catch {
      this.loadFailed.set(true);
    }
  }

  protected edit(field: 'bank' | 'number' | 'name', value: string): void {
    this[field].set(value);
    this.error.set(null);
    this.notice.set(null);
    this.fieldErrors.update((errors) => ({ ...errors, [field]: undefined }));
    this.confirmingClear.set(false);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.fieldErrors.set({});
    const bank = this.bank().trim();
    const number = this.number().trim();
    const name = this.name().trim();
    if (bank === '' && number === '' && name === '') return this.send(null);
    if (bank === '' || number === '' || name === '') {
      const required = $localize`:@@pay.account.required:กรอกช่องนี้`;
      this.fieldErrors.set({ bank: bank ? undefined : required, number: number ? undefined : required, name: name ? undefined : required });
      this.error.set($localize`:@@pay.account.incomplete:กรอกให้ครบทั้งสามช่อง หรือกดล้างถ้าไม่ต้องการตั้งบัญชี`);
      return;
    }
    if (!NUMBER_PATTERN.test(number) || number.replace(/[^0-9]/g, '').length < MIN_DIGITS) {
      this.error.set(
        $localize`:@@pay.account.badNumber:เลขบัญชีต้องเป็นตัวเลขอย่างน้อย 6 หลัก เว้นวรรคหรือใส่ขีดได้ ยาวไม่เกิน 20 ตัวอักษร`
      );
      this.fieldErrors.set({ number: this.error()! });
      return;
    }
    return this.send({ bank, number, name });
  }

  protected clear(): Promise<void> {
    if (this.busy() || !this.confirmingClear()) return Promise.resolve();
    return this.send(null);
  }

  private async send(account: PayAccount | null): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const saved = await firstValueFrom(this.payAccounts.set(this.groupCode(), account));
      this.fill(saved);
      this.confirmingClear.set(false);
      this.fieldErrors.set({});
      this.notice.set(saved ? 'saved' : 'cleared');
    } catch (err) {
      const invalid = err instanceof HttpErrorResponse && (err.error as { code?: unknown } | null)?.code === 'PAY_ACCOUNT_INVALID';
      this.error.set(
        invalid
          ? $localize`:@@pay.account.invalid:ตรวจบัญชีรับเงินอีกครั้ง ต้องกรอกครบทั้งสามช่อง และเลขบัญชีเป็นตัวเลข 6 หลักขึ้นไป`
          : $localize`:@@pay.account.saveFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`
      );
    } finally {
      this.busy.set(false);
    }
  }

  private fill(account: PayAccount | null): void {
    this.bank.set(account?.bank ?? '');
    this.number.set(account?.number ?? '');
    this.name.set(account?.name ?? '');
  }
}
