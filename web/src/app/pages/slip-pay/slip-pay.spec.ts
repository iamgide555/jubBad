import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { LiffClient } from '../../core/liff-client';
import type { SlipPayClaimOutcome, SlipPayUploadResult, SlipPayView } from '../../core/slip-pay.model';
import { SlipPayService } from '../../core/slip-pay.service';
import { SlipPay } from './slip-pay';

const TOKEN = 'Zq9SecretTokenXy7';
const ACCESS = 'line-access-token-ABC';

const LINKED: SlipPayView = {
  amountSatang: 17200,
  playerName: 'มายด์',
  claimable: [],
  accountName: 'จิตติญา ฉัตรเฉลิมวิทย์',
  alreadyPaid: false,
};
const UNLINKED: SlipPayView = {
  amountSatang: null,
  playerName: null,
  claimable: [
    { playerId: 'p1', name: 'มายด์' },
    { playerId: 'p2', name: 'บีม' },
  ],
  accountName: 'จิตติญา ฉัตรเฉลิมวิทย์',
  alreadyPaid: false,
};

describe('SlipPay', () => {
  let fixture: ComponentFixture<SlipPay>;
  let svc: {
    config: ReturnType<typeof vi.fn>;
    view: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  };
  let liff: {
    init: ReturnType<typeof vi.fn>;
    isLoggedIn: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    getAccessToken: ReturnType<typeof vi.fn>;
  };
  let route: { params: Record<string, string> };

  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const text = () => el().textContent ?? '';
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const http = (status: number) => throwError(() => new HttpErrorResponse({ status }));

  async function open(view: SlipPayView | HttpErrorResponse = LINKED) {
    svc.view.mockReturnValue(view instanceof HttpErrorResponse ? throwError(() => view) : of(view));
    fixture = TestBed.createComponent(SlipPay);
    fixture.detectChanges();
    await flush();
  }

  const file = () => new File([new Uint8Array([1, 2, 3])], 'slip.jpg', { type: 'image/jpeg' });

  /** Simulates choosing a photo in the (hidden) file input. */
  async function pick(f: File = file()) {
    const input = q('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    return f;
  }

  const uploads = (r: SlipPayUploadResult) => svc.upload.mockReturnValue(of(r));

  beforeEach(() => {
    route = { params: { sessionCode: 'sess 1', token: TOKEN } };
    svc = {
      config: vi.fn().mockReturnValue(of({ liffId: '1234567890-AbCdEfGh' })),
      view: vi.fn(),
      claim: vi.fn(),
      upload: vi.fn(),
    };
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      getAccessToken: vi.fn().mockReturnValue(ACCESS),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: SlipPayService, useValue: svc },
        { provide: LiffClient, useValue: liff },
        {
          provide: ActivatedRoute,
          useValue: {
            get snapshot() {
              return { paramMap: convertToParamMap(route.params), queryParamMap: convertToParamMap({}) };
            },
          },
        },
      ],
    });
  });

  describe('start-up', () => {
    it('reads config first, then inits LIFF with that id, then loads the view with the access token', async () => {
      await open();
      expect(svc.config).toHaveBeenCalledWith('sess 1', TOKEN);
      expect(liff.init).toHaveBeenCalledWith('1234567890-AbCdEfGh');
      expect(svc.view).toHaveBeenCalledWith('sess 1', TOKEN, ACCESS);
      expect(svc.config.mock.invocationCallOrder[0]).toBeLessThan(liff.init.mock.invocationCallOrder[0]);
      expect(liff.init.mock.invocationCallOrder[0]).toBeLessThan(svc.view.mock.invocationCallOrder[0]);
    });

    it('sends a logged-out viewer to LINE login once, back to this page, and asks for no view', async () => {
      liff.isLoggedIn.mockReturnValue(false);
      await open();
      expect(liff.login).toHaveBeenCalledTimes(1);
      expect(liff.login).toHaveBeenCalledWith(window.location.href);
      expect(svc.view).not.toHaveBeenCalled();
      expect(q('[data-slip-login]')).not.toBeNull();
    });

    it('shows the unavailable state, with no LIFF, when the config is a 404', async () => {
      svc.config.mockReturnValue(http(404));
      await open();
      expect(q('[data-slip-unavailable]')?.textContent).toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
      expect(liff.init).not.toHaveBeenCalled();
    });

    it('shows the unavailable state when the view is a 404', async () => {
      await open(new HttpErrorResponse({ status: 404 }));
      expect(q('[data-slip-unavailable]')).not.toBeNull();
    });

    it('shows the unavailable state, with no request, when the route has no token', async () => {
      route = { params: { sessionCode: 'sess 1' } };
      await open();
      expect(q('[data-slip-unavailable]')).not.toBeNull();
      expect(svc.config).not.toHaveBeenCalled();
    });

    it('shows a retryable error when LIFF fails, and retrying loads again', async () => {
      liff.init.mockRejectedValueOnce(new Error('liff down'));
      await open();
      expect(q('[data-slip-error]')).not.toBeNull();
      expect(q('[data-slip-retry]')).not.toBeNull();
      q('[data-slip-retry]')!.click();
      await flush();
      expect(q('[data-slip-error]')).toBeNull();
      expect(svc.view).toHaveBeenCalledTimes(1);
    });

    it('shows a retryable error when the view fails with a 500', async () => {
      await open(new HttpErrorResponse({ status: 500 }));
      expect(q('[data-slip-error]')).not.toBeNull();
      expect(q('[data-slip-unavailable]')).toBeNull();
    });
  });

  describe('a linked viewer', () => {
    it('shows the amount, the name and the receiver account', async () => {
      await open();
      expect(q('[data-slip-amount]')?.textContent).toContain('฿172');
      expect(text()).toContain('มายด์');
      expect(text()).toContain('โอนเข้า');
      expect(text()).toContain('จิตติญา ฉัตรเฉลิมวิทย์');
      expect(q('[data-slip-send]')?.textContent?.trim()).toBe('ส่งสลิป');
      expect(q('[data-slip-claim]')).toBeNull();
    });

    it('keeps satang when the amount has them', async () => {
      await open({ ...LINKED, amountSatang: 17250 });
      expect(q('[data-slip-amount]')?.textContent).toContain('฿172.50');
    });

    it('shows a calm paid state with the amount when already paid, with no send button', async () => {
      await open({ ...LINKED, alreadyPaid: true });
      expect(q('[data-slip-already-paid]')?.textContent).toContain('จ่ายแล้ว');
      expect(text()).toContain('฿172');
      expect(q('[data-slip-send]')).toBeNull();
    });
  });

  describe('an unlinked viewer', () => {
    it('asks who they are and lists the claimable players', async () => {
      await open(UNLINKED);
      expect(text()).toContain('คุณคือใคร?');
      expect(text()).toContain('เลือกชื่อของคุณ (ครั้งเดียว)');
      const names = Array.from(el().querySelectorAll('[data-slip-claim]')).map((b) => b.textContent?.trim());
      expect(names).toEqual(['มายด์', 'บีม']);
      expect(q('[data-slip-skip]')?.textContent?.trim()).toBe('ข้าม — ฉันจ่ายแทนคนอื่น');
      expect(q('[data-slip-send]')).toBeNull();
    });

    it('claims the tapped player, then reloads the view and shows the linked state', async () => {
      await open(UNLINKED);
      svc.claim.mockReturnValue(of({ outcome: 'linked' as SlipPayClaimOutcome }));
      svc.view.mockReturnValue(of(LINKED));
      el().querySelectorAll<HTMLElement>('[data-slip-claim]')[1].click();
      await flush();
      expect(svc.claim).toHaveBeenCalledWith('sess 1', TOKEN, ACCESS, 'p2');
      expect(svc.view).toHaveBeenCalledTimes(2);
      expect(q('[data-slip-amount]')?.textContent).toContain('฿172');
      expect(q('[data-slip-claim]')).toBeNull();
    });

    it.each([
      ['player-taken', 'ชื่อนี้มีคนเลือกไปแล้ว'],
      ['account-already-linked', 'บัญชี LINE นี้เลือกชื่อไว้แล้ว'],
      ['not-on-bill', 'ชื่อนี้ไม่อยู่ในบิลแล้ว'],
    ] as const)('on %s shows a short message and refreshes the list', async (outcome, message) => {
      await open(UNLINKED);
      svc.claim.mockReturnValue(of({ outcome }));
      const fresh = { ...UNLINKED, claimable: [{ playerId: 'p2', name: 'บีม' }] };
      svc.view.mockReturnValue(of(fresh));
      q('[data-slip-claim]')!.click();
      await flush();
      expect(q('[data-slip-claim-note]')?.textContent).toContain(message);
      expect(el().querySelectorAll('[data-slip-claim]').length).toBe(1);
      expect(text()).not.toContain(outcome);
    });

    it('skipping goes to the send state with no amount, only the account line and the send button', async () => {
      await open(UNLINKED);
      q('[data-slip-skip]')!.click();
      await flush();
      expect(q('[data-slip-claim]')).toBeNull();
      expect(q('[data-slip-amount]')).toBeNull();
      expect(text()).toContain('จิตติญา ฉัตรเฉลิมวิทย์');
      expect(q('[data-slip-send]')).not.toBeNull();
      expect(svc.claim).not.toHaveBeenCalled();
    });

    it('goes straight to the send state when nobody is claimable', async () => {
      await open({ ...UNLINKED, claimable: [] });
      expect(q('[data-slip-claim]')).toBeNull();
      expect(q('[data-slip-send]')).not.toBeNull();
    });

    it('shows the unavailable state when a claim is a 404', async () => {
      await open(UNLINKED);
      svc.claim.mockReturnValue(http(404));
      q('[data-slip-claim]')!.click();
      await flush();
      expect(q('[data-slip-unavailable]')).not.toBeNull();
    });
  });

  describe('sending a slip', () => {
    it('has a hidden file input that accepts images only', async () => {
      await open();
      const input = q('input[type="file"]') as HTMLInputElement;
      expect(input.getAttribute('accept')).toBe('image/*');
      expect(input.hidden).toBe(true);
    });

    it('the send button opens the file picker', async () => {
      await open();
      const input = q('input[type="file"]') as HTMLInputElement;
      const click = vi.spyOn(input, 'click');
      q('[data-slip-send]')!.click();
      expect(click).toHaveBeenCalledTimes(1);
    });

    it('uploads once, automatically, as soon as a file is chosen, and shows the paid state', async () => {
      uploads({ outcome: 'paid' });
      await open();
      const f = await pick();
      expect(svc.upload).toHaveBeenCalledTimes(1);
      expect(svc.upload).toHaveBeenCalledWith('sess 1', TOKEN, ACCESS, f);
      expect(q('[data-slip-result="paid"]')?.textContent).toContain('รับสลิปแล้ว');
      expect(q('[data-slip-result="paid"]')?.textContent).toContain('฿172');
    });

    it('disables the button and shows a busy state while uploading', async () => {
      const pending = new Subject<SlipPayUploadResult>();
      svc.upload.mockReturnValue(pending);
      await open();
      await pick();
      const btn = q('[data-slip-send]') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-busy')).toBe('true');
      expect(btn.textContent).toContain('กำลังส่ง');
      pending.next({ outcome: 'paid' });
      pending.complete();
      await flush();
      expect(q('[data-slip-result="paid"]')).not.toBeNull();
    });

    it('ignores a second pick while one is in flight', async () => {
      svc.upload.mockReturnValue(new Subject<SlipPayUploadResult>());
      await open();
      await pick();
      await pick();
      expect(svc.upload).toHaveBeenCalledTimes(1);
    });

    it('ignores a cancelled picker (no file)', async () => {
      await open();
      const input = q('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [], configurable: true });
      input.dispatchEvent(new Event('change'));
      await flush();
      expect(svc.upload).not.toHaveBeenCalled();
    });

    it('waiting says it went to the host to check', async () => {
      uploads({ outcome: 'waiting', reason: 'amount-mismatch' });
      await open();
      await pick();
      const box = q('[data-slip-result="waiting"]')!;
      expect(box.textContent).toContain('ส่งให้โฮสต์ตรวจแล้ว');
      expect(box.textContent).toContain('โฮสต์จะตรวจและติ๊กให้');
      expect(text()).not.toContain('amount-mismatch');
    });

    it('duplicate says the slip was already used and keeps the button usable', async () => {
      uploads({ outcome: 'duplicate' });
      await open();
      await pick();
      expect(q('[data-slip-notice]')?.textContent).toContain('สลิปนี้ถูกใช้ไปแล้ว');
      expect((q('[data-slip-send]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('not-slip asks for another photo and re-enables the button', async () => {
      uploads({ outcome: 'not-slip' });
      await open();
      await pick();
      expect(q('[data-slip-notice]')?.textContent).toContain('ไม่พบสลิปในรูปนี้ ลองเลือกรูปสลิปอีกครั้ง');
      expect((q('[data-slip-send]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a new attempt clears the old notice', async () => {
      uploads({ outcome: 'not-slip' });
      await open();
      await pick();
      uploads({ outcome: 'paid' });
      await pick();
      expect(q('[data-slip-notice]')).toBeNull();
      expect(q('[data-slip-result="paid"]')).not.toBeNull();
    });

    it('a 404 is the terminal unavailable state', async () => {
      svc.upload.mockReturnValue(http(404));
      await open();
      await pick();
      expect(q('[data-slip-unavailable]')?.textContent).toContain('ลิงก์นี้ใช้ไม่ได้แล้ว');
      expect(q('[data-slip-send]')).toBeNull();
    });

    it.each([
      [429, 'ส่งบ่อยเกินไป ลองใหม่ภายหลัง'],
      [413, 'รูปใหญ่เกินไป เลือกรูปที่เล็กกว่านี้'],
      [400, 'ไม่พบสลิปในรูปนี้ ลองเลือกรูปสลิปอีกครั้ง'],
      [500, 'ส่งไม่สำเร็จ ลองใหม่อีกครั้ง'],
      [0, 'ส่งไม่สำเร็จ ลองใหม่อีกครั้ง'],
    ])('HTTP %s shows its own message and leaves the button usable', async (status, message) => {
      svc.upload.mockReturnValue(http(status));
      await open();
      await pick();
      expect(q('[data-slip-notice]')?.textContent).toContain(message);
      expect(text()).not.toContain(String(status === 0 ? 'Unknown' : status));
      expect((q('[data-slip-send]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a paid result without a linked player shows no amount', async () => {
      await open(UNLINKED);
      q('[data-slip-skip]')!.click();
      await flush();
      uploads({ outcome: 'paid' });
      await pick();
      expect(q('[data-slip-result="paid"]')?.textContent).toContain('รับสลิปแล้ว');
      expect(q('[data-slip-result="paid"]')?.textContent).not.toContain('฿');
    });
  });

  describe('paying cash', () => {
    it('reveals the note and makes no request at all', async () => {
      await open();
      const calls = () => svc.config.mock.calls.length + svc.view.mock.calls.length + svc.claim.mock.calls.length + svc.upload.mock.calls.length;
      const before = calls();
      expect(q('[data-slip-cash-note]')).toBeNull();
      expect(q('[data-slip-cash]')?.textContent?.trim()).toBe('ฉันจ่ายเงินสดแล้ว');
      q('[data-slip-cash]')!.click();
      await flush();
      expect(q('[data-slip-cash-note]')?.textContent).toContain('บอกโฮสต์ให้ติ๊กให้ในแอปนะ');
      expect(calls()).toBe(before);
    });
  });

  describe('touch targets and privacy', () => {
    /** The component's own stylesheet, as the test DOM has it. */
    const css = () =>
      Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent ?? '')
        .join('\n');

    it('every button is at least 44px tall, by the page stylesheet', async () => {
      await open(UNLINKED);
      const sheet = css();
      for (const cls of ['slip-btn', 'claim-btn', 'text-btn']) {
        const rule = new RegExp(`\\.${cls}[^{]*\\{[^}]*min-height:\\s*([^;}]+)`).exec(sheet);
        expect(rule, `.${cls} has a min-height`).not.toBeNull();
        expect(rule![1]).toMatch(/44px|var\(--tap/);
      }
      for (const b of Array.from(el().querySelectorAll('button'))) {
        expect(b.className, b.textContent ?? '').toMatch(/slip-btn|claim-btn|text-btn/);
      }
    });

    it('never renders or logs the pay token or the access token, nor raw outcome strings', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      try {
        uploads({ outcome: 'waiting', reason: 'amount-mismatch' });
        await open();
        await pick();
        for (const secret of [TOKEN, ACCESS]) expect(el().innerHTML).not.toContain(secret);
        for (const raw of ['waiting', 'amount-mismatch', 'not-slip', 'duplicate']) expect(text()).not.toContain(raw);
        for (const spy of spies) {
          for (const args of spy.mock.calls) {
            const line = (args as unknown[]).map(String).join(' ');
            expect(line).not.toContain(TOKEN);
            expect(line).not.toContain(ACCESS);
          }
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
