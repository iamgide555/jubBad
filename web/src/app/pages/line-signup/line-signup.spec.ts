import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LiffClient } from '../../core/liff-client';
import type { LineSignupResult, LineStatusResult, SignupInfo } from '../../core/signup.service';
import { SignupService } from '../../core/signup.service';
import { LineSignup } from './line-signup';

const ACCESS = 'line-access-token-ABC';
const INFO: SignupInfo = { liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: 'https://lin.ee/bot' };
const NEW_LINE: LineStatusResult = { lineDisplayName: 'Somchai', registered: false, trialAvailable: true };

describe('LineSignup', () => {
  let fixture: ComponentFixture<LineSignup>;
  let svc: {
    info: ReturnType<typeof vi.fn>;
    lineStatus: ReturnType<typeof vi.fn>;
    lineSignup: ReturnType<typeof vi.fn>;
  };
  let liff: {
    init: ReturnType<typeof vi.fn>;
    isLoggedIn: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    getAccessToken: ReturnType<typeof vi.fn>;
  };
  let auth: { check: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.spyOn>;

  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const text = () => el().textContent ?? '';
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  function type(selector: string, value: string) {
    const input = q(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  async function open(status: LineStatusResult = NEW_LINE) {
    svc.lineStatus.mockResolvedValue(status);
    fixture = TestBed.createComponent(LineSignup);
    fixture.detectChanges();
    await flush();
  }
  async function submit(email = 'host@example.test', password = 'password123') {
    type('#email', email);
    type('#password', password);
    fixture.detectChanges();
    (q('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await flush();
  }
  const signsUp = (r: LineSignupResult) => svc.lineSignup.mockResolvedValue(r);

  beforeEach(() => {
    svc = { info: vi.fn().mockResolvedValue(INFO), lineStatus: vi.fn(), lineSignup: vi.fn() };
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      getAccessToken: vi.fn().mockReturnValue(ACCESS),
    };
    auth = { check: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SignupService, useValue: svc },
        { provide: LiffClient, useValue: liff },
        { provide: AuthService, useValue: auth },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  it('asks for LINE login when LIFF is not logged in, and does not read the status yet', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    await open();
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(svc.lineStatus).not.toHaveBeenCalled();
    expect(q('form')).toBeNull();
  });

  it('shows the form with the LINE name for a new LINE account', async () => {
    await open();
    expect(liff.init).toHaveBeenCalledWith('L1');
    expect(svc.lineStatus).toHaveBeenCalledWith(ACCESS);
    expect(q('[data-line-name]')?.textContent).toContain('Somchai');
    expect(q('form')).not.toBeNull();
    expect(q('[data-trial-used]')).toBeNull();
  });

  it('warns that the trial is used', async () => {
    await open({ lineDisplayName: 'Somchai', registered: false, trialAvailable: false });
    expect(q('[data-trial-used]')).not.toBeNull();
    expect(q('form')).not.toBeNull();
  });

  it('sends a registered LINE account to login instead of the form', async () => {
    await open({ lineDisplayName: 'Somchai', registered: true, trialAvailable: false });
    expect(q('form')).toBeNull();
    expect(q('[data-registered]')).not.toBeNull();
    expect(q('[data-login-link]')?.getAttribute('href')).toBe('/login');
  });

  it('on success shows the trial end and offers to add the bot when not a friend', async () => {
    await open();
    signsUp({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: false });
    await submit();
    expect(svc.lineSignup).toHaveBeenCalledWith(ACCESS, 'host@example.test', 'password123');
    expect(text()).toContain('16/12/2026');
    expect(q('[data-add-bot]')?.getAttribute('href')).toBe('https://lin.ee/bot');
  });

  it('says it started on free when no trial was given', async () => {
    await open();
    signsUp({ trialUntil: null, botFriend: true });
    await submit();
    expect(q('[data-done-free]')).not.toBeNull();
  });

  it.each([[true], [null]])('does not offer to add the bot when botFriend is %s', async (botFriend) => {
    await open();
    signsUp({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend });
    await submit();
    expect(q('[data-add-bot]')).toBeNull();
  });

  it('continue re-checks the session and goes to group creation', async () => {
    await open();
    signsUp({ trialUntil: null, botFriend: true });
    await submit();
    q('[data-continue]')!.click();
    await flush();
    expect(auth.check).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/groups/new']);
  });

  it('offers a retry when LINE does not answer, without running init twice', async () => {
    await open('unavailable');
    expect(q('[data-retry]')).not.toBeNull();
    svc.lineStatus.mockResolvedValue(NEW_LINE);
    q('[data-retry]')!.click();
    await flush();
    expect(liff.init).toHaveBeenCalledTimes(1);
    expect(q('form')).not.toBeNull();
  });

  it('says LINE sign-up is unavailable when no LIFF id is configured', async () => {
    svc.info.mockResolvedValue({ liffId: null, lineSignupUrl: null, botAddUrl: null });
    await open();
    expect(q('[data-unavailable]')).not.toBeNull();
    expect(liff.init).not.toHaveBeenCalled();
  });

  it('shows the email-taken line and keeps the form', async () => {
    await open();
    signsUp('email-taken');
    await submit();
    expect(q('[data-error]')?.textContent).toContain('อีเมลนี้มีบัญชีแล้ว');
    expect(q('form')).not.toBeNull();
  });

  it('points a host who already has a website account at the page that links LINE and starts the trial', async () => {
    await open();
    signsUp('email-taken');
    await submit();
    expect(q('[data-error] a[href="/line-share/link"]')).not.toBeNull();
  });

  it('sends a LINE account that turns out to be registered to login', async () => {
    await open();
    signsUp('line-registered');
    await submit();
    expect(q('[data-registered]')).not.toBeNull();
  });

  it('does not ask the server for a password that is too short', async () => {
    await open();
    await submit('host@example.test', 'short');
    expect(svc.lineSignup).not.toHaveBeenCalled();
    expect(q('[data-error]')?.textContent).toContain('8');
  });
});
