import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import type { RegisterResult, SignupInfo } from '../../core/signup.service';
import { SignupService } from '../../core/signup.service';
import { SceneHost } from '../../core/three/scene-host';
import { Signup } from './signup';

@Component({ selector: 'app-scene-host', template: '' })
class SceneHostStub {}

const INFO_ON: SignupInfo = { liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: null, contactUrl: null };
const INFO_OFF: SignupInfo = { liffId: null, lineSignupUrl: null, botAddUrl: null, contactUrl: null };

describe('Signup', () => {
  let fixture: ComponentFixture<Signup>;
  let svc: { info: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn> };
  let auth: { check: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.spyOn>;

  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };

  function type(selector: string, value: string) {
    const input = q(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function open(info: SignupInfo | 'fails' = INFO_ON) {
    svc.info.mockImplementation(() => (info === 'fails' ? Promise.reject(new Error('down')) : Promise.resolve(info)));
    fixture = TestBed.createComponent(Signup);
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

  const registers = (result: RegisterResult) => svc.register.mockResolvedValue(result);

  beforeEach(() => {
    svc = { info: vi.fn(), register: vi.fn() };
    auth = { check: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SignupService, useValue: svc },
        { provide: AuthService, useValue: auth },
      ],
    });
    // The 3D hero needs a canvas; the form is what is under test.
    TestBed.overrideComponent(Signup, { remove: { imports: [SceneHost] }, add: { imports: [SceneHostStub] } });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  it('registers and goes to group creation', async () => {
    await open();
    registers('ok');
    await submit('host@example.test', 'password123');
    expect(svc.register).toHaveBeenCalledWith('host@example.test', 'password123', '');
    expect(auth.check).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/groups/new'], { replaceUrl: true });
  });

  it('sends whatever is in the trap field', async () => {
    await open();
    registers('ok');
    type('[data-trap]', 'http://spam');
    await submit();
    expect(svc.register).toHaveBeenCalledWith('host@example.test', 'password123', 'http://spam');
  });

  it('keeps the trap out of reach of people: hidden from view, focus and screen readers', async () => {
    await open();
    const trap = q('[data-trap]') as HTMLInputElement;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute('autocomplete')).toBe('off');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says the email is taken and offers login', async () => {
    await open();
    registers('email-taken');
    await submit();
    expect(q('[data-error]')?.textContent).toContain('อีเมลนี้มีบัญชีแล้ว');
    expect(q('[data-error] a')?.getAttribute('href')).toBe('/login');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not ask the server for a password that is too short', async () => {
    await open();
    await submit('host@example.test', 'short');
    expect(svc.register).not.toHaveBeenCalled();
    expect(q('[data-error]')?.textContent).toContain('8');
  });

  it.each([
    ['rate', 'ลองมากเกินไป'],
    ['invalid', 'ตรวจอีเมลและรหัสผ่านอีกครั้ง'],
    ['error', 'สมัครไม่สำเร็จ'],
  ] as const)('shows a calm line for %s', async (result, text) => {
    await open();
    registers(result);
    await submit();
    expect(q('[data-error]')?.textContent).toContain(text);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the LINE option only when the server offers a link', async () => {
    await open(INFO_ON);
    expect(q('[data-via-line]')?.getAttribute('href')).toBe('https://liff.line.me/L1/signup');
    await open(INFO_OFF);
    expect(q('[data-via-line]')).toBeNull();
    await open('fails');
    expect(q('[data-via-line]')).toBeNull();
    expect(q('form')).not.toBeNull();
  });

  it('disables the button while sending, so a double tap sends once', async () => {
    await open();
    let resolve!: (r: RegisterResult) => void;
    svc.register.mockReturnValue(new Promise<RegisterResult>((r) => (resolve = r)));
    type('#email', 'host@example.test');
    type('#password', 'password123');
    fixture.detectChanges();
    const form = q('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect((q('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    resolve('ok');
    await flush();
    expect(svc.register).toHaveBeenCalledTimes(1);
  });

  it('links to login', async () => {
    await open();
    expect(q('[data-login-link]')?.getAttribute('href')).toBe('/login');
  });

  it('shows the password rule before anything is submitted', async () => {
    await open();
    expect(q('[data-password-hint]')?.textContent).toContain('8');
    expect((q('#password') as HTMLInputElement).getAttribute('minlength')).toBe('8');
  });

  it('keeps what was typed after an error, so a typo is fixed, not retyped', async () => {
    await open();
    registers('email-taken');
    await submit('host@example.test', 'password123');
    expect((q('#password') as HTMLInputElement).value).toBe('password123');
    expect((q('#email') as HTMLInputElement).value).toBe('host@example.test');
  });

  it('clears the error as soon as the person edits a field', async () => {
    await open();
    registers('email-taken');
    await submit();
    expect(q('[data-error]')).not.toBeNull();
    type('#email', 'other@example.test');
    fixture.detectChanges();
    expect(q('[data-error]')).toBeNull();
  });

  it('moves focus to the field that needs fixing', async () => {
    await open();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    registers('email-taken');
    await submit();
    expect((focus.mock.contexts.at(-1) as HTMLElement).id).toBe('email');
    await submit('host@example.test', 'short');
    expect((focus.mock.contexts.at(-1) as HTMLElement).id).toBe('password');
    focus.mockRestore();
  });

  it('marks the field that has the problem and ties the error to the form for screen readers', async () => {
    await open();
    await submit('host@example.test', 'short');
    expect(q('#password')?.getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-error]')?.id).toBeTruthy();
    expect(q('#password')?.getAttribute('aria-describedby')).toContain(q('[data-error]')!.id);
  });

  it('tells the person what they accept by signing up, with a link to the privacy page', async () => {
    await open();
    expect(q('[data-consent] a')?.getAttribute('href')).toBe('/privacy');
  });

  it('does not make the form carry the "link LINE later" note: that is for after sign-up', async () => {
    await open();
    expect(q('[data-recovery-note]')).toBeNull();
  });

  it('opens with what JubBad does, not just "sign up": a promise headline and three benefits', async () => {
    await open();
    // The invisible word joiners keep the phrase from breaking mid-idea; the words themselves are what is read.
    expect(q('h1')?.textContent?.replace(/\u2060/g, '')).toContain('ไม่ต้องคิดคู่เอง');
    expect(el().querySelectorAll('[data-benefit]').length).toBe(3);
    expect(q('app-scene-host')).not.toBeNull();
  });

  it('puts the LINE door first, as a button that names the trial, then the email form', async () => {
    await open(INFO_ON);
    const line = q('[data-via-line]')!;
    expect(line.textContent).toContain('30 วัน');
    expect(line.getAttribute('href')).toBe('https://liff.line.me/L1/signup');
    const form = q('form')!;
    expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('[data-or-email]')).not.toBeNull();
  });

  it('has no divider and no LINE button when LINE sign-up is not offered', async () => {
    await open(INFO_OFF);
    expect(q('[data-via-line]')).toBeNull();
    expect(q('[data-or-email]')).toBeNull();
  });

  it('keeps the submit disabled until the email is filled and the password is long enough', async () => {
    await open();
    const submit = () => q('button[type="submit"]') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    type('#email', 'host@example.test');
    type('#password', 'short');
    fixture.detectChanges();
    expect(submit().disabled).toBe(true);
    type('#password', 'long enough');
    fixture.detectChanges();
    expect(submit().disabled).toBe(false);
  });

  it('turns the hint into the problem as soon as a too-short password is typed, not after a failed submit', async () => {
    await open();
    type('#password', 'abc');
    fixture.detectChanges();
    expect(q('[data-password-hint]')?.classList.contains('invalid')).toBe(true);
    expect(q('#password')?.getAttribute('aria-invalid')).toBe('true');
    type('#password', 'long enough');
    fixture.detectChanges();
    expect(q('[data-password-hint]')?.classList.contains('invalid')).toBe(false);
  });

  it('puts the login link in a small footer, below the consent line', async () => {
    await open();
    const login = q('[data-login-link]')!;
    const consent = q('[data-consent]')!;
    expect(consent.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the email-taken recovery as its own tappable line, not a link inside the sentence', async () => {
    await open();
    registers('email-taken');
    await submit();
    const link = q('[data-error] a[href="/login"]')!;
    expect(link.closest('[data-error-action]')).not.toBeNull();
  });
});

