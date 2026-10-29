import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PaymentPanelComponent } from './payment-panel';
import { environment } from '../../../environments/environment';
import type { PaymentPanel, PaymentSendOutcome } from '../../core/payment-card.model';
import { PaymentDraftService } from '../../core/payment-card.service';

const URL = `${environment.apiBaseUrl}/sessions/sess1/payment-card`;
const GROUP_ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'Host Name' };

function panel(over: Partial<PaymentPanel> = {}): PaymentPanel {
  return {
    target: 'group',
    ended: true,
    ready: true,
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
    shareUrl: null,
    ...over,
  };
}

describe('PaymentPanel', () => {
  let fixture: ComponentFixture<PaymentPanelComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaymentPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: '**', children: [] }])],
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
    fixture.detectChanges();
  }

  async function open(body: PaymentPanel = panel(), inputs: Record<string, unknown> = {}) {
    fixture = TestBed.createComponent(PaymentPanelComponent);
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

  async function confirm(response: PaymentPanel) {
    await click('[data-confirm]');
    const req = http.expectOne(`${URL}/confirm`);
    expect(req.request.method).toBe('POST');
    req.flush(response);
    await settle();
    return req.request.body;
  }

  async function send(outcome: PaymentSendOutcome, reloaded?: PaymentPanel) {
    await click('[data-send]');
    const req = http.expectOne(`${URL}/send`);
    req.flush({ outcome });
    await settle();
    if (reloaded) {
      http.expectOne(URL).flush(reloaded);
      await settle();
    }
    return req.request.body as { sendId: string };
  }

  it('renders nothing when there is no target', async () => {
    await open(panel({ target: null }));
    expect(text().trim()).toBe('');
    expect(el().children).toHaveLength(0);
  });

  it('lists who owes what, with the total, name left and amount right', async () => {
    await open(panel({ settledCount: 2 }));
    const rows = [...el().querySelectorAll('[data-row]')];
    expect(rows.map((r) => r.querySelector('.row-name')?.textContent?.trim())).toEqual(['Amp', 'Dee']);
    expect(rows.map((r) => r.querySelector('.row-amount')?.textContent?.trim())).toEqual(['90฿', '110฿']);
    expect(q('[data-total]')?.textContent).toContain('200฿');
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

  it('prefills the account from the group default when none was confirmed tonight', async () => {
    await open(panel({ account: null }));
    expect(q<HTMLInputElement>('#pc-bank')!.value).toBe('กสิกร');
    expect(q<HTMLInputElement>('#pc-number')!.value).toBe('123-4-56789-0');
    expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Host Name');
  });

  it('prefers the confirmed account for tonight over the group default', async () => {
    await open(panel({ account: { bank: 'ไทยพาณิชย์', number: '999-9-99999-9', name: 'Tonight' }, confirmed: true }));
    expect(q<HTMLInputElement>('#pc-bank')!.value).toBe('ไทยพาณิชย์');
    expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Tonight');
  });

  it('numeric account field asks for the numeric keypad', async () => {
    await open();
    expect(q('#pc-number')?.getAttribute('inputmode')).toBe('numeric');
  });

  it('disables confirm and points to group settings when there is no account anywhere', async () => {
    await open(panel({ account: null, groupAccount: null }));
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
    expect(q('[data-no-account]')?.textContent).toContain('ตั้งบัญชีรับเงินในหน้าตั้งค่ากลุ่ม');

    await type('#pc-bank', 'กสิกร');
    await type('#pc-number', '123-4-56789-0');
    await type('#pc-name', 'Host');
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
    expect(q('[data-no-account]')).toBeNull();
  });

  it('posts the three fields on confirm', async () => {
    await open();
    await type('#pc-number', ' 111-1-11111-1 ');
    const body = await confirm(panel({ confirmed: true }));
    expect(body).toEqual({ bank: 'กสิกร', number: '111-1-11111-1', name: 'Host Name' });
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

  it('stale hides the send action and asks to confirm again', async () => {
    await open(panel({ confirmed: true, stale: true }));
    expect(q('[data-stale]')?.textContent).toContain('ยอดเปลี่ยน, ยืนยันใหม่');
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-share-link]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
  });

  it('hides send when the account is edited after confirming, until confirmed again', async () => {
    await open(panel({ confirmed: true }));
    expect(q('[data-send]')).toBeTruthy();
    await type('#pc-name', 'Someone Else');
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

    it('links to the bill settings only in the compact sheet, and closing follows the link', async () => {
      await open(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }), { compact: true });
      const closed: number[] = [];
      fixture.componentInstance.closed.subscribe(() => closed.push(1));
      const link = q<HTMLAnchorElement>('a[data-settings-link]')!;
      expect(link.getAttribute('href')).toBe('/s/sess1/bill');
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
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
    expect(q('#pc-bank')).toBeNull();
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
      ['busy', 'เพิ่งส่งไป'],
      ['stale', 'ยอดเปลี่ยนไปแล้ว'],
      ['not-confirmed', 'ยังไม่ได้ยืนยันยอด'],
    ];
    for (const [outcome, message] of cases) {
      it(`${outcome} shows its message and does not claim a send`, async () => {
        await open(panel({ confirmed: true }));
        const sent: number[] = [];
        fixture.componentInstance.sent.subscribe(() => sent.push(1));
        await click('[data-send]');
        http.expectOne(`${URL}/send`).flush({ outcome });
        await settle();
        if (outcome === 'stale' || outcome === 'not-confirmed') {
          http.expectOne(URL).flush(panel({ confirmed: outcome === 'stale', stale: outcome === 'stale' }));
          await settle();
        }
        expect(q('[data-outcome]')?.textContent).toContain(message);
        expect(q('[data-outcome]')?.textContent).not.toBe('ส่งแล้ว');
        expect(sent).toHaveLength(0);
      });
    }

    it('a network error on send reads as a failed send', async () => {
      await open(panel({ confirmed: true }));
      await click('[data-send]');
      http.expectOne(`${URL}/send`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(q('[data-outcome]')?.textContent).toContain('ส่งไม่สำเร็จ');
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

    it('not ready (409) re-reads the panel', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_NOT_READY' }, { status: 409, statusText: 'Conflict' });
      await settle();
      http.expectOne(URL).flush(panel({ ready: false, warnings: ['MISSING_COURT_FEE'] }));
      await settle();
      expect(q('[data-missing]')?.textContent).toContain('ยังไม่ได้ใส่ค่าสนาม');
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
      await type('#pc-bank', 'กสิกร');
      await click('[data-confirm]');
      http.expectNone(`${URL}/confirm`);
      expect(q('[data-error]')?.textContent).toContain('กรอกให้ครบทั้งสามช่อง');
    });
  });

  it('offers the group account back only when the fields differ from it, and restores it', async () => {
    await open();
    expect(q('[data-use-group]')).toBeNull();
    await type('#pc-name', 'Someone Else');
    expect(q('[data-use-group]')).toBeTruthy();
    await click('[data-use-group]');
    expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Host Name');
    expect(q('[data-use-group]')).toBeNull();
  });

  it('shows the hint about the collector under the account fields', async () => {
    await open();
    expect(q('[data-hint]')?.textContent).toContain('คนรับเงินไม่ต้องโอนให้ตัวเอง');
  });

  it('shows a retry when the panel cannot be read', async () => {
    fixture = TestBed.createComponent(PaymentPanelComponent);
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
    await type('#pc-name', 'Typed');
    fixture.componentRef.setInput('refreshKey', 2);
    fixture.detectChanges();
    http.expectOne(URL).flush(panel({ totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] }));
    await settle();
    expect(q('[data-total]')?.textContent).toContain('300฿');
    expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Typed');
  });

  describe('draft', () => {
    it('survives the panel being destroyed and recreated, and is not storage', async () => {
      await open();
      await type('#pc-name', 'Half Typed');
      fixture.destroy();
      await open(panel());
      expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Half Typed');
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toEqual({ ...GROUP_ACCOUNT, name: 'Half Typed' });
    });

    it('is cleared by a successful confirm', async () => {
      await open();
      await type('#pc-name', 'Half Typed');
      await confirm(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
      fixture.destroy();
      await open(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      expect(q<HTMLInputElement>('#pc-name')!.value).toBe('Half Typed');
    });

    it('is dropped by using the group account', async () => {
      await open();
      await type('#pc-name', 'Half Typed');
      await click('[data-use-group]');
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
    });

    it('is kept when a confirm fails', async () => {
      await open();
      await type('#pc-name', 'Half Typed');
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toEqual({ ...GROUP_ACCOUNT, name: 'Half Typed' });
    });
  });
});
