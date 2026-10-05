import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EarlyCheckoutDialog } from './early-checkout-dialog';
import { LiveSessionService } from '../../../core/live-session.service';
import type { CheckoutPreview, CheckoutReceipt } from '../../../core/checkout.model';

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

const breakdown = { baseSatang: 3000, shuttleSatang: 1500, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 };
const quote = (over: Partial<CheckoutPreview> = {}): CheckoutPreview => ({
  playerId: 'p1', model: 'perGame', amountSatang: 4500, games: 2, breakdown, snapshotHash: 'h1', ...over,
});
const receipt: CheckoutReceipt = { id: 'r1', playerId: 'p1', model: 'perGame', amountSatang: 4500, breakdown, settledAt: '2026-10-01T10:00:00Z' };
const billConfig = {
  perGameRateSatang: 1500, entryFeeSatang: 0, buffetPriceSatang: 12000, startingFeeSatang: 2000,
  perPlayerShuttleSatang: null, shuttleCharge: 'shared',
};
const http = (status: number, code?: string) => new HttpErrorResponse({ status, error: code ? { code } : null });

describe('EarlyCheckoutDialog', () => {
  let fixture: ComponentFixture<EarlyCheckoutDialog>;
  let live: {
    previewCheckout: ReturnType<typeof vi.fn>;
    confirmCheckout: ReturnType<typeof vi.fn>;
    undoCheckout: ReturnType<typeof vi.fn>;
    setShuttleDetails: ReturnType<typeof vi.fn>;
    getBillConfig: ReturnType<typeof vi.fn>;
    saveBillConfig: ReturnType<typeof vi.fn>;
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const btn = (selector: string) => el().querySelector(selector) as HTMLButtonElement;
  const text = () => el().textContent ?? '';
  const flush = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    live = {
      previewCheckout: vi.fn().mockResolvedValue(quote()),
      confirmCheckout: vi.fn().mockResolvedValue(receipt),
      undoCheckout: vi.fn().mockResolvedValue({ ok: true }),
      setShuttleDetails: vi.fn().mockResolvedValue({ ok: true }),
      getBillConfig: vi.fn().mockResolvedValue(billConfig),
      saveBillConfig: vi.fn().mockResolvedValue({ ok: true }),
    };
    await TestBed.configureTestingModule({
      imports: [EarlyCheckoutDialog],
      providers: [{ provide: LiveSessionService, useValue: live }],
    }).compileComponents();
    fixture = TestBed.createComponent(EarlyCheckoutDialog);
    fixture.componentRef.setInput('players', [
      { id: 'p1', name: 'นุ่น', courtLabel: null },
      { id: 'p2', name: 'ตั้ม', courtLabel: 'คอร์ท 2' },
    ]);
    fixture.componentRef.setInput('settled', []);
    fixture.detectChanges();
  });

  async function openAndPick(id = 'p1') {
    fixture.componentInstance.open();
    fixture.detectChanges();
    btn(`[data-checkout-player="${id}"]`).click();
    await flush();
  }

  it('lists players, quotes the picked one under per-game, and changes nothing by quoting', async () => {
    await openAndPick();
    expect(live.previewCheckout).toHaveBeenCalledWith('p1', 'perGame');
    expect(el().querySelector('[data-checkout-total]')!.textContent).toContain('45');
    expect(text()).toContain('ยังไม่ได้บันทึกว่าจ่ายแล้ว');
    expect(live.confirmCheckout).not.toHaveBeenCalled();
    expect(el().querySelectorAll('input[name="checkoutModel"]')).toHaveLength(3);
  });

  it('switching the model re-quotes under that model', async () => {
    await openAndPick();
    live.previewCheckout.mockResolvedValueOnce(quote({ model: 'perShuttle', amountSatang: 6000 }));
    (el().querySelectorAll('input[name="checkoutModel"]')[1] as HTMLInputElement).click();
    await flush();
    expect(live.previewCheckout).toHaveBeenLastCalledWith('p1', 'perShuttle');
    expect(el().querySelector('[data-checkout-total]')!.textContent).toContain('60');
  });

  it('under the full basis the quote says so and shows the charge', async () => {
    live.previewCheckout.mockResolvedValue(quote({ model: 'perShuttle', shuttleCharge: 'full', chargeSatang: 2000 }));
    await openAndPick();
    const basis = el().querySelector('[data-charge-basis]');
    expect(basis).toBeTruthy();
    expect(basis!.textContent).toContain('20');
  });

  it('a shared-basis quote shows no basis label', async () => {
    live.previewCheckout.mockResolvedValue(quote({ model: 'perShuttle', shuttleCharge: 'shared', chargeSatang: null }));
    await openAndPick();
    expect(el().querySelector('[data-charge-basis]')).toBeNull();
  });

  it('a player on a court gets a court-specific message and is never quoted or edited', async () => {
    await openAndPick('p2');
    expect(text()).toContain('คอร์ท 2');
    expect(text()).toContain('เอาออกจากคู่');
    expect(live.previewCheckout).not.toHaveBeenCalled();
    expect(btn('[data-confirm-checkout]').disabled).toBe(true);
  });

  it('confirming sends the quote hash and a key, shows the saved receipt, and tells the dashboard', async () => {
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    await openAndPick();
    btn('[data-confirm-checkout]').click();
    await flush();
    expect(live.confirmCheckout).toHaveBeenCalledWith('p1', 'perGame', 'h1', expect.stringMatching(/.{8,}/));
    expect(el().querySelector('[data-checkout-saved]')).toBeTruthy();
    expect(btn('[data-confirm-checkout]')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a stale answer is not a success: it explains, re-quotes, and the next confirm uses the new quote and a new key', async () => {
    await openAndPick();
    live.confirmCheckout.mockRejectedValueOnce(http(409, 'CHECKOUT_STALE'));
    live.previewCheckout.mockResolvedValueOnce(quote({ snapshotHash: 'h2', amountSatang: 4700 }));
    btn('[data-confirm-checkout]').click();
    await flush();
    expect(text()).toContain('ข้อมูลเปลี่ยนไป');
    expect(el().querySelector('[data-checkout-saved]')).toBeNull();
    expect(el().querySelector('[data-checkout-total]')!.textContent).toContain('47');
    btn('[data-confirm-checkout]').click();
    await flush();
    const [first, second] = live.confirmCheckout.mock.calls;
    expect(second[2]).toBe('h2');
    expect(second[3]).not.toBe(first[3]);
  });

  it('a network failure keeps the key, so retrying the same quote cannot charge twice', async () => {
    await openAndPick();
    live.confirmCheckout.mockRejectedValueOnce(http(0));
    btn('[data-confirm-checkout]').click();
    await flush();
    expect(text()).toContain('จะไม่คิดเงินซ้ำ');
    expect(el().querySelector('[data-checkout-saved]')).toBeNull();
    btn('[data-confirm-checkout]').click();
    await flush();
    const [first, second] = live.confirmCheckout.mock.calls;
    expect(second[3]).toBe(first[3]);
    expect(el().querySelector('[data-checkout-saved]')).toBeTruthy();
  });

  const rate = (key: string) => el().querySelector(`[data-rate="${key}"]`) as HTMLInputElement;
  const type = (key: string, value: string) => {
    rate(key).value = value;
    rate(key).dispatchEvent(new Event('input'));
  };

  it('a missing shuttle price can be set right here and re-quotes', async () => {
    live.previewCheckout.mockRejectedValueOnce(http(409, 'MISSING_SHUTTLE_PRICE'));
    await openAndPick();
    expect(text()).toContain('ยังไม่ได้ใส่ราคาลูกแบด');
    expect((el().querySelector('[data-rates]') as HTMLDetailsElement).open).toBe(true);
    type('shuttlePrice', '80');
    btn('[data-save-rates]').click();
    await flush();
    expect(live.setShuttleDetails).toHaveBeenCalledWith({ shuttlePriceSatang: 8000 });
    expect(live.previewCheckout).toHaveBeenCalledTimes(2);
    expect(el().querySelector('[data-checkout-total]')).toBeTruthy();
  });

  it('refuses an invalid rate without calling the server', async () => {
    live.previewCheckout.mockRejectedValueOnce(http(409, 'MISSING_SHUTTLE_PRICE'));
    await openAndPick();
    type('shuttlePrice', '80.505');
    btn('[data-save-rates]').click();
    await flush();
    expect(live.setShuttleDetails).not.toHaveBeenCalled();
    expect(live.saveBillConfig).not.toHaveBeenCalled();
    expect(text()).toContain('ใส่เป็นบาท');
  });

  it('shows the saved rates for the model on screen and saves edits to the session settings', async () => {
    await openAndPick();
    expect(rate('perGameRate').value).toBe('15');
    expect(rate('entryFee').value).toBe('0');
    expect(el().querySelector('[data-rate="startingFee"]')).toBeNull();
    type('perGameRate', '20');
    type('entryFee', '10.50');
    btn('[data-save-rates]').click();
    await flush();
    expect(live.saveBillConfig).toHaveBeenCalledWith({ perGameRateSatang: 2000, entryFeeSatang: 1050 });
    expect(live.previewCheckout).toHaveBeenCalledTimes(2); // re-quoted with the new rates
    expect(text()).toContain('บันทึกแล้ว');
  });

  it('per-shuttle offers the starting fee and shuttle price, and a blank charge means follow the price', async () => {
    live.previewCheckout.mockResolvedValue(quote({ model: 'perShuttle', shuttleCharge: 'full', shuttlePriceSatang: 8000 }));
    await openAndPick();
    btn('input[name="checkoutModel"][value="perShuttle"]').click();
    await flush();
    expect(rate('startingFee').value).toBe('20');
    expect(rate('shuttlePrice').value).toBe('80');
    expect(rate('perPlayerShuttle').value).toBe('');
    type('startingFee', '0');
    btn('[data-save-rates]').click();
    await flush();
    expect(live.saveBillConfig).toHaveBeenCalledWith({ startingFeeSatang: 0, perPlayerShuttleSatang: null });
    expect(live.setShuttleDetails).toHaveBeenCalledWith({ shuttlePriceSatang: 8000 });
  });

  it('opens the rates on its own for a 0-baht quote, and keeps them closed otherwise', async () => {
    await openAndPick();
    expect((el().querySelector('[data-rates]') as HTMLDetailsElement).open).toBe(false);
    live.previewCheckout.mockResolvedValue(quote({ amountSatang: 0, breakdown: { ...breakdown, baseSatang: 0, shuttleSatang: 0 } }));
    btn('input[name="checkoutModel"][value="buffet"]').click();
    await flush();
    expect((el().querySelector('[data-rates]') as HTMLDetailsElement).open).toBe(true);
  });

  it('shows why a rate could not be saved and does not re-quote', async () => {
    live.saveBillConfig.mockResolvedValueOnce({ ok: false, error: 'เปลี่ยนวิธีคิดค่าลูกไม่ได้ เพราะมีคนเช็คเอาต์ไปแล้ว' });
    await openAndPick();
    type('perGameRate', '20');
    btn('[data-save-rates]').click();
    await flush();
    expect(text()).toContain('มีคนเช็คเอาต์ไปแล้ว');
    expect(live.previewCheckout).toHaveBeenCalledTimes(1);
  });

  it('copies Thai text without settling, and shows selectable text if the clipboard is refused', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    await openAndPick();
    btn('[data-copy-checkout]').click();
    await flush();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('ยอดโดยประมาณ นุ่น'));
    expect(live.confirmCheckout).not.toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error('denied'));
    btn('[data-copy-checkout]').click();
    await flush();
    expect(el().querySelector('textarea.fallback')!.textContent).toContain('ยอดโดยประมาณ นุ่น');
  });

  it('undo needs its own confirming tap and warns about real money', async () => {
    fixture.componentRef.setInput('settled', [{ receipt, name: 'นุ่น' }]);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentInstance.open();
    fixture.detectChanges();
    btn('[data-undo="r1"]').click();
    fixture.detectChanges();
    expect(live.undoCheckout).not.toHaveBeenCalled();
    expect(text()).toContain('นอกแอป');
    btn('[data-confirm-undo]').click();
    await flush();
    expect(live.undoCheckout).toHaveBeenCalledWith('r1');
    expect(changed).toHaveBeenCalled();
  });

  describe('UX review fixes', () => {
    it('a 0-baht quote cannot be confirmed until the host acknowledges it, and says why', async () => {
      live.previewCheckout.mockResolvedValue(quote({ amountSatang: 0, breakdown: { ...breakdown, baseSatang: 0, shuttleSatang: 0 } }));
      await openAndPick();
      expect(el().querySelector('[data-zero-warning]')).toBeTruthy();
      expect(text()).toContain('อาจเพราะยังไม่ได้ตั้งราคา');
      expect(btn('[data-confirm-checkout]').disabled).toBe(true);
      const ack = el().querySelector('[data-zero-ack]') as HTMLInputElement;
      ack.checked = true;
      ack.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(btn('[data-confirm-checkout]').disabled).toBe(false);
      btn('[data-confirm-checkout]').click();
      await flush();
      expect(live.confirmCheckout).toHaveBeenCalledTimes(1);
    });

    it('a non-zero quote shows no warning and confirms as before', async () => {
      await openAndPick();
      expect(el().querySelector('[data-zero-warning]')).toBeNull();
      expect(btn('[data-confirm-checkout]').disabled).toBe(false);
    });

    it('the acknowledgement resets when the quote changes', async () => {
      live.previewCheckout.mockResolvedValue(quote({ amountSatang: 0 }));
      await openAndPick();
      const ack = el().querySelector('[data-zero-ack]') as HTMLInputElement;
      ack.checked = true;
      ack.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      (el().querySelectorAll('input[name="checkoutModel"]')[1] as HTMLInputElement).click();
      await flush();
      expect(btn('[data-confirm-checkout]').disabled).toBe(true);
    });

    it('long rosters get a name filter; short ones do not', async () => {
      fixture.componentInstance.open();
      fixture.detectChanges();
      expect(el().querySelector('[data-checkout-search]')).toBeNull();
      fixture.componentRef.setInput('players', Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, name: i === 7 ? 'ตั้ม' : `คน${i}`, courtLabel: null })));
      fixture.detectChanges();
      const input = el().querySelector('[data-checkout-search]') as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = 'ตั้ม';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(el().querySelectorAll('[data-checkout-player]')).toHaveLength(1);
      input.value = 'ไม่มีใคร';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(el().querySelector('[data-no-match]')).toBeTruthy();
    });

    it('the base line is named for the model: play, starting fee, or buffet', async () => {
      await openAndPick();
      expect(text()).toContain('ค่าเล่น');
      live.previewCheckout.mockResolvedValueOnce(quote({ model: 'perShuttle' }));
      (el().querySelectorAll('input[name="checkoutModel"]')[1] as HTMLInputElement).click();
      await flush();
      expect(text()).toContain('ค่าเริ่มต้น');
      live.previewCheckout.mockResolvedValueOnce(quote({ model: 'buffet' }));
      (el().querySelectorAll('input[name="checkoutModel"]')[2] as HTMLInputElement).click();
      await flush();
      expect(text()).toContain('ค่าบุฟเฟ่ต์');
    });

    it('model names match the bill page vocabulary', async () => {
      await openAndPick();
      const labels = [...el().querySelectorAll('.model-option span')].map((s) => s.textContent!.trim());
      expect(labels).toEqual(['คิดต่อเกม', 'ตามลูกแบด', 'บุฟเฟ่ต์']);
    });
  });
});
