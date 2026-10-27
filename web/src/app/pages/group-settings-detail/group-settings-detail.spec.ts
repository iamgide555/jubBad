import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupSettingsDetail } from './group-settings-detail';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import { stubPlanService } from '../../core/plan.testing';

const B = environment.apiBaseUrl;
const GROUP = { code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null };

describe('GroupSettingsDetail', () => {
  let httpMock: HttpTestingController;
  let harness: RouterTestingHarness;
  let plan: ReturnType<typeof stubPlanService>;

  beforeEach(async () => {
    plan = stubPlanService();
    TestBed.configureTestingModule({
      providers: [
        plan.provider,
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

  describe('plan', () => {
    const lockHints = () => el().querySelectorAll('app-plan-lock').length;
    const exportBtn = () => [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('ดาวน์โหลดข้อมูล (JSON)'))!;

    async function openAdvancedAs(p: 'free' | 'host' | null, shuttle: boolean, history: boolean) {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: shuttle });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: history });
      if (p) plan.answer(p);
      await settle();
    }
    const box = (name: string) => el().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

    it('reads the plan of the group it is showing', async () => {
      await openAdvancedAs('free', false, false);
      expect(plan.calls).toEqual(['group1']);
    });

    it('free: both advanced switches are disabled while off, each with a plan hint, and stay visible', async () => {
      await openAdvancedAs('free', false, false);
      expect(box('shuttleTools').disabled).toBe(true);
      expect(box('crossSessionHistory').disabled).toBe(true);
      expect(lockHints()).toBe(1);
    });

    it('free: a switch that is already on stays enabled so it can be turned off, and still shows the plan hint', async () => {
      await openAdvancedAs('free', true, true);
      expect(box('shuttleTools').disabled).toBe(false);
      expect(box('crossSessionHistory').disabled).toBe(false);
      // Still marked as not on the plan, so an inactive-looking ON switch is explained.
      expect(lockHints()).toBe(1);
      box('shuttleTools').checked = false;
      box('shuttleTools').dispatchEvent(new Event('change'));
      const req = httpMock.expectOne({ url: `${B}/groups/group1/shuttle-tools`, method: 'POST' });
      expect(req.request.body).toEqual({ enabled: false });
      req.flush({ enabled: false });
      await settle();
      // Once off, the lock applies again.
      expect(box('shuttleTools').disabled).toBe(true);
      expect(lockHints()).toBe(1);
    });

    const hintOf = (name: string) =>
      box(name).closest('.switch-row')!.querySelector('.inactive-hint')?.textContent?.trim() ?? '';

    it('free: an ON switch is drawn inactive and says new rounds will not use it; an OFF one says nothing of its own', async () => {
      await openAdvancedAs('free', true, false);
      expect(box('shuttleTools').classList.contains('inactive')).toBe(true);
      expect(box('shuttleTools').checked).toBe(true);
      expect(box('shuttleTools').disabled).toBe(false);
      expect(hintOf('shuttleTools')).toBe('เปิดอยู่ แต่รอบใหม่จะไม่ใช้ในแพ็ก⁠เกจนี้');
      expect(box('crossSessionHistory').classList.contains('inactive')).toBe(false);
      expect(hintOf('crossSessionHistory')).toBe('');
    });

    it('free: one plan lock under both switches, not one per switch', async () => {
      await openAdvancedAs('free', true, true);
      expect(lockHints()).toBe(1);
      expect(el().querySelector('.switch-row app-plan-lock')).toBeNull();
      expect(el().querySelector('app-plan-lock')?.textContent).toContain('ใช้ได้ในแพ็ก⁠เกจโฮสต์');
      expect(el().querySelector('app-plan-lock')?.textContent).toContain('ดูแพ็ก⁠เกจ');
    });

    it('free: turning an ON switch off drops the inactive look and its hint', async () => {
      await openAdvancedAs('free', false, true);
      expect(box('crossSessionHistory').classList.contains('inactive')).toBe(true);
      box('crossSessionHistory').checked = false;
      box('crossSessionHistory').dispatchEvent(new Event('change'));
      httpMock.expectOne({ url: `${B}/groups/group1/cross-session-history`, method: 'POST' }).flush({ enabled: false });
      await settle();
      expect(box('crossSessionHistory').classList.contains('inactive')).toBe(false);
      expect(hintOf('crossSessionHistory')).toBe('');
    });

    it('host: nothing is locked', async () => {
      await openAdvancedAs('host', false, false);
      expect(box('shuttleTools').disabled).toBe(false);
      expect(box('crossSessionHistory').disabled).toBe(false);
      expect(lockHints()).toBe(0);
    });

    it('an unknown plan (never answered) locks nothing', async () => {
      await openAdvancedAs(null, false, false);
      expect(box('shuttleTools').disabled).toBe(false);
      expect(lockHints()).toBe(0);
    });

    it('a failed plan read locks nothing', async () => {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: false });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: false });
      plan.fail();
      await settle();
      expect(box('shuttleTools').disabled).toBe(false);
      expect(lockHints()).toBe(0);
    });

    it('says the plan refused when the server still answers PLAN_REQUIRED', async () => {
      await openAdvancedAs('host', false, false);
      box('shuttleTools').checked = true;
      box('shuttleTools').dispatchEvent(new Event('change'));
      httpMock
        .expectOne({ url: `${B}/groups/group1/shuttle-tools`, method: 'POST' })
        .flush({ code: 'PLAN_REQUIRED', requiredPlan: 'host' }, { status: 403, statusText: 'Forbidden' });
      await settle();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('แพ็ก⁠เกจโฮสต์');
    });

    it('free: share with no token shows the plan hint instead of the enable button', async () => {
      await open('share');
      httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: null });
      plan.answer('free');
      await settle();
      expect(el().querySelector('[data-share]')).toBeNull();
      expect(el().querySelector('app-share-dashboard-panel app-plan-lock')).toBeTruthy();
    });

    it('free: an existing share link keeps its stop-sharing control', async () => {
      await open('share');
      httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: 'tok' });
      plan.answer('free');
      await settle();
      expect(el().querySelector('[data-stop]')).toBeTruthy();
      expect(el().querySelector('[data-copy]')).toBeTruthy();
      expect(lockHints()).toBe(0);
    });

    it('host: share with no token offers the enable button and no hint', async () => {
      await open('share');
      httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: null });
      plan.answer('host');
      await settle();
      expect(el().querySelector('[data-share]')).toBeTruthy();
      expect(lockHints()).toBe(0);
    });

    it('free: the export button is enabled with a 30-day note and no plan lock, and rename and delete stay', async () => {
      await open('manage');
      plan.answer('free');
      await settle();
      expect(exportBtn().disabled).toBe(false);
      expect(el().querySelector('.detail-section app-plan-lock')).toBeNull();
      expect(el().querySelector('[data-export-note]')?.textContent).toContain('30 วัน');
      expect(el().querySelector<HTMLButtonElement>('.rename-row button')!.disabled).toBe(false);
      expect(el().querySelector('.danger-zone')).toBeTruthy();
    });

    it('host: the export button is enabled and there is no hint', async () => {
      await open('manage');
      plan.answer('host');
      await settle();
      expect(exportBtn().disabled).toBe(false);
      expect(lockHints()).toBe(0);
      expect(el().querySelector('[data-export-note]')).toBeNull();
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

  describe('line', () => {
    const STATUS = {
      configured: true,
      botAddUrl: 'https://lin.ee/jubbad',
      linked: false,
      lineGroupName: null,
      linkedAt: null,
      leftAt: null,
      summaryDefault: true,
    };
    const q = (selector: string) => el().querySelector<HTMLElement>(selector);

    afterEach(() => vi.useRealTimers());

    async function openLine(status: Record<string, unknown> = {}, answer: 'free' | 'host' | null = 'host') {
      const page = await harness.navigateByUrl('/g/group1/settings/line', GroupSettingsDetail);
      httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
      await settle();
      httpMock.expectOne(`${B}/groups/group1/line`).flush({ ...STATUS, ...status });
      if (answer) plan.answer(answer);
      await settle();
      return page;
    }

    // Under fake timers whenStable() never resolves, so these tests flush by hand.
    async function fakeSettle() {
      await vi.advanceTimersByTimeAsync(0);
      harness.detectChanges();
    }

    async function makeCode(expiresInMs = 10 * 60_000, fake = false) {
      q('[data-make-code]')!.click();
      httpMock
        .expectOne({ url: `${B}/groups/group1/line/code`, method: 'POST' })
        .flush({ code: 'K7P2QX', expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
      await (fake ? fakeSettle() : settle());
    }

    it('says the bot is not set up when the server has no LINE channel, and offers nothing to do', async () => {
      await openLine({ configured: false });
      expect(q('[data-not-configured]')?.textContent).toContain('ยังไม่ได้ตั้งค่าบอท LINE ของระบบ');
      expect(q('[data-make-code]')).toBeNull();
      expect(q('[data-add-bot]')).toBeNull();
    });

    it('not linked on a paid plan: an add-the-bot link, the one-bot hint and a create-code button', async () => {
      await openLine();
      const add = q('[data-add-bot]') as HTMLAnchorElement;
      expect(add.getAttribute('href')).toBe('https://lin.ee/jubbad');
      expect(add.textContent).toContain('เพิ่มบอทเข้ากลุ่ม LINE');
      expect(el().textContent).toContain('กลุ่ม LINE หนึ่งกลุ่มมีบอทได้ตัวเดียว');
      expect(q('[data-make-code]')?.textContent).toContain('สร้างรหัสเชื่อม');
      expect(q('[data-code]')).toBeNull();
    });

    it('creating a code shows it large, with the /link instruction and the time left', async () => {
      await openLine();
      await makeCode();
      expect(q('[data-code]')?.textContent?.trim()).toBe('K7P2QX');
      expect(el().textContent).toContain('/link K7P2QX');
      expect(el().textContent).toContain('หมดอายุใน 10 นาที');
    });

    it('polls the status every 5 seconds and shows the linked state once the LINE group links', async () => {
      await openLine();
      vi.useFakeTimers();
      await makeCode(10 * 60_000, true);
      await vi.advanceTimersByTimeAsync(5000);
      httpMock.expectOne(`${B}/groups/group1/line`).flush(STATUS);
      await vi.advanceTimersByTimeAsync(5000);
      httpMock.expectOne(`${B}/groups/group1/line`).flush({
        ...STATUS,
        linked: true,
        lineGroupName: 'ก๊วนพฤหัส LINE',
        linkedAt: '2026-10-26T12:00:00.000Z',
      });
      await fakeSettle();
      expect(q('[data-linked]')?.textContent).toContain('เชื่อมกับ ก๊วนพฤหัส LINE แล้ว');
      expect(q('[data-code]')).toBeNull();
      await vi.advanceTimersByTimeAsync(20000);
      httpMock.expectNone(`${B}/groups/group1/line`);
    });

    it('stops polling and drops the code once it has expired', async () => {
      await openLine();
      vi.useFakeTimers();
      await makeCode(6000, true);
      await vi.advanceTimersByTimeAsync(5000);
      httpMock.expectOne(`${B}/groups/group1/line`).flush(STATUS);
      await vi.advanceTimersByTimeAsync(5000);
      await fakeSettle();
      expect(q('[data-code]')).toBeNull();
      expect(q('[data-make-code]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(20000);
      httpMock.expectNone(`${B}/groups/group1/line`);
    });

    it('linked: shows the LINE group name and unlinks only after an inline confirm', async () => {
      await openLine({ linked: true, lineGroupName: 'ก๊วนพฤหัส LINE', linkedAt: '2026-10-26T12:00:00.000Z' });
      expect(q('[data-linked]')?.textContent).toContain('ก๊วนพฤหัส LINE');
      expect(q('[data-make-code]')).toBeNull();
      q('[data-unlink]')!.click();
      await settle();
      expect(el().textContent).toContain('บอทจะออกจากกลุ่ม LINE');
      httpMock.expectNone({ url: `${B}/groups/group1/line`, method: 'DELETE' });
      q('[data-confirm-unlink]')!.click();
      httpMock.expectOne({ url: `${B}/groups/group1/line`, method: 'DELETE' }).flush({ unlinked: true });
      await settle();
      expect(q('[data-linked]')).toBeNull();
      expect(q('[data-make-code]')).not.toBeNull();
    });

    describe('summary card default switch', () => {
      const LINKED = { linked: true, lineGroupName: 'ก๊วนพฤหัส LINE' };
      const box = () => q('[data-summary-default]') as HTMLInputElement | null;

      it('shows checked from the saved default and saves a change with a PATCH', async () => {
        await openLine(LINKED);
        expect(box()?.checked).toBe(true);
        box()!.click();
        const req = httpMock.expectOne({ url: `${B}/groups/group1/line`, method: 'PATCH' });
        expect(req.request.body).toEqual({ summaryDefault: false });
        req.flush({ summaryDefault: false });
        await settle();
        expect(box()?.checked).toBe(false);
      });

      it('shows unchecked when the saved default is off', async () => {
        await openLine({ ...LINKED, summaryDefault: false });
        expect(box()?.checked).toBe(false);
      });

      it('snaps back and shows the error when the save fails', async () => {
        await openLine(LINKED);
        box()!.click();
        httpMock
          .expectOne({ url: `${B}/groups/group1/line`, method: 'PATCH' })
          .flush({ code: 'X' }, { status: 500, statusText: 'x' });
        await settle();
        expect(box()?.checked).toBe(true);
        expect(q('[data-error]')).not.toBeNull();
      });

      it('is absent when the group is paused or not linked', async () => {
        await openLine(LINKED, 'free');
        expect(box()).toBeNull();
      });

      it('is absent when the group is not linked', async () => {
        await openLine();
        expect(box()).toBeNull();
      });
    });

    it('cancelling the unlink confirm sends nothing', async () => {
      await openLine({ linked: true, lineGroupName: 'x' });
      q('[data-unlink]')!.click();
      await settle();
      q('[data-cancel-unlink]')!.click();
      await settle();
      expect(q('[data-confirm-unlink]')).toBeNull();
      expect(q('[data-linked]')).not.toBeNull();
    });

    it('tells the host the bot was removed from the LINE group and lets them link again', async () => {
      await openLine({ leftAt: '2026-10-20T08:00:00.000Z' });
      expect(q('[data-left-notice]')?.textContent).toContain('บอทถูกนำออกจากกลุ่ม LINE');
      expect(q('[data-make-code]')).not.toBeNull();
    });

    it('free and not linked: the plan lock and no code button', async () => {
      await openLine({}, 'free');
      expect(el().textContent).toContain('การเชื่อมกลุ่ม LINE ใช้ได้ในแพ็ก⁠เกจโฮสต์');
      expect(q('[data-make-code]')).toBeNull();
      expect(q('[data-unlink]')).toBeNull();
    });

    it('free but still linked: a paused notice, an upgrade button and Unlink only', async () => {
      await openLine({ linked: true, lineGroupName: 'ก๊วนพฤหัส LINE' }, 'free');
      expect(q('[data-paused]')?.textContent).toContain('บอทหยุดจำรายชื่อชั่วคราว');
      expect(q('[data-paused] .lock-more, [data-paused] button')).not.toBeNull();
      expect(q('[data-make-code]')).toBeNull();
      expect(q('[data-unlink]')).not.toBeNull();
      expect(q('[data-linked]')).toBeNull();
    });

    it('a PLAN_REQUIRED refusal on creating a code shows the plan message', async () => {
      await openLine();
      q('[data-make-code]')!.click();
      httpMock
        .expectOne({ url: `${B}/groups/group1/line/code`, method: 'POST' })
        .flush({ code: 'PLAN_REQUIRED', requiredPlan: 'host' }, { status: 403, statusText: 'Forbidden' });
      await settle();
      expect(q('[data-error]')?.textContent).toContain('ฟีเจอร์นี้ใช้ได้ในแพ็ก⁠เกจโฮสต์');
    });

    it('a 503 on creating a code shows that the bot is not set up', async () => {
      await openLine();
      q('[data-make-code]')!.click();
      httpMock
        .expectOne({ url: `${B}/groups/group1/line/code`, method: 'POST' })
        .flush({ code: 'LINE_NOT_CONFIGURED' }, { status: 503, statusText: 'Service Unavailable' });
      await settle();
      expect(q('[data-not-configured]')?.textContent).toContain('ยังไม่ได้ตั้งค่าบอท LINE ของระบบ');
    });

    it('a failed status read says so and offers a retry, never an empty page', async () => {
      const page = await harness.navigateByUrl('/g/group1/settings/line', GroupSettingsDetail);
      httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
      await settle();
      httpMock.expectOne(`${B}/groups/group1/line`).flush('x', { status: 500, statusText: 'x' });
      await settle();
      expect(page.status()).toBe('ready');
      expect(q('[data-line-load-failed]')).not.toBeNull();
      q('[data-line-load-failed] button')!.click();
      httpMock.expectOne(`${B}/groups/group1/line`).flush(STATUS);
      await settle();
      expect(q('[data-make-code]')).not.toBeNull();
    });
  });
});
