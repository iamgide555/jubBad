import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { PaymentCardPanel } from '../../core/payment-card.model';
import { SlipHostService } from '../../core/slip-host.service';
import { environment } from '../../../environments/environment';
import { PaymentStatusSheet } from './payment-status-sheet';

const URL = `${environment.apiBaseUrl}/sessions/sess1/payment-card`;
const card = (over: Partial<PaymentCardPanel> = {}): PaymentCardPanel => ({
  target: 'group', ended: true, ready: true, contentHash: 'h1', groupName: 'Court', date: '31 Oct 2026', venue: null,
  warnings: [], notices: [], rows: [{playerId: 'a', name: 'Amp', amountSatang: 9000, absent: false}],
  settledCount: 0, totalSatang: 9000, groupAccount: {bank: 'Bank', number: '123456', name: 'Saved Name'},
  account: {bank: 'Bank', number: '123456', name: 'Tonight Name'}, confirmed: true, stale: false,
  lastSentAt: '2026-10-31T04:00:00Z', lastDmAt: null, shareUrl: null, ...over,
});

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});

describe('PaymentStatusSheet', () => {
  let fixture: ComponentFixture<PaymentStatusSheet>;
  let http: HttpTestingController;
  let slips: {panel: ReturnType<typeof vi.fn>};
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); await new Promise(r => setTimeout(r, 0)); fixture.detectChanges(); };
  beforeEach(() => {
    slips = {panel: vi.fn().mockReturnValue(of({paid: [], waiting: [], duplicates: [], links: []}))};
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting(), {provide: SlipHostService, useValue: slips}]});
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PaymentStatusSheet);
    fixture.componentRef.setInput('sessionCode', 'sess1'); fixture.componentRef.setInput('open', false);
  });
  afterEach(() => http.verify());
  async function open() { fixture.componentRef.setInput('open', true); await settle(); }

  it('reads only while open and opens directly to current players without an invoice', async () => {
    await settle(); http.expectNone(URL); expect(slips.panel).not.toHaveBeenCalled();
    await open(); expect(root().textContent).toContain('กำลังโหลด');
    http.expectOne(URL).flush(card()); await settle();
    expect(root().querySelector('dialog')?.open).toBe(true);
    expect(root().querySelector('[data-collection-context]')?.textContent).toContain('Court');
    expect(root().querySelector('[data-collection-context]')?.textContent).toContain('31 Oct 2026');
    expect(root().querySelector('[data-paid-count]')?.textContent).toContain('0 / 1');
    expect(root().querySelector('[data-person]')?.textContent).toContain('Amp');
    expect(root().querySelector('app-payment-panel')).toBeNull();
    expect(root().querySelectorAll('.sheet-header h2')).toHaveLength(1);
    expect(root().querySelector('[data-slip-review] > header h3')).toBeNull();
    expect(slips.panel).toHaveBeenCalledWith('sess1');
    fixture.componentRef.setInput('open', false); await settle();
    await open(); http.expectOne(URL).flush(card({rows: [{playerId: 'b', name: 'Beam', amountSatang: 10000, absent: false}]})); await settle();
    expect(root().querySelector('[data-person]')?.textContent).toContain('Beam');
  });

  it.each([
    {confirmed: false, lastSentAt: null},
    {confirmed: true, lastSentAt: null, lastDmAt: '2026-10-31'},
  ])('refuses an ineligible fresh card %j', async state => {
    await open(); http.expectOne(URL).flush(card(state)); await settle();
    expect(root().querySelector('[data-status-unavailable]')).not.toBeNull();
    expect(slips.panel).not.toHaveBeenCalled();
  });

  it('shows a visible error and retries without rendering stale host data', async () => {
    await open(); http.expectOne(URL).flush({}, {status: 500, statusText: 'Error'}); await settle();
    expect(root().querySelector('[role=alert]')).not.toBeNull();
    root().querySelector<HTMLButtonElement>('[data-status-retry]')!.click(); await settle();
    http.expectOne(URL).flush(card()); await settle();
    expect(root().querySelector('[data-slip-review]')).not.toBeNull();
  });

  it('hides host controls if owner access was revoked', async () => {
    await open(); http.expectOne(URL).flush({}, {status: 404, statusText: 'Not found'}); await settle();
    expect(root().querySelector('[data-status-unavailable]')).not.toBeNull();
    expect(slips.panel).not.toHaveBeenCalled();
  });

  it('uses the group saved name when fixing a receiver mismatch', async () => {
    slips.panel.mockReturnValue(of({paid: [], links: [], duplicates: [], waiting: [{id: 'w1', reason: 'receiver', displayName: 'Mind', pictureUrl: null, lineUserId: 'u1', amountSatang: 9000, receiverName: 'New Name', receiverTail: null, createdAt: '2026-10-31T04:00:00Z', candidatePlayerIds: ['a']}]}));
    await open(); http.expectOne(URL).flush(card()); await settle();
    root().querySelector<HTMLButtonElement>('[data-update-name]')!.click(); await settle();
    const text = root().querySelector('[data-name-dialog]')!.textContent!;
    expect(text).toContain('Saved Name'); expect(text).not.toContain('Tonight Name');
  });
});
