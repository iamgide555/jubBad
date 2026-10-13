import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupSettingsDetail } from './group-settings-detail';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;
const GROUP = { code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null };

describe('GroupSettingsDetail', () => {
  let httpMock: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => httpMock.verify());

  // The load finishes in a promise continuation: let it run, then render the result.
  async function settle() {
    await harness.fixture.whenStable();
    harness.detectChanges();
    await harness.fixture.whenStable();
  }

  async function open(section: string) {
    const page = await harness.navigateByUrl(`/g/group1/settings/${section}`, GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await settle();
    // Manage reads the host's own groups for the same-name note on rename.
    if (section === 'manage') {
      httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([
        { code: 'group1', name: 'ก๊วนอังคาร' },
        { code: 'group2', name: 'ก๊วนพุธ' },
      ]);
      await harness.fixture.whenStable();
    }
    return page;
  }
  const el = () => harness.routeNativeElement as HTMLElement;

  it('names the group in its back link, which returns to the open settings row', async () => {
    await open('manage');
    const back = el().querySelector<HTMLAnchorElement>('a.back')!;
    expect(back.textContent).toContain('ก๊วนอังคาร');
    expect(back.getAttribute('href')).toBe('/g/group1?settings=manage');
  });

  describe('share', () => {
    it('states who can see the summary and shows the existing share panel', async () => {
      await open('share');
      httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: null });
      await settle();
      expect(el().textContent).toContain('ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้');
      expect(el().querySelector('app-share-dashboard-panel')).toBeTruthy();
      expect(el().querySelector('[data-share]')).toBeTruthy(); // explicit create, never automatic
    });
  });

  describe('advanced', () => {
    async function openAdvanced(shuttle: boolean, history: boolean) {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: shuttle });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: history });
      await harness.fixture.whenStable();
    }
    const box = (name: string) => el().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

    it('loads both switches before any roster exists', async () => {
      await openAdvanced(false, true);
      expect(box('shuttleTools').checked).toBe(false);
      expect(box('crossSessionHistory').checked).toBe(true);
    });

    it('keeps the on/off explanation for cross-session history', async () => {
      await openAdvanced(false, false);
      expect(el().textContent).toContain('ปิด: เลี่ยงคู่ซ้ำเฉพาะคืนนี้ · เปิด: นับทุกรอบที่ผ่านมา');
      expect(el().textContent).toContain('มีผลกับรอบที่สร้างต่อจากนี้');
    });

    it('saves a switch and shows the saved value', async () => {
      await openAdvanced(false, false);
      box('shuttleTools').checked = true;
      box('shuttleTools').dispatchEvent(new Event('change'));
      const req = httpMock.expectOne({ url: `${B}/groups/group1/shuttle-tools`, method: 'POST' });
      expect(req.request.body).toEqual({ enabled: true });
      req.flush({ enabled: true });
      await harness.fixture.whenStable();
      expect(box('shuttleTools').checked).toBe(true);
    });

    it('saves the cross-session history switch independently of shuttle tools', async () => {
      await openAdvanced(false, false);
      box('crossSessionHistory').checked = true;
      box('crossSessionHistory').dispatchEvent(new Event('change'));
      const req = httpMock.expectOne({ url: `${B}/groups/group1/cross-session-history`, method: 'POST' });
      expect(req.request.body).toEqual({ enabled: true });
      req.flush({ enabled: true });
      await harness.fixture.whenStable();
      expect(box('crossSessionHistory').checked).toBe(true);
      expect(box('shuttleTools').checked).toBe(false);
    });

    it('puts the switch back and says so when saving fails', async () => {
      await openAdvanced(false, false);
      box('crossSessionHistory').checked = true;
      box('crossSessionHistory').dispatchEvent(new Event('change'));
      httpMock
        .expectOne({ url: `${B}/groups/group1/cross-session-history`, method: 'POST' })
        .flush('x', { status: 500, statusText: 'x' });
      await harness.fixture.whenStable();
      expect(box('crossSessionHistory').checked).toBe(false);
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('บันทึกไม่สำเร็จ');
    });

    it('says the settings could not be loaded instead of showing defaults', async () => {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush('x', { status: 500, statusText: 'x' });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: false });
      await harness.fixture.whenStable();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('โหลดการตั้งค่าไม่สำเร็จ');
      expect(box('shuttleTools').disabled).toBe(true);
    });
  });

  describe('manage', () => {
    it('renames the group with a trimmed name', async () => {
      const page = await open('manage');
      page.renameDraft.set('  ก๊วนพฤหัส  ');
      const done = page.rename();
      const req = httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' });
      expect(req.request.body).toEqual({ name: 'ก๊วนพฤหัส' });
      req.flush({ code: 'group1', name: 'ก๊วนพฤหัส' });
      await done;
      await harness.fixture.whenStable();
      expect(el().querySelector('a.back')?.textContent).toContain('ก๊วนพฤหัส');
    });

    it("warns once when renaming to another of the host's group names, then renames on a second save", async () => {
      const page = await open('manage');
      page.renameDraft.set('ก๊วนพุธ');
      await page.rename();
      await harness.fixture.whenStable();
      httpMock.expectNone({ url: `${B}/groups/group1`, method: 'PUT' });
      expect(el().querySelector('[data-duplicate]')?.textContent).toContain('คุณมีก๊วนชื่อนี้อยู่แล้ว');

      const done = page.rename();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' }).flush({ code: 'group1', name: 'ก๊วนพุธ' });
      await done;
    });

    it('does not warn when saving the group under its own current name', async () => {
      const page = await open('manage');
      page.renameDraft.set('ก๊วนอังคาร');
      const done = page.rename();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' }).flush({ code: 'group1', name: 'ก๊วนอังคาร' });
      await done;
    });

    it('keeps the typed name and allows a retry when renaming fails', async () => {
      const page = await open('manage');
      page.renameDraft.set('ก๊วนพฤหัส');
      const failed = page.rename();
      httpMock
        .expectOne({ url: `${B}/groups/group1`, method: 'PUT' })
        .flush('x', { status: 500, statusText: 'Server Error' });
      await failed;
      await settle();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('บันทึกชื่อก๊วนไม่สำเร็จ');
      expect(page.renameDraft()).toBe('ก๊วนพฤหัส');
      expect(el().querySelector('a.back')?.textContent).toContain('ก๊วนอังคาร');

      const retry = page.rename();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' }).flush({ code: 'group1', name: 'ก๊วนพฤหัส' });
      await retry;
      await settle();
      expect(page.renameError()).toBeNull();
      expect(el().querySelector('[role="alert"]')).toBeNull();
      expect(el().querySelector('a.back')?.textContent).toContain('ก๊วนพฤหัส');
    });

    it('refuses a blank rename inline without a request', async () => {
      const page = await open('manage');
      page.renameDraft.set('   ');
      await page.rename();
      await harness.fixture.whenStable();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('กรุณาใส่ชื่อก๊วนก่อน');
    });

    it('enables delete only once the group name is typed back, and deletion sits inside the danger zone', async () => {
      const page = await open('manage');
      const del = () => el().querySelector<HTMLButtonElement>('.danger-zone button.danger')!;
      expect(del().disabled).toBe(true);
      page.deleteConfirmText.set('ก๊วนอังคาร');
      await harness.fixture.whenStable();
      expect(del().disabled).toBe(false);
    });

    it('deletes and returns to the group list', async () => {
      const page = await open('manage');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      page.deleteConfirmText.set('ก๊วนอังคาร');
      const done = page.deleteGroup();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'DELETE' }).flush({ code: 'group1', deleted: true });
      await done;
      expect(navigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows not-found for an unknown section', async () => {
    await harness.navigateByUrl('/g/group1/settings/nope', GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await settle();
    expect(el().textContent).toContain('ไม่พบหน้านี้');
  });

  it('offers a retry when the group fails to load for a reason other than not-found', async () => {
    const page = await harness.navigateByUrl('/g/group1/settings/manage', GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 500, statusText: 'x' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('โหลดก๊วนไม่สำเร็จ');
    expect(el().textContent).not.toContain('ไม่พบก๊วนนี้');

    el().querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await settle();
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([{ code: 'group1', name: 'ก๊วนอังคาร' }]);
    await settle();
    expect(page.status()).toBe('ready');
    expect(el().querySelector('a.back')?.textContent).toContain('ก๊วนอังคาร');
    expect(el().querySelector('.danger-zone')).toBeTruthy();
  });

  it('shows not-found when the group does not exist', async () => {
    await harness.navigateByUrl('/g/group1/settings/manage', GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    await settle();
    expect(el().textContent).toContain('ไม่พบก๊วนนี้');
    expect(el().querySelector('.danger-zone')).toBeNull();
  });
});
