import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Admin } from './admin';
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

  it('shows the effective plan label on each user row', async () => {
    await setup([user({ id: 'u1', plan: 'host', effectivePlan: 'host' })]);
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('โฮสต์');
    expect(row('u1').querySelector('[data-plan-lapsed]')).toBeNull();
  });

  it('marks a lapsed plan and shows the plan it is really on', async () => {
    await setup([
      user({ plan: 'club', effectivePlan: 'free', planRenewsAt: '2026-01-31T16:59:59.999Z' }),
    ]);
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ฟรี');
    expect(row('u1').querySelector('[data-plan-lapsed]')!.textContent).toContain(
      'หมดอายุ — ใช้แบบฟรีอยู่'
    );
  });

  it('shows an admin account as having everything, with no plan to choose or save', async () => {
    await setup([user({ role: 'admin', plan: 'free', effectivePlan: 'club' })]);
    expect(row('u1').querySelector('[data-plan-lapsed]')).toBeNull();
    expect(row('u1').querySelector('select')).toBeNull();
    expect(row('u1').querySelector('[data-plan-save]')).toBeNull();
    expect(row('u1').querySelector('[data-plan-admin]')!.textContent).toContain('เข้าถึงได้ทุกอย่าง');
  });

  it('offers the three plans and saves the chosen one with no renewal date as null', async () => {
    await setup([user({})]);
    const select = row('u1').querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['free', 'host', 'club']);
    select.value = 'free';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    (row('u1').querySelector('[data-plan-save]') as HTMLButtonElement).click();
    const req = httpMock.expectOne(`${B}/admin/users/u1/plan`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ plan: 'free', renewsAt: null });
    req.flush({ id: 'u1', plan: 'free', planRenewsAt: null, effectivePlan: 'free' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(row('u1').querySelector('[data-plan-label]')!.textContent).toContain('ฟรี');
  });

  it('sends the renewal date as YYYY-MM-DD and reads a stored one back as its Bangkok date', async () => {
    // End of 31 Jan in Bangkok is 16:59:59.999Z the same day.
    await setup([user({ planRenewsAt: '2026-01-31T16:59:59.999Z' })]);
    const date = row('u1').querySelector('input[type="date"]') as HTMLInputElement;
    expect(date.value).toBe('2026-01-31');

    date.value = '2026-02-28';
    date.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    (row('u1').querySelector('[data-plan-save]') as HTMLButtonElement).click();
    const req = httpMock.expectOne(`${B}/admin/users/u1/plan`);
    expect(req.request.body).toEqual({ plan: 'club', renewsAt: '2026-02-28' });
    req.flush({
      id: 'u1',
      plan: 'club',
      planRenewsAt: '2026-02-28T16:59:59.999Z',
      effectivePlan: 'club',
    });
  });

  it('keeps the row as it was when the save fails and says so', async () => {
    await setup([user({})]);
    (row('u1').querySelector('[data-plan-save]') as HTMLButtonElement).click();
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
