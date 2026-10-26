import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Admin, addMonth } from './admin';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

const user = (over: Record<string, unknown>) => ({
  id: 'u1',
  email: 'host@example.test',
  role: 'host',
  disabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ownedGroups: [],
  plan: 'club',
  planRenewsAt: null,
  effectivePlan: 'club',
  groupLimit: 10,
  ...over,
});

describe('Admin plan control', () => {
  let fixture: ComponentFixture<Admin>;
  let component: Admin;
  let httpMock: HttpTestingController;

  async function setup(users: unknown[]) {
    await TestBed.configureTestingModule({
      imports: [Admin],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { logout: () => Promise.resolve() } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Admin);
    component = fixture.componentInstance;
    httpMock.expectOne(`${B}/admin/users`).flush(users);
    httpMock.expectOne(`${B}/admin/groups`).flush([]);
    httpMock.expectOne(`${B}/admin/reset-requests`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => httpMock.verify());

  const el = () => fixture.nativeElement as HTMLElement;
  const row = (id: string) => el().querySelector(`[data-plan-row="${id}"]`)!;
  /** The one save button: the user update goes first, then the plan when it changed. */
  const saveEditRow = async (id: string) => {
    (row(id).closest('tr')!.querySelector('[data-edit-save]') as HTMLButtonElement).click();
    httpMock.expectOne({ url: `${B}/admin/users/${id}`, method: 'PUT' }).flush({ id });
    await fixture.whenStable();
  };
  const pickPlan = async (id: string, plan: string) => {
    const select = row(id).querySelector('select') as HTMLSelectElement;
    select.value = plan;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const edit = async (id: string) => {
    (row(id).closest('tr')!.querySelector('[data-edit]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('shows the effective plan label on each user row', async () => {
    await setup([user({ id: 'u1', plan: 'host', effectivePlan: 'host' })]);
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('โฮสต์');
    expect(row('u1').querySelector('[data-plan-lapsed]')).toBeNull();
  });

  it('keeps the package controls out of the row until แก้ไข is pressed, and drops unsaved drafts on cancel', async () => {
    await setup([user({})]);
    expect(row('u1').querySelector('select')).toBeNull();
    expect(row('u1').querySelector('input[type="date"]')).toBeNull();
    expect(row('u1').querySelector('[data-plan-save]')).toBeNull();
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ก๊วนใหญ่');

    await edit('u1');
    const select = row('u1').querySelector('select') as HTMLSelectElement;
    select.value = 'free';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    (row('u1').closest('tr')!.querySelector('.ghost:not([data-edit])') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(row('u1').querySelector('select')).toBeNull();

    await edit('u1');
    expect((row('u1').querySelector('select') as HTMLSelectElement).value).toBe('club');
  });

  it('marks a lapsed plan and shows the plan it is really on', async () => {
    await setup([
      user({ plan: 'club', effectivePlan: 'free', planRenewsAt: '2026-01-31T16:59:59.999Z' }),
    ]);
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ฟรี');
    expect(row('u1').querySelector('[data-plan-lapsed]')!.textContent).toContain(
      'หมดเมื่อ 31/01/2026 — ใช้แบบฟรีอยู่'
    );
    // The date is in the lapsed line, not repeated as a "ถึง" line under it.
    expect(row('u1').querySelector('[data-plan-until]')).toBeNull();
  });

  it('shows an admin account as having everything, with no plan to choose or save', async () => {
    await setup([user({ role: 'admin', plan: 'free', effectivePlan: 'club' })]);
    expect(row('u1').querySelector('[data-plan-lapsed]')).toBeNull();
    expect(row('u1').querySelector('select')).toBeNull();
    expect(row('u1').querySelector('[data-plan-save]')).toBeNull();
    expect(row('u1').querySelector('[data-plan-admin]')!.textContent).toContain('เข้าถึงได้ทุกอย่าง');
    await edit('u1');
    expect(row('u1').querySelector('select')).toBeNull();
    expect(row('u1').querySelector('[data-plan-save]')).toBeNull();
  });

  it('offers the three plans and saves the chosen one with no renewal date as null', async () => {
    await setup([user({})]);
    await edit('u1');
    const select = row('u1').querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['free', 'host', 'club']);
    await pickPlan('u1', 'free');

    await saveEditRow('u1');
    const req = httpMock.expectOne(`${B}/admin/users/u1/plan`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ plan: 'free', renewsAt: null });
    req.flush({ id: 'u1', plan: 'free', planRenewsAt: null, effectivePlan: 'free', groupLimit: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ฟรี');
  });

  it('sends the renewal date as YYYY-MM-DD and reads a stored one back as its Bangkok date', async () => {
    // End of 31 Jan in Bangkok is 16:59:59.999Z the same day.
    await setup([user({ planRenewsAt: '2026-01-31T16:59:59.999Z' })]);
    await edit('u1');
    const date = row('u1').querySelector('input[type="date"]') as HTMLInputElement;
    expect(date.value).toBe('2026-01-31');

    date.value = '2026-02-28';
    date.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await saveEditRow('u1');
    const req = httpMock.expectOne(`${B}/admin/users/u1/plan`);
    expect(req.request.body).toEqual({ plan: 'club', renewsAt: '2026-02-28' });
    req.flush({
      id: 'u1',
      plan: 'club',
      planRenewsAt: '2026-02-28T16:59:59.999Z',
      effectivePlan: 'club',
      groupLimit: 10,
    });
  });

  describe('one save button for the whole edit row', () => {
    it('has a single save button, and no separate plan save', async () => {
      await setup([user({})]);
      await edit('u1');
      expect(row('u1').querySelector('[data-plan-save]')).toBeNull();
      expect(row('u1').closest('tr')!.querySelectorAll('[data-edit-save]').length).toBe(1);
    });

    it('saves the user, then the plan, when the plan changed', async () => {
      await setup([user({})]);
      await edit('u1');
      await pickPlan('u1', 'host');
      await saveEditRow('u1');
      const req = httpMock.expectOne(`${B}/admin/users/u1/plan`);
      expect(req.request.body).toEqual({ plan: 'host', renewsAt: null });
      req.flush({ id: 'u1', plan: 'host', planRenewsAt: null, effectivePlan: 'host', groupLimit: 3 });
    });

    it('saves only the user, never the plan, when the plan was not touched', async () => {
      await setup([user({})]);
      await edit('u1');
      await saveEditRow('u1');
      httpMock.expectNone(`${B}/admin/users/u1/plan`);
    });

    it('does not save the plan when the user update fails, and says so', async () => {
      await setup([user({})]);
      await edit('u1');
      await pickPlan('u1', 'host');
      (row('u1').closest('tr')!.querySelector('[data-edit-save]') as HTMLButtonElement).click();
      httpMock
        .expectOne({ url: `${B}/admin/users/u1`, method: 'PUT' })
        .flush({ message: 'no' }, { status: 409, statusText: 'Conflict' });
      await fixture.whenStable();
      fixture.detectChanges();
      httpMock.expectNone(`${B}/admin/users/u1/plan`);
      expect(el().querySelector('[role="alert"]')).not.toBeNull();
    });
  });

  describe('actions stay reachable on a narrow table', () => {
    it('view and edit rows keep their buttons in a sticky cell, so an iPad never has to scroll sideways to reach them', async () => {
      await setup([user({})]);
      const cell = () => row('u1').closest('tr')!.querySelector('td.actions-cell') as HTMLElement;
      expect(cell().querySelector('.admin-actions [data-edit]')).not.toBeNull();
      expect(getComputedStyle(cell()).position).toBe('sticky');
      await edit('u1');
      expect(cell().querySelector('.admin-actions [data-edit-save]')).not.toBeNull();
      expect(getComputedStyle(cell()).position).toBe('sticky');
    });
  });

  describe('+1 month', () => {
    it('addMonth: from the later of the stored date and today, one month on, clamped to month end', () => {
      expect(addMonth('2026-10-10', '2026-10-26')).toBe('2026-11-26');
      expect(addMonth('2026-11-30', '2026-10-26')).toBe('2026-12-30');
      expect(addMonth('2027-01-31', '2026-10-26')).toBe('2027-02-28');
      expect(addMonth('2028-01-31', '2026-10-26')).toBe('2028-02-29');
      expect(addMonth('', '2026-10-26')).toBe('2026-11-26');
    });

    it('the button fills the date field from the stored renewal date', async () => {
      await setup([user({ plan: 'host', effectivePlan: 'host', planRenewsAt: '2099-01-15T16:59:59.999Z' })]);
      await edit('u1');
      (row('u1').querySelector('[data-plan-add-month]') as HTMLButtonElement).click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect((row('u1').querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2099-02-15');
    });
  });

  describe('plan cell wording', () => {
    it('flags a free user who owns more groups than the plan allows', async () => {
      await setup([
        user({
          plan: 'free',
          effectivePlan: 'free',
          groupLimit: 1,
          ownedGroups: [
            { code: 'a', name: 'A' },
            { code: 'b', name: 'B' },
          ],
        }),
      ]);
      expect(row('u1').querySelector('[data-over-cap]')!.textContent).toContain('เกินโควตา 2/1');
    });

    it('does not flag a user at or under the cap, or an admin', async () => {
      await setup([
        user({ id: 'u1', plan: 'free', effectivePlan: 'free', groupLimit: 1, ownedGroups: [{ code: 'a', name: 'A' }] }),
        user({ id: 'u2', role: 'admin', groupLimit: null, ownedGroups: Array.from({ length: 12 }, (_, i) => ({ code: `g${i}`, name: null })) }),
      ]);
      expect(row('u1').querySelector('[data-over-cap]')).toBeNull();
      expect(row('u2').querySelector('[data-over-cap]')).toBeNull();
    });

    it('a free user with a stored renewal date shows no "ถึง" line', async () => {
      await setup([user({ plan: 'free', effectivePlan: 'free', planRenewsAt: '2030-12-31T16:59:59.999Z' })]);
      expect(row('u1').querySelector('[data-plan-until]')).toBeNull();
    });
  });

  describe('renewal date in view mode', () => {
    const until = (id: string) => row(id).querySelector('[data-plan-until]');

    it('shows "ถึง dd/mm/yyyy" in Bangkok under the plan for a user with a renewal date', async () => {
      await setup([user({ plan: 'host', effectivePlan: 'host', planRenewsAt: '2026-11-19T16:59:59.999Z' })]);
      expect(until('u1')!.textContent!.trim()).toBe('ถึง 19/11/2026');
      expect(until('u1')!.classList).toContain('muted');
    });

    it('shows nothing when the plan never expires', async () => {
      await setup([user({ planRenewsAt: null })]);
      expect(until('u1')).toBeNull();
    });

    it('an admin account shows no date', async () => {
      await setup([user({ role: 'admin', planRenewsAt: '2026-11-19T16:59:59.999Z' })]);
      expect(until('u1')).toBeNull();
    });

    it('is not repeated in the edit row, where the date field already holds it', async () => {
      await setup([user({ planRenewsAt: '2026-11-19T16:59:59.999Z' })]);
      await edit('u1');
      expect(until('u1')).toBeNull();
    });
  });

  describe('saved confirmation', () => {
    const saved = () => row('u1').querySelector('[data-plan-saved]');
    async function saveOk() {
      await pickPlan('u1', 'host');
      await saveEditRow('u1');
      httpMock
        .expectOne(`${B}/admin/users/u1/plan`)
        .flush({ id: 'u1', plan: 'host', planRenewsAt: null, effectivePlan: 'host', groupLimit: 3 });
      // The row closes in a continuation after the plan answers: let it run before rendering.
      await new Promise((r) => setTimeout(r));
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('says บันทึกแล้ว beside the save button after a successful save', async () => {
      await setup([user({})]);
      await edit('u1');
      expect(saved()).toBeNull();
      await saveOk();
      expect(saved()!.textContent!.trim()).toBe('บันทึกแล้ว');
    });

    it('clears once the row is edited again', async () => {
      await setup([user({})]);
      await edit('u1');
      await saveOk();
      await edit('u1');
      await pickPlan('u1', 'free');
      expect(saved()).toBeNull();
    });

    it('clears when the row is opened again and cancelled', async () => {
      await setup([user({})]);
      await edit('u1');
      await saveOk();
      expect(saved()).not.toBeNull();
      await edit('u1');
      (row('u1').closest('tr')!.querySelector('.ghost:not([data-edit])') as HTMLButtonElement).click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(saved()).toBeNull();
    });

    it('does not show after a failed save', async () => {
      await setup([user({})]);
      await edit('u1');
      await pickPlan('u1', 'host');
      await saveEditRow('u1');
      httpMock.expectOne(`${B}/admin/users/u1/plan`).flush({ message: 'no' }, { status: 400, statusText: 'Bad Request' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(saved()).toBeNull();
    });
  });

  it('keeps the row as it was when the save fails and says so', async () => {
    await setup([user({})]);
    await edit('u1');
    await pickPlan('u1', 'free');
    await saveEditRow('u1');
    httpMock
      .expectOne(`${B}/admin/users/u1/plan`)
      .flush({ message: 'no' }, { status: 400, statusText: 'Bad Request' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(row('u1').querySelector('[role="alert"]')).not.toBeNull();
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ก๊วนใหญ่');
    expect(component.users()[0].plan).toBe('club');
  });
});
