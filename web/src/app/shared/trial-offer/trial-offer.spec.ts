import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TrialOffer } from './trial-offer';

describe('TrialOffer', () => {
  let fixture: ComponentFixture<TrialOffer>;

  beforeEach(() => {
    fixture = TestBed.createComponent(TrialOffer);
    fixture.componentRef.setInput('linkUrl', 'https://liff.line.me/L1/link');
    fixture.detectChanges();
  });

  it('offers the 30-day trial for linking LINE', () => {
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ทดลองใช้ครบทุกฟีเจอร์ฟรี 30 วัน');
  });

  it('links to the given URL', () => {
    const a = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('[data-trial-link]')!;
    expect(a.getAttribute('href')).toBe('https://liff.line.me/L1/link');
    expect(a.rel).toContain('noopener');
  });

  it('says what "every feature" includes, in one line', () => {
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-trial-includes]')?.textContent).toContain('ดูย้อนหลัง');
  });

  it('names the outcome on the button, not just the mechanism', () => {
    const text = (fixture.nativeElement as HTMLElement).querySelector('[data-trial-link]')?.textContent ?? '';
    expect(text).toContain('เริ่มทดลอง');
  });

  it('carries the recovery benefit that used to sit on the sign-up form', () => {
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-trial-recovery]')?.textContent).toContain('รหัสผ่าน');
  });
});

