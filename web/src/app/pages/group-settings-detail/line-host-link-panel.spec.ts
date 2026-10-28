import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LineHostLinkPanel } from './line-host-link-panel';
import { environment } from '../../../environments/environment';

const URL = `${environment.apiBaseUrl}/groups/group1/line/host`;
const STATUS = { configured: true, botAddUrl: 'https://lin.ee/jubbad', accountLinked: false, enabled: false, summaryDefault: false, summaryAvailable: true };
const LINKED = { accountLinked: true, enabled: false };
const ON = { accountLinked: true, enabled: true };

describe('LineHostLinkPanel', () => {
  let fixture: ComponentFixture<LineHostLinkPanel>;
  let httpMock: HttpTestingController;

  const tick = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  // Under fake timers a real setTimeout never fires, so these flush by hand.
  const fakeTick = async () => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const box = () => q('[data-host-enabled]') as HTMLInputElement | null;
  const state = () => q('[data-host-state]')?.textContent?.trim();

  async function open(initial: Record<string, unknown> | 'failed' = {}, paid = true) {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LineHostLinkPanel);
    fixture.componentRef.setInput('groupCode', 'group1');
    fixture.componentRef.setInput('paid', paid);
    fixture.detectChanges();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('GET');
    if (initial === 'failed') req.flush('x', { status: 500, statusText: 'x' });
    else req.flush({ ...STATUS, ...initial });
    await tick();
  }

  async function makeCode(expiresInMs = 10 * 60_000, fake = false) {
    q('[data-host-make-code]')!.click();
    httpMock
      .expectOne({ url: `${URL}/code`, method: 'POST' })
      .flush({ code: 'K7P2QX', expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
    await (fake ? fakeTick() : tick());
  }

  afterEach(() => {
    vi.useRealTimers();
    httpMock.verify();
  });

  it('reads the status of this group from the group route', async () => {
    await open();
    expect(q('[data-host-section] h2')?.textContent).toContain('แชตส่วนตัวกับบอท');
  });

  it('account not linked: an add-the-bot-as-friend link and a create-code button', async () => {
    await open();
    const add = q('[data-host-add-bot]') as HTMLAnchorElement;
    expect(add.getAttribute('href')).toBe('https://lin.ee/jubbad');
    expect(add.textContent).toContain('เพิ่มบอทเป็นเพื่อนใน LINE');
    expect(q('[data-host-make-code]')).not.toBeNull();
    expect(q('[data-host-code]')).toBeNull();
    expect(box()).toBeNull();
  });

  it('creating a code shows it large, with the /link instruction, the time left and a copy button', async () => {
    await open();
    await makeCode();
    expect(q('[data-host-code]')?.textContent?.trim()).toBe('K7P2QX');
    expect(el().textContent).toContain('/link K7P2QX');
    expect(el().textContent).toContain('หมดอายุใน 10 นาที');
    expect(q('[data-host-copy]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
  });

  it('copies the /link command and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open();
    await makeCode();
    q('[data-host-copy]')!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith('/link K7P2QX');
    expect(q('[data-host-copied]')).not.toBeNull();
  });

  it('tells the host to type it when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    await open();
    await makeCode();
    q('[data-host-copy]')!.click();
    await tick();
    expect(q('[data-host-copy-failed]')).not.toBeNull();
  });

  it('polls every 5 seconds and shows the linked state once the host sends the code', async () => {
    await open();
    vi.useFakeTimers();
    await makeCode(10 * 60_000, true);
    await vi.advanceTimersByTimeAsync(5000);
    httpMock.expectOne(URL).flush(STATUS);
    await vi.advanceTimersByTimeAsync(5000);
    httpMock.expectOne(URL).flush({ ...STATUS, accountLinked: true, enabled: true });
    await fakeTick();
    expect(q('[data-host-linked]')?.textContent).toContain('ผูกบัญชี LINE ของคุณแล้ว');
    expect(box()?.checked).toBe(true);
    expect(state()).toBe('เปิดอยู่');
    expect(q('[data-host-code]')).toBeNull();
    await vi.advanceTimersByTimeAsync(20000);
    httpMock.expectNone(URL);
  });

  it('stops polling and drops the code once it has expired', async () => {
    await open();
    vi.useFakeTimers();
    await makeCode(6000, true);
    await vi.advanceTimersByTimeAsync(5000);
    httpMock.expectOne(URL).flush(STATUS);
    await vi.advanceTimersByTimeAsync(5000);
    await fakeTick();
    expect(q('[data-host-code]')).toBeNull();
    expect(q('[data-host-make-code]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20000);
    httpMock.expectNone(URL);
  });

  it('account linked but this group off: the switch is unchecked and the account note is shown', async () => {
    await open(LINKED);
    expect(box()?.checked).toBe(false);
    expect(q('[data-host-linked]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
    expect(q('[data-host-add-bot]')).toBeNull();
    expect(q('[data-host-paused]')).toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('turning the switch on saves with a PUT and the box and tag follow the server', async () => {
    await open(LINKED);
    box()!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ enabled: true });
    expect(box()?.checked).toBe(false); // does not move until the server confirms
    req.flush({ enabled: true });
    await tick();
    expect(box()?.checked).toBe(true);
    expect(state()).toBe('เปิดอยู่');
    expect(q('[data-host-error]')).toBeNull();
  });

  describe('summary card default', () => {
    const SUMMARY = `${environment.apiBaseUrl}/groups/group1/line`;
    const sw = () => q('[data-host-summary-default]') as HTMLInputElement | null;

    it('is shown when the account is linked, this group is on and a card can go out', async () => {
      await open({ ...ON, summaryDefault: true });
      expect(sw()?.checked).toBe(true);
      expect(q('[data-host-summary-default]')?.closest('label')?.textContent).toContain(
        'ส่งการ์ดสรุปให้ฉันทาง LINE เมื่อจบรอบ'
      );
    });

    it('is hidden when this group is off, the account is not linked, or no card can go out', async () => {
      await open(LINKED);
      expect(sw()).toBeNull();
      TestBed.resetTestingModule();
      await open();
      expect(sw()).toBeNull();
      TestBed.resetTestingModule();
      await open({ ...ON, summaryAvailable: false });
      expect(sw()).toBeNull();
    });

    it('is hidden when the server says no switch is wanted, e.g. a bot-linked group, though linked and on', async () => {
      await open({ ...ON, summaryAvailable: false });
      expect(sw()).toBeNull();
      expect(q('[data-host-enabled]')).not.toBeNull();
    });

    it('is hidden on a paused group (plan lapsed) while the paused notice shows', async () => {
      await open(ON, false);
      expect(q('[data-host-paused]')).not.toBeNull();
      expect(sw()).toBeNull();
    });

    it('saves with a PATCH and the box follows the server', async () => {
      await open(ON);
      sw()!.click();
      const req = httpMock.expectOne({ url: SUMMARY, method: 'PATCH' });
      expect(req.request.body).toEqual({ summaryDefault: true });
      expect(sw()?.checked).toBe(false); // does not move until the server confirms
      req.flush({ summaryDefault: true });
      await tick();
      expect(sw()?.checked).toBe(true);
      expect(q('[data-host-error]')).toBeNull();
    });

    it('a failed save leaves the box where it was and shows an error', async () => {
      await open({ ...ON, summaryDefault: true });
      sw()!.click();
      httpMock.expectOne({ url: SUMMARY, method: 'PATCH' }).flush('x', { status: 500, statusText: 'x' });
      await tick();
      expect(sw()?.checked).toBe(true);
      expect(q('[data-host-error]')).not.toBeNull();
    });

    it('a plan refusal shows the plan message and reverts the box', async () => {
      await open(ON);
      sw()!.click();
      httpMock
        .expectOne({ url: SUMMARY, method: 'PATCH' })
        .flush({ code: 'PLAN_REQUIRED' }, { status: 403, statusText: 'Forbidden' });
      await tick();
      expect(sw()?.checked).toBe(false);
      expect(q('[data-host-error]')?.textContent).toContain('โฮสต์');
    });
  });

  it('a failed save leaves the box unchecked and shows an error', async () => {
    await open(LINKED);
    box()!.click();
    httpMock.expectOne({ url: URL, method: 'PUT' }).flush('x', { status: 500, statusText: 'x' });
    await tick();
    expect(box()?.checked).toBe(false);
    expect(q('[data-host-error]')).not.toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('a 403 on saving the switch swaps it for the plan lock', async () => {
    await open(LINKED);
    box()!.click();
    httpMock
      .expectOne({ url: URL, method: 'PUT' })
      .flush({ code: 'PLAN_REQUIRED', requiredPlan: 'host' }, { status: 403, statusText: 'Forbidden' });
    await tick();
    expect(q('[data-host-lock]')).not.toBeNull();
    expect(box()).toBeNull();
    expect(q('[data-host-unlink]')).not.toBeNull();
  });

  it('a 409 on saving the switch re-reads the status', async () => {
    await open(LINKED);
    box()!.click();
    httpMock
      .expectOne({ url: URL, method: 'PUT' })
      .flush({ code: 'LINE_NOT_LINKED' }, { status: 409, statusText: 'Conflict' });
    await tick();
    httpMock.expectOne(URL).flush(STATUS);
    await tick();
    expect(box()).toBeNull();
    expect(q('[data-host-make-code]')).not.toBeNull();
  });

  it('turning the switch off saves enabled false and the tag goes back to ยังไม่เปิด', async () => {
    await open(ON);
    expect(box()?.checked).toBe(true);
    box()!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ enabled: false });
    req.flush({ enabled: false });
    await tick();
    expect(box()?.checked).toBe(false);
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('free plan, account linked and this group on: a paused notice, and the switch can still be turned off', async () => {
    await open(ON, false);
    expect(q('[data-host-paused]')?.textContent).toContain('หยุดรับรายชื่อ');
    expect(q('[data-host-lock]')).toBeNull();
    expect(box()?.checked).toBe(true);
    expect(state()).toBe('หยุดชั่วคราว');
    box()!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ enabled: false });
    req.flush({ enabled: false });
    await tick();
    expect(box()).toBeNull(); // off on the free plan: the plan lock takes the switch's place
    expect(q('[data-host-paused]')).toBeNull();
    expect(q('[data-host-lock]')).not.toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('free plan, account linked and this group off: the plan lock stands in for the switch', async () => {
    await open(LINKED, false);
    expect(q('[data-host-lock]')).not.toBeNull();
    expect(q('[data-host-paused]')).toBeNull();
    expect(box()).toBeNull();
    expect(q('[data-host-unlink]')).not.toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('the tag reads เปิดอยู่ only when linked, on and paid', async () => {
    await open(ON);
    expect(state()).toBe('เปิดอยู่');
    expect(q('[data-host-state]')?.classList.contains('on')).toBe(true);
  });

  it('the tag reads ยังไม่เปิด and is not drawn as on when the account is not linked', async () => {
    await open();
    expect(state()).toBe('ยังไม่เปิด');
    expect(q('[data-host-state]')?.classList.contains('on')).toBe(false);
  });

  it('the paused tag is not drawn as on', async () => {
    await open(ON, false);
    expect(q('[data-host-state]')?.classList.contains('on')).toBe(false);
  });

  it('account linked: unlinks only after an inline confirm, then goes back to the not-linked state', async () => {
    await open(ON);
    expect(q('[data-host-linked]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
    q('[data-host-unlink]')!.click();
    await tick();
    httpMock.expectNone({ url: URL, method: 'DELETE' });
    expect(q('[data-host-confirm-unlink]')).not.toBeNull();
    q('[data-host-confirm-unlink]')!.click();
    httpMock.expectOne({ url: URL, method: 'DELETE' }).flush({ unlinked: true });
    await tick();
    expect(q('[data-host-linked]')).toBeNull();
    expect(box()).toBeNull();
    expect(q('[data-host-make-code]')).not.toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('cancelling the unlink confirm sends nothing', async () => {
    await open(ON);
    q('[data-host-unlink]')!.click();
    await tick();
    q('[data-host-cancel-unlink]')!.click();
    await tick();
    expect(q('[data-host-confirm-unlink]')).toBeNull();
    expect(q('[data-host-linked]')).not.toBeNull();
  });

  it('a failed unlink keeps the linked state and shows an error', async () => {
    await open(ON);
    q('[data-host-unlink]')!.click();
    await tick();
    q('[data-host-confirm-unlink]')!.click();
    httpMock.expectOne({ url: URL, method: 'DELETE' }).flush('x', { status: 500, statusText: 'x' });
    await tick();
    expect(q('[data-host-error]')).not.toBeNull();
    expect(q('[data-host-linked]')).not.toBeNull();
  });

  it('unlink stays available on the free plan', async () => {
    await open(ON, false);
    expect(q('[data-host-unlink]')).not.toBeNull();
    q('[data-host-unlink]')!.click();
    await tick();
    q('[data-host-confirm-unlink]')!.click();
    httpMock.expectOne({ url: URL, method: 'DELETE' }).flush({ unlinked: true });
    await tick();
    expect(q('[data-host-linked]')).toBeNull();
    expect(q('[data-host-lock]')).not.toBeNull();
  });

  it('says the bot is not set up when the server has no LINE channel, and offers nothing to do', async () => {
    await open({ configured: false, botAddUrl: null });
    expect(q('[data-host-not-configured]')?.textContent).toContain('ยังไม่ได้ตั้งค่าบอท LINE ของระบบ');
    expect(q('[data-host-make-code]')).toBeNull();
    expect(q('[data-host-add-bot]')).toBeNull();
    expect(q('[data-host-state]')).toBeNull();
  });

  it('shows no tag before the status has loaded', async () => {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LineHostLinkPanel);
    fixture.componentRef.setInput('groupCode', 'group1');
    fixture.detectChanges();
    expect(q('[data-host-state]')).toBeNull();
    expect(q('[data-host-section] h2')).not.toBeNull();
    httpMock.expectOne(URL).flush(STATUS);
    await tick();
    expect(q('[data-host-state]')).not.toBeNull();
  });

  it('a 503 on creating a code shows that the bot is not set up', async () => {
    await open();
    q('[data-host-make-code]')!.click();
    httpMock
      .expectOne({ url: `${URL}/code`, method: 'POST' })
      .flush({ code: 'LINE_NOT_CONFIGURED' }, { status: 503, statusText: 'Service Unavailable' });
    await tick();
    expect(q('[data-host-not-configured]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
  });

  it('a failed status read says so and offers a retry', async () => {
    await open('failed');
    expect(q('[data-host-load-failed]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
    expect(q('[data-host-state]')).toBeNull();
    q('[data-host-load-failed] button')!.click();
    httpMock.expectOne(URL).flush(STATUS);
    await tick();
    expect(q('[data-host-load-failed]')).toBeNull();
    expect(q('[data-host-make-code]')).not.toBeNull();
  });

  it('a 403 on creating a code swaps the button for the plan lock', async () => {
    await open();
    q('[data-host-make-code]')!.click();
    httpMock
      .expectOne({ url: `${URL}/code`, method: 'POST' })
      .flush({ code: 'PLAN_REQUIRED', requiredPlan: 'host' }, { status: 403, statusText: 'Forbidden' });
    await tick();
    expect(q('[data-host-lock]')?.textContent).toContain('การรับรายชื่อทางแชตส่วนตัวใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(q('[data-host-lock] .lock-more')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
  });

  it('free and account not linked: the plan lock and no code button', async () => {
    await open({}, false);
    expect(q('[data-host-lock]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
    expect(state()).toBe('ยังไม่เปิด');
  });

  it('a 409 on creating a code (already linked elsewhere) re-reads the status', async () => {
    await open();
    q('[data-host-make-code]')!.click();
    httpMock
      .expectOne({ url: `${URL}/code`, method: 'POST' })
      .flush({ code: 'LINE_ALREADY_LINKED' }, { status: 409, statusText: 'Conflict' });
    await tick();
    httpMock.expectOne(URL).flush({ ...STATUS, ...LINKED });
    await tick();
    expect(q('[data-host-linked]')).not.toBeNull();
    expect(box()).not.toBeNull();
  });

  it('shows an error and keeps the button when creating a code fails', async () => {
    await open();
    q('[data-host-make-code]')!.click();
    httpMock.expectOne({ url: `${URL}/code`, method: 'POST' }).flush('x', { status: 500, statusText: 'x' });
    await tick();
    expect(q('[data-host-error]')).not.toBeNull();
    expect(q('[data-host-make-code]')).not.toBeNull();
  });
});
