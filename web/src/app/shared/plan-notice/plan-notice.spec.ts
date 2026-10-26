import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { GroupPlan } from '../../core/plan';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';
import { PlanNotice } from './plan-notice';

const DAY = 24 * 3600 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const base: GroupPlan = { plan: 'free', renewsAt: null, lapsedAt: null, paused: false, archiveHidden: 0 };

describe('PlanNotice', () => {
  let fixture: ComponentFixture<PlanNotice>;
  const open = vi.fn();
  const el = () => fixture.nativeElement as HTMLElement;
  const line = () => el().querySelector('[data-plan-notice]');

  function render(plan: GroupPlan | null) {
    fixture.componentRef.setInput('plan', plan);
    fixture.detectChanges();
  }

  beforeEach(() => {
    open.mockClear();
    TestBed.configureTestingModule({ providers: [{ provide: UpgradeSheetService, useValue: { open } }] });
    fixture = TestBed.createComponent(PlanNotice);
  });

  it('renders nothing for an unknown plan', () => {
    render(null);
    expect(line()).toBeNull();
  });

  it('renders nothing for a plan with plenty of time left', () => {
    render({ ...base, plan: 'host', renewsAt: inDays(10) });
    expect(line()).toBeNull();
  });

  it('says the plan is ending, with the Bangkok date, when 3 days remain', () => {
    const renewsAt = inDays(3);
    render({ ...base, plan: 'host', renewsAt });
    expect(line()?.textContent).toContain('แพ็ก⁠เกจโฮสต์หมด');
    expect(line()?.getAttribute('data-plan-notice')).toBe('expiring');
  });

  it('says new rounds use the free plan after a lapse', () => {
    render({ ...base, renewsAt: '2026-10-10T16:59:59.999Z', lapsedAt: '2026-10-10T16:59:59.999Z' });
    expect(line()?.getAttribute('data-plan-notice')).toBe('lapsed');
    expect(line()?.textContent).toContain('แพ็ก⁠เกจโฮสต์หมดเมื่อ 10/10/2026');
    expect(line()?.textContent).toContain('รอบใหม่ใช้แบบฟรี');
  });

  it('a paused group says so, naming the cap, and takes precedence over a lapse', () => {
    render({ ...base, paused: true, lapsedAt: '2026-10-10T16:59:59.999Z' });
    expect(line()?.getAttribute('data-plan-notice')).toBe('paused');
    expect(line()?.textContent).toContain('ก๊วนนี้พักไว้');
    expect(line()?.textContent).toContain('1 ก๊วน');
  });

  it('the button opens the upgrade sheet: ต่ออายุ for a lapse or expiry, ดูแพ็กเกจ when paused', () => {
    render({ ...base, plan: 'host', renewsAt: inDays(2) });
    const btn = () => el().querySelector('button') as HTMLButtonElement;
    expect(btn().textContent?.trim()).toBe('ต่ออายุ');
    btn().click();
    expect(open).toHaveBeenCalledTimes(1);
    render({ ...base, paused: true });
    expect(btn().textContent?.trim()).toBe('ดูแพ็ก⁠เกจ');
  });
});
