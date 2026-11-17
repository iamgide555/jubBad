import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { LiffClient } from '../../core/liff-client';
import type { LineLinkResult, LineStatusResult } from '../../core/signup.service';
import { SignupService } from '../../core/signup.service';
import { LineLink } from './line-link';

const ACCESS = 'line-access-token-ABC';
const NEW_LINE: LineStatusResult = { lineDisplayName: 'Somchai', registered: false, trialAvailable: true };

describe('LineLink', () => {
  let fixture: ComponentFixture<LineLink>;
  let svc: { info: ReturnType<typeof vi.fn>; lineStatus: ReturnType<typeof vi.fn>; lineLink: ReturnType<typeof vi.fn> };
  let liff: { init: ReturnType<typeof vi.fn>; isLoggedIn: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn>; getAccessToken: ReturnType<typeof vi.fn> };
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
    fixture = TestBed.createComponent(LineLink);
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
  const links = (r: LineLinkResult) => svc.lineLink.mockResolvedValue(r);

  beforeEach(() => {
    sessionStorage.clear();
    svc = {
      info: vi.fn().mockResolvedValue({ liffId: 'L1', lineSignupUrl: null, botAddUrl: 'https://lin.ee/bot', contactUrl: null }),
      lineStatus: vi.fn(),
      lineLink: vi.fn(),
    };
    liff = {
      init: vi.fn().mockResolvedValue(undefined),
      isLoggedIn: vi.fn().mockReturnValue(true),
      login: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn().mockReturnValue(ACCESS),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SignupService, useValue: svc },
        { provide: LiffClient, useValue: liff },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  it('shows the form with the LINE name', async () => {
    await open();
    expect(q('[data-line-name]')?.textContent).toContain('Somchai');
    expect(q('form')).not.toBeNull();
  });

  it('asks for LINE login first when LIFF is not logged in', async () => {
    liff.isLoggedIn.mockReturnValue(false);
    await open();
    expect(liff.login).toHaveBeenCalledTimes(1);
    expect(q('form')).toBeNull();
  });

  it('says a LINE account that is already linked is linked, with a login button', async () => {
    await open({ lineDisplayName: 'Somchai', registered: true, trialAvailable: false });
    expect(q('form')).toBeNull();
    expect(q('[data-already-linked]')).not.toBeNull();
    expect(q('[data-login-link]')?.getAttribute('href')).toBe('/login');
  });

  it('links and shows the trial end', async () => {
    await open();
    links({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: true });
    await submit();
    expect(svc.lineLink).toHaveBeenCalledWith(ACCESS, 'host@example.test', 'password123');
    expect(q('[data-done]')).not.toBeNull();
    expect(text()).toContain('16/12/2026');
  });

  it('links and shows no trial line when none started', async () => {
    await open();
    links({ trialUntil: null, botFriend: true });
    await submit();
    expect(q('[data-done]')).not.toBeNull();
    expect(q('[data-trial]')).toBeNull();
  });

  it('shows the wrong-password line and keeps the form', async () => {
    await open();
    links('bad-credentials');
    await submit();
    expect(q('[data-error]')?.textContent).toContain('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    expect(q('form')).not.toBeNull();
  });

  it.each([
    ['account-linked', 'ผูกกับ LINE อื่นอยู่แล้ว'],
    ['line-linked', 'ผูกกับบัญชี JubBad อื่นอยู่แล้ว'],
    ['rate', 'ลองมากเกินไป'],
  ] as const)('says %s', async (result, line) => {
    await open();
    links(result);
    await submit();
    expect(q('[data-error]')?.textContent).toContain(line);
  });

  it('never navigates: the page signs no one in', async () => {
    await open();
    links({ trialUntil: null, botFriend: true });
    await submit();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers a retry when LINE does not answer', async () => {
    await open('unavailable' as LineStatusResult);
    expect(q('[data-retry]')).not.toBeNull();
  });

  it('warns before submitting when this LINE account has already had its trial', async () => {
    await open({ lineDisplayName: 'Somchai', registered: false, trialAvailable: false });
    expect(q('[data-trial-used]')).not.toBeNull();
    expect(q('form')).not.toBeNull();
  });

  it('says nothing about a trial when the LINE account can still earn one', async () => {
    await open();
    expect(q('[data-trial-used]')).toBeNull();
  });

  it('asks a LINE account that is not a friend of the bot to add it, once linked', async () => {
    await open();
    links({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: false });
    await submit();
    expect(q('[data-add-bot]')?.getAttribute('href')).toBe('https://lin.ee/bot');
  });

  it('does not ask a friend, or an unknown, to add the bot', async () => {
    await open();
    links({ trialUntil: null, botFriend: null });
    await submit();
    expect(q('[data-add-bot]')).toBeNull();
  });

  it('only promises roster-by-chat when a trial just started, and says what is needed otherwise', async () => {
    await open();
    links({ trialUntil: '2026-12-16T16:59:59.999Z', botFriend: true });
    await submit();
    expect(q('[data-how-to]')).not.toBeNull();
    expect(q('[data-needs-host-plan]')).toBeNull();
  });

  it('with no trial, says sending rosters by chat needs the Host plan', async () => {
    await open();
    links({ trialUntil: null, botFriend: true });
    await submit();
    expect(q('[data-how-to]')).toBeNull();
    expect(q('[data-needs-host-plan]')).not.toBeNull();
  });

  it('sends a refused LINE token through LINE login again', async () => {
    await open('unauthorized' as LineStatusResult);
    expect(liff.logout).toHaveBeenCalledTimes(1);
    expect(liff.login).toHaveBeenCalledTimes(1);
  });

  it('is not a dead end when LINE sign-in is not set up', async () => {
    svc.info.mockResolvedValue({ liffId: null, lineSignupUrl: null, botAddUrl: null, contactUrl: null });
    await open();
    expect(q('[data-unavailable]')).not.toBeNull();
    expect(q('[data-home-link]')?.getAttribute('href')).toBe('/');
  });

  it('shows no empty "LINE account:" line when LINE gave no name', async () => {
    await open({ lineDisplayName: null, registered: false, trialAvailable: true });
    expect(q('[data-line-name]')).toBeNull();
  });

  it('shows what is accepted by linking, with a link to the privacy page', async () => {
    await open();
    expect(q('[data-consent] a')?.getAttribute('href')).toBe('/privacy');
  });
});

