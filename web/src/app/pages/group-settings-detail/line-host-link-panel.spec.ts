import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LineHostLinkPanel } from './line-host-link-panel';
import { environment } from '../../../environments/environment';

const URL = `${environment.apiBaseUrl}/line/host`;
const STATUS = { configured: true, botAddUrl: 'https://lin.ee/jubbad', linked: false, linkedAt: null };

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

  async function open(initial: Record<string, unknown> | 'failed' = {}, paid = true) {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LineHostLinkPanel);
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

  it('not linked: an add-the-bot-as-friend link and a create-code button', async () => {
    await open();
    const add = q('[data-host-add-bot]') as HTMLAnchorElement;
    expect(add.getAttribute('href')).toBe('https://lin.ee/jubbad');
    expect(add.textContent).toContain('เพิ่มบอทเป็นเพื่อนใน LINE');
    expect(q('[data-host-make-code]')).not.toBeNull();
    expect(q('[data-host-code]')).toBeNull();
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
    httpMock.expectOne(URL).flush({ ...STATUS, linked: true, linkedAt: '2026-10-28T12:00:00.000Z' });
    await fakeTick();
    expect(q('[data-host-linked]')?.textContent).toContain('ผูกบัญชี LINE ของคุณแล้ว');
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

  it('linked: says so and unlinks only after an inline confirm', async () => {
    await open({ linked: true, linkedAt: '2026-10-28T12:00:00.000Z' });
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
    expect(q('[data-host-make-code]')).not.toBeNull();
  });

  it('cancelling the unlink confirm sends nothing', async () => {
    await open({ linked: true });
    q('[data-host-unlink]')!.click();
    await tick();
    q('[data-host-cancel-unlink]')!.click();
    await tick();
    expect(q('[data-host-confirm-unlink]')).toBeNull();
    expect(q('[data-host-linked]')).not.toBeNull();
  });

  it('says the bot is not set up when the server has no LINE channel, and offers nothing to do', async () => {
    await open({ configured: false, botAddUrl: null });
    expect(q('[data-host-not-configured]')?.textContent).toContain('ยังไม่ได้ตั้งค่าบอท LINE ของระบบ');
    expect(q('[data-host-make-code]')).toBeNull();
    expect(q('[data-host-add-bot]')).toBeNull();
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
    expect(q('[data-host-lock]')?.textContent).toContain('การผูกบัญชี LINE ใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(q('[data-host-lock] .lock-more')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
  });

  it('free and not linked: the plan lock and no code button', async () => {
    await open({}, false);
    expect(q('[data-host-lock]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
  });

  it('free but still linked: a paused notice and Unlink only', async () => {
    await open({ linked: true }, false);
    expect(q('[data-host-paused]')?.textContent).toContain('หยุดรับรายชื่อ');
    expect(q('[data-host-unlink]')).not.toBeNull();
    expect(q('[data-host-make-code]')).toBeNull();
    expect(q('[data-host-linked]')).toBeNull();
  });

  it('a 409 on creating a code (already linked elsewhere) re-reads the status', async () => {
    await open();
    q('[data-host-make-code]')!.click();
    httpMock
      .expectOne({ url: `${URL}/code`, method: 'POST' })
      .flush({ code: 'LINE_ALREADY_LINKED' }, { status: 409, statusText: 'Conflict' });
    await tick();
    httpMock.expectOne(URL).flush({ ...STATUS, linked: true });
    await tick();
    expect(q('[data-host-linked]')).not.toBeNull();
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
