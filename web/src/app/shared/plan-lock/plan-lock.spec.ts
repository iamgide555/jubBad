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
    expect(text).toContain('ใช้ได้ในแพ็กเกจโฮสต์');
    expect(text).toContain('ติดต่อผู้ดูแลเพื่ออัปเกรด');
  });
});
