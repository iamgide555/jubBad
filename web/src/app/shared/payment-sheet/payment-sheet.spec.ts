import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { SlipHostService } from '../../core/slip-host.service';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PaymentSheet } from './payment-sheet';
import { environment } from '../../../environments/environment';
import type { PaymentCardPanel } from '../../core/payment-card.model';
import type { BillResponse } from '../../core/bill.model';

const URL = `${environment.apiBaseUrl}/sessions/sess1/payment-card`;
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'Host Name' };

function panel(over: Partial<PaymentCardPanel> = {}): PaymentCardPanel {
  return {
    target: 'group',
    ended: true,
    ready: false,
    contentHash: 'hash-1',
    groupName: 'ตีชิล',
    date: '29 ต.ค. 2569',
    venue: null,
    warnings: ['shuttle-price'],
    notices: [],
    rows: [{ playerId: 'a', name: 'Amp', amountSatang: 9000, absent: false }],
    settledCount: 0,
    totalSatang: 9000,
    groupAccount: ACCOUNT,
    account: ACCOUNT,
    confirmed: false,
    stale: false,
    lastSentAt: null,
    lastDmAt: null,
    shareUrl: null,
    ...over,
  };
}

// jsdom 28's HTMLDialogElement has no showModal()/close(); same shim as the other dialog specs.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

describe('PaymentSheet', () => {
  let fixture: ComponentFixture<PaymentSheet>;
  let http: HttpTestingController;
  const closed = vi.fn<() => void>();
  const sent = vi.fn<() => void>();

  const el = () => fixture.nativeElement as HTMLElement;
  const dialog = () => el().querySelector('dialog') as HTMLDialogElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaymentSheet],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        // A confirmed card embeds the slip review, which reads its own routes (covered in slip-review.spec.ts).
        { provide: SlipHostService, useValue: { panel: () => of({ paid: [], waiting: [], duplicates: [], links: [] }) } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PaymentSheet);
    closed.mockClear();
    sent.mockClear();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.componentInstance.sent.subscribe(sent);
    fixture.componentRef.setInput('sessionCode', 'sess1');
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
  });
  afterEach(() => {
    for (const req of http.match(r => r.url.endsWith('/sessions/sess1/bill'))) {
      req.flush({}, { status: 500, statusText: 'Server Error' });
    }
    http.verify();
  });

  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  async function open(body: PaymentCardPanel = panel()) {
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    http.expectOne(URL).flush(body);
    await settle();
  }

  it('is a closed dialog that reads nothing until it is opened', () => {
    expect(dialog().open).toBe(false);
    http.expectNone(URL);
    expect(el().querySelector('app-payment-panel')).toBeNull();
  });

  it('keeps an in-flight method save alive after closing and reports its latest bill', async () => {
    await open(panel({ ready: true, confirmed: true, warnings: [] }));
    const bill = {
      session: { shuttleToolsEnabled: false }, configSource: 'saved',
      config: { model: 'perGame', perGameRateSatang: 1000, entryFeeSatang: 0, capSatang: null, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1 },
    } as BillResponse;
    http.expectOne(`${environment.apiBaseUrl}/sessions/sess1/bill`).flush(bill);
    await settle();
    const changed = vi.fn();
    fixture.componentInstance.billChanged.subscribe(changed);
    el().querySelector<HTMLButtonElement>('app-payment-calculation [data-model="buffet"]')!.click();
    await settle();
    const save = http.expectOne(`${environment.apiBaseUrl}/sessions/sess1/bill-method`);
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    expect(dialog().open).toBe(false);
    expect(el().querySelector('app-payment-panel')).not.toBeNull();
    const updated = { ...bill, config: { ...bill.config, model: 'buffet', buffetPriceSatang: 15000, buffetShuttlesIncluded: true } };
    save.flush(updated);
    await settle();
    expect(changed).toHaveBeenCalledWith(updated);
    http.expectOne(URL).flush(panel({ ready: true, confirmed: false, warnings: [] }));
    await settle();
    expect(el().querySelector('app-payment-panel')).toBeNull();
  });

  it('opens as a modal dialog holding the compact payment panel', async () => {
    await open();
    expect(dialog().open).toBe(true);
    expect(el().querySelector('h2')?.textContent).toContain('ใบเก็บเงิน');
    expect(el().querySelector('[data-payment-panel].compact')).not.toBeNull();
  });

  it('is the payment bottom sheet, on top of the shared sheet shell', async () => {
    await open();
    expect(dialog().classList.contains('payment-sheet')).toBe(true);
    expect(dialog().classList.contains('sheet-dialog')).toBe(true);
  });

  it('has one labelled close button, at the top in a sticky header, which only asks to close', async () => {
    await open();
    const header = el().querySelector('.sheet-header') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.querySelector('h2')?.textContent).toContain('ใบเก็บเงิน');
    const top = header.querySelector('button.close-top') as HTMLButtonElement;
    expect(top.textContent?.trim()).toBe('ปิด');
    expect(top.getAttribute('type')).toBe('button');
    // No full-width close at the bottom competing with the primary action.
    expect(el().querySelector('button.close')).toBeNull();
    const closes = [...el().querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'ปิด');
    expect(closes).toEqual([top]);
    top.click();
    expect(closed).toHaveBeenCalledTimes(1);
    http.expectNone(`${URL}/confirm`);
    http.expectNone(`${URL}/send`);
  });

  it('closes on a tap on the backdrop, but not on a tap inside the sheet', async () => {
    await open();
    (el().querySelector('.sheet-card h2') as HTMLElement).click();
    expect(closed).not.toHaveBeenCalled();
    dialog().click();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("puts the panel's actions in its sticky bottom bar", async () => {
    await open(panel({ ready: true, warnings: [] }));
    const bar = el().querySelector('[data-actions]') as HTMLElement;
    expect(bar.classList.contains('bar')).toBe(true);
    expect(bar.querySelector('[data-confirm]')).not.toBeNull();
    // The status region rides in the same sticky bar, directly above the button, so an outcome is never under it.
    const dock = el().querySelector('[data-dock]') as HTMLElement;
    const live = dock.querySelector('[aria-live="polite"]')!;
    expect(dock.classList.contains('bar')).toBe(true);
    expect(dock.contains(bar)).toBe(true);
    expect(live.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no amounts while the bill is not ready', async () => {
    await open();
    expect(el().querySelector('[data-missing]')).not.toBeNull();
    expect(el().querySelector('[data-row]')).toBeNull();
    expect(el().querySelector('[data-total]')).toBeNull();
  });

  it('closes when the panel says the host followed its link to the bill', async () => {
    await open();
    (el().querySelector('[data-settings-link]') as HTMLAnchorElement).click();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, which the browser reports as a native close', async () => {
    await open();
    dialog().dispatchEvent(new Event('close'));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes the native dialog when the parent turns open off, without a second closed event', async () => {
    await open();
    fixture.componentRef.setInput('open', false);
    await settle();
    expect(dialog().open).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });

  it('tells the parent when the card went into the group', async () => {
    await open(panel({ ready: true, warnings: [], confirmed: true, stale: false }));
    (el().querySelector('[data-send]') as HTMLButtonElement).click();
    await settle();
    const req = http.expectOne(`${URL}/send`);
    req.flush({ outcome: 'sent' });
    await settle();
    http.expectOne(URL).flush(panel({ ready: true, warnings: [], confirmed: true, lastSentAt: '2026-10-29T13:00:00.000Z' }));
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });
});
