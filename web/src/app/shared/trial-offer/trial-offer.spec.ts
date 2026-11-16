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
});
