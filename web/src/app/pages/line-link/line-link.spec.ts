import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { LiffClient } from '../../core/liff-client';
import type { LineLinkResult, LineStatusResult } from '../../core/signup.service';
import { SignupService } from '../../core/signup.service';
import { LineLink } from './line-link';

const ACCESS = 'line-access-token-ABC';
const NEW_LINE: LineStatusResult = { lineDisplayName: 'Somchai', registered: false, trialAvailable: true };

describe('LineLink', () => {
  let fixture: ComponentFixture<LineLink>;
  let svc: { info: ReturnType<typeof vi.fn>; lineStatus: ReturnType<typeof vi.fn>; lineLink: ReturnType<typeof vi.fn> };
  let liff: { init: ReturnType<typeof vi.fn>; isLoggedIn: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn>; getAccessToken: ReturnType<typeof vi.fn> };
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
    svc = {
      info: vi.fn().mockResolvedValue({ liffId: 'L1', lineSignupUrl: null, botAddUrl: null }),
      lineStatus: vi.fn(),
      lineLink: vi.fn(),
    };
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
    links({ trialUntil: '2026-12-16T16:59:59.999Z' });
    await submit();
    expect(svc.lineLink).toHaveBeenCalledWith(ACCESS, 'host@example.test', 'password123');
    expect(q('[data-done]')).not.toBeNull();
    expect(text()).toContain('16/12/2026');
  });

  it('links and shows no trial line when none started', async () => {
    await open();
    links({ trialUntil: null });
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

  it('never navigates and never calls auth.check: the page did not sign the browser in', async () => {
    await open();
    links({ trialUntil: null });
    await submit();
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.check).not.toHaveBeenCalled();
  });

  it('offers a retry when LINE does not answer', async () => {
    await open('unavailable' as LineStatusResult);
    expect(q('[data-retry]')).not.toBeNull();
  });
});
