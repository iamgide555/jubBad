import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SignupService, type SignupInfo } from '../../core/signup.service';
import { Privacy } from './privacy';

const INFO: SignupInfo = { liffId: null, lineSignupUrl: null, botAddUrl: null, contactUrl: null };

describe('Privacy', () => {
  let fixture: ComponentFixture<Privacy>;
  let info: ReturnType<typeof vi.fn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };

  async function open(reply: Promise<SignupInfo>) {
    info.mockReturnValue(reply);
    fixture = TestBed.createComponent(Privacy);
    fixture.detectChanges();
    await flush();
  }

  beforeEach(() => {
    info = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SignupService, useValue: { info } }],
    });
  });

  it('says what is collected, including the LINE id kept to stop repeat trials', async () => {
    await open(Promise.resolve(INFO));
    const collected = q('[data-collected]')!.textContent!;
    expect(collected).toContain('อีเมล');
    expect(collected).toContain('LINE');
    expect(collected).toContain('สลิป');
  });

  it('says who can see it, how long, and how to ask for deletion', async () => {
    await open(Promise.resolve(INFO));
    expect(q('[data-visible]')).not.toBeNull();
    expect(q('[data-retention]')).not.toBeNull();
    expect(q('[data-rights]')).not.toBeNull();
  });

  it('links to the operator when the server has a contact link', async () => {
    await open(Promise.resolve({ ...INFO, contactUrl: 'https://line.me/ti/p/abc' }));
    const link = q('[data-contact] a');
    expect(link?.getAttribute('href')).toBe('https://line.me/ti/p/abc');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('still tells the reader how to be reached when there is no contact link', async () => {
    await open(Promise.resolve(INFO));
    expect(q('[data-contact] a')).toBeNull();
    expect(q('[data-contact]')?.textContent).toContain('ผู้ดูแล');
  });

  it('is readable when the sign-up info cannot be loaded', async () => {
    await open(Promise.reject(new Error('offline')));
    expect(q('[data-collected]')).not.toBeNull();
    expect(q('[data-contact] a')).toBeNull();
  });

  it('has a way back to sign up', async () => {
    await open(Promise.resolve(INFO));
    expect(q('[data-back-link]')?.getAttribute('href')).toBe('/signup');
  });
});
