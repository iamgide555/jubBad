import { provideHttpClient, HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError, type Observable } from 'rxjs';
import type { SlipDuplicate, SlipHostPanel, SlipLink, SlipPaidRow, SlipWaiting } from '../../core/slip-host.model';
import { SlipHostService } from '../../core/slip-host.service';
import { SlipReview } from './slip-review';

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

const ROWS = [
  { playerId: 'a', name: 'Amp', amountSatang: 9000, absent: false },
  { playerId: 'b', name: 'Beam', amountSatang: 11000, absent: false },
  { playerId: 'c', name: 'Cat', amountSatang: 9000, absent: false },
  { playerId: 'z', name: 'Zero', amountSatang: 0, absent: false },
];

const paid = (over: Partial<SlipPaidRow> = {}): SlipPaidRow => ({
  playerId: 'a',
  source: 'slip',
  at: '2026-10-30T13:00:00.000Z',
  amountChangedSince: false,
  ...over,
});

const waiting = (over: Partial<SlipWaiting> = {}): SlipWaiting => ({
  id: 'w-secret-1',
  reason: 'unmapped',
  displayName: 'Mind',
  pictureUrl: 'https://profile.line-scdn.net/abc',
  lineUserId: 'U-secret-line-id',
  amountSatang: 9000,
  receiverName: null,
  receiverTail: null,
  createdAt: '2026-10-30T13:05:00.000Z',
  candidatePlayerIds: ['a'],
  ...over,
});

const dup = (over: Partial<SlipDuplicate> = {}): SlipDuplicate => ({
  id: 'd-secret-1',
  displayName: 'Mind',
  lineUserId: 'U-secret-line-id',
  referenceTail: '123456',
  originalPlayerIds: ['a'],
  createdAt: '2026-10-30T13:10:00.000Z',
  ...over,
});

const link = (over: Partial<SlipLink> = {}): SlipLink => ({ playerId: 'a', displayName: 'Amp LINE', linkedBy: 'self', ...over });

const panel = (over: Partial<SlipHostPanel> = {}): SlipHostPanel => ({ paid: [], waiting: [], duplicates: [], links: [], ...over });

describe('SlipReview', () => {
  let fixture: ComponentFixture<SlipReview>;
  let svc: {
    panel: ReturnType<typeof vi.fn>;
    tick: ReturnType<typeof vi.fn>;
    untick: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    updateName: ReturnType<typeof vi.fn>;
    dismissDuplicate: ReturnType<typeof vi.fn>;
    imageUrl: ReturnType<typeof vi.fn>;
    closeCollection: ReturnType<typeof vi.fn>;
    setLink: ReturnType<typeof vi.fn>;
  };

  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el().querySelector<T>(s);
  const qa = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(el().querySelectorAll<T>(s));
  const text = () => el().textContent ?? '';
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const click = async (target: HTMLElement | null) => {
    target!.click();
    await settle();
  };
  const conflict = (code: string): Observable<never> =>
    throwError(() => new HttpErrorResponse({ status: 409, error: { code } }));

  async function open(data: SlipHostPanel = panel(), inputs: Record<string, unknown> = {}) {
    svc.panel.mockReturnValue(of(data));
    fixture = TestBed.createComponent(SlipReview);
    fixture.componentRef.setInput('code', 'sess1');
    fixture.componentRef.setInput('rows', ROWS);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    const ok = () => of({ ok: true as const });
    svc = {
      panel: vi.fn(),
      imageUrl: vi.fn().mockReturnValue('/private/image'),
      closeCollection: vi.fn().mockImplementation(ok),
      tick: vi.fn().mockImplementation(ok),
      untick: vi.fn().mockImplementation(ok),
      resolve: vi.fn().mockImplementation(ok),
      dismiss: vi.fn().mockImplementation(ok),
      updateName: vi.fn().mockImplementation(ok),
      dismissDuplicate: vi.fn().mockImplementation(ok),
      setLink: vi.fn().mockImplementation(ok),
    };
    TestBed.configureTestingModule({ providers: [provideHttpClient(), { provide: SlipHostService, useValue: svc }] });
  });

  describe('review evidence and collection', () => {
    it('shows private thumbnail enlarged on request and a legacy fallback', async () => {
      await open(panel({ waiting: [waiting({ imageId: 'img1' } as any)] } as any));
      expect(q<HTMLImageElement>('[data-slip-image]')?.getAttribute('src')).toBe('/private/image');
      await click(q('[data-enlarge]'));
      expect(q('[data-image-dialog]')?.hasAttribute('open')).toBe(true);
      await open(panel({ waiting: [waiting()] }));
      expect(q('[data-no-image]')?.textContent).toContain('รูป');
    });

    it('requires sufficient reviewed total, preserves multiple selections and sends satang', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: [], amountSatang: null })] }));
      await click(qa('[data-cover]')[0]);
      await click(qa('[data-cover]')[1]);
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(true);
      const amount = q<HTMLInputElement>('[data-reviewed-amount]');
      expect(amount).not.toBeNull();
      amount!.value = '199.99'; amount!.dispatchEvent(new Event('input')); await settle();
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(true);
      expect(q('[data-selected-total]')?.textContent).toContain('200');
      expect(q('[data-difference]')?.textContent).toContain('0.01');
      amount!.value = '200'; amount!.dispatchEvent(new Event('input')); await settle();
      expect(qa<HTMLInputElement>('[data-cover]').map(c => c.checked)).toEqual([true, true, false]);
      await click(q('[data-resolve]'));
      expect(svc.resolve).toHaveBeenCalledWith('sess1', 'w-secret-1', { coversPlayerIds: ['a', 'b'], senderPlayerId: null, reviewedAmountSatang: 20000 });
    });

    it('accepts reviewed overpayment and names exact, short and extra amounts', async () => {
      await open(panel({ waiting: [waiting()] }));
      expect(q('[data-difference]')?.textContent).toContain('ยอดตรงกัน');
      const amount = q<HTMLInputElement>('[data-reviewed-amount]')!;
      amount.value = '89'; amount.dispatchEvent(new Event('input')); await settle();
      expect(q('[data-difference]')?.textContent).toContain('ยังขาด ฿1');
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(true);
      amount.value = '100'; amount.dispatchEvent(new Event('input')); await settle();
      expect(q('[data-difference]')?.textContent).toContain('จ่ายเกิน ฿10');
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false);
      await click(q('[data-resolve]'));
      expect(svc.resolve).toHaveBeenCalledWith('sess1', 'w-secret-1', { coversPlayerIds: ['a'], senderPlayerId: 'a', reviewedAmountSatang: 10000 });
    });

    it('refreshes all data once, preserves review drafts and shows last success or failure', async () => {
      await open(panel({ waiting: [waiting()] }));
      const amount = q<HTMLInputElement>('[data-reviewed-amount]')!;
      amount.value = '100'; amount.dispatchEvent(new Event('input')); await settle();
      expect(q('[data-refreshed-at]')).not.toBeNull();
      const pending = new Subject<SlipHostPanel>(); svc.panel.mockReturnValue(pending);
      const refresh = q<HTMLButtonElement>('[data-refresh]'); expect(refresh).not.toBeNull();
      refresh!.click(); await settle();
      expect(q<HTMLButtonElement>('[data-refresh]')!.disabled).toBe(true);
      q<HTMLButtonElement>('[data-refresh]')!.click();
      expect(svc.panel).toHaveBeenCalledTimes(2);
      pending.next(panel({ waiting: [waiting()], paid: [paid({ playerId: 'b' })], duplicates: [dup()], links: [link()] })); pending.complete(); await settle();
      expect(q<HTMLInputElement>('[data-reviewed-amount]')!.value).toBe('100');
      expect(q('[data-paid-count]')!.textContent).toContain('1 / 3');
      expect(q('[data-duplicate]')).not.toBeNull(); expect(q('[data-link]')).not.toBeNull();
      svc.panel.mockReturnValue(throwError(() => new Error('offline')));
      await click(q('[data-refresh]'));
      expect(q('[data-load-failed]')).not.toBeNull();
      expect(q<HTMLInputElement>('[data-reviewed-amount]')!.value).toBe('100');
      expect(q('[data-refreshed-at]')).not.toBeNull();
    });

    it('disables manual refresh while a payment mutation is running', async () => {
      await open(); const pending = new Subject<{ok: true}>(); svc.tick.mockReturnValue(pending);
      await click(q('[data-person]'));
      expect(q<HTMLButtonElement>('[data-refresh]')?.disabled).toBe(true);
      pending.next({ok: true}); pending.complete(); await settle();
      expect(q<HTMLButtonElement>('[data-refresh]')?.disabled).toBe(false);
    });

    it('rejects invalid money and keeps the original OCR amount visible after editing', async () => {
      await open(panel({ waiting: [waiting()] }));
      const amount = q<HTMLInputElement>('[data-reviewed-amount]')!;
      for (const invalid of ['', '0', '-90', '90.001', 'NaN', '1e2']) {
        amount.value = invalid; amount.dispatchEvent(new Event('input')); await settle();
        expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(true);
      }
      amount.value = '110'; amount.dispatchEvent(new Event('input')); await settle();
      expect(q('[data-w-amount]')!.textContent).toContain('90');
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false);
    });

    it('shows missing image fallback when a retained image cannot load', async () => {
      await open(panel({ waiting: [waiting({ imageId: 'expired' } as any)] } as any));
      q('[data-slip-image]')!.dispatchEvent(new Event('error')); await settle();
      expect(q('[data-no-image]')).not.toBeNull();
      expect(q('[data-slip-image]')).toBeNull();
    });

    it('allows deletion retry after collection closed with images remaining', async () => {
      await open(panel({ collection: { closedAt: '2026-10-31', canClose: false, imageCount: 2 } } as any));
      expect(q('[data-close-collection]')?.textContent).toContain('ลบรูปอีกครั้ง');
      await click(q('[data-close-collection]'));
      await click(q('[data-confirm-close]'));
      expect(svc.closeCollection).toHaveBeenCalledWith('sess1');
    });

    it('shows pending only for a linked sender with an exact single-person amount', async () => {
      await open(panel({ paid: [paid({ playerId: 'c' })], waiting: [waiting({ linkedPlayerId: 'a' } as any), waiting({ id: 'w2', linkedPlayerId: 'b', amountSatang: 9000 } as any)] } as any));
      expect(qa('[data-chip]').map(c => c.textContent!.trim())).toEqual(['รอยืนยัน', 'ยังไม่จ่าย', 'สลิป']);
    });

    it('does not prefill sender for a linked account', async () => {
      await open(panel({ waiting: [waiting({ linkedPlayerId: 'b' } as any)] }));
      expect(q<HTMLSelectElement>('[data-sender]')!.value).toBe('');
    });

    it('offers close only when ready, confirms deletion count and disables closed controls', async () => {
      await open(panel()); expect(q('[data-close-collection]')).toBeNull();
      await open(panel({ collection: { closedAt: null, canClose: true, imageCount: 3 } } as any));
      await click(q('[data-close-collection]'));
      expect(q('[data-close-dialog]')?.hasAttribute('open')).toBe(true);
      expect(q('[data-close-dialog]')?.textContent).toContain('3');
      expect(q('[data-close-dialog]')?.textContent).toContain('ถาวร');
      svc.panel.mockReturnValue(of(panel({ waiting: [waiting()], links: [link()], duplicates: [dup()], collection: { closedAt: '2026-10-31', canClose: false, imageCount: 0 } } as any)));
      await click(q('[data-confirm-close]'));
      expect(svc.closeCollection).toHaveBeenCalledWith('sess1');
      expect(text()).toContain('เก็บเงินครบแล้ว');
      expect(qa<HTMLButtonElement>('[data-person], [data-resolve], [data-dismiss], [data-link-remove], [data-dup-ack]').every(b => b.disabled)).toBe(true);
      expect(qa<HTMLInputElement>('[data-cover]').every(b => b.disabled)).toBe(true);
    });
  });

  describe('paid status', () => {
    it('lists people owing money with a chip per source and counts only billed people', async () => {
      await open(panel({ paid: [paid({ playerId: 'a', source: 'slip' }), paid({ playerId: 'b', source: 'host' })] }));
      const people = qa('[data-person]');
      expect(people.map((p) => p.querySelector('.person-name')!.textContent!.trim())).toEqual(['Amp', 'Beam', 'Cat']);
      expect(people.map((p) => p.querySelector('[data-chip]')!.textContent!.trim())).toEqual(['สลิป', 'โฮสต์ติ๊ก', 'ยังไม่จ่าย']);
      expect(q('[data-paid-count]')!.textContent).toContain('ชำระแล้ว 2 / 3 คน');
    });

    it('does not reuse the early-checkout wording', async () => {
      await open(panel({ paid: [paid()] }));
      expect(text()).not.toContain('จ่ายแล้ว');
    });

    it('marks a slip payment whose amount changed afterwards', async () => {
      await open(panel({ paid: [paid({ amountChangedSince: true })] }));
      expect(qa('[data-person]')[0].querySelector('[data-changed]')!.textContent).toContain('ยอดเปลี่ยนหลังจ่าย');
      expect(qa('[data-person]')[1].querySelector('[data-changed]')).toBeNull();
    });

    it('ticks an unpaid person and undoes a paid one, refreshing after each', async () => {
      await open(panel({ paid: [paid({ playerId: 'b', source: 'host' })] }));
      await click(qa('[data-person]')[0]);
      expect(svc.tick).toHaveBeenCalledWith('sess1', 'a');
      expect(svc.untick).not.toHaveBeenCalled();
      await click(qa('[data-person]')[1]);
      expect(svc.untick).toHaveBeenCalledWith('sess1', 'b');
      expect(svc.panel).toHaveBeenCalledTimes(3);
    });

    it('still lists a paid mark whose person is no longer on the bill, so it can be undone', async () => {
      await open(panel({ paid: [paid({ playerId: 'gone', source: 'host' })], links: [link({ playerId: 'gone', displayName: 'Gone LINE' })] }));
      const people = qa('[data-person]');
      expect(people).toHaveLength(4);
      expect(people[3].textContent).toContain('Gone LINE');
      await click(people[3]);
      expect(svc.untick).toHaveBeenCalledWith('sess1', 'gone');
    });

    it('calls an unknown paid person ไม่ทราบชื่อ', async () => {
      await open(panel({ paid: [paid({ playerId: 'gone', source: 'host' })] }));
      expect(qa('[data-person]')[3].textContent).toContain('ไม่ทราบชื่อ');
    });

    it('sends one request for a double tap', async () => {
      await open();
      const row = qa('[data-person]')[0];
      row.click();
      row.click();
      await settle();
      expect(svc.tick).toHaveBeenCalledTimes(1);
    });

    it('shows a short Thai message when a tap fails', async () => {
      await open();
      svc.tick.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
      await click(qa('[data-person]')[0]);
      expect(q('[data-error]')!.textContent).toContain('ไม่สำเร็จ');
    });
  });

  describe('badge', () => {
    it('counts waiting slips and undismissed duplicates', async () => {
      await open(panel({ waiting: [waiting(), waiting({ id: 'w2' })], duplicates: [dup()] }));
      expect(q('[data-review-badge]')!.textContent).toContain('รอตรวจ 3');
    });

    it('is hidden at zero', async () => {
      await open();
      expect(q('[data-review-badge]')).toBeNull();
    });
  });

  describe('waiting slips', () => {
    it('shows sender avatar and name, amount, time and a plain reason', async () => {
      await open(panel({ waiting: [waiting()] }));
      const card = q('[data-waiting]')!;
      const img = card.querySelector<HTMLImageElement>('img[data-w-avatar]')!;
      expect(img.getAttribute('src')).toBe('https://profile.line-scdn.net/abc');
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(card.querySelector('[data-w-name]')!.textContent).toContain('Mind');
      expect(card.querySelector('[data-w-amount]')!.textContent).toContain('฿90');
      expect(card.querySelector('[data-w-time]')!.textContent).toMatch(/\d{2}:\d{2}/);
      expect(card.querySelector('[data-w-reason]')!.textContent).toContain('ยังไม่รู้ว่าเป็นใคร');
    });

    it('uses a placeholder with no picture, and unknown name and amount fallbacks', async () => {
      await open(panel({ waiting: [waiting({ pictureUrl: null, displayName: null, amountSatang: null })] }));
      const card = q('[data-waiting]')!;
      expect(card.querySelector('img')).toBeNull();
      expect(card.querySelector('[data-w-placeholder]')).not.toBeNull();
      expect(card.querySelector('[data-w-name]')!.textContent).toContain('ไม่ทราบชื่อ');
      expect(card.querySelector('[data-w-amount]')!.textContent).toContain('ไม่ทราบยอด');
    });

    it.each([
      ['unmapped', 'ยังไม่รู้ว่าเป็นใคร'],
      ['amount', 'ยอดไม่ตรงกับที่ต้องจ่าย'],
      ['date', 'วันที่บนสลิปไม่ตรงกับบิลนี้'],
      ['receiver', 'ชื่อผู้รับไม่ตรง'],
      ['unreadable', 'อ่านยอดจากสลิปไม่ได้'],
      ['stale', 'ยอดบิลเปลี่ยนหลังยืนยัน'],
      ['collision', 'คนนี้จ่ายไปแล้วหรือไม่อยู่ในบิล'],
    ] as const)('explains a %s slip', async (reason, line) => {
      await open(panel({ waiting: [waiting({ reason })] }));
      expect(q('[data-w-reason]')!.textContent).toContain(line);
    });

    it('offers only unpaid people owing money in "this slip covers"', async () => {
      await open(panel({ paid: [paid({ playerId: 'b', source: 'host' })], waiting: [waiting({ candidatePlayerIds: [] })] }));
      const labels = qa('[data-cover]').map((c) => c.closest('label')!.querySelector('.pick-name')!.textContent!.trim());
      expect(labels).toEqual(['Amp', 'Cat']);
    });

    it('pre-ticks the candidate only when there is exactly one', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: ['a'] })] }));
      expect(qa<HTMLInputElement>('[data-cover]').map((c) => c.checked)).toEqual([true, false, false]);
    });

    it('does not pre-tick with several candidates or none', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: ['a', 'c'] }), waiting({ id: 'w2', candidatePlayerIds: [] })] }));
      expect(qa<HTMLInputElement>('[data-cover]').every((c) => !c.checked)).toBe(true);
    });

    it('disables Confirm until someone is ticked', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: [] })] }));
      const confirm = q<HTMLButtonElement>('[data-resolve]')!;
      expect(confirm.disabled).toBe(true);
      await click(qa('[data-cover]')[0]);
      expect(q<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false);
    });

    it('pre-fills the sender with the single ticked person when the account is unlinked, and it can be cleared', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: ['a'] })] }));
      const sender = q<HTMLSelectElement>('[data-sender]')!;
      expect(sender.value).toBe('a');
      sender.value = '';
      sender.dispatchEvent(new Event('change'));
      await settle();
      expect(q<HTMLSelectElement>('[data-sender]')!.value).toBe('');
      await click(q('[data-resolve]'));
      expect(svc.resolve).toHaveBeenCalledWith('sess1', 'w-secret-1', { coversPlayerIds: ['a'], senderPlayerId: null, reviewedAmountSatang: 9000 });
    });

    it('does not pre-fill the sender when two are ticked or the slip is not unmapped', async () => {
      await open(panel({ waiting: [waiting({ reason: 'amount', candidatePlayerIds: ['a'] })] }));
      expect(q<HTMLSelectElement>('[data-sender]')!.value).toBe('');
      await open(panel({ waiting: [waiting({ candidatePlayerIds: [] })] }));
      await click(qa('[data-cover]')[0]);
      expect(q<HTMLSelectElement>('[data-sender]')!.value).toBe('a');
      await click(qa('[data-cover]')[1]);
      expect(q<HTMLSelectElement>('[data-sender]')!.value).toBe('');
    });

    it('offers every person on the bill and ไม่มีในระบบ as the sender', async () => {
      await open(panel({ waiting: [waiting()] }));
      const options = qa<HTMLOptionElement>('[data-sender] option').map((o) => o.textContent!.trim());
      expect(options).toEqual(['ไม่มีในระบบ', 'Amp', 'Beam', 'Cat', 'Zero']);
    });

    it('sends both lists on Confirm and refreshes', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: [], amountSatang: 18000 })] }));
      await click(qa('[data-cover]')[0]);
      await click(qa('[data-cover]')[2]);
      const sender = q<HTMLSelectElement>('[data-sender]')!;
      sender.value = 'b';
      sender.dispatchEvent(new Event('change'));
      await settle();
      await click(q('[data-resolve]'));
      expect(svc.resolve).toHaveBeenCalledWith('sess1', 'w-secret-1', { coversPlayerIds: ['a', 'c'], senderPlayerId: 'b', reviewedAmountSatang: 18000 });
      expect(svc.panel).toHaveBeenCalledTimes(2);
    });

    it('sends one request for a double tap on Confirm', async () => {
      await open(panel({ waiting: [waiting()] }));
      const confirm = q<HTMLButtonElement>('[data-resolve]')!;
      confirm.click();
      confirm.click();
      await settle();
      expect(svc.resolve).toHaveBeenCalledTimes(1);
    });

    it('warns before Confirm when the picked sender already has a different LINE account', async () => {
      await open(panel({ waiting: [waiting({ candidatePlayerIds: [] })], links: [link({ playerId: 'b' })] }));
      expect(q('[data-sender-warning]')).toBeNull();
      const sender = q<HTMLSelectElement>('[data-sender]')!;
      sender.value = 'b';
      sender.dispatchEvent(new Event('change'));
      await settle();
      expect(q('[data-sender-warning]')!.textContent).toContain('คนนี้ผูกกับบัญชี LINE อื่นอยู่แล้ว การยืนยันจะแทนที่บัญชีเดิม');
      expect(svc.resolve).not.toHaveBeenCalled();
    });

    it('skips a slip with Dismiss', async () => {
      await open(panel({ waiting: [waiting()] }));
      await click(q('[data-dismiss]'));
      expect(svc.dismiss).toHaveBeenCalledWith('sess1', 'w-secret-1');
    });
  });

  describe('fixing the saved name', () => {
    const receiver = () => waiting({ reason: 'receiver', receiverName: 'จิตติญา ฉ.', receiverTail: '5953' });

    it('shows the receiver block and button only for a receiver slip with a name', async () => {
      await open(panel({ waiting: [receiver()] }), { savedName: 'จิตติญา ฉัตรเฉลิมวิทย์' });
      expect(q('[data-receiver]')!.textContent).toContain('บนสลิป: จิตติญา ฉ.');
      expect(q('[data-receiver]')!.textContent).toContain('เลขบัญชีลงท้าย 5953');
      expect(q('[data-update-name]')!.textContent).toContain('อัปเดตชื่อที่ตั้งไว้เป็น "จิตติญา ฉ."');
    });

    it('shows the receiver block but no button when the group has no saved name to change', async () => {
      // The server only rewrites a saved account's name; with none there is nothing to fix.
      await open(panel({ waiting: [receiver()] }));
      expect(q('[data-receiver]')!.textContent).toContain('บนสลิป: จิตติญา ฉ.');
      expect(q('[data-update-name]')).toBeNull();
    });

    it('is absent for every other reason, and for a receiver slip with no name', async () => {
      await open(panel({ waiting: [waiting({ reason: 'amount', receiverName: 'X' }), waiting({ id: 'w2', reason: 'receiver', receiverName: null })] }));
      expect(q('[data-update-name]')).toBeNull();
      expect(q('[data-receiver]')).toBeNull();
    });

    it('confirms with old and new names and calls the route only after confirming', async () => {
      await open(panel({ waiting: [receiver()] }), { savedName: 'จิตติญา ฉัตรเฉลิมวิทย์' });
      await click(q('[data-update-name]'));
      const dialog = q<HTMLDialogElement>('[data-name-dialog]')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.textContent).toContain('เปลี่ยนชื่อผู้รับจาก "จิตติญา ฉัตรเฉลิมวิทย์" เป็น "จิตติญา ฉ."');
      expect(dialog.textContent).toContain('หลังจากนี้สลิปที่โอนให้ชื่อนี้จะผ่านอัตโนมัติ');
      expect(svc.updateName).not.toHaveBeenCalled();
      await click(q('[data-name-cancel]'));
      expect(svc.updateName).not.toHaveBeenCalled();
      await click(q('[data-update-name]'));
      await click(q('[data-name-confirm]'));
      expect(svc.updateName).toHaveBeenCalledWith('sess1', 'w-secret-1');
      expect(svc.panel).toHaveBeenCalledTimes(2);
      expect(q('[data-update-name]')).toBeNull();
      expect(q('[data-name-updated]')).not.toBeNull();
    });
  });

  describe('errors', () => {
    it.each([
      ['COVERS_REQUIRED', 'เลือกคนที่สลิปนี้จ่ายให้'],
      ['PLAYER_NOT_ON_BILL', 'ไม่อยู่ในบิลแล้ว'],
      ['ACCOUNT_ALREADY_LINKED', 'บัญชี LINE นี้ผูกกับคนอื่นอยู่แล้ว'],
      ['PLAYER_NOT_IN_GROUP', 'ไม่ได้อยู่ในก๊วนนี้แล้ว'],
      ['NAME_UPDATE_NOT_APPLICABLE', 'เปลี่ยนชื่อผู้รับจากสลิปนี้ไม่ได้'],
      ['PAY_ACCOUNT_INVALID', 'ชื่อผู้รับบนสลิปใช้ไม่ได้'],
    ])('maps %s to Thai text with no raw code', async (code, expected) => {
      await open(panel({ waiting: [waiting()] }));
      svc.resolve.mockReturnValue(conflict(code));
      await click(q('[data-resolve]'));
      const message = q('[data-w-error]')!.textContent!;
      expect(message).toContain(expected);
      expect(text()).not.toContain(code);
    });

    it('maps a failed name update', async () => {
      await open(panel({ waiting: [waiting({ reason: 'receiver', receiverName: 'X' })] }), { savedName: 'Y' });
      svc.updateName.mockReturnValue(conflict('PAY_ACCOUNT_INVALID'));
      await click(q('[data-update-name]'));
      await click(q('[data-name-confirm]'));
      expect(q('[data-w-error]')!.textContent).toContain('ชื่อผู้รับบนสลิปใช้ไม่ได้');
    });
  });

  describe('duplicates', () => {
    it('lists the sender, time, original payers and reference tail, and acknowledges', async () => {
      await open(panel({ duplicates: [dup({ originalPlayerIds: ['a', 'c'] })] }));
      const card = q('[data-duplicate]')!;
      expect(q('[data-duplicates]')!.textContent).toContain('สลิปซ้ำ');
      expect(card.textContent).toContain('Mind');
      expect(card.textContent).toContain('ใช้กับ Amp, Cat แล้ว');
      expect(card.textContent).toContain('…123456');
      await click(card.querySelector('[data-dup-ack]'));
      expect(svc.dismissDuplicate).toHaveBeenCalledWith('sess1', 'd-secret-1');
    });

    it('omits the original line when the original payers are unknown', async () => {
      await open(panel({ duplicates: [dup({ originalPlayerIds: ['gone'] })] }));
      expect(q('[data-duplicate]')!.textContent).not.toContain('ใช้กับ');
    });
  });

  describe('linked accounts', () => {
    it('lists links with a self or host label and removes with a null account', async () => {
      await open(panel({ links: [link({ playerId: 'a', linkedBy: 'self' }), link({ playerId: 'b', displayName: null, linkedBy: 'host' })] }));
      const rows = qa('[data-link]');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('Amp');
      expect(rows[0].textContent).toContain('Amp LINE');
      expect(rows[0].querySelector('[data-link-kind]')!.textContent).toContain('ผูกเอง');
      expect(rows[1].querySelector('[data-link-kind]')!.textContent).toContain('โฮสต์ผูก');
      expect(rows[1].textContent).toContain('ไม่ทราบชื่อ');
      await click(rows[1].querySelector('[data-link-remove]'));
      expect(svc.setLink).toHaveBeenCalledWith('sess1', 'b', null);
    });

    it('is not rendered with no links', async () => {
      await open();
      expect(q('[data-links]')).toBeNull();
    });
  });

  describe('hygiene', () => {
    it('never renders ids or tokens, and never calls console', async () => {
      const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      await open(panel({ paid: [paid()], waiting: [waiting()], duplicates: [dup()], links: [link()] }));
      const html = el().innerHTML;
      for (const secret of ['w-secret-1', 'd-secret-1', 'U-secret-line-id']) expect(html).not.toContain(secret);
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
      spies.forEach((s) => s.mockRestore());
    });

    it('shows a retry when the read fails and no data is on screen', async () => {
      svc.panel.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
      fixture = TestBed.createComponent(SlipReview);
      fixture.componentRef.setInput('code', 'sess1');
      fixture.componentRef.setInput('rows', ROWS);
      fixture.detectChanges();
      await settle();
      expect(q('[data-load-failed]')).not.toBeNull();
      svc.panel.mockReturnValue(of(panel()));
      await click(q('[data-load-failed] button'));
      expect(q('[data-load-failed]')).toBeNull();
      expect(q('[data-slip-review]')).not.toBeNull();
    });

    it('ignores an older read that answers after a newer one', async () => {
      const first = new Subject<SlipHostPanel>();
      svc.panel.mockReturnValueOnce(first);
      fixture = TestBed.createComponent(SlipReview);
      fixture.componentRef.setInput('code', 'sess1');
      fixture.componentRef.setInput('rows', ROWS);
      fixture.detectChanges();
      svc.panel.mockReturnValue(of(panel({ paid: [paid()] })));
      fixture.componentRef.setInput('rows', [...ROWS]);
      await settle();
      first.next(panel());
      first.complete();
      await settle();
      expect(q('[data-paid-count]')!.textContent).toContain('ชำระแล้ว 1 / 3 คน');
    });
  });
});
