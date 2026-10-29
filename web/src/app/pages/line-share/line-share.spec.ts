import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { LiffClient } from '../../core/liff-client';
import type { LineShareCard, PaymentShareCard } from '../../core/line.model';
import { LineService } from '../../core/line.service';
import { LineShare } from './line-share';

const CARD: LineShareCard = {
  liffId: '1234567890-AbCdEfGh',
  card: { type: 'flex', altText: 'สรุปรอบ ตีชิล', contents: { type: 'bubble' } },
  preview: { name: 'ตีชิล', date: '2026-10-28', venue: 'Bad@Mama', players: 12, games: 9 },
};

const PAY: PaymentShareCard = {
  liffId: '1234567890-AbCdEfGh',
  messages: [{ type: 'flex', altText: 'ใบเก็บเงิน', contents: { type: 'bubble' } }],
  preview: { name: 'ตีชิล', date: '2026-10-28', count: 12, totalSatang: 144000, bank: 'KBank', accountName: 'สมชาย ใจดี' },
};

describe('LineShare', () => {
  let fixture: ComponentFixture<LineShare>;
  let shareCard: ReturnType<typeof vi.fn>;
  let paymentShareCard: ReturnType<typeof vi.fn>;
  let liff: {
    init: ReturnType<typeof vi.fn>;
    isLoggedIn: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    canShare: ReturnType<typeof vi.fn>;
    share: ReturnType<typeof vi.fn>;
  };

  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };

  let route: { params: Record<string, string>; query: Record<string, string> };

  async function open(card: LineShareCard | HttpErrorResponse = CARD) {
    shareCard.mockReturnValue(card instanceof HttpErrorResponse ? throwError(() => card) : of(card));
    fixture = TestBed.createComponent(LineShare);
    fixture.detectChanges();
    await flush();
  }

  async function openPay(card: PaymentShareCard | HttpErrorResponse = PAY) {
    paymentShareCard.mockReturnValue(card instanceof HttpErrorResponse ? throwError(() => card) : of(card));
    fixture = TestBed.createComponent(LineShare);
    fixture.detectChanges();
    await flush();
  }

  beforeEach(() => {
    route = { params: { sessionCode: 'sess 1' }, query: {} };
    shareCard = vi.fn();
    paymentShareCard = vi.fn();
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      canShare: vi.fn().mockReturnValue(true),
      share: vi.fn().mockResolvedValue('sent'),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: LineService, useValue: { shareCard, paymentShareCard } },
        { provide: LiffClient, useValue: liff },
        {
          provide: ActivatedRoute,
          useValue: {
            get snapshot() {
              return { paramMap: convertToParamMap(route.params), queryParamMap: convertToParamMap(route.query) };
            },
          },
        },
      ],
    });
  });

  it('asks the server for the card of the session in the route', async () => {
    await open();
    expect(shareCard).toHaveBeenCalledWith('sess 1');
  });

  it("takes the session code from LIFF's liff.state when the path has none", async () => {
    // Angular hands over query values already decoded: ?liff.state=%2Fabc123 arrives as '/abc123'.
    route = { params: {}, query: { 'liff.state': '/abc123' } };
    await open();
    expect(shareCard).toHaveBeenCalledWith('abc123');
    expect(liff.init).toHaveBeenCalledTimes(1);
  });

  it('prefers the path code over liff.state', async () => {
    route = { params: { sessionCode: 'fromPath' }, query: { 'liff.state': '/other' } };
    await open();
    expect(shareCard).toHaveBeenCalledWith('fromPath');
  });

  it('says the summary is missing, and never touches the server or LIFF, when there is no code at all', async () => {
    route = { params: {}, query: {} };
    await open();
    expect(q('[data-share-missing]')?.textContent).toContain('ไม่พบสรุปนี้');
    expect(shareCard).not.toHaveBeenCalled();
    expect(liff.init).not.toHaveBeenCalled();
  });

  it('treats an empty liff.state (just a slash) as no code', async () => {
    route = { params: {}, query: { 'liff.state': '/' } };
    await open();
    expect(q('[data-share-missing]')).not.toBeNull();
    expect(shareCard).not.toHaveBeenCalled();
    expect(liff.init).not.toHaveBeenCalled();
  });

  it('uses the spec labels for the pick and send-again buttons', async () => {
    await open();
    expect(q('[data-share-pick]')?.textContent?.trim()).toBe('เลือกกลุ่มแล้วส่ง');
    q('[data-share-pick]')!.click();
    await flush();
    expect(q('[data-share-again]')?.textContent?.trim()).toBe('ส่งที่อื่นอีก');
  });

  it('says the summary is missing on a 404, and never touches LIFF', async () => {
    await open(new HttpErrorResponse({ status: 404 }));
    expect(q('[data-share-missing]')?.textContent).toContain('ไม่พบสรุปนี้');
    expect(liff.init).not.toHaveBeenCalled();
    expect(q('[data-share-pick]')).toBeNull();
  });

  it('inits LIFF with the id the server returned', async () => {
    await open();
    expect(liff.init).toHaveBeenCalledTimes(1);
    expect(liff.init).toHaveBeenCalledWith('1234567890-AbCdEfGh');
  });

  it('sends a logged-out visitor to LINE login once, returning to this page', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    await open();
    await flush();
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledWith(window.location.href);
    expect(q('[data-share-login]')?.textContent).toContain('กำลังไปหน้าเข้าสู่ระบบ LINE');
    expect(q('[data-share-pick]')).toBeNull();
  });

  it('previews the card: name, date, venue, players and games', async () => {
    await open();
    const preview = q('[data-share-preview]')?.textContent ?? '';
    expect(preview).toContain('ตีชิล');
    expect(preview).toContain('2026-10-28');
    expect(preview).toContain('Bad@Mama');
    expect(preview).toContain('12 คน');
    expect(preview).toContain('9 เกม');
    expect((q('[data-share-pick]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves the venue out when there is none', async () => {
    await open({ ...CARD, preview: { ...CARD.preview, venue: null } });
    expect(q('[data-share-venue]')).toBeNull();
    expect(q('[data-share-preview]')?.textContent).not.toContain('null');
  });

  it('shares the card from the server when the button is tapped, and shows it as sent', async () => {
    await open();
    q('[data-share-pick]')!.click();
    expect(liff.share).toHaveBeenCalledTimes(1);
    expect(liff.share).toHaveBeenCalledWith([CARD.card]);
    await flush();
    expect(q('[data-share-done]')?.textContent).toContain('ส่งแล้ว');
    expect(q('[data-share-pick]')).toBeNull();
  });

  it('calls share inside the click itself, with no await in between, or the browser blocks the picker', async () => {
    await open();
    let resolve!: (v: 'sent') => void;
    liff.share.mockReturnValue(new Promise((r) => (resolve = r)));
    q('[data-share-pick]')!.click();
    // Nothing has been flushed: the call must already have happened.
    expect(liff.share).toHaveBeenCalledTimes(1);
    resolve('sent');
  });

  it('lets the host send again after it was sent', async () => {
    await open();
    q('[data-share-pick]')!.click();
    await flush();
    q('[data-share-again]')!.click();
    await flush();
    expect(q('[data-share-done]')).toBeNull();
    expect(q('[data-share-pick]')).not.toBeNull();
  });

  it('stays ready, with no error, when the host closes the picker', async () => {
    liff.share.mockResolvedValue('cancelled');
    await open();
    q('[data-share-pick]')!.click();
    await flush();
    expect(q('[data-share-pick]')).not.toBeNull();
    expect((q('[data-share-pick]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-share-done]')).toBeNull();
    expect(q('[data-share-error]')).toBeNull();
    expect(q('[data-share-send-failed]')).toBeNull();
  });

  it('says so, and can retry, when LINE fails to open the picker', async () => {
    liff.share.mockRejectedValue(new Error('boom'));
    await open();
    q('[data-share-pick]')!.click();
    await flush();
    expect(q('[data-share-send-failed]')).not.toBeNull();
    expect((q('[data-share-pick]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('tells the host to open it in the LINE app when the share picker is not available', async () => {
    liff.canShare.mockReturnValue(false);
    await open();
    expect(q('[data-share-unavailable]')?.textContent).toContain('LINE');
    expect(q('[data-share-pick]')).toBeNull();
  });

  it('shows an error when LIFF fails to start', async () => {
    liff.init.mockRejectedValue(new Error('liff down'));
    await open();
    expect(q('[data-share-error]')).not.toBeNull();
    expect(q('[data-share-pick]')).toBeNull();
    expect(liff.login).not.toHaveBeenCalled();
  });

  it('shows an error when the card cannot be fetched for a reason other than 404', async () => {
    await open(new HttpErrorResponse({ status: 500 }));
    expect(q('[data-share-error]')).not.toBeNull();
    expect(q('[data-share-missing]')).toBeNull();
    expect(liff.init).not.toHaveBeenCalled();
  });

  describe('payment card', () => {
    beforeEach(() => {
      route = { params: { sessionCode: 'abc', token: 'TOK' }, query: {} };
    });

    it('asks the pay endpoint, with the token, and not the summary endpoint', async () => {
      await openPay();
      expect(paymentShareCard).toHaveBeenCalledWith('abc', 'TOK');
      expect(shareCard).not.toHaveBeenCalled();
      expect(liff.init).toHaveBeenCalledWith('1234567890-AbCdEfGh');
    });

    it("takes the code and token from LIFF's liff.state when the path has none", async () => {
      route = { params: {}, query: { 'liff.state': '/pay/abc/TOK' } };
      await openPay();
      expect(paymentShareCard).toHaveBeenCalledWith('abc', 'TOK');
      expect(shareCard).not.toHaveBeenCalled();
    });

    it('still reads a summary liff.state as the summary card', async () => {
      route = { params: {}, query: { 'liff.state': '/abc' } };
      await open();
      expect(shareCard).toHaveBeenCalledWith('abc');
      expect(paymentShareCard).not.toHaveBeenCalled();
    });

    it.each(['/pay/abc', '/pay/abc/', '/pay//TOK', '/pay/', '/pay'])(
      'says the card is missing, with no request, when liff.state %s lacks a code or token',
      async (state) => {
        route = { params: {}, query: { 'liff.state': state } };
        await openPay();
        expect(q('[data-share-missing]')).not.toBeNull();
        expect(paymentShareCard).not.toHaveBeenCalled();
        expect(shareCard).not.toHaveBeenCalled();
        expect(liff.init).not.toHaveBeenCalled();
      },
    );

    it('says the card is missing on a 404, in words that point back to the bill screen, and never touches LIFF', async () => {
      await openPay(new HttpErrorResponse({ status: 404 }));
      expect(q('[data-share-missing]')?.textContent).toContain('ไม่พบใบเก็บเงินนี้ ลองกดปุ่มจากหน้าเก็บเงินอีกครั้ง');
      expect(liff.init).not.toHaveBeenCalled();
      expect(q('[data-share-pick]')).toBeNull();
    });

    it('shows an error when the card cannot be fetched for a reason other than 404', async () => {
      await openPay(new HttpErrorResponse({ status: 500 }));
      expect(q('[data-share-error]')).not.toBeNull();
      expect(q('[data-share-missing]')).toBeNull();
    });

    it('titles the page for the payment card', async () => {
      await openPay();
      expect(q('h1')?.textContent?.trim()).toBe('ส่งใบเก็บเงินเข้ากลุ่ม LINE');
    });

    it('previews the count, the total and who is paid before the host picks a group', async () => {
      await openPay();
      const preview = q('[data-share-preview]')?.textContent ?? '';
      expect(preview).toContain('ใบเก็บเงิน · 12 คน · รวม ฿1,440');
      expect(preview).toContain('โอนให้ สมชาย ใจดี (KBank)');
      expect(preview).toContain('ตีชิล');
      expect(preview).toContain('2026-10-28');
      expect(el().textContent).toContain('เลือกกลุ่มหรือแชตใน LINE ใบเก็บเงินจะถูกส่งในชื่อของคุณ');
      expect(q('[data-share-pick]')?.textContent?.trim()).toBe('เลือกกลุ่มแล้วส่ง');
    });

    it('never renders the token', async () => {
      await openPay();
      q('[data-share-pick]')!.click();
      await flush();
      expect(el().innerHTML).not.toContain('TOK');
    });

    it('shares the one message the server returned, straight from the tap', async () => {
      await openPay();
      q('[data-share-pick]')!.click();
      expect(liff.share).toHaveBeenCalledTimes(1);
      expect(liff.share).toHaveBeenCalledWith(PAY.messages);
      await flush();
      expect(q('[data-share-done]')?.textContent).toContain('ส่งแล้ว');
    });

    it('shares every message when the server returns two (card plus account number text)', async () => {
      const messages = [PAY.messages[0], { type: 'text', text: '123-4-56789-0' }];
      await openPay({ ...PAY, messages });
      q('[data-share-pick]')!.click();
      expect(liff.share).toHaveBeenCalledWith(messages);
      expect((liff.share.mock.calls[0][0] as unknown[]).length).toBe(2);
    });

    it('lets the host send again after it was sent', async () => {
      await openPay();
      q('[data-share-pick]')!.click();
      await flush();
      expect(q('[data-share-done]')).not.toBeNull();
      expect(q('[data-share-again]')?.textContent?.trim()).toBe('ส่งที่อื่นอีก');
      q('[data-share-again]')!.click();
      await flush();
      expect(q('[data-share-done]')).toBeNull();
      expect(q('[data-share-pick]')).not.toBeNull();
    });
  });
});
