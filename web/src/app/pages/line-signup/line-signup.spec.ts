import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LiffClient } from '../../core/liff-client';
import type { LineSignupResult, LineStatusResult, SignupInfo } from '../../core/signup.service';
import { SignupService } from '../../core/signup.service';
import { LineSignup } from './line-signup';

const ACCESS = 'line-access-token-ABC';
const INFO: SignupInfo = { liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: 'https://lin.ee/bot', contactUrl: null };
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
    logout: ReturnType<typeof vi.fn>;
    getAccessToken: ReturnType<typeof vi.fn>;
  };
  let auth: { check: ReturnType<typeof vi.fn>; email: ReturnType<typeof signal<string | null>> };
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
    sessionStorage.clear();
    svc = { info: vi.fn().mockResolvedValue(INFO), lineStatus: vi.fn(), lineSignup: vi.fn() };
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn().mockReturnValue(ACCESS),
    };
    auth = { check: vi.fn().mockResolvedValue(false), email: signal<string | null>(null) };
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
    expect(navigate).toHaveBeenCalledWith(['/groups/new'], { replaceUrl: true });
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
    svc.info.mockResolvedValue({ liffId: null, lineSignupUrl: null, botAddUrl: null, contactUrl: null });
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

  it('reads the sign-up info once for the whole page', async () => {
    await open();
    expect(svc.info).toHaveBeenCalledTimes(1);
  });

  it('sends a refused LINE token through LINE login again instead of repeating the same failure', async () => {
    await open('unauthorized' as LineStatusResult);
    expect(liff.logout).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(q('[data-retry]')).toBeNull();
  });

  it('shows an error with a retry, not another redirect, when a restart just happened and the token is refused again', async () => {
    sessionStorage.setItem('jubbad.line.restartedAt', String(Date.now()));
    await open('unauthorized' as LineStatusResult);
    expect(liff.logout).not.toHaveBeenCalled();
    expect(q('[data-retry]')).not.toBeNull();
  });

  it('does the same when the token is refused on submit', async () => {
    await open();
    signsUp('unauthorized');
    await submit();
    expect(liff.logout).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledTimes(1);
  });

  it('does not sign someone up a second time: a signed-in host is told so and offered the link page', async () => {
    auth.check.mockResolvedValue(true);
    auth.email.set('host@example.test');
    await open();
    expect(q('[data-signed-in]')?.textContent).toContain('host@example.test');
    expect(q('[data-signed-in] a[href="/line-share/link"]')).not.toBeNull();
    expect(q('form')).toBeNull();
    expect(svc.lineStatus).not.toHaveBeenCalled();
  });

  it('shows the password rule up front and keeps what was typed after an error', async () => {
    await open();
    expect(q('[data-password-hint]')?.textContent).toContain('8');
    signsUp('email-taken');
    await submit('host@example.test', 'password123');
    expect((q('#password') as HTMLInputElement).value).toBe('password123');
  });

  it('shows no empty "LINE account:" line when LINE gave no name', async () => {
    await open({ lineDisplayName: null, registered: false, trialAvailable: true });
    expect(q('[data-line-name]')).toBeNull();
  });

  it('tells a new host the app login is separate from LINE, so they sign in with their email elsewhere', async () => {
    await open();
    signsUp({ trialUntil: null, botFriend: true });
    await submit();
    expect(q('[data-other-devices]')).not.toBeNull();
  });

  it('shows what is accepted by signing up, with a link to the privacy page', async () => {
    await open();
    expect(q('[data-consent] a')?.getAttribute('href')).toBe('/privacy');
  });

  it('shows every waiting or failed state in one status block, with a spinner only while something is happening', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    await open();
    expect(q('[data-status]')).not.toBeNull();
    expect(q('[data-status] app-icon')).not.toBeNull();
    expect(q('[data-status] [data-retry]')).toBeNull();
  });

  it('puts the retry button inside that same block when LINE did not answer', async () => {
    await open('unavailable' as LineStatusResult);
    expect(q('[data-status] [data-retry]')).not.toBeNull();
    expect(q('[data-status] app-icon')).toBeNull();
  });

  it('leads the done screen with the main next step, and keeps the notes below it', async () => {
    await open();
    signsUp({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: false });
    await submit();
    const next = q('[data-continue]')!;
    for (const later of ['[data-other-devices]', '[data-add-bot]']) {
      expect(next.compareDocumentPosition(q(later)!) & Node.DOCUMENT_POSITION_FOLLOWING, later).toBeTruthy();
    }
  });

  it('tells a signed-in host who they are signed in as and gives them a button, not a link in a sentence', async () => {
    auth.check.mockResolvedValue(true);
    auth.email.set('host@example.test');
    await open();
    expect(q('[data-signed-in-email]')?.textContent).toContain('host@example.test');
    expect(q('[data-signed-in] a.button[href="/line-share/link"]')).not.toBeNull();
  });

  it('keeps the submit disabled until the password is long enough, and says so as it is typed', async () => {
    await open();
    const submit_ = () => q('button[type="submit"]') as HTMLButtonElement;
    type('#email', 'host@example.test');
    type('#password', 'abc');
    fixture.detectChanges();
    expect(submit_().disabled).toBe(true);
    expect(q('[data-password-hint]')?.classList.contains('invalid')).toBe(true);
    type('#password', 'long enough');
    fixture.detectChanges();
    expect(submit_().disabled).toBe(false);
  });

  it('is a main landmark', async () => {
    await open();
    expect(q('main.line-signup')).not.toBeNull();
  });
});
