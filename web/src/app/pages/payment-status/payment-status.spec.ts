import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Component, input } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { CollectorSlipService } from '../../core/collector-slip.service';
import { LiffClient } from '../../core/liff-client';
import { SlipReviewApi } from '../../core/slip-review-api';
import { SlipReview, type SlipReviewRow } from '../../shared/slip-review/slip-review';
import { SlipPayService } from '../../core/slip-pay.service';
import { PaymentStatus } from './payment-status';

const VIEW = { sessionDate: '30 ต.ค. 2569', rows: [
  { name: 'Paid Person', amountSatang: 17200, paid: true, amountChangedSince: true },
  { name: 'Unpaid Person', amountSatang: 18050, paid: false, amountChangedSince: false },
] };

/** Stands in for the real review so the page's wiring is what is under test, not the review's own HTTP. */
@Component({ selector: 'app-slip-review', template: '' })
class FakeSlipReview {
  readonly code = input.required<string>();
  readonly rows = input.required<readonly SlipReviewRow[]>();
  readonly collectorMode = input(false);
  readonly hideTitle = input(false);
}

const MANAGE = { groupName: 'ก๊วน', date: '30 ต.ค. 2569', accountName: 'สมชาย', rows: [{ playerId: 'p1', name: 'A', amountSatang: 10000, absent: false }] };

describe('PaymentStatus', () => {
  let fixture: ComponentFixture<PaymentStatus>;
  let api: { config: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; role: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn> };
  let liff: { init: ReturnType<typeof vi.fn>; isLoggedIn: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn>; getAccessToken: ReturnType<typeof vi.fn> };
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent ?? '';
  const flush = async () => { await new Promise((r) => setTimeout(r, 0)); fixture.detectChanges(); };
  const open = async () => { fixture = TestBed.createComponent(PaymentStatus); fixture.detectChanges(); await flush(); };
  const error = (status: number) => throwError(() => new HttpErrorResponse({ status }));

  beforeEach(() => {
    api = { config: vi.fn().mockReturnValue(of({ liffId: 'LIFF' })), status: vi.fn().mockReturnValue(of(VIEW)), claim: vi.fn(), role: vi.fn().mockReturnValue(of({ collector: false })), upload: vi.fn() };
    liff = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: vi.fn().mockReturnValue(true), login: vi.fn(), getAccessToken: vi.fn().mockReturnValue('ACCESS') };
    TestBed.configureTestingModule({ providers: [
      { provide: SlipPayService, useValue: api }, { provide: LiffClient, useValue: liff },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'abc', token: 'TOK' }) } } },
    ] });
  });

  it('distinguishes pending from unpaid and paid, and shows collection completion', async () => {
    api.status.mockReturnValue(of({ ...VIEW, closedAt: '2026-10-31', pendingSlipCount: 2, rows: [...VIEW.rows, { name: 'Pending Person', amountSatang: 9000, paid: false, pending: true, amountChangedSince: false }] }));
    await open();
    expect(el().querySelector('[data-unpaid-count]')?.textContent).toContain('1');
    expect(el().querySelector('[data-pending-count]')?.textContent).toContain('1');
    expect(el().querySelector('[data-pending-slip-count]')?.textContent).toContain('2');
    expect(text()).toContain('เก็บเงินครบแล้ว');
    const row = [...el().querySelectorAll('[data-status-row]')].find(r => r.textContent?.includes('Pending Person'));
    expect(row?.textContent).toContain('รอยืนยัน');
    expect(row?.querySelector('.pending-state')).not.toBeNull();
  });

  it('labels the เจ้าของบัญชี as such, counted with the paid', async () => {
    api.status.mockReturnValue(of({ ...VIEW, rows: [...VIEW.rows, { name: 'Mookie', amountSatang: 11300, paid: true, pending: false, amountChangedSince: false, owner: true }] }));
    await open();
    const row = [...el().querySelectorAll('[data-status-row]')].find(r => r.textContent?.includes('Mookie'));
    expect(row?.querySelector('[data-owner-state]')?.textContent).toContain('เจ้าของบัญชี');
    expect(row?.textContent).not.toContain('จ่ายแล้ว');
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

  it('puts the unpaid first, then waiting slips, then the paid in the server\'s order', async () => {
    api.status.mockReturnValue(of({ ...VIEW, rows: [
      { name: 'Unpaid A', amountSatang: 1, paid: false, pending: false, amountChangedSince: false },
      { name: 'Pending B', amountSatang: 1, paid: false, pending: true, amountChangedSince: false },
      { name: 'First Payer', amountSatang: 1, paid: true, pending: false, amountChangedSince: false },
      { name: 'Second Payer', amountSatang: 1, paid: true, pending: false, amountChangedSince: false },
    ] }));
    await open();
    const names = [...el().querySelectorAll('[data-status-row] .person-name')].map((n) => n.textContent?.trim());
    expect(names).toEqual(['Unpaid A', 'Pending B', 'First Payer', 'Second Payer']);
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

  it('shows the read-only list, with no review, when the viewer is not the collector', async () => {
    await open();
    expect(api.role).toHaveBeenCalledWith('abc', 'TOK', 'ACCESS');
    expect(el().querySelector('app-slip-review')).toBeNull();
    expect(text()).toContain('ดูได้อย่างเดียว · โฮสต์เป็นคนแก้สถานะ');
    expect(api.status).toHaveBeenCalled();
  });

  it('gives the review the collector service as its data source, not the host one', async () => {
    await open();
    const injector = fixture.debugElement.injector;
    expect(injector.get(SlipReviewApi)).toBe(injector.get(CollectorSlipService));
  });

  it('falls back to the read-only list when the role read fails', async () => {
    api.role.mockReturnValue(error(500));
    await open();
    expect(el().querySelector('app-slip-review')).toBeNull();
    expect(text()).toContain('Unpaid Person');
  });

  it('goes straight to unavailable when the role read is a 404, without a second refused read', async () => {
    api.role.mockReturnValue(error(404));
    await open();
    expect(api.status).not.toHaveBeenCalled();
    expect(text()).toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
  });

  it('shows the retryable error when the role read is throttled (429), without reading the status', async () => {
    api.role.mockReturnValue(error(429));
    await open();
    expect(api.status).not.toHaveBeenCalled();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).not.toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
    api.role.mockReturnValue(of({ collector: false }));
    el().querySelector('button')!.click();
    await flush();
    expect(text()).toContain('Unpaid Person');
  });

  describe('as the collector', () => {
    let manage: ReturnType<typeof vi.fn>;
    let configure: ReturnType<typeof vi.fn>;
    const collectorOpen = async () => {
      TestBed.overrideComponent(PaymentStatus, {
        remove: { imports: [SlipReview] },
        add: { imports: [FakeSlipReview] },
      });
      await open();
    };

    beforeEach(() => {
      api.role.mockReturnValue(of({ collector: true }));
      manage = vi.fn().mockReturnValue(of(MANAGE));
      configure = vi.fn();
      TestBed.overrideComponent(PaymentStatus, {
        set: { providers: [{ provide: CollectorSlipService, useValue: { manage, configure } }] },
      });
    });

    it('renders the manage header and the review in collector mode instead of the status list', async () => {
      await collectorOpen();
      expect(configure).toHaveBeenCalledWith('TOK', 'ACCESS');
      expect(manage).toHaveBeenCalledWith('abc');
      expect(api.status).not.toHaveBeenCalled();
      expect(text()).toContain('คุณจัดการการชำระเงินบิลนี้');
      expect(text()).not.toContain('ดูได้อย่างเดียว');
      const review = fixture.debugElement.query((d) => d.name === 'app-slip-review');
      expect(review).not.toBeNull();
      expect(review.componentInstance.collectorMode()).toBe(true);
      expect(review.componentInstance.hideTitle()).toBe(true);
      expect(review.componentInstance.code()).toBe('abc');
      expect(review.componentInstance.rows()).toEqual(MANAGE.rows);
      expect(el().querySelector('[data-status-row]')).toBeNull();
    });

    it('shows unavailable when the manage read is refused', async () => {
      manage.mockReturnValue(error(404));
      await collectorOpen();
      expect(text()).toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
      expect(el().querySelector('app-slip-review')).toBeNull();
    });

    it('uses the same management view for owner access and host payment marks', async () => {
      manage.mockReturnValue(of({ ...MANAGE, paid: [{ playerId: 'p1', source: 'host', at: '2026-11-01T10:00:00Z', amountChangedSince: false, imageId: null }] }));
      await collectorOpen();
      expect(manage).toHaveBeenCalledWith('abc');
      expect(api.status).not.toHaveBeenCalled();
      const review = fixture.debugElement.query((d) => d.name === 'app-slip-review');
      expect(review.componentInstance.collectorMode()).toBe(true);
    });
  });
});
