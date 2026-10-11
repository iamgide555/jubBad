import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { Landing } from './landing';
import { environment } from '../../../environments/environment';

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

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Landing],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
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
  async function loadWith(groups = GROUPS) {
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
  });

  it('starts a new group and navigates to it', async () => {
    await loadWith();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigateByUrl');
    component.startNewGroup();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/g\/[0-9a-f]{8}$/));
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

    it('shows no "other users" row to a host, whose response has no mine flag', async () => {
      await loadWith();
      expect(fixture.nativeElement.querySelector('.others-toggle')).toBeFalsy();
    });
  });
});
