import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { GroupCreate } from './group-create';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import { stubPlanService } from '../../core/plan.testing';

const B = environment.apiBaseUrl;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The caller's own list: one group of theirs, and (as an admin sees it) one of another host's. */
const OWN = [
  { code: 'existing1', name: 'ก๊วน อังคารเดิม' },
  { code: 'other1', name: 'ของคนอื่น', mine: false },
];

describe('GroupCreate', () => {
  let fixture: ComponentFixture<GroupCreate>;
  let component: GroupCreate;
  let httpMock: HttpTestingController;
  let plan: ReturnType<typeof stubPlanService>;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    plan = stubPlanService();
    await TestBed.configureTestingModule({
      imports: [GroupCreate],
      providers: [
        plan.provider,
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(GroupCreate);
    component = fixture.componentInstance;
    // The constructor reads the host's own groups for the same-name warning.
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush(OWN);
    await fixture.whenStable();
  });

  afterEach(() => httpMock.verify());

  const el = () => fixture.nativeElement as HTMLElement;

  it('warns once about a name the host already uses, links to it, and creates on a second submit', async () => {
    component.name.set('  ก๊วน  อังคารเดิม ');
    await component.submit();
    fixture.detectChanges();
    httpMock.expectNone({ url: `${B}/groups`, method: 'POST' });
    const note = el().querySelector('[data-duplicate]')!;
    expect(note.textContent).toContain('คุณมีก๊วนชื่อนี้อยู่แล้ว');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/g/existing1');

    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ก๊วน อังคารเดิม' });
    await done;
  });

  it('editing the name clears the same-name note', async () => {
    component.name.set('ก๊วน อังคารเดิม');
    await component.submit();
    expect(component.duplicateOf()).not.toBeNull();
    component.onNameChange('ก๊วนอังคารใหม่');
    expect(component.duplicateOf()).toBeNull();
  });

  it("never warns about another host's group with the same name", async () => {
    component.name.set('ของคนอื่น');
    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ของคนอื่น' });
    await done;
    expect(component.duplicateOf()).toBeNull();
  });

  it('offers a way back to the group list before anything is created', () => {
    const back = [...el().querySelectorAll('a')].find((a) => a.getAttribute('href') === '/');
    expect(back).toBeTruthy();
  });

  it('starts with an empty name field and a placeholder example', () => {
    const input = el().querySelector<HTMLInputElement>('#group-name')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('ก๊วนอังคาร');
  });

  it('shows an inline alert and sends nothing for a whitespace-only name', async () => {
    component.name.set('   ');
    await component.submit();
    fixture.detectChanges();
    const alert = el().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('กรุณาใส่ชื่อก๊วนก่อน');
    httpMock.expectNone(`${B}/groups`);
  });

  it('creates the group with a trimmed name and a full UUID, then opens it', async () => {
    component.name.set('  ก๊วนอังคาร  ');
    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    expect(req.request.body.name).toBe('ก๊วนอังคาร');
    expect(req.request.body.code).toMatch(UUID);
    expect(navigate).not.toHaveBeenCalled();
    req.flush({ code: req.request.body.code, name: 'ก๊วนอังคาร' });
    await done;
    expect(navigate).toHaveBeenCalledWith(`/g/${req.request.body.code}`, { replaceUrl: true });
  });

  it('disables the button and says it is creating while the request is in flight', async () => {
    component.name.set('ก๊วนอังคาร');
    const done = component.submit();
    fixture.detectChanges();
    const button = el().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('กำลังสร้างก๊วน...');
    await component.submit(); // a second tap while busy sends nothing
    const req = httpMock.expectOne(`${B}/groups`);
    req.flush({ code: req.request.body.code, name: 'ก๊วนอังคาร' });
    await done;
  });

  it('keeps the name and reuses the same code when a retry follows a network failure', async () => {
    component.name.set('ก๊วนอังคาร');
    const first = component.submit();
    const failed = httpMock.expectOne(`${B}/groups`);
    const code = failed.request.body.code;
    failed.error(new ProgressEvent('error'), { status: 0, statusText: 'Network' });
    await first;
    fixture.detectChanges();
    expect(component.name()).toBe('ก๊วนอังคาร');
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('สร้างก๊วนไม่สำเร็จ');

    const second = component.submit();
    const retry = httpMock.expectOne(`${B}/groups`);
    expect(retry.request.body.code).toBe(code);
    retry.flush({ code, name: 'ก๊วนอังคาร' });
    await second;
  });

  it('says the plan allows no more groups, with the limit, when creation is refused with GROUP_LIMIT', async () => {
    component.name.set('ก๊วนอังคาร');
    const done = component.submit();
    httpMock
      .expectOne({ url: `${B}/groups`, method: 'POST' })
      .flush({ code: 'GROUP_LIMIT', limit: 1 }, { status: 403, statusText: 'Forbidden' });
    await done;
    fixture.detectChanges();
    // A plan limit is information, not the host's mistake: a calm notice, never the error alert.
    expect(el().querySelector('[role="alert"]')).toBeNull();
    const notice = el().querySelector('.notice')?.textContent ?? '';
    expect(notice).toContain('สร้างได้ 1 ก๊วน');
    expect(notice).not.toContain('สร้างก๊วนไม่สำเร็จ');
    expect(navigate).not.toHaveBeenCalled();
    expect(component.creating()).toBe(false);
  });

  it('opened directly at the cap: the plan lock replaces the form', async () => {
    plan.answerMine({ plan: 'free', groupCount: 1, groupLimit: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el().querySelector('form.create-form')).toBeNull();
    expect(el().querySelector('app-plan-lock')?.textContent).toContain('สร้างได้ 1 ก๊วน');
  });

  it('opened at the cap on a paid plan: the limit is said plainly, with no upgrade pitch and no form', async () => {
    plan.answerMine({ plan: 'host', groupCount: 3, groupLimit: 3 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el().querySelector('form.create-form')).toBeNull();
    expect(el().querySelector('app-plan-lock')).toBeNull();
    expect(el().querySelector('.notice')?.textContent).toContain('สร้างได้ 3 ก๊วน');
  });

  it('below the cap, or with the plan unknown or failed: the form is there', async () => {
    fixture.detectChanges();
    expect(el().querySelector('form.create-form')).not.toBeNull();
    plan.answerMine({ groupCount: 0, groupLimit: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el().querySelector('form.create-form')).not.toBeNull();
    expect(el().querySelector('app-plan-lock')).toBeNull();
  });

  it('switches to a fresh code after a 404, so it never retries a dead code', async () => {
    component.name.set('ก๊วนอังคาร');
    const first = component.submit();
    const dead = httpMock.expectOne(`${B}/groups`);
    const code = dead.request.body.code;
    dead.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await first;
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('สร้างก๊วนไม่สำเร็จ');

    const second = component.submit();
    const next = httpMock.expectOne(`${B}/groups`);
    expect(next.request.body.code).not.toBe(code);
    expect(next.request.body.code).toMatch(UUID);
    next.flush({ code: next.request.body.code, name: 'ก๊วนอังคาร' });
    await second;
  });

  it('creates without the check when the group list could not be read', async () => {
    const again = TestBed.createComponent(GroupCreate);
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush('x', { status: 500, statusText: 'x' });
    await again.whenStable();
    again.componentInstance.name.set('ก๊วน อังคารเดิม');
    const done = again.componentInstance.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ก๊วน อังคารเดิม' });
    await done;
    again.destroy();
  });
});
