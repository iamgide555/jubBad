import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';
import { PlanLock } from './plan-lock';

describe('PlanLock', () => {
  let fixture: ComponentFixture<PlanLock>;
  const open = vi.fn();
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    open.mockClear();
    TestBed.configureTestingModule({ providers: [{ provide: UpgradeSheetService, useValue: { open } }] });
    fixture = TestBed.createComponent(PlanLock);
    fixture.detectChanges();
  });

  it('renders the default hint on one line, with no separate upgrade sub-line', () => {
    expect(el().querySelector('.lock-hint')?.textContent?.trim()).toBe('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(el().querySelector('.lock-sub')).toBeNull();
    expect(el().textContent).not.toContain('ติดต่อผู้ดูแล');
  });

  it('a hint input replaces the hint line', () => {
    fixture.componentRef.setInput('hint', 'โหมดสูสีและตามระดับใช้ได้ในแพ็ก⁠เกจโฮสต์');
    fixture.detectChanges();
    expect(el().querySelector('.lock-hint')?.textContent?.trim()).toBe('โหมดสูสีและตามระดับใช้ได้ในแพ็ก⁠เกจโฮสต์');
    expect(el().querySelectorAll('.lock-hint').length).toBe(1);
  });

  it('a null hint keeps the default line', () => {
    fixture.componentRef.setInput('hint', null);
    fixture.detectChanges();
    expect(el().querySelector('.lock-hint')?.textContent?.trim()).toBe('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
  });

  it('tapping ดูแพ็กเกจ opens the upgrade sheet', () => {
    (el().querySelector('button.lock-more') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
