import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        // The real route table is used here, and its guarded routes would
        // otherwise fire a real GET /auth/me the moment a test navigates. These
        // specs are not about auth; the guard has its own tests.
        { provide: AuthService, useValue: { check: () => Promise.resolve(true) } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;

    // Constructor fires GET /groups/group1 - respond 404 (brand-new group) by
    // default; tests that need a pre-existing group flush a real body instead.
    httpMock.expectOne(`${B}/groups/group1`).flush('Not Found', { status: 404, statusText: 'Not Found' });
    // The constructor also asks for the group's past sessions.
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await fixture.whenStable();
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('links back to the group list', () => {
    const links = [...fixture.nativeElement.querySelectorAll('a')] as HTMLAnchorElement[];
    const back = links.find((a) => a.textContent?.trim() === '← กลับ');
    expect(back?.getAttribute('href')).toBe('/');
  });

  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('groupName is empty when no Group exists yet', () => {
    expect(component.groupName()).toBe('');
  });

  it('lastSessionCode is null when no Group exists yet', () => {
    expect(component.lastSessionCode()).toBeNull();
  });

  it('parse shows an error and stays in the paste state when the group name is empty', async () => {
    component.groupName.set('');
    component.rawText.set('1. ตั้ม');
    await component.parse();

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('ชื่อก๊วน');
  });

  it('parse shows an error and stays in the paste state when nothing has been pasted', async () => {
    component.groupName.set('Group A');
    component.rawText.set('   ');
    await component.parse();

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('วางข้อความรายชื่อ');
  });

  it('parse shows an error when the server reports no recognized roster', async () => {
    component.groupName.set('Group A');
    component.rawText.set('ไกด์\nเตย');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await parsePromise;

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('ไม่พบรายชื่อผู้เล่น');
  });

  it('keeps pasted input and allows a retry when parsing fails', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. Alice');

    const failedParse = component.parse();
    expect(component.isParsing()).toBe(true);
    httpMock
      .expectOne(`${B}/groups/group1/parse`)
      .flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedParse;

    expect(component.state()).toBe('paste');
    expect(component.rawText()).toBe('1. Alice');
    expect(component.pasteError()).toContain('อ่านรายชื่อไม่สำเร็จ');
    expect(component.isParsing()).toBe(false);

    const retry = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: [{ inputName: 'Alice', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await retry;
    expect(component.state()).toBe('confirm');
  });

  it('a successful parse switches to confirm, prefilling header fields and reviews', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: 'KIP', courtCount: 2 },
      rosterReviews: [
        { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
        { inputName: 'เกียร์', match: { type: 'new' } },
      ],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    expect(component.state()).toBe('confirm');
    expect(component.date()).toBe('2026-09-08');
    expect(component.venue()).toBe('KIP');
    expect(component.courtCount()).toBe(2);
    expect(component.rosterReviews()).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' },
    ]);
  });

  it('resolves a fuzzy suggestion to the matched player name via playerName()', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตัม');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตัม', match: { type: 'fuzzy', playerId: 'p1', score: 0.8 } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    expect(component.playerName('p1')).toBe('ตั้ม');
  });

  it('toggleDecision flips a review between accept and reject-new', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตัม');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตัม', match: { type: 'fuzzy', playerId: 'p1', score: 0.8 } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    const review = component.rosterReviews()[0];
    expect(review.decision).toBe('accept');
    component.toggleDecision(review);
    expect(component.rosterReviews()[0].decision).toBe('reject-new');
  });

  it('renders a row per slot when two entries share a name', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม (1)\n2. ตั้ม (2)');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: [
        { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
        { inputName: 'ตั้ม', match: { type: 'duplicate', playerId: 'p1' } },
      ],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.review-list .review-row');
    expect(rows.length).toBe(2);

    // Both slots carry the same pasted text, so it cannot be what identifies a
    // row. Toggling the second must change the second, not redraw the first.
    component.toggleDecision(component.rosterReviews()[1]);
    fixture.detectChanges();

    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.review-list .review-row button')
    ).map((b) => (b as HTMLElement).textContent!.trim());
    expect(labels).toEqual(['ใช้ผู้เล่นเดิม', 'คนเดียวกัน']);
    expect(component.rosterReviews().map((r) => r.decision)).toEqual(['accept', 'accept']);
  });

  it('labels a duplicate by whether it is the same person, not by yes/no', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม (1)\n2. ตั้ม (2)');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [
        { inputName: 'ตั้ม (1)', match: { type: 'exact', playerId: 'p1' } },
        { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' } },
      ],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    const duplicate = component.rosterReviews()[1];
    expect(duplicate.decision).toBe('reject-new');
    expect(component.decisionLabel(duplicate)).toBe('คนละคน');
    component.toggleDecision(duplicate);
    expect(component.decisionLabel(component.rosterReviews()[1])).toBe('คนเดียวกัน');
  });

  it('canConfirm is false until date and courtCount are set', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    expect(component.canConfirm()).toBe(false);
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    expect(component.canConfirm()).toBe(true);
  });

  it('confirmRoster posts the resolved reviews and navigates to the new session', async () => {
    const router = TestBed.inject(Router);
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    component.date.set('2026-09-08');
    component.courtCount.set(2);
    component.venue.set('KIP');

    const confirmPromise = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body).toMatchObject({
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
      idempotencyKey: expect.any(String),
    });
    req.flush({ code: 'sess1' });
    await confirmPromise;
    await fixture.whenStable();

    expect(router.url).toBe('/s/sess1');
  });

  it('disables confirmation and sends only one request while creation is in flight', async () => {
    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.rawText.set('1. Alice');
    component.rosterReviews.set([
      { inputName: 'Alice', match: { type: 'new' }, decision: 'accept' },
    ]);
    component.state.set('confirm');
    fixture.detectChanges();

    const pending = component.confirmRoster();
    fixture.detectChanges();
    expect(component.isSubmitting()).toBe(true);
    expect(fixture.nativeElement.querySelector('button[aria-busy="true"]').disabled).toBe(true);

    await component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    req.flush({ code: 'sess1' });
    await pending;
    expect(component.isSubmitting()).toBe(false);
  });

  it('preserves reviews and idempotency key when creation fails, then retries safely', async () => {
    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.rawText.set('1. Alice');
    component.rosterReviews.set([
      { inputName: 'Alice', match: { type: 'new' }, decision: 'accept' },
    ]);
    component.state.set('confirm');

    const failedCreate = component.confirmRoster();
    const first = httpMock.expectOne(`${B}/sessions`);
    const idempotencyKey = first.request.body.idempotencyKey;
    first.flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedCreate;

    expect(component.confirmError()).toContain('สร้างก๊วนไม่สำเร็จ');
    expect(component.isSubmitting()).toBe(false);
    expect(component.rosterReviews()).toHaveLength(1);

    const retry = component.confirmRoster();
    const second = httpMock.expectOne(`${B}/sessions`);
    expect(second.request.body.idempotencyKey).toBe(idempotencyKey);
    second.flush({ code: 'sess1' });
    await retry;
  });

  it('confirmRoster trims a whitespace-only venue to null', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.venue.set('   ');

    const confirmPromise = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body).toMatchObject({ venue: null });
    req.flush({ code: 'sess1' });
    await confirmPromise;
  });

  it('saveGroupName sends the group name via renameGroup', async () => {
    component.groupName.set('Group A');
    const save = component.saveGroupName();

    const req = httpMock.expectOne(`${B}/groups/group1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'Group A' });
    req.flush({ code: 'group1', name: 'Group A' });
    await save;
  });

  it('preserves the group name and allows a retry when renaming fails', async () => {
    component.groupName.set('Group A');
    const failedSave = component.saveGroupName();
    expect(component.isRenaming()).toBe(true);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedSave;

    expect(component.groupName()).toBe('Group A');
    expect(component.renameError()).toContain('บันทึกชื่อก๊วนไม่สำเร็จ');
    expect(component.isRenaming()).toBe(false);

    const retry = component.saveGroupName();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'Group A' });
    await retry;
    expect(component.renameError()).toBeNull();
  });

  it('lists past sessions for the group', async () => {
    // The default beforeEach flushed an empty list; re-create with real rows.
    httpMock.verify();
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'G', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([
      {
        code: 'sess9',
        date: '2026-09-08',
        venue: 'ยิมกลาง',
        courtCount: 2,
        createdAt: '2026-09-08T10:00:00.000Z',
        endedAt: null,
        matchCount: 4,
      },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('2026-09-08');
    expect(text).toContain('ยิมกลาง');
    expect(text).toContain('ยังไม่จบ');
  });

  it('only enables delete once the group name is typed back', async () => {
    component.groupName.set('ก๊วนอังคาร');
    expect(component.canDelete()).toBe(false);

    component.deleteConfirmText.set('ผิด');
    expect(component.canDelete()).toBe(false);

    component.deleteConfirmText.set('ก๊วนอังคาร');
    expect(component.canDelete()).toBe(true);
  });

  it('does not delete when the confirmation does not match', async () => {
    component.groupName.set('ก๊วนอังคาร');
    component.deleteConfirmText.set('อะไรก็ไม่รู้');
    await component.deleteGroup();
    // No request at all — httpMock.verify() in afterEach proves it.
    expect(component.canDelete()).toBe(false);
  });

  it('deletes the group and returns to the landing page', async () => {
    component.groupName.set('ก๊วนอังคาร');
    component.deleteConfirmText.set('ก๊วนอังคาร');
    const promise = component.deleteGroup();

    const req = httpMock.expectOne(`${B}/groups/group1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ code: 'group1', deleted: true });
    await promise;
  });
});

describe('GroupEntry with an existing group', () => {
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('prefills groupName and lastSessionCode from the fetched Group', async () => {
    httpMock
      .expectOne(`${environment.apiBaseUrl}/groups/group1`)
      .flush({ code: 'group1', name: 'Group A', lastSessionCode: 'sess1' });
    httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/sessions`).flush([]);
    await fixture.whenStable();

    expect(fixture.componentInstance.groupName()).toBe('Group A');
    expect(fixture.componentInstance.lastSessionCode()).toBe('sess1');
  });
});