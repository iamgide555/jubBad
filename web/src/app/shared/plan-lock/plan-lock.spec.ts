import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PlanLock } from './plan-lock';

describe('PlanLock', () => {
  let fixture: ComponentFixture<PlanLock>;

  beforeEach(() => {
    fixture = TestBed.createComponent(PlanLock);
    fixture.detectChanges();
  });

  it('renders the hint and the upgrade sub-line', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(text).toContain('ติดต่อผู้ดูแลเพื่ออัปเกรด');
  });

  it('a hint input replaces the first line only; the upgrade sub-line stays', () => {
    fixture.componentRef.setInput('hint', 'โหมดสูสีและตามระดับใช้ได้ในแพ็ก⁠เกจโฮสต์');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.lock-hint')?.textContent?.trim()).toBe('โหมดสูสีและตามระดับใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(el.querySelectorAll('.lock-hint').length).toBe(1);
    expect(el.querySelector('.lock-sub')?.textContent).toContain('ติดต่อผู้ดูแลเพื่ออัปเกรด');
  });

  it('a null hint keeps the default first line', () => {
    fixture.componentRef.setInput('hint', null);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.lock-hint')?.textContent?.trim()).toBe('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
  });
});
