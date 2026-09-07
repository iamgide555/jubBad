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
});
