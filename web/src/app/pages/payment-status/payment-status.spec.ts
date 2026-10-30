import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { LiffClient } from '../../core/liff-client';
import { SlipPayService } from '../../core/slip-pay.service';
import { PaymentStatus } from './payment-status';

const VIEW = { sessionDate: '30 ต.ค. 2569', rows: [
  { name: 'Paid Person', amountSatang: 17200, paid: true, amountChangedSince: true },
  { name: 'Unpaid Person', amountSatang: 18050, paid: false, amountChangedSince: false },
] };

describe('PaymentStatus', () => {
  let fixture: ComponentFixture<PaymentStatus>;
  let api: { config: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn> };
  let liff: { init: ReturnType<typeof vi.fn>; isLoggedIn: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn>; getAccessToken: ReturnType<typeof vi.fn> };
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent ?? '';
  const flush = async () => { await new Promise((r) => setTimeout(r, 0)); fixture.detectChanges(); };
  const open = async () => { fixture = TestBed.createComponent(PaymentStatus); fixture.detectChanges(); await flush(); };
  const error = (status: number) => throwError(() => new HttpErrorResponse({ status }));

  beforeEach(() => {
    api = { config: vi.fn().mockReturnValue(of({ liffId: 'LIFF' })), status: vi.fn().mockReturnValue(of(VIEW)), claim: vi.fn(), upload: vi.fn() };
    liff = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: vi.fn().mockReturnValue(true), login: vi.fn(), getAccessToken: vi.fn().mockReturnValue('ACCESS') };
    TestBed.configureTestingModule({ providers: [
      { provide: SlipPayService, useValue: api }, { provide: LiffClient, useValue: liff },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'abc', token: 'TOK' }) } } },
    ] });
  });

  it('reads without a claim, shows counts/date/amounts, and puts unpaid first', async () => {
    await open();
    expect(api.status).toHaveBeenCalledWith('abc', 'TOK', 'ACCESS');
    expect(liff.init).toHaveBeenCalledWith('LIFF');
    expect(text()).toContain('30 ต.ค. 2569');
    expect(text()).toContain('172');
    expect(text()).toContain('180.50');
    expect(text()).toContain('ยอดเปลี่ยนหลังจ่าย');
    expect(el().querySelector('[data-unpaid-count]')?.textContent).toContain('1');
    expect(el().querySelector('[data-paid-count]')?.textContent).toContain('1');
    const rows = [...el().querySelectorAll('[data-status-row]')];
    expect(rows[0].textContent).toContain('Unpaid Person');
    expect(rows[0].textContent).toContain('ยังไม่จ่าย');
    expect(rows[1].textContent).toContain('Paid Person');
    expect(rows[1].textContent).toContain('จ่ายแล้ว');
    expect(api.claim).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    expect(el().querySelector('input,select,textarea,a')).toBeNull();
    expect(el().querySelectorAll('button')).toHaveLength(1);
  });

  it('refreshes latest marks and prevents overlapping refresh', async () => {
    await open();
    const pending = new Subject<typeof VIEW>();
    api.status.mockReturnValue(pending);
    const refresh = el().querySelector('button')!;
    refresh.click(); await flush();
    expect(el().querySelector('button')!.disabled).toBe(true);
    el().querySelector('button')!.click();
    expect(api.status).toHaveBeenCalledTimes(2);
    pending.next({ ...VIEW, rows: VIEW.rows.map((r) => ({ ...r, paid: true })) }); pending.complete();
    await flush();
    expect(el().querySelector('[data-unpaid-count]')?.textContent).toContain('0');
    expect(el().querySelector('[data-paid-count]')?.textContent).toContain('2');
    expect(liff.init).toHaveBeenCalledTimes(1);
  });

  it('goes through LINE login before reading status', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    await open();
    expect(liff.login).toHaveBeenCalledWith(window.location.href);
    expect(api.status).not.toHaveBeenCalled();
    expect(text()).toContain('เข้าสู่ระบบ LINE');
  });

  it('shows loading until status arrives', async () => {
    api.status.mockReturnValue(new Subject());
    await open();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('กำลังโหลด');
  });

  it('shows unavailable for revoked token and hides old results after refresh', async () => {
    await open(); api.status.mockReturnValue(error(404));
    el().querySelector('button')!.click(); await flush();
    expect(text()).toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
    expect(text()).not.toContain('Paid Person');
  });

  it('shows recoverable error on failure and retries', async () => {
    api.status.mockReturnValue(error(500)); await open();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    api.status.mockReturnValue(of(VIEW)); el().querySelector('button')!.click(); await flush();
    expect(text()).toContain('Unpaid Person');
  });

  it('does not read data without an access token', async () => {
    liff.getAccessToken.mockReturnValue(null); await open();
    expect(api.status).not.toHaveBeenCalled();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows an empty bill without payment actions', async () => {
    api.status.mockReturnValue(of({ sessionDate: null, rows: [] })); await open();
    expect(text()).toContain('ไม่มีรายชื่อในบิลนี้');
    expect(el().querySelectorAll('[data-status-row]')).toHaveLength(0);
  });
});
