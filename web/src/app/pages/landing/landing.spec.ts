import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { Landing, type GroupSummary } from './landing';
import { environment } from '../../../environments/environment';
import { stubPlanService } from '../../core/plan.testing';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';

const B = environment.apiBaseUrl;

const GROUPS = [
  {
    code: 'aaa',
    name: 'วันอังคาร',
    sessionCount: 12,
    playerCount: 14,
    lastSessionCode: 's-aaa',
    lastSessionAt: '2026-09-01T10:00:00.000Z',
  },
  {
    code: 'bbb',
    name: 'วันศุกร์',
    sessionCount: 0,
    playerCount: 0,
    lastSessionCode: null,
    lastSessionAt: null,
  },
];

describe('Landing', () => {
  let fixture: ComponentFixture<Landing>;
  let component: Landing;
  let httpMock: HttpTestingController;
  let plan: ReturnType<typeof stubPlanService>;

  beforeEach(async () => {
    plan = stubPlanService();
    await TestBed.configureTestingModule({
      imports: [Landing],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), plan.provider],
    }).compileComponents();

    fixture = TestBed.createComponent(Landing);
    component = fixture.componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /**
   * The component loads in its constructor, so the response has to be flushed
   * and its promise allowed to settle before the template reflects it.
   */
  async function loadWith(groups: GroupSummary[] = GROUPS) {
    fixture.detectChanges();
    httpMock.expectOne(`${B}/groups`).flush(groups);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('lists every group the admin has', async () => {
    await loadWith();
    const rows = fixture.nativeElement.querySelectorAll('.group-row');
    expect(rows.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('วันอังคาร');
  });

  it('offers a way in for a group that has never had a session', async () => {
    // A group exists from the moment a roster is parsed into it, so a brand new
    // one has no session to continue — it must still be openable.
    await loadWith();
    const rows = fixture.nativeElement.querySelectorAll('.group-row');
    expect(rows[1].textContent).toContain('วันศุกร์');
  });

  it('shows an empty state rather than a bare page when there are no groups', async () => {
    await loadWith([]);
    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('shows a retryable error instead of treating a failed load as no groups', async () => {
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/groups`)
      .flush('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.empty')).toBeFalsy();
    expect(fixture.nativeElement.textContent).toContain('โหลดก๊วนไม่สำเร็จ');

    component.retryLoad();
    httpMock.expectOne(`${B}/groups`).flush(GROUPS);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('วันอังคาร');
  });

  it('will not delete until the group name is typed back exactly', async () => {
    await loadWith();
    component.startRemove(GROUPS[0]);
    expect(component.canRemove()).toBe(false);

    component.removeConfirmText.set('วันอังคาร ');
    expect(component.canRemove()).toBe(true);
  });

  it('does not accept another group name as confirmation', async () => {
    await loadWith();
    component.startRemove(GROUPS[0]);
    component.removeConfirmText.set('วันศุกร์');
    expect(component.canRemove()).toBe(false);
  });

  it('deletes the group and drops it from the list', async () => {
    await loadWith();
    component.startRemove(GROUPS[0]);
    component.removeConfirmText.set('วันอังคาร');

    const done = component.confirmRemove();
    httpMock.expectOne({ url: `${B}/groups/aaa`, method: 'DELETE' }).flush({ deleted: true });
    await done;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('วันอังคาร');
    // The server released a paused group the moment this one went: re-read, never guess.
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([GROUPS[1]]);
  });

  it('after a delete, the paused badge and the cap count are re-read, not left stale', async () => {
    await loadWith([GROUPS[0], { ...GROUPS[1], paused: true }]);
    plan.answerMine({ plan: 'free', groupCount: 2, groupLimit: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.paused-badge')).not.toBeNull();
    expect(plan.mineCalls).toHaveLength(1);

    component.startRemove(GROUPS[0]);
    component.removeConfirmText.set('วันอังคาร');
    const done = component.confirmRemove();
    httpMock.expectOne({ url: `${B}/groups/aaa`, method: 'DELETE' }).flush({ deleted: true });
    await done;
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([{ ...GROUPS[1], paused: false }]);
    plan.answerMine({ plan: 'free', groupCount: 1, groupLimit: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(plan.mineCalls).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.paused-badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-start-link]')).not.toBeNull();
  });

  it('puts เริ่มรอบ on every own group row, a link straight to the roster screen', async () => {
    // A host with a weekly group otherwise needs list -> group -> เริ่มรอบใหม่ -> paste.
    await loadWith();
    const rows = [...fixture.nativeElement.querySelectorAll('.group-row')] as HTMLElement[];
    expect(rows.length).toBe(2);
    for (const [i, group] of GROUPS.entries()) {
      const link = rows[i].querySelector<HTMLAnchorElement>('[data-start-link]');
      expect(link, group.code).not.toBeNull();
      expect(link!.getAttribute('href')).toBe(`/g/${group.code}/start`);
      expect(link!.textContent?.trim()).toBe('เริ่มรอบ');
      expect(link!.closest('.group-actions')).not.toBeNull();
    }
  });

  it('offers เริ่มรอบ even on a group that has never had a session', async () => {
    await loadWith();
    const row = [...fixture.nativeElement.querySelectorAll('.group-row')][1] as HTMLElement;
    expect(row.textContent).not.toContain('ไปรอบล่าสุด');
    expect(row.querySelector('[data-start-link]')).not.toBeNull();
  });

  it('puts เริ่มรอบ before ไปรอบล่าสุด in the row', async () => {
    await loadWith();
    const actions = fixture.nativeElement.querySelector('.group-actions') as HTMLElement;
    const labels = [...actions.querySelectorAll('a, button')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['เริ่มรอบ', 'ไปรอบล่าสุด', 'ลบ']);
  });

  it('sizes the group name link as a tap target, in every row', async () => {
    await loadWith();
    // Component CSS is attached to the document, so the computed style is the rule as shipped.
    // --tap lives in the global stylesheet, which this spec does not load; give it a value.
    (fixture.nativeElement as HTMLElement).style.setProperty('--tap', '44px');
    const links = [...fixture.nativeElement.querySelectorAll('.group-name')] as HTMLAnchorElement[];
    expect(links.length).toBe(2);
    for (const link of links) {
      const style = getComputedStyle(link);
      expect(style.display).toBe('inline-flex');
      expect(style.alignItems).toBe('center');
      expect(style.minHeight).toBe('var(--tap)');
    }
  });

  it('sends "create a group" to the name-only creation screen', async () => {
    await loadWith();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigateByUrl');
    component.startNewGroup();
    expect(spy).toHaveBeenCalledWith('/groups/new');
  });

  it('cancelling a removal leaves the group alone', async () => {
    await loadWith();
    component.startRemove(GROUPS[0]);
    component.cancelRemove();
    expect(component.removingCode()).toBeNull();
    // No DELETE is issued — httpMock.verify() in afterEach enforces that.
  });

  describe('as an admin, with other hosts\' groups in the list', () => {
    const row = (code: string, name: string, mine: boolean, ownerEmail: string | null) => ({
      code,
      name,
      sessionCount: 1,
      playerCount: 8,
      lastSessionCode: `s-${code}`,
      lastSessionAt: '2026-09-01T10:00:00.000Z',
      mine,
      ownerEmail,
    });
    const MIXED = [
      row('m1', 'ของฉัน', true, 'admin@x.test'),
      row('a1', 'ก๊วนของนุ้ย', false, 'nui@x.test'),
      row('a2', 'ก๊วนวันเสาร์', false, 'nui@x.test'),
      row('b1', 'ก๊วนของบอย', false, 'boy@x.test'),
      row('o1', 'ก๊วนไม่มีเจ้าของ', false, null),
    ];

    it("lists only the admin's own groups until the others are opened", async () => {
      await loadWith(MIXED as never);
      const text = fixture.nativeElement.textContent;
      expect(fixture.nativeElement.querySelectorAll('.group-row').length).toBe(1);
      expect(text).toContain('ของฉัน');
      expect(text).not.toContain('ก๊วนของนุ้ย');
      // The collapsed row says how many are inside, so it is worth opening.
      expect(fixture.nativeElement.querySelector('.others-toggle').textContent).toContain('4');
    });

    it('opens to one heading per host, ownerless last, with their groups under it', async () => {
      await loadWith(MIXED as never);
      component.toggleOthers();
      fixture.detectChanges();

      const headings = [...fixture.nativeElement.querySelectorAll('.owner-heading')].map(
        (h) => (h as HTMLElement).textContent!.trim(),
      );
      expect(headings.length).toBe(3);
      expect(headings[0]).toContain('boy@x.test');
      expect(headings[1]).toContain('nui@x.test');
      expect(headings[1]).toContain('2');
      expect(fixture.nativeElement.textContent).toContain('ก๊วนวันเสาร์');
    });

    it("never offers delete on another host's group, only on the admin's own", async () => {
      await loadWith(MIXED as never);
      component.toggleOthers();
      fixture.detectChanges();

      const rows = [...fixture.nativeElement.querySelectorAll('.group-row')] as HTMLElement[];
      expect(rows.length).toBe(5);
      const withRemove = rows.filter((r) => r.querySelector('.remove'));
      expect(withRemove.length).toBe(1);
      expect(withRemove[0].textContent).toContain('ของฉัน');
    });

    it("offers เริ่มรอบ on the admin's own group only, never on another host's", async () => {
      await loadWith(MIXED as never);
      component.toggleOthers();
      fixture.detectChanges();

      const rows = [...fixture.nativeElement.querySelectorAll('.group-row')] as HTMLElement[];
      expect(rows.length).toBe(5);
      const withStart = rows.filter((r) => r.querySelector('[data-start-link]'));
      expect(withStart.length).toBe(1);
      expect(withStart[0].textContent).toContain('ของฉัน');
      expect(withStart[0].querySelector('[data-start-link]')!.getAttribute('href')).toBe('/g/m1/start');
      // The others' rows still have their names and tap-sized name links.
      for (const row of rows.filter((r) => !r.querySelector('[data-start-link]'))) {
        expect(row.querySelector('.group-name')).not.toBeNull();
      }
    });

    it('shows no "other users" row to a host, whose response has no mine flag', async () => {
      await loadWith();
      expect(fixture.nativeElement.querySelector('.others-toggle')).toBeFalsy();
    });
  });

  describe('the group cap and paused groups', () => {
    const root = () => fixture.nativeElement as HTMLElement;
    const capped = () => root().querySelector<HTMLButtonElement>('[data-new-group-capped]');

    it('at the cap: the create control shows the count and the limit, and opens the upgrade sheet instead of navigating', async () => {
      await loadWith();
      plan.answerMine({ plan: 'free', groupCount: 1, groupLimit: 1 });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(capped()?.textContent).toContain('ก๊วน 1/1');
      // Not the green call to action: it does not create, it explains.
      expect(capped()?.classList.contains('ghost')).toBe(true);
      expect(root().querySelector('app-plan-lock')?.textContent).toContain('สร้างได้ 1 ก๊วน');
      const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      const open = vi.spyOn(TestBed.inject(UpgradeSheetService), 'open').mockImplementation(() => undefined);
      capped()!.click();
      expect(open).toHaveBeenCalledTimes(1);
      expect(nav).not.toHaveBeenCalled();
    });

    it('at the cap on a paid plan: the button is disabled with the limit said plainly, and no upgrade pitch', async () => {
      await loadWith();
      plan.answerMine({ plan: 'host', groupCount: 3, groupLimit: 3 });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(capped()?.disabled).toBe(true);
      expect(root().querySelector('app-plan-lock')).toBeNull();
      expect(root().querySelector('[data-cap-note]')?.textContent).toContain('สร้างได้ 3 ก๊วน');
    });

    it('below the cap, for an admin, and while the plan is unknown: the ordinary create button', async () => {
      await loadWith();
      expect(capped()).toBeNull();
      plan.answerMine({ groupCount: 0, groupLimit: 1 });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(capped()).toBeNull();
      expect(root().querySelector('.new-group')).not.toBeNull();
    });

    it('an admin (no limit) is never capped', async () => {
      await loadWith();
      plan.answerMine({ plan: 'club', groupCount: 40, groupLimit: null });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(capped()).toBeNull();
    });

    it('a failed plan read blocks nothing', async () => {
      await loadWith();
      plan.failMine();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(capped()).toBeNull();
    });

    it('a paused group wears a พักไว้ badge and has no เริ่มรอบ link', async () => {
      await loadWith([{ ...GROUPS[0], paused: true }, GROUPS[1]]);
      const rows = root().querySelectorAll('.group-row');
      expect(rows[0].querySelector('.paused-badge')?.textContent?.trim()).toBe('พักไว้');
      expect(rows[0].querySelector('[data-start-link]')).toBeNull();
      expect(rows[1].querySelector('.paused-badge')).toBeNull();
      expect(rows[1].querySelector('[data-start-link]')).not.toBeNull();
    });
  });
});
