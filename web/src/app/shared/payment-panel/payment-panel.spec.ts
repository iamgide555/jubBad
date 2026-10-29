import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PaymentPanel } from './payment-panel';
import { environment } from '../../../environments/environment';
import type { PaymentCardPanel, PaymentSendOutcome } from '../../core/payment-card.model';
import { PaymentDraftService } from '../../core/payment-card.service';

const URL = `${environment.apiBaseUrl}/sessions/sess1/payment-card`;
const GROUP_ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'Host Name' };

function panel(over: Partial<PaymentCardPanel> = {}): PaymentCardPanel {
  return {
    target: 'group',
    ended: true,
    ready: true,
    contentHash: 'hash-1',
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

describe('PaymentCardPanel', () => {
  let fixture: ComponentFixture<PaymentPanel>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaymentPanel],
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

  it('treats people listed at 0 baht each as nobody owing: the empty state, no confirm or send', async () => {
    const zero = [
      { playerId: 'a', name: 'Amp', amountSatang: 0, absent: false },
      { playerId: 'd', name: 'Dee', amountSatang: 0, absent: false },
    ];
    await open(panel({ rows: zero, totalSatang: 0, confirmed: true }));
    expect(q('[data-empty]')?.textContent).toContain('ไม่มีใครต้องจ่าย');
    expect(el().querySelectorAll('[data-row]')).toHaveLength(0);
    expect(q('[data-total]')).toBeNull();
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-send]')).toBeNull();
    expect(q('[data-share-link]')).toBeNull();
  });

  it('prefills the account from the group default when none was confirmed tonight', async () => {
    await open(panel({ account: null }));
    expect(q<HTMLInputElement>('[data-field="bank"] input')!.value).toBe('กสิกร');
    expect(q<HTMLInputElement>('input[data-field="number"]')!.value).toBe('123-4-56789-0');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Host Name');
  });

  it('prefers the confirmed account for tonight over the group default', async () => {
    await open(panel({ account: { bank: 'ไทยพาณิชย์', number: '999-9-99999-9', name: 'Tonight' }, confirmed: true }));
    expect(q<HTMLInputElement>('[data-field="bank"] input')!.value).toBe('ไทยพาณิชย์');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Tonight');
  });

  it('numeric account field asks for the numeric keypad', async () => {
    await open();
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
    expect(q('[data-total]')?.textContent).toContain('200฿');
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
        expect(q<HTMLButtonElement>('[data-send]')?.disabled ?? true).toBe(true);
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

    it('offers a primary DM button for a sendable card, keeping the link and its hint as the secondary action', async () => {
      await open(host());
      expect(q('[data-dm-send]')?.textContent).toContain('ส่งการ์ดให้ฉันทาง LINE');
      expect(q<HTMLButtonElement>('[data-dm-send]')!.disabled).toBe(false);
      expect(q<HTMLAnchorElement>('a[data-share-link]')!.getAttribute('href')).toBe(SHARE);
      expect(text()).toContain('เปิดใน LINE เพื่อส่ง');
      expect(text()).toContain('กดแล้วเลือกกลุ่มในแอป LINE');
      expect(q('[data-send]')).toBeNull();
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
      expect(live.textContent).toContain('ส่งการ์ดให้คุณใน LINE แล้ว เปิด LINE แล้วกด "ส่งเข้ากลุ่ม"');
      const time = new Date(at);
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      expect(q('[data-last-dm]')?.textContent).toContain(`ส่งแล้ว ${hhmm}`);
      expect(sent).toHaveLength(0);
      expect(q('[data-dm-send]')?.textContent).toContain('ส่งอีกครั้ง');
      expect(q('[data-last-sent]')).toBeNull();
    });

    it('marks the DM sent at once, so a quick second tap already asks first while the re-read runs', async () => {
      await open(host());
      await click('[data-dm-send]');
      http.expectOne(`${URL}/dm`).flush({ outcome: 'sent' });
      await settle();
      const reread = http.expectOne(URL);
      expect(q<HTMLButtonElement>('[data-dm-send]')?.disabled).toBe(true);
      reread.flush(host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      await settle();
      expect(q('[data-dm-send]')?.textContent).toContain('ส่งอีกครั้ง');
    });

    it('a second tap after a sent card goes through the inline two-step, with a new UUID', async () => {
      await open(host({ lastDmAt: '2026-10-29T13:05:00.000Z' }));
      expect(q('[data-dm-send]')?.textContent).toContain('ส่งอีกครั้ง');

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
      ['failed', 'ส่งไม่สำเร็จ ถ้าคุณบล็อกหรือลบบอทไปแล้ว ให้เพิ่มบอทเป็นเพื่อนอีกครั้ง'],
      ['quota', 'โควต้า'],
      ['unavailable', 'ตอนนี้ส่งเข้าไลน์ไม่ได้'],
      ['busy', 'เพิ่งส่งเข้ากลุ่มไปแล้ว'],
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
        expect(q<HTMLButtonElement>('[data-dm-send]')?.disabled ?? true).toBe(true);
        http.expectOne(URL).flush(host({ stale: outcome === 'stale', confirmed: outcome !== 'not-confirmed' }));
        await settle();
        expect(q('[data-outcome]')?.textContent).toContain(message);
        expect(text()).not.toContain('ส่งการ์ดให้คุณใน LINE แล้ว');
      });
    }

    it('after a failed refresh the DM button stays off until a read succeeds', async () => {
      await open(host(), { refreshKey: 1 });
      fixture.componentRef.setInput('refreshKey', 2);
      fixture.detectChanges();
      http.expectOne(URL).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(q<HTMLButtonElement>('[data-dm-send]')!.disabled).toBe(true);
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

    it('changed (409) re-reads the panel before Confirm is usable again, then confirms the new amounts', async () => {
      await open();
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({ code: 'PAYMENT_CHANGED' }, { status: 409, statusText: 'Conflict' });
      await settle();
      // Still busy: the re-read decides what the host confirms next.
      expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
      const moved = panel({ contentHash: 'hash-2', totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] });
      http.expectOne(URL).flush(moved);
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ยอดเปลี่ยน ตรวจยอดอีกครั้ง');
      expect(q('[data-total]')?.textContent).toContain('300฿');
      expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);

      const body = await confirm(panel({ ...moved, confirmed: true }));
      expect(body.expectedHash).toBe('hash-2');
    });

    it('nothing due (409) says nothing wrong, and the re-read shows that nobody owes', async () => {
      await open();
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
      expect(q('[data-error]')?.textContent).toContain('กรอกให้ครบทั้งสามช่อง');
    });
  });

  it('offers the group account back only when the fields differ from it, and restores it', async () => {
    await open();
    expect(q('[data-use-group]')).toBeNull();
    await type('input[data-field="name"]', 'Someone Else');
    expect(q('[data-use-group]')).toBeTruthy();
    await click('[data-use-group]');
    expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Host Name');
    expect(q('[data-use-group]')).toBeNull();
  });

  it('shows the hint about the collector under the account fields', async () => {
    await open();
    expect(q('[data-hint]')?.textContent).toContain('คนรับเงินไม่ต้องโอนให้ตัวเอง');
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
    await type('input[data-field="name"]', 'Typed');
    fixture.componentRef.setInput('refreshKey', 2);
    fixture.detectChanges();
    http.expectOne(URL).flush(panel({ totalSatang: 30000, rows: [{ playerId: 'a', name: 'Amp', amountSatang: 30000, absent: false }] }));
    await settle();
    expect(q('[data-total]')?.textContent).toContain('300฿');
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
    await open();
    const first = fixture;
    await open();
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
      expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
      http.expectOne(URL).flush(fresh);
      await settle();
      expect(q('[data-total]')?.textContent).toContain('300฿');
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
      expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
      expect(q<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);

      await click('[data-load-failed] button');
      http.expectOne(URL).flush(panel({ confirmed: true }));
      await settle();
      expect(q('[data-load-failed]')).toBeNull();
      expect(q<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
      expect(q<HTMLButtonElement>('[data-send]')!.disabled).toBe(false);
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
      // The re-read is still in flight: already "send again", and not tappable yet.
      const button = q<HTMLButtonElement>('[data-send]')!;
      expect(button.textContent).toContain('ส่งอีกครั้ง');
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
      expect(q<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
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
      await type('input[data-field="name"]', 'Half Typed');
      await confirm(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
      fixture.destroy();
      await open(panel({ confirmed: true, account: { ...GROUP_ACCOUNT, name: 'Half Typed' } }));
      expect(q<HTMLInputElement>('input[data-field="name"]')!.value).toBe('Half Typed');
    });

    it('is dropped by using the group account', async () => {
      await open();
      await type('input[data-field="name"]', 'Half Typed');
      await click('[data-use-group]');
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toBeNull();
    });

    it('is kept when a confirm fails', async () => {
      await open();
      await type('input[data-field="name"]', 'Half Typed');
      await click('[data-confirm]');
      http.expectOne(`${URL}/confirm`).flush({}, { status: 500, statusText: 'Server Error' });
      await settle();
      expect(TestBed.inject(PaymentDraftService).get('sess1')).toEqual({ ...GROUP_ACCOUNT, name: 'Half Typed' });
    });
  });
});
