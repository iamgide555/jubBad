import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { PaymentPanel } from './payment-panel';
import { environment } from '../../../environments/environment';
import type { PaymentCardPanel, PaymentSendOutcome } from '../../core/payment-card.model';
import { PaymentDraftService } from '../../core/payment-card.service';
import { Component, input, output } from '@angular/core';
import { By } from '@angular/platform-browser';
import type { BillResponse } from '../../core/bill.model';
import { PaymentCalculation } from '../payment-calculation/payment-calculation';

@Component({ selector: 'app-payment-calculation', template: '' })
class CalculationStub {
  readonly sessionCode = input.required<string>();
  readonly refreshKey = input<unknown>(null);
  readonly locked = input(false);
  readonly confirmed = input(false);
  readonly changed = output<BillResponse>();
  readonly changing = output<boolean>();
}
import type { SlipHostPanel } from '../../core/slip-host.model';
import { SlipHostService } from '../../core/slip-host.service';

const URL = `${environment.apiBaseUrl}/sessions/sess1/payment-card`;
const GROUP_ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'Host Name' };

function panel(over: Partial<PaymentCardPanel> = {}): PaymentCardPanel {
  return {
    target: 'group',
    ended: true,
    ready: true,
    contentHash: 'hash-1',
    groupName: 'ตีชิล',
    date: '29 ต.ค. 2569',
    venue: 'Bad@Mama',
    warnings: [],
    notices: [],
    rows: [
      { playerId: 'a', name: 'Amp', amountSatang: 9000, absent: false },
      { playerId: 'd', name: 'Dee', amountSatang: 11000, absent: false },
    ],
    settledCount: 0,
    totalSatang: 20000,
    groupAccount: GROUP_ACCOUNT,
    account: GROUP_ACCOUNT,
    confirmed: false,
    stale: false,
    lastSentAt: null,
    lastDmAt: null,
    shareUrl: null,
    ...over,
  };
}

beforeAll(() => {
  // jsdom has no modal dialogs; the embedded slip review confirms with one.
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

describe('PaymentCardPanel', () => {
  let fixture: ComponentFixture<PaymentPanel>;
  let http: HttpTestingController;
  /** The embedded slip review reads its own routes; its behaviour is covered in slip-review.spec.ts. */
  let slipPanel: SlipHostPanel;
  let slipHost: { panel: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    TestBed.overrideComponent(PaymentPanel, { remove: { imports: [PaymentCalculation] }, add: { imports: [CalculationStub] } });
    slipPanel = { paid: [], waiting: [], duplicates: [], links: [] };
    slipHost = { panel: vi.fn().mockImplementation(() => of(slipPanel)) };
    await TestBed.configureTestingModule({
      imports: [PaymentPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: SlipHostService, useValue: slipHost },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => el().querySelector<T>(selector);
  const text = () => el().textContent ?? '';

  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    // Responses resolve through several promise hops (a send awaits the re-read it triggers).
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  async function open(body: PaymentCardPanel = panel(), inputs: Record<string, unknown> = {}) {
    fixture = TestBed.createComponent(PaymentPanel);
    fixture.componentRef.setInput('sessionCode', 'sess1');
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    http.expectOne(URL).flush(body);
    await settle();
  }

  async function type(selector: string, value: string) {
    const input = q<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function click(selector: string) {
    q<HTMLButtonElement>(selector)!.click();
    await settle();
  }

  /** "แก้บัญชีคืนนี้": the fields fold into the preview while they hold the group or confirmed account. */
  async function expandAccount() {
    await click('[data-edit-account]');
  }

  /** Busy or out of date: refused by a guard and marked aria-disabled, never natively disabled (focus stays). */
  const off = (selector: string) => {
    const button = q<HTMLButtonElement>(selector);
    return button === null || button.getAttribute('aria-disabled') === 'true';
  };

  async function confirm(response: PaymentCardPanel) {
    await click('[data-confirm]');
    const req = http.expectOne(`${URL}/confirm`);
    expect(req.request.method).toBe('POST');
    req.flush(response);
    await settle();
    return req.request.body;
  }

  /** Every send outcome re-reads the panel; `reloaded` is what that read answers. */
  async function send(outcome: PaymentSendOutcome, reloaded: PaymentCardPanel = panel({ confirmed: true })) {
    await click('[data-send]');
    const req = http.expectOne(`${URL}/send`);
    req.flush({ outcome });
    await settle();
    http.expectOne(URL).flush(reloaded);
    await settle();
    return req.request.body as { sendId: string };
  }

  it('renders nothing when there is no target', async () => {
    await open(panel({ target: null }));
    expect(text().trim()).toBe('');
    expect(el().children).toHaveLength(0);
  });

  it('tells the calculation toggle whether a current confirmation stands', async () => {
    await open(panel({ confirmed: true }));
    const stub = () => fixture.debugElement.query(By.directive(CalculationStub)).componentInstance as CalculationStub;
    expect(stub().confirmed()).toBe(true);
  });

  it('does not warn about revoking when the card is not confirmed', async () => {
    await open(panel({ confirmed: false }));
    const stub = fixture.debugElement.query(By.directive(CalculationStub)).componentInstance as CalculationStub;
    expect(stub.confirmed()).toBe(false);
  });

  it('blocks sending while changing method and until fresh amounts are read', async () => {
    await open(panel({ confirmed: true }));
    const calculation = fixture.debugElement.query(By.directive(CalculationStub)).componentInstance as CalculationStub;
    calculation.changing.emit(true);
    await click('[data-send]');
    http.expectNone(`${URL}/send`);
    calculation.changed.emit({} as BillResponse);
    calculation.changing.emit(false);
    await settle();
    expect(q('[data-send]')).toBeNull();
    http.expectNone(`${URL}/send`);
    http.expectOne(URL).flush(panel({ confirmed: false, totalSatang: 30000 }));
    await settle();
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-confirm]')).not.toBeNull();
    expect(q('[data-total]')?.textContent).toContain('฿300');
  });

  it('offers bill settings for zero totals and requests local settings from the bill page', async () => {
    await open(panel({ totalSatang: 0, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 0, absent: false }] }), { compact: true, onBillPage: true });
    const requested = vi.fn();
    expect(q('[data-empty]')?.textContent).toContain('ยอดทุกคนเป็น 0 บาท');
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
    (fixture.componentInstance as unknown as { settingsRequested: { subscribe: (fn: () => void) => unknown } }).settingsRequested.subscribe(requested);
    await click('button[data-settings-link]');
    expect(requested).toHaveBeenCalledOnce();
  });

  it('shows a loading status until the first read resolves', async () => {
    fixture = TestBed.createComponent(PaymentPanel);
    fixture.componentRef.setInput('sessionCode', 'sess1');
    fixture.detectChanges();
    const req = http.expectOne(URL);
    expect(q('[data-loading]')?.textContent).toContain('กำลังโหลดใบเก็บเงิน');
    req.flush(panel());
    await settle();
    expect(q('[data-loading]')).toBeNull();
  });

  it('puts session, total and receiving account before the full roster', async () => {
    await open();
    const summary = q('[data-review-summary]')!;
    expect(summary?.textContent).toContain('ตีชิล');
    expect(summary?.textContent).toContain('29 ต.ค. 2569');
    expect(summary?.textContent).toContain('฿200');
    expect(summary?.textContent).toContain('Host Name');
    expect(summary?.textContent).toContain('123-4-56789-0');
    expect(summary.compareDocumentPosition(q('[data-rows]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expandAccount();
    await type('input[data-field="name"]', 'Tonight');
    expect(summary.textContent).toContain('Tonight');
    expect(q('[data-preview] [data-row]')).not.toBeNull();
  });

  it('announces confirmation progress and keeps the focused button', async () => {
    await open();
    const button = q('[data-confirm]')!;
    button.focus();
    await click('[data-confirm]');
    const req = http.expectOne(`${URL}/confirm`);
    expect(button.textContent).toContain('กำลังยืนยัน');
    expect(q('[aria-live="polite"] [data-progress]')?.textContent).toContain('กำลังยืนยัน');
    expect(document.activeElement).toBe(button);
    req.flush(panel({ confirmed: true }));
    await settle();
    expect(q('[data-progress]')).toBeNull();
  });

  it('announces delivery progress until the outcome and re-read finish', async () => {
    await open(panel({ confirmed: true }));
    await click('[data-send]');
    const req = http.expectOne(`${URL}/send`);
    expect(q('[data-send]')?.textContent).toContain('กำลังส่ง');
    expect(q('[data-progress]')?.textContent).toContain('กำลังส่ง');
    req.flush({ outcome: 'sent' });
    await settle();
    expect(q('[data-progress]')).not.toBeNull();
    http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
    await settle();
    expect(q('[data-progress]')).toBeNull();
  });

  it('links missing account errors to fields and focuses the first invalid input', async () => {
    await open(panel({ account: null, groupAccount: null }));
    await type('input[data-field="number"]', '123456');
    await click('[data-confirm]');
    http.expectNone(`${URL}/confirm`);
    const bank = q<HTMLInputElement>('[data-field="bank"] input')!;
    expect(bank.getAttribute('aria-invalid')).toBe('true');
    expect(q(`#${bank.getAttribute('aria-describedby')}`)?.textContent).toContain('กรอกช่องนี้');
    expect(document.activeElement).toBe(bank);
    // Focus moved by validation, not by the host: the bank list stays shut, so it never covers the error.
    expect(q('[role="listbox"]')).toBeNull();
    expect(bank.getAttribute('aria-expanded')).toBe('false');
    await type('[data-field="bank"] input', 'กสิกร');
    expect(bank.hasAttribute('aria-invalid')).toBe(false);
  });

  it('rejects an invalid number locally, retaining input and focusing its error', async () => {
    await open();
    await expandAccount();
    await type('input[data-field="number"]', '12abc');
    await click('[data-confirm]');
    http.expectNone(`${URL}/confirm`);
    const number = q<HTMLInputElement>('input[data-field="number"]')!;
    expect(number.value).toBe('12abc');
    expect(number.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(number);
    const described = number.getAttribute('aria-describedby')!.split(' ');
    expect(described.map(id => q(`#${id}`)?.textContent).join(' ')).toContain('6');
  });

  it('lists who owes what, with the total, name left and amount right', async () => {
    await open(panel({ settledCount: 2 }));
    const rows = [...el().querySelectorAll('[data-row]')];
    expect(rows.map((r) => r.querySelector('.row-name')?.textContent?.trim())).toEqual(['Amp', 'Dee']);
    expect(rows.map((r) => r.querySelector('.row-amount')?.textContent?.trim())).toEqual(['฿90', '฿110']);
    expect(q('[data-total]')?.textContent).toContain('฿200');
    expect(q('[data-settled]')?.textContent).toContain('2');
  });

  it('marks a no-show and reads a zero amount as nothing to transfer', async () => {
    await open(
      panel({
        rows: [
          { playerId: 'a', name: 'Amp', amountSatang: 0, absent: false },
          { playerId: 'z', name: 'Zed', amountSatang: 5000, absent: true },
        ],
      })
    );
    const rows = [...el().querySelectorAll('[data-row]')];
    expect(rows[0].querySelector('.row-amount')?.textContent).toContain('ไม่ต้องโอน');
    expect(rows[1].querySelector('.row-name')?.textContent).toContain('Zed');
    expect(rows[1].textContent).toContain('(ไม่มา)');
    expect(rows[0].textContent).not.toContain('(ไม่มา)');
  });

  it('says nobody owes anything, with no confirm or send', async () => {
    await open(panel({ rows: [], totalSatang: 0 }));
    expect(q('[data-empty]')).toBeTruthy();
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
  });

  it('treats people listed at 0 baht each as nobody owing: the empty state, no confirm or send', async () => {
    const zero = [
      { playerId: 'a', name: 'Amp', amountSatang: 0, absent: false },
      { playerId: 'd', name: 'Dee', amountSatang: 0, absent: false },
    ];
    await open(panel({ rows: zero, totalSatang: 0, confirmed: true }));
    expect(q('[data-empty]')?.textContent).toContain('ยอดทุกคนเป็น 0 บาท');
    expect(el().querySelectorAll('[data-row]')).toHaveLength(0);
    expect(q('[data-total]')).toBeNull();
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-share-link]')).toBeNull();
  });

  it('prefills the account from the group default when none was confirmed tonight', async () => {
    await open(panel({ account: null }));
    // Folded into the preview as the card prints it, until the host asks to change it.
    expect(q('[data-field="bank"] input')).toBeNull();
    expect(q('[data-account-name]')?.textContent).toContain('โอนให้ Host Name');
    expect(q('[data-account]')?.textContent).toContain('กสิกร');
    expect(q('[data-account-number]')?.textContent?.trim()).toBe('123-4-56789-0');
    await expandAccount();
    expect(q<HTMLInputElement>('[data-field="bank"] input')!.value).toBe('กสิกร');
    expect(q<HTMLInputElement>('input[data-field="number"]')!.value).toBe('123-4-56789-0');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Host Name');
  });

  it('prefers the confirmed account for tonight over the group default', async () => {
    await open(panel({ account: { bank: 'ไทยพาณิชย์', number: '999-9-99999-9', name: 'Tonight' }, confirmed: true }));
    expect(q('[data-account-name]')?.textContent).toContain('โอนให้ Tonight');
    // Tonight's account is not the group's, so putting the group's back is offered beside the edit action.
    expect(q('[data-use-group]')).toBeTruthy();
    await expandAccount();
    expect(q<HTMLInputElement>('[data-field="bank"] input')!.value).toBe('ไทยพาณิชย์');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Tonight');
  });

  it('numeric account field asks for the numeric keypad', async () => {
    await open();
    await expandAccount();
    expect(q('input[data-field="number"]')?.getAttribute('inputmode')).toBe('numeric');
  });

  it('disables confirm and points to group settings when there is no account anywhere', async () => {
    await open(panel({ account: null, groupAccount: null }));
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
    expect(q('[data-no-account]')?.textContent).toContain('ตั้งบัญชีรับเงินในหน้าตั้งค่ากลุ่ม');

    await type('[data-field="bank"] input', 'กสิกร');
    await type('input[data-field="number"]', '123-4-56789-0');
    await type('input[data-field="name"]', 'Host');
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
    expect(q('[data-no-account]')).toBeNull();
  });

  it('posts the three fields on confirm, with the content hash of the amounts on screen', async () => {
    await open();
    await expandAccount();
    await type('input[data-field="number"]', ' 111-1-11111-1 ');
    const body = await confirm(panel({ confirmed: true }));
    expect(body).toEqual({ bank: 'กสิกร', number: '111-1-11111-1', name: 'Host Name', expectedHash: 'hash-1' });
  });

  it('shows the group send button only once confirmed', async () => {
    await open();
    expect(q('[data-send]')).toBeNull();
    await confirm(panel({ confirmed: true }));
    expect(q('[data-send]')?.textContent).toContain('ส่งเข้ากลุ่ม');
  });

  it('host target: after confirm, an anchor to the share link and no sent claim', async () => {
    await open(panel({ target: 'host' }));
    expect(q('[data-share-link]')).toBeNull();
    await confirm(panel({ target: 'host', confirmed: true, shareUrl: 'https://liff.line.me/1/pay/sess1/tok' }));
    const a = q<HTMLAnchorElement>('a[data-share-link]')!;
    expect(a.getAttribute('href')).toBe('https://liff.line.me/1/pay/sess1/tok');
    expect(a.textContent).toContain('เปิดใน LINE เพื่อส่ง');
    expect(text()).toContain('กดแล้วเลือกกลุ่มในแอป LINE');
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-sent]')).toBeNull();
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    await settle();
    expect(q('[data-sent]')).toBeNull();
    expect(text()).not.toContain('ส่งแล้ว');
  });

  it('group send posts a fresh UUID, says sent and tells the host page', async () => {
    await open(panel({ confirmed: true }));
    const sent: number[] = [];
    fixture.componentInstance.sent.subscribe(() => sent.push(1));
    const body = await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
    expect(body.sendId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(q('[data-outcome]')?.textContent).toContain('ส่งแล้ว');
    expect(sent).toHaveLength(1);
    expect(q('[data-send]')?.textContent).toContain('ส่งอีกครั้ง');
  });

  it('a second send asks first, inline, and sends a different UUID', async () => {
    await open(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
    expect(q('[data-last-sent]')?.textContent).toContain('ส่งแล้ว');
    expect(q('[data-send]')?.textContent).toContain('ส่งอีกครั้ง');

    await click('[data-send]');
    http.expectNone(`${URL}/send`);
    expect(q('[data-resend-prompt]')).toBeTruthy();

    await click('[data-resend-cancel]');
    expect(q('[data-resend-prompt]')).toBeNull();
    http.expectNone(`${URL}/send`);

    await click('[data-send]');
    const first = await (async () => {
      await click('[data-resend-yes]');
      const req = http.expectOne(`${URL}/send`);
      req.flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:06:00.000Z' }));
      await settle();
      return req.request.body.sendId as string;
    })();

    await click('[data-send]');
    await click('[data-resend-yes]');
    const second = http.expectOne(`${URL}/send`);
    expect(second.request.body.sendId).not.toBe(first);
    second.flush({ outcome: 'sent' });
    await settle();
    http.expectOne(URL).flush(panel({ confirmed: true }));
  });

  it('stale hides the send action and asks to confirm again, with Confirm as the one primary', async () => {
    await open(panel({ confirmed: true, stale: true }));
    expect(q('[data-stale]')?.textContent).toContain('ยอดเปลี่ยน ยืนยันใหม่อีกครั้ง');
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-share-link]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
    expect(off('[data-confirm]')).toBe(false);
    expect(q('[data-confirm]')?.textContent?.trim()).toBe('ยืนยันใหม่');
    expect(q('[data-confirm]')?.classList.contains('ghost')).toBe(false);
  });

  it('hides send when the account is edited after confirming, until confirmed again', async () => {
    await open(panel({ confirmed: true }));
    expect(q('[data-send]')).toBeTruthy();
    await expandAccount();
    await type('input[data-field="name"]', 'Someone Else');
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-edited]')).toBeTruthy();
  });

  describe('not ready', () => {
    const cases: [string, string][] = [
      ['MISSING_COURT_FEE', 'ยังไม่ได้ใส่ค่าสนาม'],
      ['MISSING_SHUTTLE_COUNT', 'ยังไม่ได้ใส่จำนวนลูก'],
      ['MISSING_SHUTTLE_PRICE', 'ยังไม่ได้ใส่ราคาลูก'],
      ['UNKNOWN_SHUTTLE_USE', 'มีเกมที่ไม่ได้บันทึกลูก'],
    ];
    for (const [code, message] of cases) {
      it(`names ${code} and offers neither confirm nor send`, async () => {
        await open(panel({ ready: false, warnings: [code], rows: [], totalSatang: 0 }));
        expect(q('[data-missing]')?.textContent).toContain(message);
        expect(q('[data-confirm]')).toBeNull();
        expect(q('[data-send]')).toBeNull();
        expect(q('[data-empty]')).toBeNull();
      });
    }

    it('lists every missing input at once', async () => {
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE', 'MISSING_SHUTTLE_PRICE'] }));
      const t = q('[data-missing]')!.textContent!;
      expect(t).toContain('ยังไม่ได้ใส่ค่าสนาม');
      expect(t).toContain('ยังไม่ได้ใส่ราคาลูก');
    });

    // The amounts are provisional while an input is missing, so none of them is shown anywhere.
    for (const [where, inputs] of [
      ['on the bill screen', {}],
      ['in the sheet', { compact: true }],
    ] as const) {
      it(`shows no rows and no total ${where}, only what is missing`, async () => {
        await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'], settledCount: 1 }), inputs);
        expect(q('[data-missing]')?.textContent).toContain('ยังไม่ได้ใส่ค่าสนาม');
        expect(q('[data-rows]')).toBeNull();
        expect(el().querySelectorAll('[data-row]')).toHaveLength(0);
        expect(q('[data-total]')).toBeNull();
        expect(q('[data-settled]')).toBeNull();
        expect(text()).not.toContain('90฿');
        expect(text()).not.toContain('200');
      });
    }

    it('shows no rows and no total for an open session either, only what is missing', async () => {
      await open(panel({ ended: false, ready: false, warnings: ['MISSING_SHUTTLE_PRICE'] }));
      expect(q('[data-missing]')?.textContent).toContain('ยังไม่ได้ใส่ราคาลูก');
      expect(q('[data-rows]')).toBeNull();
      expect(q('[data-total]')).toBeNull();
      expect(q('[data-open-note]')).toBeNull();
      expect(q('[data-confirm]')).toBeNull();
    });

    it('links to the bill settings only in the compact sheet, and closing follows the link', async () => {
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }), { compact: true });
      const closed: number[] = [];
      fixture.componentInstance.closed.subscribe(() => closed.push(1));
      const link = q<HTMLAnchorElement>('a[data-settings-link]')!;
      expect(link.getAttribute('href')).toBe('/s/sess1/bill#bill-settings');
      link.addEventListener('click', (e) => e.preventDefault());
      link.click();
      expect(closed).toHaveLength(1);
    });

    it('has no settings link when embedded in the bill screen', async () => {
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }));
      expect(q('[data-settings-link]')).toBeNull();
      expect(q('[data-missing]')).toBeTruthy();
    });
  });

  it('shows a preview with a note, and no actions, while the session is still open', async () => {
    await open(panel({ ended: false }));
    expect(q('[data-open-note]')).toBeTruthy();
    expect(el().querySelectorAll('[data-row]')).toHaveLength(2);
    expect(q('[data-total]')?.textContent).toContain('฿200');
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-field="bank"] input')).toBeNull();
  });

  it('shows informational notices without blocking confirm', async () => {
    await open(panel({ warnings: ['EXCESS_CREDIT'], notices: ['EXCESS_CREDIT'] }));
    expect(q('[data-notice]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
  });

  describe('send outcomes', () => {
    const cases: [PaymentSendOutcome, string][] = [
      ['quota', 'โควต้า'],
      ['failed', 'ส่งไม่สำเร็จ'],
      ['unavailable', 'ตอนนี้ส่งเข้าไลน์ไม่ได้'],
      ['busy', 'เพิ่งส่งเข้ากลุ่มไปแล้ว'],
      ['stale', 'ยอดเปลี่ยนไปแล้ว'],
      ['not-confirmed', 'ยังไม่ได้ยืนยันยอด'],
    ];
    for (const [outcome, message] of cases) {
      it(`${outcome} shows its message, re-reads the panel and does not claim a send`, async () => {
        await open(panel({ confirmed: true }));
        const sent: number[] = [];
        fixture.componentInstance.sent.subscribe(() => sent.push(1));
        await click('[data-send]');
        http.expectOne(`${URL}/send`).flush({ outcome });
        await settle();
        // Busy until the re-read lands.
        expect(off('[data-send]')).toBe(true);
        http.expectOne(URL).flush(panel({ confirmed: outcome !== 'not-confirmed', stale: outcome === 'stale' }));
        await settle();
        expect(q('[data-outcome]')?.textContent).toContain(message);
        expect(q('[data-outcome]')?.textContent).not.toBe('ส่งแล้ว');
        expect(sent).toHaveLength(0);
      });
    }

    it('busy re-reads the panel, so the send time it brings arms the resend prompt', async () => {
      await open(panel({ confirmed: true }));
      expect(q('[data-send]')?.textContent).toContain('ส่งเข้ากลุ่ม');
      await send('busy', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      expect(q('[data-outcome]')?.textContent).toContain('เพิ่งส่งเข้ากลุ่มไปแล้ว');
      expect(q('[data-send]')?.textContent).toContain('ส่งอีกครั้ง');
      await click('[data-send]');
      http.expectNone(`${URL}/send`);
      expect(q('[data-resend-prompt]')).toBeTruthy();
    });

    it('a network error on send reads as a failed send, and re-reads the panel', async () => {
      await open(panel({ confirmed: true }));
      await click('[data-send]');
      http.expectOne(`${URL}/send`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      http.expectOne(URL).flush(panel({ confirmed: true }));
      await settle();
      expect(q('[data-outcome]')?.textContent).toContain('ส่งไม่สำเร็จ');
    });
  });

  describe('retry key across taps', () => {
    it('a failed send is retried with the same sendId, so LINE drops a repeat of a card it already took', async () => {
      await open(panel({ confirmed: true }));
      const first = await send('failed');
      const second = await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      expect(second.sendId).toBe(first.sendId);
    });

    it('a send whose answer was lost (network error) is retried with the same sendId', async () => {
      await open(panel({ confirmed: true }));
      await click('[data-send]');
      const lost = http.expectOne(`${URL}/send`);
      lost.error(new ProgressEvent('error'));
      await settle();
      http.expectOne(URL).flush(panel({ confirmed: true }));
      await settle();
      const retry = await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      expect(retry.sendId).toBe(lost.request.body.sendId);
    });

    it('a deliberate resend after a sent card gets a new sendId', async () => {
      await open(panel({ confirmed: true }));
      const first = await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      await click('[data-send]');
      await click('[data-resend-yes]');
      const again = http.expectOne(`${URL}/send`);
      expect(again.request.body.sendId).not.toBe(first.sendId);
      again.flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:06:00.000Z' }));
      await settle();
    });

    for (const outcome of ['busy', 'quota', 'unavailable', 'stale', 'not-confirmed'] as const) {
      it(`a definitive ${outcome} answer makes the next tap a new sendId`, async () => {
        await open(panel({ confirmed: true }));
        const first = await send(outcome);
        const next = await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
        expect(next.sendId).not.toBe(first.sendId);
      });
    }

    it('a failed send is not reused once the card content changed', async () => {
      await open(panel({ confirmed: true }));
      const first = await send('failed', panel({ confirmed: true, contentHash: 'hash-2' }));
      const next = await send('sent', panel({ confirmed: true, contentHash: 'hash-2', lastSentAt: '2026-10-29T13:05:00.000Z' }));
      expect(next.sendId).not.toBe(first.sendId);
    });
  });

  describe('host target: bot DM of the card', () => {
    const SHARE = 'https://liff.line.me/1/pay/sess1/tok';
    const host = (over: Partial<PaymentCardPanel> = {}) =>
      panel({ target: 'host', confirmed: true, shareUrl: SHARE, ...over });

    /** One tap of the DM button; the outcome re-reads the panel, which answers `reloaded`. */
    async function dm(outcome: PaymentSendOutcome, reloaded: PaymentCardPanel = host()) {
      await click('[data-dm-send]');
      const req = http.expectOne(`${URL}/dm`);
      expect(req.request.method).toBe('POST');
      req.flush({ outcome });
      await settle();
      http.expectOne(URL).flush(reloaded);
      await settle();
      return req.request.body as { sendId: string };
    }

    it('offers a primary DM button for a sendable card, with the link and its hint folded under "ส่งวิธีอื่น"', async () => {
      await open(host());
      // Worded as a DM to the host, so it never reads like the summary page's "send to the group".
      expect(q('[data-dm-send]')?.textContent?.trim()).toBe('ส่งใบเก็บเงินให้ฉันทาง LINE');
      expect(off('[data-dm-send]')).toBe(false);
      const other = q<HTMLDetailsElement>('details[data-other-ways]')!;
      expect(other.open).toBe(false);
      expect(other.querySelector('summary')?.textContent?.trim()).toBe('ส่งวิธีอื่น');
      expect(other.querySelector<HTMLAnchorElement>('a[data-share-link]')!.getAttribute('href')).toBe(SHARE);
      expect(other.textContent).toContain('เปิดใน LINE เพื่อส่ง');
      expect(other.textContent).toContain('กดแล้วเลือกกลุ่มในแอป LINE');
      // The link is not in the action row: the DM button is the one primary there.
      expect(q('[data-actions] [data-share-link]')).toBeNull();
      expect(q('[data-send]')).toBeNull();
      expect(q('[data-confirm]')).toBeNull();
    });

    it('does not offer it for the group target', async () => {
      await open(panel({ confirmed: true }));
      expect(q('[data-dm-send]')).toBeNull();
      expect(q('[data-send]')).toBeTruthy();
    });

    it('does not offer it before the confirm', async () => {
      await open(panel({ target: 'host' }));
      expect(q('[data-dm-send]')).toBeNull();
    });

    it('does not offer it for a stale card', async () => {
      await open(host({ stale: true, shareUrl: null }));
      expect(q('[data-dm-send]')).toBeNull();
    });

    it('does not offer it once the account is edited after the confirm', async () => {
      await open(host());
      expect(q('[data-dm-send]')).toBeTruthy();
      await expandAccount();
      await type('input[data-field="name"]', 'Someone Else');
      expect(q('[data-dm-send]')).toBeNull();
      expect(q('[data-share-link]')).toBeNull();
    });

    it('does not offer it while an amount is undefined', async () => {
      await open(host({ ready: false, warnings: ['MISSING_COURT_FEE'], shareUrl: null }));
      expect(q('[data-dm-send]')).toBeNull();
    });

    it('does not offer it when nobody owes', async () => {
      await open(host({ rows: [], totalSatang: 0, shareUrl: null }));
      expect(q('[data-dm-send]')).toBeNull();
    });

    it('does not offer it without a share link (no LIFF id on the server)', async () => {
      await open(host({ shareUrl: null }));
      expect(q('[data-dm-send]')).toBeNull();
    });

    it('a tap posts a fresh UUID, says the card is in LINE with the sent time, and does not tell the host page', async () => {
      await open(host());
      const sent: number[] = [];
      fixture.componentInstance.sent.subscribe(() => sent.push(1));
      const at = '2026-10-29T13:05:00.000Z';
      const body = await dm('sent', host({ lastDmAt: at }));
      expect(body.sendId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const live = q('[aria-live="polite"]')!;
      const time = new Date(at);
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      // The DM's own words, in the live region: in the host's chat, and the group step still to do.
      expect(live.querySelector('[data-last-dm]')?.textContent?.trim()).toBe(
        `ส่งให้คุณใน LINE แล้ว ${hhmm} · ยังต้องกด "ส่งเข้ากลุ่ม" ในแชต`
      );
      // Never the group's "ส่งแล้ว" (sent): nothing reached the group yet.
      expect(text()).not.toContain('ส่งแล้ว');
      expect(sent).toHaveLength(0);
      expect(q('[data-dm-send]')?.textContent?.trim()).toBe('ส่งให้ฉันอีกครั้ง');
      expect(q('[data-last-sent]')).toBeNull();
    });

    it('marks the DM sent at once, so a quick second tap already asks first while the re-read runs', async () => {
      await open(host());
      await click('[data-dm-send]');
      http.expectOne(`${URL}/dm`).flush({ outcome: 'sent' });
      await settle();
      const reread = http.expectOne(URL);
      expect(off('[data-dm-send]')).toBe(true);
      // Keep progress until the re-read lands, alongside the optimistic DM timestamp.
      expect(q('[data-dm-send]')?.textContent).toContain('กำลังส่ง');
      expect(q('[data-last-dm]')?.textContent).toContain('ส่งให้คุณใน LINE แล้ว');
      reread.flush(host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      await settle();
      expect(q('[data-dm-send]')?.textContent?.trim()).toBe('ส่งให้ฉันอีกครั้ง');
    });

    it('a second tap after a sent card goes through the inline two-step, with a new UUID', async () => {
      await open(host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(q('[data-dm-send]')?.textContent?.trim()).toBe('ส่งให้ฉันอีกครั้ง');

      await click('[data-dm-send]');
      http.expectNone(`${URL}/dm`);
      expect(q('[data-dm-resend-prompt]')).toBeTruthy();
      expect(q('[data-dm-resend-prompt]')?.textContent).toContain('ส่งการ์ดให้ฉันซ้ำอีกรอบใช่ไหม');

      await click('[data-dm-resend-cancel]');
      expect(q('[data-dm-resend-prompt]')).toBeNull();
      http.expectNone(`${URL}/dm`);

      await click('[data-dm-send]');
      await click('[data-dm-resend-yes]');
      const req = http.expectOne(`${URL}/dm`);
      expect(req.request.body.sendId).toMatch(/^[0-9a-f-]{36}$/);
      req.flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(host({ lastDmAt: '2026-10-29T13:06:00.000Z' }));
      await settle();
    });

    it('a failed send is retried with the same sendId, and a definite answer starts a new one', async () => {
      await open(host());
      const first = await dm('failed');
      const second = await dm('sent', host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(second.sendId).toBe(first.sendId);

      await click('[data-dm-send]');
      await click('[data-dm-resend-yes]');
      const third = http.expectOne(`${URL}/dm`);
      expect(third.request.body.sendId).not.toBe(first.sendId);
      third.flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(host({ lastDmAt: '2026-10-29T13:06:00.000Z' }));
      await settle();
    });

    it('a failed send is not reused once the card content changed', async () => {
      await open(host());
      const first = await dm('failed', host({ contentHash: 'hash-2' }));
      const next = await dm('sent', host({ contentHash: 'hash-2', lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(next.sendId).not.toBe(first.sendId);
    });

    it('a kept sendId does not survive a re-confirm, which rotates the share link the DM card carries', async () => {
      const TOK2 = 'https://liff.line.me/1/pay/sess1/tok2';
      /** A current card offers no Confirm, so a re-confirm follows an account edit, as it would on screen. */
      const reconfirmAs = async (name: string) => {
        if (q('[data-edit-account]')) await expandAccount();
        await type('input[data-field="name"]', name);
        const account = { ...GROUP_ACCOUNT, name };
        await confirm(host({ account, shareUrl: TOK2 }));
        return account;
      };
      await open(host());
      const first = await dm('failed');
      // Same amounts. The second re-confirm brings the very same link, so only the confirm itself can reset it.
      let account = await reconfirmAs('Tonight One');
      const second = await dm('failed', host({ account, shareUrl: TOK2 }));
      expect(second.sendId).not.toBe(first.sendId);

      account = await reconfirmAs('Tonight Two');
      const third = await dm('failed', host({ account, shareUrl: TOK2 }));
      expect(third.sendId).not.toBe(second.sendId);
    });

    it('a kept sendId is not reused when a read brings a different share link', async () => {
      await open(host(), { refreshKey: 1 });
      const first = await dm('failed');
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      http.expectOne(URL).flush(host({ shareUrl: 'https://liff.line.me/1/pay/sess1/tok3' }));
      await settle();
      const next = await dm('sent', host({ shareUrl: 'https://liff.line.me/1/pay/sess1/tok3', lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(next.sendId).not.toBe(first.sendId);
    });

    it('a request that throws reads as failed, re-reads the panel and retries under the same sendId', async () => {
      await open(host());
      await click('[data-dm-send]');
      const lost = http.expectOne(`${URL}/dm`);
      lost.error(new ProgressEvent('error'));
      await settle();
      http.expectOne(URL).flush(host());
      await settle();
      expect(q('[data-outcome]')?.textContent).toContain('ส่งไม่สำเร็จ');
      const retry = await dm('sent', host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(retry.sendId).toBe(lost.request.body.sendId);
    });

    const cases: [PaymentSendOutcome, string][] = [
      ['failed', 'ส่งไม่สำเร็จ ลองอีกครั้ง ถ้ายังไม่ได้ อาจเพราะบล็อกหรือลบบอทไปแล้ว ให้เพิ่มบอทเป็นเพื่อนอีกครั้ง'],
      ['quota', 'ส่งการ์ดให้คุณไม่ได้ ใช้ "เปิดใน LINE เพื่อส่ง" ใน "ส่งวิธีอื่น" แทน'],
      ['unavailable', 'ตอนนี้ส่งเข้าไลน์ไม่ได้'],
      ['busy', 'เพิ่งส่งการ์ดให้คุณไปแล้ว ดูในแชต LINE'],
      ['stale', 'ยอดเปลี่ยนไปแล้ว'],
      ['not-confirmed', 'ยังไม่ได้ยืนยันยอด'],
    ];
    for (const [outcome, message] of cases) {
      it(`${outcome} shows its message and re-reads the panel`, async () => {
        await open(host());
        await click('[data-dm-send]');
        http.expectOne(`${URL}/dm`).flush({ outcome });
        await settle();
        // Busy until the re-read lands.
        expect(off('[data-dm-send]')).toBe(true);
        http.expectOne(URL).flush(host({ stale: outcome === 'stale', confirmed: outcome !== 'not-confirmed' }));
        await settle();
        expect(q('[data-outcome]')?.textContent).toContain(message);
        expect(text()).not.toContain('ส่งให้คุณใน LINE แล้ว');
        // Out of quota, the other way to send is the way now: it opens by itself.
        if (outcome === 'quota') expect(q<HTMLDetailsElement>('details[data-other-ways]')?.open).toBe(true);
        if (outcome === 'busy' || outcome === 'quota') expect(text()).not.toContain('ส่งเข้ากลุ่มไม่ได้');
        if (outcome === 'busy') expect(text()).not.toContain('เพิ่งส่งเข้ากลุ่มไปแล้ว');
      });
    }

    it('after a failed refresh the DM button stays off until a read succeeds', async () => {
      await open(host(), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(off('[data-dm-send]')).toBe(true);
      // A tap is refused by the guard, not just greyed out.
      await click('[data-dm-send]');
      http.expectNone(`${URL}/dm`);
    });

    it('the host link never claims a send', async () => {
      await open(host());
      const a = q<HTMLAnchorElement>('a[data-share-link]')!;
      a.addEventListener('click', (e) => e.preventDefault());
      a.click();
      await settle();
      http.expectNone(`${URL}/dm`);
      expect(q('[data-outcome]')).toBeNull();
      expect(q('[data-last-dm]')).toBeNull();
      expect(text()).not.toContain('ส่งแล้ว');
    });
  });

  describe('confirm errors', () => {
    it('a partial account (400) asks to check the account', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAY_ACCOUNT_INVALID' }, { status: 400, statusText: 'Bad Request' });
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ตรวจบัญชีรับเงินอีกครั้ง');
    });

    it('explains that a closed collection cannot be reconfirmed', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'COLLECTION_CLOSED' }, { status: 409, statusText: 'Conflict' });
      await settle();
      expect(text()).toContain('ปิดการเก็บเงินแล้ว แก้ไขบิลไม่ได้');
    });

    it('changed (409) re-reads the panel before Confirm is usable again, then confirms the new amounts', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_CHANGED' }, { status: 409, statusText: 'Conflict' });
      await settle();
      // Still busy: the re-read decides what the host confirms next.
      expect(off('[data-confirm]')).toBe(true);
      const moved = panel({ contentHash: 'hash-2', totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] });
      http.expectOne(URL).flush(moved);
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ยอดเปลี่ยน ตรวจยอดอีกครั้ง');
      expect(q('[data-total]')?.textContent).toContain('฿300');
      expect(off('[data-confirm]')).toBe(false);

      const body = await confirm(panel({ ...moved, confirmed: true }));
      expect(body.expectedHash).toBe('hash-2');
    });

    it('nothing due (409) says nothing wrong, and the re-read shows that nobody owes', async () => {
      await open();
      q<HTMLButtonElement>('[data-confirm]')!.focus();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_NOTHING_DUE' }, { status: 409, statusText: 'Conflict' });
      await settle();
      // No error text, not even while the re-read is in flight.
      expect(q('[data-error]')).toBeNull();
      http.expectOne(URL).flush(panel({ rows: [], totalSatang: 0 }));
      await settle();
      expect(q('[data-empty]')?.textContent).toContain('ไม่มีใครต้องจ่าย');
      expect(q('[data-error]')).toBeNull();
      expect(text()).not.toContain('ยังมียอดที่ไม่ครบ');
      expect(document.activeElement).toBe(fixture.nativeElement);
    });

    it('not ready (409) re-reads the panel', async () => {
      await open();
      q<HTMLButtonElement>('[data-confirm]')!.focus();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_NOT_READY' }, { status: 409, statusText: 'Conflict' });
      await settle();
      http.expectOne(URL).flush(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }));
      await settle();
      expect(q('[data-missing]')?.textContent).toContain('ยังไม่ได้ใส่ค่าสนาม');
      expect(document.activeElement).toBe(fixture.nativeElement);
    });

    it('no account (409) asks to fill in the account', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_NO_ACCOUNT' }, { status: 409, statusText: 'Conflict' });
      await settle();
      expect(q('[data-error]')?.textContent).toContain('กรอกให้ครบทั้งสามช่อง');
      expect(q('[data-error]')?.textContent).not.toContain('ล้าง');
    });

    it('unavailable (409) says the card cannot be used right now', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_UNAVAILABLE' }, { status: 409, statusText: 'Conflict' });
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ใบเก็บเงินใช้ไม่ได้ในตอนนี้');
    });

    it('an unreachable server says it could not confirm', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ยืนยันไม่สำเร็จ');
    });

    it('a partial account is caught before it is sent', async () => {
      await open(panel({ account: null, groupAccount: null }));
      await type('[data-field="bank"] input', 'กสิกร');
      await click('[data-confirm]');
      http.expectNone(`${URL}/confirm`);
      // The fields say what is wrong; the line beside Confirm only points at them.
      expect(q('[data-error]')?.textContent?.trim()).toBe('ตรวจช่องที่ทำเครื่องหมาย');
      for (const field of ['number', 'name']) {
        const input = q<HTMLInputElement>(`input[data-field="${field}"]`)!;
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(q(`#${input.getAttribute('aria-describedby')!.split(' ').pop()}`)?.textContent).toContain('กรอกช่องนี้');
      }
    });

    it('a bad number is named once, under its field, not again beside Confirm', async () => {
      await open();
      await expandAccount();
      await type('input[data-field="number"]', '12abc');
      await click('[data-confirm]');
      http.expectNone(`${URL}/confirm`);
      expect(text().split('เลขบัญชีต้องเป็นตัวเลข').length - 1).toBe(1);
      expect(q('[data-error]')?.textContent?.trim()).toBe('ตรวจช่องที่ทำเครื่องหมาย');
      expect(q('[data-error]')?.getAttribute('role')).toBe('alert');
    });
  });

  it('offers the group account back only when the fields differ from it, and restores it', async () => {
    await open();
    expect(q('[data-use-group]')).toBeNull();
    await expandAccount();
    expect(q('[data-use-group]')).toBeNull();
    await type('input[data-field="name"]', 'Someone Else');
    expect(q('[data-use-group]')).toBeTruthy();
    await click('[data-use-group]');
    // Back to the group's account, folded into the preview again.
    expect(q('[data-account-name]')?.textContent).toContain('โอนให้ Host Name');
    expect(q('input[data-field="name"]')).toBeNull();
    expect(q('[data-use-group]')).toBeNull();
    await expandAccount();
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Host Name');
  });

  it('shows the collector hint, as two short sentences, only before the confirm', async () => {
    await open();
    const hint = [...el().querySelectorAll('[data-hint] p')].map((p) => p.textContent?.trim());
    expect(hint).toEqual(['คนที่รับเงินไม่ต้องโอนให้ตัวเอง', 'ตั้งยอดของเขาเป็น 0 ได้ในหน้าคิดเงิน ใช้ ไม่คิดเงิน']);
    await confirm(panel({ confirmed: true }));
    expect(q('[data-hint]')).toBeNull();
  });

  it('shows a retry when the panel cannot be read', async () => {
    fixture = TestBed.createComponent(PaymentPanel);
    fixture.componentRef.setInput('sessionCode', 'sess1');
    fixture.detectChanges();
    http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
    await settle();
    expect(q('[data-load-failed]')).toBeTruthy();
    await click('[data-load-failed] button');
    http.expectOne(URL).flush(panel());
    await settle();
    expect(q('[data-load-failed]')).toBeNull();
    expect(el().querySelectorAll('[data-row]')).toHaveLength(2);
  });

  it('re-reads the panel when the refresh key changes, keeping what the host typed', async () => {
    await open(panel(), { refreshKey: 1 });
    await expandAccount();
    await type('input[data-field="name"]', 'Typed');
    fixture.componentRef.setInput('refreshKey', 2);
    fixture.detectChanges();
    http.expectOne(URL).flush(panel({ totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] }));
    await settle();
    expect(q('[data-total]')?.textContent).toContain('฿300');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Typed');
  });

  it('links the collector hint to the bill screen in the sheet only', async () => {
    await open(panel(), { compact: true });
    const closed: number[] = [];
    fixture.componentInstance.closed.subscribe(() => closed.push(1));
    const link = q<HTMLAnchorElement>('a[data-rows-link]')!;
    expect(link.getAttribute('href')).toBe('/s/sess1/bill');
    link.click();
    expect(closed).toHaveLength(1);
    fixture.destroy();

    await open(panel());
    expect(q('[data-rows-link]')).toBeNull();
  });

  it('gives two mounted panels their own input ids', async () => {
    // No account anywhere, so the fields are open on both.
    await open(panel({ account: null, groupAccount: null }));
    const first = fixture;
    await open(panel({ account: null, groupAccount: null }));
    const ids = [first, fixture].flatMap((f) =>
      ['[data-field="bank"] input', 'input[data-field="number"]', 'input[data-field="name"]'].map(
        (sel) => (f.nativeElement as HTMLElement).querySelector(sel)!.id
      )
    );
    expect(new Set(ids).size).toBe(6);
    for (const f of [first, fixture]) {
      for (const label of (f.nativeElement as HTMLElement).querySelectorAll('label')) {
        expect((f.nativeElement as HTMLElement).querySelector(`#${label.getAttribute('for')}`)).toBeTruthy();
      }
    }
  });

  it('keeps a persistent live region for status messages', async () => {
    await open(panel({ confirmed: true }));
    const live = q('[aria-live="polite"]')!;
    expect(live.textContent?.trim()).toBe('');
    await send('sent', panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
    expect(q('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toContain('ส่งแล้ว');
  });

  describe('status beside the action that caused it', () => {
    const SHARE = 'https://liff.line.me/1/pay/sess1/tok';
    const AT = '2026-10-29T13:05:00.000Z';
    const hhmm = (iso: string) => {
      const at = new Date(iso);
      return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    };
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    let scroll: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scroll = vi.fn();
      Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scroll, configurable: true, writable: true });
    });
    afterEach(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    it('in the sheet, a group send says sent, with its time, inside the bottom bar above Send', async () => {
      await open(panel({ confirmed: true }), { compact: true });
      const live = q('[aria-live="polite"]')!;
      await send('sent', panel({ confirmed: true, lastSentAt: AT }));
      expect(q('[aria-live="polite"]')).toBe(live);
      const bar = q('[data-dock]')!;
      expect(bar.classList.contains('bar')).toBe(true);
      expect(bar.contains(live)).toBe(true);
      expect(live.querySelector('[data-outcome]')?.textContent?.trim()).toBe(`ส่งแล้ว ${hhmm(AT)}`);
      const button = q('[data-send]')!;
      expect(bar.contains(button)).toBe(true);
      expect(before(live, button)).toBe(true);
    });

    it('in the sheet, a DM says where the card went inside the bottom bar above the DM button', async () => {
      await open(panel({ target: 'host', confirmed: true, shareUrl: SHARE }), { compact: true });
      const live = q('[aria-live="polite"]')!;
      await click('[data-dm-send]');
      http.expectOne(`${URL}/dm`).flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(panel({ target: 'host', confirmed: true, shareUrl: SHARE, lastDmAt: AT }));
      await settle();
      expect(q('[aria-live="polite"]')).toBe(live);
      const bar = q('[data-dock]')!;
      expect(bar.classList.contains('bar')).toBe(true);
      expect(bar.contains(live)).toBe(true);
      expect(live.querySelector('[data-last-dm]')?.textContent).toContain(`ส่งให้คุณใน LINE แล้ว ${hhmm(AT)}`);
      expect(before(live, q('[data-dm-send]')!)).toBe(true);
    });

    it('in the sheet, the confirmed line and a failed send also sit in the bar, above the button', async () => {
      await open(panel(), { compact: true });
      await confirm(panel({ confirmed: true }));
      const bar = q('[data-dock]')!;
      expect(bar.querySelector('[data-confirmed]')).toBeTruthy();
      await send('failed');
      const failed = bar.querySelector('[data-outcome]')!;
      expect(failed.textContent).toContain('ส่งไม่สำเร็จ');
      expect(before(failed, q('[data-send]')!)).toBe(true);
    });

    it('in the sheet, an earlier send time sits in the bar above "send again"', async () => {
      await open(panel({ confirmed: true, lastSentAt: AT }), { compact: true });
      const bar = q('[data-dock]')!;
      expect(bar.querySelector('[data-last-sent]')?.textContent).toContain(`ส่งแล้ว ${hhmm(AT)}`);
      expect(before(bar.querySelector('[data-last-sent]')!, q('[data-send]')!)).toBe(true);
    });

    it('the sheet bar never scrolls: the status is already on screen', async () => {
      await open(panel({ confirmed: true }), { compact: true });
      await send('sent', panel({ confirmed: true, lastSentAt: AT }));
      expect(scroll.mock.contexts).not.toContain(q('[aria-live="polite"]'));
    });

    it('on the bill screen there is no bar, and the status is scrolled into view after a send', async () => {
      await open(panel({ confirmed: true }));
      expect(q('[data-dock]')?.classList.contains('bar')).toBe(false);
      await send('sent', panel({ confirmed: true, lastSentAt: AT }));
      const live = q('[aria-live="polite"]')!;
      expect(live.textContent).toContain('ส่งแล้ว');
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scroll.mock.contexts).toContain(live);
    });

    it('on the bill screen a failed send scrolls its alert into view, not the live region', async () => {
      await open(panel({ confirmed: true, stale: false }));
      await send('failed', panel({ confirmed: true, stale: true }));
      const alert = q('[data-dock] [role="alert"][data-outcome]')!;
      expect(alert.textContent).toContain('ส่งไม่สำเร็จ');
      // The live region has text too here (the card moved on), but the failure is what the host must see.
      expect(q('[aria-live="polite"]')!.textContent?.trim()).not.toBe('');
      expect(scroll.mock.contexts).toContain(alert);
      expect(scroll.mock.contexts).not.toContain(q('[aria-live="polite"]'));
    });

    it('in the sheet, the dock is not a bar when there is nothing to tap', async () => {
      await open(panel({ ended: false }), { compact: true });
      expect(q('[data-actions]')).toBeNull();
      expect(q('[data-dock]')?.classList.contains('bar')).toBe(false);
      expect(q('[data-dock] [aria-live="polite"]')).toBeTruthy();
    });
  });

  describe('sequencing', () => {
    it('an older read that answers after a confirm cannot undo it', async () => {
      await open(panel(), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      const older = http.expectOne(URL);
      await click('[data-confirm]');
      const confirmReq = http.expectOne(`${URL}/confirm`);
      confirmReq.flush(panel({ confirmed: true }));
      await settle();
      older.flush(panel());
      await settle();
      expect(q('[data-send]')).toBeTruthy();
    });

    it('an older read answering before the confirm also cannot undo it', async () => {
      await open(panel(), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      const older = http.expectOne(URL);
      await click('[data-confirm]');
      const confirmReq = http.expectOne(`${URL}/confirm`);
      older.flush(panel());
      await settle();
      confirmReq.flush(panel({ confirmed: true }));
      await settle();
      expect(q('[data-send]')).toBeTruthy();
    });

    it('a confirm overtaken by a newer read is discarded and the panel re-reads', async () => {
      await open(panel(), { refreshKey: 1 });
      await click('[data-confirm]');
      const confirmReq = http.expectOne(`${URL}/confirm`);
      // The bill changes while the confirm is in flight; the newer read lands first, already stale.
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      const newer = http.expectOne(URL);
      const fresh = panel({ confirmed: true, stale: true, totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] });
      newer.flush(fresh);
      await settle();
      // The confirm response still describes the old amounts as current.
      confirmReq.flush(panel({ confirmed: true }));
      await settle();
      // The discarded answer's re-read is in flight: no second Confirm may freeze amounts not yet on screen.
      expect(off('[data-confirm]')).toBe(true);
      http.expectOne(URL).flush(fresh);
      await settle();
      expect(q('[data-total]')?.textContent).toContain('฿300');
      expect(q('[data-stale]')).toBeTruthy();
      expect(q('[data-send]')).toBeNull();
    });

    it('after a failed refresh Confirm and Send stay off until a read succeeds', async () => {
      await open(panel({ confirmed: true }), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(q('[data-load-failed]')).toBeTruthy();
      // Confirmed and current: Send is the one action, and it is off.
      expect(q('[data-confirm]')).toBeNull();
      expect(off('[data-send]')).toBe(true);
      await click('[data-send]');
      http.expectNone(`${URL}/send`);

      await click('[data-load-failed] button');
      http.expectOne(URL).flush(panel({ confirmed: true }));
      await settle();
      expect(q('[data-load-failed]')).toBeNull();
      expect(off('[data-send]')).toBe(false);
    });

    it('a failed refresh shows no retry for a group without a payment card', async () => {
      await open(panel({ target: null }), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(q('[data-load-failed]')).toBeNull();
    });

    it('a second tap right after a send still goes through the resend prompt', async () => {
      await open(panel({ confirmed: true }));
      await click('[data-send]');
      const req = http.expectOne(`${URL}/send`);
      req.flush({ outcome: 'sent' });
      await settle();
      // The re-read is still in flight: explicit progress, and not tappable yet.
      const button = q<HTMLButtonElement>('[data-send]')!;
      expect(button.textContent).toContain('กำลังส่ง');
      button.click();
      await settle();
      http.expectNone(`${URL}/send`);
      expect(q('[data-resend-prompt]')).toBeNull();

      http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      await settle();
      await click('[data-send]');
      http.expectNone(`${URL}/send`);
      expect(q('[data-resend-prompt]')).toBeTruthy();
    });

    it('still asks first when the re-read after a send fails', async () => {
      await open(panel({ confirmed: true }));
      await click('[data-send]');
      http.expectOne(`${URL}/send`).flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      // The read failed, so sending is off until Retry works; the sent mark stays.
      expect(off('[data-send]')).toBe(true);
      await click('[data-load-failed] button');
      http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      await settle();
      await click('[data-send]');
      expect(q('[data-resend-prompt]')).toBeTruthy();
    });
  });

  describe('draft', () => {
    it('survives the panel being destroyed and recreated, without touching browser storage', async () => {
      const local = vi.spyOn(Storage.prototype, 'setItem');
      await open();
      await expandAccount();
      await type('input[data-field="name"]', 'Half Typed');
      expect(local).not.toHaveBeenCalled();
      local.mockRestore();
      fixture.destroy();
      await open(panel());
      expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Half Typed');
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toEqual({ ...GROUP_ACCOUNT, name: 'Half Typed' });
    });

    it('is cleared by a successful confirm', async () => {
      await open();
      await expandAccount();
      await type('input[data-field="name"]', 'Half Typed');
      await confirm(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
      fixture.destroy();
      await open(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      // Tonight's confirmed account, folded into the preview.
      expect(q('[data-account-name]')?.textContent).toContain('โอนให้ Half Typed');
      await expandAccount();
      expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Half Typed');
    });

    it('is dropped by using the group account', async () => {
      await open();
      await expandAccount();
      await type('input[data-field="name"]', 'Half Typed');
      await click('[data-use-group]');
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
    });

    it('is kept when a confirm fails', async () => {
      await open();
      await expandAccount();
      await type('input[data-field="name"]', 'Half Typed');
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toEqual({ ...GROUP_ACCOUNT, name: 'Half Typed' });
    });
  });
  describe('the card preview', () => {
    it('reads as the card the group receives: header, date and venue, rows, total and the account', async () => {
      await open(panel({ settledCount: 1 }));
      const preview = q('[data-preview]')!;
      expect(preview.tagName).toBe('FIGURE');
      expect(preview.querySelector('.preview-head')?.textContent).toContain('ยอดค่าเล่น');
      expect(q('[data-preview-group]')?.textContent?.trim()).toBe('ตีชิล');
      expect(q('[data-preview-meta]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('29 ต.ค. 2569 · Bad@Mama');
      expect(q('[data-total] span')?.textContent?.trim()).toBe('รวม');
      expect(q('[data-total] .total-amount')?.textContent?.trim()).toBe('฿200');
      expect(q('[data-settled]')?.textContent).toContain('จ่ายแล้ว 1 คน');
      const account = q('[data-account]')!;
      expect(preview.contains(account)).toBe(true);
      expect(q('[data-account-name]')?.textContent?.trim()).toBe('โอนให้ Host Name');
      expect(account.textContent).toContain('กสิกร');
      expect(q('[data-account-number]')?.textContent?.trim()).toBe('123-4-56789-0');
    });

    it('keeps the rows in the order the server sends (sorted by name there), absent marked, zero as ไม่ต้องโอน', async () => {
      await open(
        panel({
          rows: [
            { playerId: 'z', name: 'Bee', amountSatang: 20800, absent: true },
            { playerId: 'a', name: 'Cat', amountSatang: 0, absent: false },
          ],
          totalSatang: 20800,
        })
      );
      const rows = [...el().querySelectorAll('[data-row]')].map((r) => [
        r.querySelector('.row-name')?.textContent?.trim(),
        r.querySelector('.row-absent')?.textContent?.trim() ?? null,
        r.querySelector('.row-amount')?.textContent?.trim(),
      ]);
      expect(rows).toEqual([
        ['Bee', '(ไม่มา)', '฿208'],
        ['Cat', null, 'ไม่ต้องโอน'],
      ]);
    });

    it('leaves the venue out when the card has none', async () => {
      await open(panel({ venue: null }));
      expect(q('[data-preview-meta]')?.textContent?.trim()).toBe('29 ต.ค. 2569');
    });

    it('folds the account fields into the preview, and "แก้บัญชีคืนนี้" opens them with focus on their group', async () => {
      await open();
      expect(q('[data-account-fields]')).toBeNull();
      const edit = q<HTMLButtonElement>('[data-edit-account]')!;
      expect(edit.textContent?.trim()).toBe('แก้บัญชีคืนนี้');
      edit.focus();
      await click('[data-edit-account]');
      const fields = q('[data-account-fields]')!;
      expect(fields).toBeTruthy();
      expect(document.activeElement).toBe(fields);
      expect(q('[data-edit-account]')).toBeNull();
    });

    it('keeps the fields open while a draft differs from the group account', async () => {
      TestBed.inject(PaymentDraftService).set('sess1', { ...GROUP_ACCOUNT, name: 'Draft Name' });
      await open();
      expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Draft Name');
      expect(q('[data-edit-account]')).toBeNull();
    });

    it('never folds the fields away while the host types, even back to the group account', async () => {
      await open();
      await expandAccount();
      await type('input[data-field="name"]', 'Someone');
      await type('input[data-field="name"]', 'Host Name');
      expect(q('input[data-field="name"]')).toBeTruthy();
    });
  });

  describe('one primary action per state', () => {
    const buttons = () => [...el().querySelectorAll<HTMLElement>('[data-actions] button, [data-actions] a')];

    it('before the confirm: Confirm alone, worded for amounts and account', async () => {
      await open();
      expect(buttons()).toHaveLength(1);
      expect(buttons()[0].matches('[data-confirm]')).toBe(true);
      expect(buttons()[0].textContent?.trim()).toBe('ยืนยันยอดและบัญชี');
      expect(buttons()[0].classList.contains('ghost')).toBe(false);
    });

    it('confirmed and current: the group send alone, with no Confirm button', async () => {
      await open(panel({ confirmed: true }));
      expect(buttons()).toHaveLength(1);
      expect(buttons()[0].matches('[data-send]')).toBe(true);
      expect(q('[data-confirm]')).toBeNull();
    });

    it('confirmed and current for the host target: the DM alone in the action row', async () => {
      await open(panel({ target: 'host', confirmed: true, shareUrl: 'https://liff.line.me/1/pay/sess1/tok' }));
      expect(buttons()).toHaveLength(1);
      expect(buttons()[0].matches('[data-dm-send]')).toBe(true);
    });

    it('edited after the confirm: Confirm again, alone', async () => {
      await open(panel({ confirmed: true }));
      await expandAccount();
      await type('input[data-field="name"]', 'Someone Else');
      expect(buttons()).toHaveLength(1);
      expect(buttons()[0].textContent?.trim()).toBe('ยืนยันใหม่');
    });

    it('not ready in the sheet: a button-styled link to fill in what is missing', async () => {
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }), { compact: true });
      expect(buttons()).toHaveLength(1);
      const link = buttons()[0] as HTMLAnchorElement;
      expect(link.matches('a.button-link[data-settings-link]')).toBe(true);
      expect(link.textContent?.trim()).toBe('ไปตั้งค่าในหน้าคิดเงิน');
    });

    it('sits in a sticky bottom bar in the sheet only', async () => {
      await open(panel(), { compact: true });
      expect(q('[data-actions]')?.classList.contains('bar')).toBe(true);
      expect(q('[data-dock]')?.classList.contains('bar')).toBe(true);
      fixture.destroy();
      await open(panel());
      expect(q('[data-actions]')?.classList.contains('bar')).toBe(false);
      expect(q('[data-dock]')?.classList.contains('bar')).toBe(false);
    });

    it('has no action row when there is nothing to do', async () => {
      await open(panel({ ended: false }));
      expect(q('[data-actions]')).toBeNull();
      fixture.destroy();
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }));
      expect(q('[data-actions]')).toBeNull();
    });
  });

  it('names how many inputs are still missing, as a to-do', async () => {
    await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE', 'MISSING_SHUTTLE_PRICE'] }));
    expect(q('[data-missing] .missing-title')?.textContent?.trim()).toBe('ยังขาดอีก 2 อย่างก่อนส่ง');
    expect(el().querySelectorAll('[data-missing] li')).toHaveLength(2);
  });

  describe('confirmed state and focus', () => {
    let scroll: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scroll = vi.fn();
      Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scroll, configurable: true, writable: true });
    });
    afterEach(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    it('says the card is confirmed and ready to send, in the live region', async () => {
      await open();
      await confirm(panel({ confirmed: true }));
      const live = q('[aria-live="polite"]')!;
      expect(live.querySelector('[data-confirmed]')?.textContent?.trim()).toBe('ยืนยันยอดแล้ว · ส่งได้เลย');
      expect(live.querySelector('[data-confirmed] app-icon')).toBeTruthy();
    });

    it('keeps focus on the Confirm button while it is busy: aria-disabled, never disabled', async () => {
      await open();
      const button = q<HTMLButtonElement>('[data-confirm]')!;
      button.focus();
      await click('[data-confirm]');
      const req = http.expectOne(`${URL}/confirm`);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(button);
      // A second tap while busy is refused by the guard.
      await click('[data-confirm]');
      http.expectNone(`${URL}/confirm`);
      req.flush(panel({ confirmed: true }));
      await settle();
    });

    it('hands focus to the Send that replaced Confirm, and brings it into view', async () => {
      await open();
      q<HTMLButtonElement>('[data-confirm]')!.focus();
      await confirm(panel({ confirmed: true }));
      const send = q('[data-send]')!;
      expect(document.activeElement).toBe(send);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scroll.mock.contexts).toContain(send);
    });

    it('for the host target, hands focus to the DM button', async () => {
      await open(panel({ target: 'host' }));
      q<HTMLButtonElement>('[data-confirm]')!.focus();
      await confirm(panel({ target: 'host', confirmed: true, shareUrl: 'https://liff.line.me/1/pay/sess1/tok' }));
      expect(document.activeElement).toBe(q('[data-dm-send]'));
    });

    it('moves focus into the resend prompt and back to Send when it is cancelled', async () => {
      await open(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      q<HTMLButtonElement>('[data-send]')!.focus();
      await click('[data-send]');
      expect(document.activeElement).toBe(q('[data-resend-yes]'));
      await click('[data-resend-cancel]');
      expect(document.activeElement).toBe(q('[data-send]'));
    });

    for (const target of ['group', 'host'] as const) {
      it(`keeps focus inside the panel while a ${target} resend is pending`, async () => {
        const dm = target === 'host';
        await open(panel({
          target,
          confirmed: true,
          shareUrl: dm ? 'https://liff.line.me/1/pay/sess1/tok' : null,
          ...(dm ? { lastDmAt: '2026-10-29T13:05:00.000Z' } : { lastSentAt: '2026-10-29T13:05:00.000Z' }),
        }));
        const selector = dm ? '[data-dm-send]' : '[data-send]';
        q<HTMLButtonElement>(selector)!.focus();
        await click(selector);
        await click(dm ? '[data-dm-resend-yes]' : '[data-resend-yes]');
        const focused = document.activeElement;
        const replacement = q(selector);
        const request = http.expectOne(`${URL}/${dm ? 'dm' : 'send'}`);
        request.flush({ outcome: 'sent' });
        await settle();
        http.expectOne(URL).flush(panel({ target, confirmed: true }));
        await settle();
        expect(focused).toBe(replacement);
      });
    }

    for (const outcome of ['stale', 'not-confirmed'] as const) {
      it(`moves focus to Confirm when sending finds the card ${outcome}`, async () => {
        await open(panel({ confirmed: true }));
        q<HTMLButtonElement>('[data-send]')!.focus();
        await send(outcome, panel({ confirmed: outcome === 'stale', stale: outcome === 'stale' }));
        expect(document.activeElement).toBe(q('[data-confirm]'));
      });
    }

    it('keeps focus on the panel when a send re-read removes every action', async () => {
      await open(panel({ confirmed: true }));
      q<HTMLButtonElement>('[data-send]')!.focus();
      await send('unavailable', panel({ target: null }));
      expect(document.activeElement).toBe(fixture.nativeElement);
    });

    it('puts focus back on Send after a resend goes out', async () => {
      await open(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      q<HTMLButtonElement>('[data-send]')!.focus();
      await click('[data-send]');
      await click('[data-resend-yes]');
      http.expectOne(`${URL}/send`).flush({ outcome: 'sent' });
      await settle();
      http.expectOne(URL).flush(panel({ confirmed: true, lastSentAt: '2026-10-29T13:06:00.000Z' }));
      await settle();
      expect(document.activeElement).toBe(q('[data-send]'));
    });
  });
  describe('invoice focus', () => {
    it('keeps host review out of the invoice even for a confirmed sent card', async () => {
      await open(panel({ confirmed: true, lastSentAt: '2026-10-29T13:05:00.000Z' }));
      expect(q('app-slip-review')).toBeNull();
      expect(slipHost.panel).not.toHaveBeenCalled();
    });
  });
});
