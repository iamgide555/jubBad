import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { RosterDraftService, type RosterDraft } from '../../core/roster-draft.service';
import { standardLadderFixture } from '../../core/group-levels.testing';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

/** Four brand-new-player reviews — the roster's `minRoster` floor — for tests
 *  that need to clear the minimum without that being what's under test. */
function fourNewPlayers() {
  return [
    { inputName: 'ตั้ม', match: { type: 'new' as const } },
    { inputName: 'เกียร์', match: { type: 'new' as const } },
    { inputName: 'มด', match: { type: 'new' as const } },
    { inputName: 'มะนาว', match: { type: 'new' as const } },
  ];
}

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

    // Constructor reads the saved group. The group always exists before this
    // screen now — it is created at /groups/new.
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await fixture.whenStable();
  });

  afterEach(() => {
    // The review opens a read of the group's ladder, not the subject of most tests here.
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    TestBed.inject(RosterDraftService).clear('group1');
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });


  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('shows both the paste-roster and manual-start buttons on the paste screen', () => {
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.some((b) => b.textContent?.trim() === 'อ่านรายชื่อ')).toBe(true);
    expect(buttons.some((b) => b.textContent?.trim() === 'เพิ่มรายชื่อเอง')).toBe(true);
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

  it('startManual reads the group players and lands on an empty confirm screen without parsing', async () => {
    component.rawText.set('leftover');
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await done;
    httpMock.expectNone(`${B}/groups/group1/parse`);
    expect(component.state()).toBe('confirm');
    expect(component.rosterReviews()).toEqual([]);
    expect(component.waitlistReviews()).toEqual([]);
    expect(component.rawText()).toBe('');
    expect(component.warnings()).toEqual([]);
    // Today is the starting default for an ad-hoc night.
    expect(component.date().length).toBeGreaterThan(0);
  });

  it('startManual allows a retry when reading players fails', async () => {
    const first = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush('x', { status: 500, statusText: 'x' });
    await first;
    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('อ่านรายชื่อไม่สำเร็จ');

    const second = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await second;
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

  it('setDecision sets a review to the chosen decision', async () => {
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
    expect(review.decision).toBe('reject-new');
    component.setDecision(review, 'accept');
    expect(component.rosterReviews()[0].decision).toBe('accept');
    component.setDecision(component.rosterReviews()[0], 'reject-new');
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
    // row. Setting the second must change the second, not redraw the first.
    // Answering the (initially open) duplicate row also collapses it, same
    // as the already-closed exact row above it — both end up as a single
    // "change answer" link.
    component.setDecision(component.rosterReviews()[1], 'accept');
    fixture.detectChanges();

    const rowLabels = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.review-list .review-row'
    );
    const labelsPerRow = Array.from(rowLabels).map((row) =>
      Array.from(row.querySelectorAll('button')).map((b) => b.textContent!.trim())
    );
    expect(labelsPerRow).toEqual([['เปลี่ยนคำตอบ'], ['เปลี่ยนคำตอบ']]);
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
    expect(component.decisionLabel(duplicate, 'accept')).toBe('คนเดียวกัน');
    expect(component.decisionLabel(duplicate, 'reject-new')).toBe('คนละคน');
    component.setDecision(duplicate, 'accept');
    expect(component.rosterReviews()[1].decision).toBe('accept');
  });

  it('canConfirm is false until date and courtCount are set', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
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

  it('canConfirm is false below the minimum roster size, even with date and courtCount set', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: fourNewPlayers().slice(0, 3),
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    expect(component.acceptedRosterCount()).toBe(3);
    expect(component.canConfirm()).toBe(false);
  });

  it('an accepted duplicate does not count as an extra player towards the minimum', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม (1)\n2. ตั้ม (2)\n3. มด\n4. มะนาว');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: [
        { inputName: 'ตั้ม (1)', match: { type: 'exact', playerId: 'p1' } },
        { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' } },
        { inputName: 'มด', match: { type: 'new' } },
        { inputName: 'มะนาว', match: { type: 'new' } },
      ],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    // Duplicate row starts as reject-new ("คนละคน") — a genuinely distinct
    // fourth person, clearing the minimum.
    expect(component.acceptedRosterCount()).toBe(4);
    expect(component.canConfirm()).toBe(true);

    // Accepting "same person" collapses it onto p1's id instead of adding a
    // fourth distinct player, dropping back below the minimum.
    component.setDecision(component.rosterReviews()[1], 'accept');
    expect(component.acceptedRosterCount()).toBe(3);
    expect(component.canConfirm()).toBe(false);
  });

  it('confirmRoster posts the resolved reviews and navigates to the new session', async () => {
    const router = TestBed.inject(Router);
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
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
    component.rosterReviews.set(
      fourNewPlayers().map((r) => ({ ...r, decision: 'accept' as const }))
    );
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
    component.rosterReviews.set(
      fourNewPlayers().map((r) => ({ ...r, decision: 'accept' as const }))
    );
    component.state.set('confirm');

    const failedCreate = component.confirmRoster();
    const first = httpMock.expectOne(`${B}/sessions`);
    const idempotencyKey = first.request.body.idempotencyKey;
    first.flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedCreate;

    expect(component.confirmError()).toContain('สร้างรอบไม่สำเร็จ');
    expect(component.isSubmitting()).toBe(false);
    expect(component.rosterReviews()).toHaveLength(4);

    const retry = component.confirmRoster();
    const second = httpMock.expectOne(`${B}/sessions`);
    expect(second.request.body.idempotencyKey).toBe(idempotencyKey);
    second.flush({ code: 'sess1' });
    await retry;
  });

  it('confirmRoster trims a whitespace-only venue to null', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
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

  it('names the group in a back link to group home', () => {
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    expect(back.textContent).toContain('ก๊วนทดสอบ');
    expect(back.getAttribute('href')).toBe('/g/group1');
  });

  it('titles a group without sessions เริ่มรอบแรก', () => {
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('เริ่มรอบแรก');
  });

  it('keeps no settings on this screen', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('ตั้งค่าขั้นสูง');
    expect(text).not.toContain('ลบก๊วนนี้');
    expect(fixture.nativeElement.querySelector('app-share-dashboard-panel')).toBeNull();
  });

  it('restores a pasted draft after leaving and coming back', async () => {
    component.rawText.set('1. ตั้ม\n2. มด');
    fixture.destroy();

    const again = TestBed.createComponent(GroupEntry);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await again.whenStable();
    expect(again.componentInstance.rawText()).toBe('1. ตั้ม\n2. มด');
    again.destroy();
  });

  it('restores a confirm-step draft — reviews, manual rows and the idempotency key — after a settings detour', async () => {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await done;
    component.addExisting('p1');
    const review = component.rosterReviews()[0];
    expect(component.isManualReview(review)).toBe(true);
    // The key is minted on the first create attempt; a retry after the detour must reuse it.
    (component as unknown as { creationIdempotencyKey: string | null }).creationIdempotencyKey = 'key-1';
    fixture.destroy();

    const again = TestBed.createComponent(GroupEntry);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await again.whenStable();
    const restored = again.componentInstance;
    expect(restored.state()).toBe('confirm');
    expect(restored.rosterReviews()).toHaveLength(1);
    expect(restored.isManualReview(restored.rosterReviews()[0])).toBe(true);
    expect((restored as unknown as { creationIdempotencyKey: string | null }).creationIdempotencyKey).toBe('key-1');
    again.destroy();
  });

  it('clears the draft once the session is created', async () => {
    // Start from a restored draft, so the draft exists in the service when the session is made.
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    fixture.destroy();
    expect(TestBed.inject(RosterDraftService).get('group1')).not.toBeNull();
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await fixture.whenStable();
    expect(component.rawText()).toBe('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;
    component.date.set('2026-09-08');
    component.courtCount.set(2);

    const confirmPromise = component.confirmRoster();
    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await confirmPromise;
    fixture.destroy();
    expect(TestBed.inject(RosterDraftService).get('group1')).toBeNull();
  });

  it('discardDraft empties the roster and returns to the paste box', async () => {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await done;
    component.rawText.set('1. ตั้ม');
    component.manualQuery.set('น้องใหม่');
    component.addNew();
    expect(component.rosterReviews()).toHaveLength(1);
    component.discardDraft();
    expect(component.state()).toBe('paste');
    expect(component.rawText()).toBe('');
    expect(component.rosterReviews()).toEqual([]);
    expect(TestBed.inject(RosterDraftService).get('group1')).toBeNull();
  });

  it('a missing group is not found here too, with no paste box', async () => {
    fixture.destroy();
    const again = TestBed.createComponent(GroupEntry);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    await again.whenStable();
    expect(again.nativeElement.textContent).toContain('ไม่พบก๊วนนี้');
    expect(again.nativeElement.querySelector('textarea')).toBeNull();
    again.destroy();
  });
});

// Template-level smoke tests for Task 2's manual-add UI. Task 1's own
// signals/actions (manualQuery, manualCandidates, manualMatchState,
// addExisting, addNew, removeManual) have their own coverage above and in
// roster-review.spec.ts; these only check the template wiring Task 2 adds on
// top, per the brief's three required self-review items. Task 3 owns the
// exhaustive behavioral suite.
describe('GroupEntry manual roster add UI (Task 2)', () => {
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

    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'Group A', lastSessionCode: null });
    await fixture.whenStable();

    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เกียร์', aliases: [] },
    ]);
    await parsePromise;
    fixture.detectChanges();
  });

  afterEach(() => {
    // The review opens a read of the group's ladder, not the subject of most tests here.
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    httpMock.verify();
  });

  function reviewRowFor(name: string): HTMLElement {
    const rows = [...fixture.nativeElement.querySelectorAll('.review-row')] as HTMLElement[];
    const row = rows.find((r) => r.textContent?.includes(name));
    if (!row) throw new Error(`no review row found containing "${name}"`);
    return row;
  }

  it('shows a remove control instead of the imported yes/no toggle for a manually added existing player', () => {
    component.addExisting('p2');
    fixture.detectChanges();

    const row = reviewRowFor('เกียร์');
    const buttonLabels = [...row.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttonLabels.some((t) => t?.includes('เปลี่ยนคำตอบ'))).toBe(false);
    expect(buttonLabels.some((t) => t?.includes('นำออก'))).toBe(true);
  });

  it('shows a remove control instead of any toggle for a manually staged new player', () => {
    component.manualQuery.set('น้องใหม่');
    component.addNew();
    fixture.detectChanges();

    const row = reviewRowFor('น้องใหม่');
    expect(row.textContent).toContain('คนใหม่');
    const buttonLabels = [...row.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttonLabels.some((t) => t?.includes('เปลี่ยนคำตอบ'))).toBe(false);
    expect(buttonLabels.some((t) => t?.includes('นำออก'))).toBe(true);
  });

  it('removes only the manual row when its remove control is clicked', () => {
    component.addExisting('p2');
    fixture.detectChanges();
    const before = component.rosterReviews().length;

    const row = reviewRowFor('เกียร์');
    const removeBtn = [...row.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('นำออก')
    )!;
    removeBtn.click();
    fixture.detectChanges();

    expect(component.rosterReviews().length).toBe(before - 1);
    expect(component.rosterReviews().some((r) => r.inputName === 'เกียร์')).toBe(false);
    expect(component.rosterReviews().some((r) => r.inputName === 'ตั้ม')).toBe(true);
  });

  it('does not offer "add as new" for an empty query, and offers it once non-empty text has no exact match', () => {
    expect(component.manualQuery()).toBe('');
    expect(component.manualShowAddNew()).toBe(false);

    component.onManualQueryChange('ผู้เล่นใหม่');
    fixture.detectChanges();

    // manualMatchState() alone reports 'no-match' both for a blank query and
    // a genuine miss — manualShowAddNew must not rely on that distinction.
    expect(component.manualMatchState().kind).toBe('no-match');
    expect(component.manualShowAddNew()).toBe(true);
  });

  it('hides "add as new" once the query exactly matches an already-selected player', () => {
    // p1 ("ตั้ม") is already claimed by the imported row from parse().
    component.onManualQueryChange('ตั้ม');
    fixture.detectChanges();

    expect(component.manualMatchState().kind).toBe('exact-match-already-selected');
    expect(component.manualShowAddNew()).toBe(false);
  });

  it('hides "add as new" when the query exactly matches an unclaimed existing player', () => {
    // p2 ("เกียร์") is a real player but not yet claimed by any review row —
    // addNew()'s own exactPlayerMatch guard would reject this query, so the
    // UI must not dangle a clickable "add as new" option for it; the query
    // should instead route the user to select the existing player.
    component.onManualQueryChange('เกียร์');
    fixture.detectChanges();

    expect(component.manualMatchState().kind).toBe('exact-match-available');
    expect(component.manualShowAddNew()).toBe(false);
  });

  it('clears a stale manualAddError as soon as the query is edited', () => {
    component.manualAddError.set('ข้อผิดพลาดเก่า');
    component.onManualQueryChange('x');
    expect(component.manualAddError()).toBeNull();
  });

  it('ignores Enter while IME composition is in progress', () => {
    component.onManualQueryChange('ตั้มมี่');
    fixture.detectChanges();
    const before = component.rosterReviews().length;
    const input = fixture.nativeElement.querySelector('#manual-add-input') as HTMLInputElement;
    component.manualActiveIndex.set(0);

    component.onManualKeydown({
      isComposing: true,
      key: 'Enter',
      target: input,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);

    expect(component.rosterReviews().length).toBe(before);
  });

  it('disables the manual-add input while isSubmitting is true', async () => {
    component.date.set('2026-09-08');
    component.courtCount.set(1);
    // Base roster from beforeEach is just 'ตั้ม' — pad to the minimum so
    // confirmRoster() actually fires instead of a canConfirm() no-op.
    component.addExisting('p2');
    component.manualQuery.set('คนที่สาม');
    component.addNew();
    component.manualQuery.set('คนที่สี่');
    component.addNew();
    const confirmPromise = component.confirmRoster();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('#manual-add-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await confirmPromise;
  });
});

// Exhaustive behavioral coverage for the manual roster-add control (Task 3).
// Task 1/2 own the focused unit tests and template smoke tests above; these
// exercise the full end-to-end wiring: typing, selecting, keyboard
// navigation, submission failure, and reparse reset. Player pool:
// - p1 "ตั้ม"     — claimed by the imported row from parse()
// - p2 "เกียร์"    — unclaimed, single exact match for its own name
// - p3 "มด"       — unclaimed, shares the "ม" prefix with p4
// - p4 "มะนาว"    — unclaimed, shares the "ม" prefix with p3
describe('GroupEntry manual roster add — behavior (Task 3)', () => {
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

    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'Group A', lastSessionCode: null });
    await fixture.whenStable();

    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 1 },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เกียร์', aliases: [] },
      { id: 'p3', name: 'มด', aliases: [] },
      { id: 'p4', name: 'มะนาว', aliases: [] },
    ]);
    await parsePromise;
    fixture.detectChanges();
  });

  afterEach(() => {
    // The review opens a read of the group's ladder, not the subject of most tests here.
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    httpMock.verify();
  });

  function manualInput(): HTMLInputElement {
    return fixture.nativeElement.querySelector('#manual-add-input') as HTMLInputElement;
  }

  function keydown(key: string, extra: Partial<KeyboardEvent> = {}): void {
    component.onManualKeydown({
      isComposing: false,
      key,
      target: manualInput(),
      preventDefault: () => {},
      ...extra,
    } as unknown as KeyboardEvent);
  }

  it('adds an existing player end-to-end via selectManualCandidate and clears the query', () => {
    component.onManualQueryChange('เกียร์');
    fixture.detectChanges();

    const candidate = component.manualCandidates().find((c) => c.player.id === 'p2')!;
    expect(candidate).toBeTruthy();
    component.selectManualCandidate(candidate, manualInput());

    expect(component.rosterReviews()).toContainEqual({
      inputName: 'เกียร์',
      match: { type: 'exact', playerId: 'p2' },
      decision: 'accept',
    });
    expect(component.manualQuery()).toBe('');
  });

  it('adds a brand-new player end-to-end via confirmAddNew', () => {
    component.onManualQueryChange('คนใหม่มาก');
    fixture.detectChanges();

    component.confirmAddNew(manualInput());

    expect(component.rosterReviews()).toContainEqual({
      inputName: 'คนใหม่มาก',
      match: { type: 'new' },
      decision: 'accept',
    });
  });

  it('recomputes claimedIds/manualCandidates when an imported decision changes', () => {
    expect(component.claimedIds().has('p1')).toBe(true);
    component.manualQuery.set('ตั้ม');
    expect(component.manualCandidates()).toEqual([]);

    const importedP1 = component.rosterReviews().find((r) => !component.isManualReview(r))!;
    component.setDecision(importedP1, 'reject-new');

    expect(component.claimedIds().has('p1')).toBe(false);
    expect(component.manualCandidates().map((c) => c.player.id)).toContain('p1');

    component.setDecision(component.rosterReviews()[0], 'accept');
    expect(component.claimedIds().has('p1')).toBe(true);
    expect(component.manualCandidates()).toEqual([]);
  });

  it('rejects a whitespace-only confirmAddNew with an error and no row added', () => {
    component.onManualQueryChange('   ');
    fixture.detectChanges();
    const before = component.rosterReviews().length;

    component.confirmAddNew(manualInput());

    expect(component.manualAddError()).toBeTruthy();
    expect(component.rosterReviews().length).toBe(before);
  });

  it('rejects a second literal-duplicate new draft, case-insensitively', () => {
    component.onManualQueryChange('Newbie');
    fixture.detectChanges();
    component.confirmAddNew(manualInput());
    const afterFirst = component.rosterReviews().length;

    component.onManualQueryChange('newbie');
    fixture.detectChanges();
    component.confirmAddNew(manualInput());

    expect(component.manualAddError()).toBeTruthy();
    expect(component.rosterReviews().length).toBe(afterFirst);
  });

  it('removeManualRow removes a manual existing-player addition and makes it searchable again', () => {
    component.addExisting('p2');
    fixture.detectChanges();
    const review = component.rosterReviews().find((r) => r.match.type === 'exact' && r.match.playerId === 'p2')!;

    component.removeManualRow(review);

    expect(component.rosterReviews().some((r) => r.match.type === 'exact' && r.match.playerId === 'p2')).toBe(
      false
    );
    component.manualQuery.set('เกียร์');
    expect(component.manualCandidates().map((c) => c.player.id)).toContain('p2');
  });

  it('ignores a rapid second tap on the same candidate — only one row is added', () => {
    component.onManualQueryChange('เกียร์');
    fixture.detectChanges();
    const candidate = component.manualCandidates().find((c) => c.player.id === 'p2')!;

    component.selectManualCandidate(candidate, manualInput());
    component.selectManualCandidate(candidate, manualInput());

    const p2Rows = component
      .rosterReviews()
      .filter((r) => r.match.type === 'exact' && r.match.playerId === 'p2');
    expect(p2Rows).toHaveLength(1);
  });

  it('arrow-key navigation wraps at both ends of the combined candidate + add-new list', () => {
    component.onManualQueryChange('ม');
    fixture.detectChanges();

    // "มด" and "มะนาว" both match by prefix; no exact match exists for "ม",
    // so "add as new" is also offered — 3 options total.
    expect(component.manualCandidates().map((c) => c.player.id).sort()).toEqual(['p3', 'p4']);
    expect(component.manualShowAddNew()).toBe(true);

    expect(component.manualActiveIndex()).toBe(-1);
    keydown('ArrowDown');
    expect(component.manualActiveIndex()).toBe(0);
    keydown('ArrowDown');
    expect(component.manualActiveIndex()).toBe(1);
    keydown('ArrowDown');
    expect(component.manualActiveIndex()).toBe(2);
    keydown('ArrowDown');
    expect(component.manualActiveIndex()).toBe(0); // wraps forward past the end

    keydown('ArrowUp');
    expect(component.manualActiveIndex()).toBe(2); // wraps backward past the start
  });

  it('Escape dismisses suggestions and clears the active index without clearing the typed query', () => {
    component.onManualQueryChange('ม');
    fixture.detectChanges();
    component.manualActiveIndex.set(1);

    keydown('Escape');

    expect(component.manualShowSuggestions()).toBe(false);
    expect(component.manualActiveIndex()).toBe(-1);
    expect(component.manualQuery()).toBe('ม');
  });

  it('preserves manual additions on a failed confirmRoster and reuses the idempotency key on retry', async () => {
    component.addExisting('p2');
    component.addExisting('p3');
    component.onManualQueryChange('คนใหม่มาก');
    fixture.detectChanges();
    component.confirmAddNew(manualInput());
    component.date.set('2026-09-08');
    component.courtCount.set(1);

    const failedCreate = component.confirmRoster();
    const first = httpMock.expectOne(`${B}/sessions`);
    const idempotencyKey = first.request.body.idempotencyKey;
    first.flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedCreate;

    expect(component.confirmError()).toBeTruthy();
    expect(component.rosterReviews().some((r) => r.match.type === 'exact' && r.match.playerId === 'p2')).toBe(
      true
    );
    expect(component.rosterReviews().some((r) => r.match.type === 'new' && r.inputName === 'คนใหม่มาก')).toBe(
      true
    );

    const retry = component.confirmRoster();
    const second = httpMock.expectOne(`${B}/sessions`);
    expect(second.request.body.idempotencyKey).toBe(idempotencyKey);
    second.flush({ code: 'sess1' });
    await retry;
  });

  it('a successful reparse clears rosterReviews, manualQuery, and manualAddError', async () => {
    component.addExisting('p2');
    component.manualQuery.set('leftover query');
    component.manualAddError.set('leftover error');

    component.groupName.set('Group A');
    component.rawText.set('1. เกียร์');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-09', venue: null, courtCount: 1 },
      rosterReviews: [{ inputName: 'เกียร์', match: { type: 'exact', playerId: 'p2' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เกียร์', aliases: [] },
    ]);
    await parsePromise;

    expect(component.rosterReviews()).toEqual([
      { inputName: 'เกียร์', match: { type: 'exact', playerId: 'p2' }, decision: 'accept' },
    ]);
    expect(component.manualQuery()).toBe('');
    expect(component.manualAddError()).toBeNull();
  });

  it('a failed reparse leaves manual query, error, and rows untouched', async () => {
    component.addExisting('p2');
    component.manualQuery.set('leftover query');
    component.manualAddError.set('leftover error');
    const before = component.rosterReviews();

    component.rawText.set('1. เกียร์');
    const failedParse = component.parse();
    httpMock
      .expectOne(`${B}/groups/group1/parse`)
      .flush('Server error', { status: 500, statusText: 'Server Error' });
    await failedParse;

    expect(component.rosterReviews()).toBe(before);
    expect(component.manualQuery()).toBe('leftover query');
    expect(component.manualAddError()).toBe('leftover error');
  });

  it('adds a Thai name with a parenthetical label through the full add-new flow', () => {
    component.onManualQueryChange('ตั้ม (2)');
    fixture.detectChanges();

    component.confirmAddNew(manualInput());

    expect(component.rosterReviews()).toContainEqual({
      inputName: 'ตั้ม (2)',
      match: { type: 'new' },
      decision: 'accept',
    });
  });

  it('once every existing player is claimed, manualCandidates is empty but "add as new" stays available for an unmatched name', () => {
    component.addExisting('p2');
    component.addExisting('p3');
    component.addExisting('p4');

    // "ตั้ม" is p1, already claimed by the imported row.
    component.onManualQueryChange('ตั้ม');
    fixture.detectChanges();
    expect(component.manualCandidates()).toEqual([]);
    expect(component.manualMatchState().kind).toBe('exact-match-already-selected');
    expect(component.manualShowAddNew()).toBe(false);

    component.onManualQueryChange('คนใหม่มาก');
    fixture.detectChanges();
    expect(component.manualCandidates()).toEqual([]);
    expect(component.manualMatchState().kind).toBe('no-match');
    expect(component.manualShowAddNew()).toBe(true);
  });
});

describe('GroupEntry roster review and group ladders (host feedback F)', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;
  const custom = {
    mode: 'custom' as const,
    revision: 6,
    levels: [{ id: 'x', name: 'BG', startingElo: 1000 }, { id: 'y', name: 'BGN', startingElo: 1100 }, { id: 'z', name: 'N', startingElo: 1200 }],
    assignedCounts: { x: 0, y: 0, z: 0 },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'Group A', lastSessionCode: null });
    await fixture.whenStable();
  });
  afterEach(() => httpMock.verify());

  /** Parses the group's roster; the review opens, and reads the ladder, once the parse returns. */
  async function openReview(ladder: object | 'fail') {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    const parsing = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsing;
    const req = httpMock.expectOne(`${B}/groups/group1/levels`);
    if (ladder === 'fail') req.flush('x', { status: 500, statusText: 'Server Error' });
    else req.flush(ladder);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('reads the ladder once the review opens, and offers its own names to new players', async () => {
    await openReview(custom);
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.review-row app-level-picker')][0].querySelectorAll('.chip');
    expect([...chips].map((b) => b.textContent!.trim())).toEqual(['-', 'BG', 'BGN', 'N']);
  });

  it('a failed ladder read disables the level choice on every new player', async () => {
    await openReview('fail');
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.review-row app-level-picker .chip')] as HTMLButtonElement[];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((b) => b.disabled)).toBe(true);
  });

  it('creating a session with a chosen level sends the ladder revision that was read', async () => {
    await openReview(custom);
    component.setLevel(component.rosterReviews()[0], 'BGN');
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    const creating = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body.expectedLadderRevision).toBe(6);
    expect(req.request.body.rosterReviews[0].level).toBe('BGN');
    req.flush({ code: 'sess1' });
    await creating;
  });

  it('a session with no level choice sends no revision', async () => {
    await openReview(custom);
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    const creating = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body.expectedLadderRevision).toBeUndefined();
    req.flush({ code: 'sess1' });
    await creating;
  });

  it('an old tab\'s label after the ladder changed is a visible conflict: no session, ladder reread, stale label dropped', async () => {
    await openReview(custom);
    component.setLevel(component.rosterReviews()[0], 'BGN');
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    const creating = component.confirmRoster();
    httpMock.expectOne(`${B}/sessions`).flush({ code: 'LEVEL_LADDER_STALE' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    // The ladder was switched elsewhere to one that has no BGN.
    httpMock.expectOne(`${B}/groups/group1/levels`).flush({ ...custom, revision: 7, levels: [{ id: 'q', name: 'ใหม่', startingElo: 1200 }] });
    await creating;
    expect(component.confirmError()).toContain('มีการแก้ระดับ');
    expect(component.rosterReviews()[0].level).toBeUndefined();
    expect(component.ladder()?.revision).toBe(7);
  });
});

// UX review: the review step's discard used to be its first, irreversible control and wiped
// the paste with it. It now sits last, says ล้างรายชื่อ, and can be taken back for a few
// seconds; a pasted roster can also go back to its text without losing it.
describe('GroupEntry review step: clear with undo, edit the paste (UX review)', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;
  const PASTE = '1. ตัม\n2. เกียร์';
  const el = () => fixture.nativeElement as HTMLElement;
  const undoButton = () => el().querySelector<HTMLButtonElement>('[role="status"] [data-undo]');
  const buttonByText = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text) ?? null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await render();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    TestBed.inject(RosterDraftService).clear('group1');
    httpMock.verify();
  });

  async function render(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /** By default a pasted roster with one fuzzy question (opens a choice) and one new player. */
  async function parsePasted(
    text = PASTE,
    rosterReviews: object[] = [
      { inputName: 'ตัม', match: { type: 'fuzzy', playerId: 'p1', score: 0.8 } },
      { inputName: 'เกียร์', match: { type: 'new' } },
    ]
  ): Promise<void> {
    component.rawText.set(text);
    const parsing = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: 'KIP', courtCount: 2 },
      rosterReviews,
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsing;
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
    await render();
  }

  async function startManualRoster(): Promise<void> {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await done;
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
    await render();
  }

  const key = () => (component as unknown as { creationIdempotencyKey: string | null }).creationIdempotencyKey;
  const setKey = (k: string) =>
    ((component as unknown as { creationIdempotencyKey: string | null }).creationIdempotencyKey = k);

  it('labels the paste box: the label points at the textarea', () => {
    const textarea = el().querySelector('textarea')!;
    expect(textarea.id).toBe('roster-text');
    const label = el().querySelector<HTMLLabelElement>(`label[for="${textarea.id}"]`);
    expect(label?.textContent).toContain('ข้อความรายชื่อ');
  });

  it('puts ล้างรายชื่อ after the confirm button, never as the review step\'s first control', async () => {
    await parsePasted();
    const discard = el().querySelector<HTMLButtonElement>('[data-discard]')!;
    const confirm = buttonByText('ยืนยันรายชื่อ')!;
    expect(discard.textContent!.trim()).toBe('ล้างรายชื่อ');
    expect(discard.classList).toContain('ghost');
    expect(confirm.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el().querySelector('button')).not.toBe(discard);
  });

  it('the confirm button spans the container', async () => {
    await parsePasted();
    const confirm = buttonByText('ยืนยันรายชื่อ')!;
    expect(confirm.classList).toContain('confirm-roster');
    expect(getComputedStyle(confirm).width).toBe('100%');
  });

  it('clearing offers an undo above the paste box that brings the whole review back', async () => {
    await parsePasted();
    component.manualQuery.set('น้องใหม่');
    component.addNew();
    component.date.set('2026-09-20');
    component.courtCount.set(3);
    setKey('key-1');
    const before = component.rosterReviews();
    expect(component.isOpen(before[0])).toBe(true);
    expect(component.isManualReview(before[2])).toBe(true);
    await render();

    el().querySelector<HTMLButtonElement>('[data-discard]')!.click();
    await render();
    expect(component.state()).toBe('paste');
    expect(component.rosterReviews()).toEqual([]);
    expect(component.rawText()).toBe('');
    expect(key()).toBeNull();
    expect(undoButton()?.textContent?.trim()).toBe('เลิกทำ');
    expect(undoButton()!.closest('[role="status"]')!.textContent).toContain('ล้างรายชื่อแล้ว');
    expect(undoButton()!.compareDocumentPosition(el().querySelector('textarea')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    undoButton()!.click();
    await render();
    expect(component.state()).toBe('confirm');
    expect(component.rawText()).toBe(PASTE);
    const restored = component.rosterReviews();
    expect(restored).toEqual(before);
    expect(component.isOpen(restored[0])).toBe(true);
    expect(component.isManualReview(restored[2])).toBe(true);
    expect(component.date()).toBe('2026-09-20');
    expect(component.courtCount()).toBe(3);
    expect(key()).toBe('key-1');
    expect(component.undoSnapshot()).toBeNull();
    expect(undoButton()).toBeNull();
    expect(el().textContent).not.toContain('ล้างรายชื่อแล้ว');
  });

  it('the undo offer lapses after 8 seconds, and undo does nothing afterwards', async () => {
    await parsePasted();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    component.discardDraft();
    fixture.detectChanges();
    expect(undoButton()).not.toBeNull();

    vi.advanceTimersByTime(7999);
    fixture.detectChanges();
    expect(component.undoSnapshot()).not.toBeNull();
    expect(undoButton()).not.toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(component.undoSnapshot()).toBeNull();
    expect(undoButton()).toBeNull();

    component.undoDiscard();
    expect(component.state()).toBe('paste');
    expect(component.rosterReviews()).toEqual([]);
    expect(component.rawText()).toBe('');
  });

  it('parsing again withdraws the undo offer', async () => {
    await parsePasted();
    component.discardDraft();
    expect(component.undoSnapshot()).not.toBeNull();

    await parsePasted('1. มด');
    expect(component.undoSnapshot()).toBeNull();
    expect(undoButton()).toBeNull();
    const after = component.rosterReviews();
    component.undoDiscard();
    expect(component.rosterReviews()).toBe(after);
    expect(component.rawText()).toBe('1. มด');
  });

  it('starting a manual roster withdraws the undo offer', async () => {
    await parsePasted();
    component.discardDraft();
    expect(component.undoSnapshot()).not.toBeNull();

    await startManualRoster();
    expect(component.undoSnapshot()).toBeNull();
    component.undoDiscard();
    expect(component.rosterReviews()).toEqual([]);
    expect(component.rawText()).toBe('');
  });

  it('typing new text into the paste box withdraws the undo offer', async () => {
    await parsePasted();
    component.discardDraft();
    await render();
    expect(undoButton()).not.toBeNull();

    const textarea = el().querySelector('textarea')!;
    textarea.value = '1. คนใหม่';
    textarea.dispatchEvent(new Event('input'));
    await render();
    expect(component.rawText()).toBe('1. คนใหม่');
    expect(component.undoSnapshot()).toBeNull();
    expect(undoButton()).toBeNull();
    component.undoDiscard();
    expect(component.state()).toBe('paste');
    expect(component.rawText()).toBe('1. คนใหม่');
  });

  it('creating the session withdraws the undo offer', async () => {
    await parsePasted();
    component.discardDraft();
    expect(component.undoSnapshot()).not.toBeNull();
    // Back to a confirmable review without going through undo.
    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.rosterReviews.set(fourNewPlayers().map((r) => ({ ...r, decision: 'accept' as const })));
    component.state.set('confirm');

    const creating = component.confirmRoster();
    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await creating;
    expect(component.undoSnapshot()).toBeNull();
    const after = component.rosterReviews();
    component.undoDiscard();
    expect(component.rosterReviews()).toBe(after);
  });

  it('a clear tapped after the session was created never brings the roster back', async () => {
    await parsePasted();
    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.rosterReviews.set(fourNewPlayers().map((r) => ({ ...r, decision: 'accept' as const })));
    const creating = component.confirmRoster();
    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await creating;

    // A late tap while the dashboard is opening.
    component.discardDraft();
    component.undoDiscard();
    expect(component.state()).toBe('paste');
    expect(component.rosterReviews()).toEqual([]);
  });

  it('leaving with an undo pending clears its timer and saves no draft from it', async () => {
    await parsePasted();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      component.discardDraft();
      const call = setSpy.mock.calls.findIndex((c) => c[1] === 8000);
      expect(call).toBeGreaterThanOrEqual(0);
      const timer = setSpy.mock.results[call].value;
      fixture.destroy();
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect(component.undoSnapshot()).toBeNull();
      // The live screen was an empty paste box: nothing to keep, and the cleared roster is not it.
      expect(TestBed.inject(RosterDraftService).get('group1')).toBeNull();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('a pasted roster can go back to its text: the paste box returns with the text kept', async () => {
    await parsePasted();
    const edit = el().querySelector<HTMLButtonElement>('[data-edit-paste]')!;
    expect(edit.textContent!.trim()).toBe('← แก้ข้อความที่วาง');
    expect(edit.classList).toContain('ghost');
    // Directly under the title: the review's first control, before the date and the roster.
    expect(el().querySelector('button')).toBe(edit);
    expect(el().querySelector('h1')!.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(edit.compareDocumentPosition(el().querySelector('input[type="date"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    edit.click();
    await render();
    expect(component.state()).toBe('paste');
    expect(component.rawText()).toBe(PASTE);
    expect(el().querySelector('textarea')!.value).toBe(PASTE);

    fixture.destroy();
    const draft = TestBed.inject(RosterDraftService).get('group1');
    expect(draft?.state).toBe('paste');
    expect(draft?.rawText).toBe(PASTE);
  });

  it('a manual-start roster has no pasted text to go back to', async () => {
    await startManualRoster();
    expect(component.state()).toBe('confirm');
    expect(el().querySelector('[data-edit-paste]')).toBeNull();
  });

  // Fix round 1 (Task 3 review).

  /** Fails one create, so the attempt's idempotency key is minted; returns it. */
  async function failCreate(): Promise<string> {
    const creating = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    const sent = req.request.body.idempotencyKey as string;
    req.flush('Server error', { status: 500, statusText: 'Server Error' });
    await creating;
    expect(component.confirmError()).toContain('สร้างรอบไม่สำเร็จ');
    return sent;
  }

  it('a fresh parse after edit-paste is a fresh attempt: the failed attempt\'s idempotency key is not reused', async () => {
    await parsePasted(PASTE, fourNewPlayers());
    const first = await failCreate();
    expect(key()).toBe(first);

    component.editPaste();
    await parsePasted('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว\n5. ส้ม', fourNewPlayers());
    const creating = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body.idempotencyKey).toEqual(expect.any(String));
    expect(req.request.body.idempotencyKey).not.toBe(first);
    req.flush({ code: 'sess2' });
    await creating;
  });

  it('a draft restored after a detour is the same attempt: the failed attempt\'s key is kept', async () => {
    await parsePasted(PASTE, fourNewPlayers());
    const first = await failCreate();
    fixture.destroy();

    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
    await render();
    expect(component.state()).toBe('confirm');
    expect(key()).toBe(first);

    const creating = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body.idempotencyKey).toBe(first);
    req.flush({ code: 'sess1' });
    await creating;
  });

  it('a second clear while the undo is pending keeps the first snapshot, not an empty one', async () => {
    await parsePasted();
    component.discardDraft();
    const pending = component.undoSnapshot();
    expect(pending?.rosterReviews).toHaveLength(2);

    component.discardDraft();
    expect(component.undoSnapshot()).toBe(pending);
    component.undoDiscard();
    expect(component.state()).toBe('confirm');
    expect(component.rosterReviews()).toHaveLength(2);
    expect(component.rawText()).toBe(PASTE);
  });

  describe('focus at the moments a control disappears', () => {
    const textarea = () => el().querySelector<HTMLTextAreaElement>('#roster-text');

    it('the fixture is in the document, so focus is real', () => {
      expect(document.body.contains(el())).toBe(true);
    });

    it('after a clear, focus is on the undo button', async () => {
      await parsePasted();
      el().querySelector<HTMLButtonElement>('[data-discard]')!.focus();
      el().querySelector<HTMLButtonElement>('[data-discard]')!.click();
      expect(undoButton()).not.toBeNull();
      expect(document.activeElement).toBe(undoButton());
      await render();
      expect(document.activeElement).toBe(undoButton());
    });

    it('when the undo lapses while focused, focus moves to the paste box, not the page', async () => {
      await parsePasted();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      component.discardDraft();
      expect(document.activeElement).toBe(undoButton());
      vi.advanceTimersByTime(8000);
      fixture.detectChanges();
      expect(undoButton()).toBeNull();
      expect(document.activeElement).toBe(textarea());
    });

    it('when the undo lapses while focus is elsewhere, focus is left where the host put it', async () => {
      await parsePasted();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      component.discardDraft();
      const back = el().querySelector<HTMLAnchorElement>('a.back')!;
      back.focus();
      expect(document.activeElement).toBe(back);
      vi.advanceTimersByTime(8000);
      fixture.detectChanges();
      expect(document.activeElement).toBe(back);
    });

    it('after undo, focus returns to the clear button the host acted from', async () => {
      await parsePasted();
      component.discardDraft();
      undoButton()!.click();
      const discard = el().querySelector<HTMLButtonElement>('[data-discard]');
      expect(discard).not.toBeNull();
      expect(document.activeElement).toBe(discard);
      await render();
      expect(document.activeElement).toBe(el().querySelector('[data-discard]'));
    });

    it('after edit-paste, focus is in the paste box', async () => {
      await parsePasted();
      const edit = el().querySelector<HTMLButtonElement>('[data-edit-paste]')!;
      edit.focus();
      edit.click();
      expect(textarea()).not.toBeNull();
      expect(document.activeElement).toBe(textarea());
      await render();
      expect(document.activeElement).toBe(textarea());
    });
  });
});

describe('GroupEntry weekly paste path: autofocus and paste from the clipboard (UX review)', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;
  const ROSTER = '1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว';
  const GROUP = { code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null };
  const FALLBACK = 'วางเองในช่องด้านล่างได้เลย';
  const EMPTY = 'คลิปบอร์ดว่างอยู่ คัดลอกข้อความรายชื่อจาก LINE ก่อน';
  const el = () => fixture.nativeElement as HTMLElement;
  const textarea = () => el().querySelector<HTMLTextAreaElement>('#roster-text');
  const clipButton = () => el().querySelector<HTMLButtonElement>('[data-paste-clipboard]');
  // Reading the page is what the browser's own render would have done by then.
  const noteSlot = () => {
    fixture.detectChanges();
    return el().querySelector<HTMLElement>('[data-clipboard-note]');
  };
  const note = () => noteSlot()?.textContent?.trim() ?? '';
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const parseUrl = `${B}/groups/group1/parse`;

  // jsdom has no navigator.clipboard, so a stub is an own property to delete again, not one to put back.
  const stubClipboard = (value: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  const readingWith = (text: string) => ({ readText: vi.fn(() => Promise.resolve(text)) });
  /** `(pointer: fine)` answers `fine`; any other query answers the opposite, so only that query can decide. */
  const stubPointer = (fine: boolean) => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query === '(pointer: fine)' ? fine : !fine,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
    return matchMedia;
  };
  /** open() autofocuses the box, so a test about focus *arriving* there must first take focus away and prove it. */
  const leaveBox = () => {
    textarea()!.blur();
    expect(document.activeElement).not.toBe(textarea());
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    vi.useRealTimers();
    // A test that stopped early must not leave the next one a half-built TestBed.
    for (const req of httpMock.match(`${B}/groups/group1`)) req.flush(GROUP);
    for (const req of httpMock.match((r) => r.url.endsWith('/groups/group1/levels'))) req.flush(standardLadderFixture());
    TestBed.inject(RosterDraftService).clear('group1');
    httpMock.verify();
  });

  /** Opens the screen. `group: 'pending'` leaves the group request unanswered, as on a slow connection. */
  async function open(group: 'ready' | 'pending' = 'ready'): Promise<void> {
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    if (group === 'ready') {
      httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
      await fixture.whenStable();
    }
    fixture.detectChanges();
    await fixture.whenStable();
  }
  async function answerGroup(): Promise<void> {
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const seedDraft = (over: Partial<RosterDraft>) =>
    TestBed.inject(RosterDraftService).save('group1', {
      state: 'paste',
      rawText: '',
      date: '',
      venue: '',
      courtCount: null,
      warnings: [],
      unrecognizedLines: [],
      rosterReviews: [],
      waitlistReviews: [],
      players: [],
      manualReviews: new Set(),
      openReviews: new Set(),
      idempotencyKey: null,
      ...over,
    });
  const confirmDraft = (): Partial<RosterDraft> => ({
    state: 'confirm',
    rawText: ROSTER,
    date: '2026-09-08',
    courtCount: 2,
    rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' }, decision: 'accept' }],
  });

  /** Answers the parse and players reads a roster message sets going. */
  async function answerParse(rosterReviews: object[] = fourNewPlayers()): Promise<void> {
    httpMock.expectOne(parseUrl).flush({
      header: { isoDate: '2026-09-08', venue: null, courtCount: 2 },
      rosterReviews,
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await settle();
    if (rosterReviews.length > 0) httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
  }

  describe('autofocus', () => {
    it('focuses the empty paste box once the group has loaded, not before', async () => {
      await open('pending');
      expect(textarea()).not.toBeNull();
      expect(document.activeElement).not.toBe(textarea());
      await answerGroup();
      expect(document.activeElement).toBe(textarea());
    });

    it('focuses the box on a group that already has sessions too', async () => {
      await open('pending');
      expect(document.activeElement).not.toBe(textarea());
      httpMock.expectOne(`${B}/groups/group1`).flush({ ...GROUP, lastSessionCode: 's1' });
      await fixture.whenStable();
      expect(document.activeElement).toBe(textarea());
    });

    it('does not focus the box on a touch screen, where focus would open the keyboard over the clipboard button', async () => {
      const matchMedia = stubPointer(false);
      await open('pending');
      await answerGroup();
      expect(matchMedia).toHaveBeenCalledWith('(pointer: fine)');
      expect(document.activeElement).not.toBe(textarea());
      // The box and the button are there and usable; only the focus is withheld.
      expect(textarea()).not.toBeNull();
      expect(clipButton()!.disabled).toBe(false);
    });

    it('focuses the box with a mouse or trackpad (pointer: fine)', async () => {
      const matchMedia = stubPointer(true);
      await open('pending');
      expect(document.activeElement).not.toBe(textarea());
      await answerGroup();
      expect(matchMedia).toHaveBeenCalledWith('(pointer: fine)');
      expect(document.activeElement).toBe(textarea());
    });

    it('focuses the box where there is no matchMedia at all', async () => {
      expect((window as unknown as { matchMedia?: unknown }).matchMedia).toBeUndefined();
      await open('pending');
      expect(document.activeElement).not.toBe(textarea());
      await answerGroup();
      expect(document.activeElement).toBe(textarea());
    });

    it('does not focus the box while an undo is pending, even on a screen that did not come from a draft', async () => {
      // No draft is restored here: the only thing standing between the late group answer and the
      // undo button's focus is the pending undo itself.
      await open('pending');
      component.state.set('confirm');
      component.discardDraft();
      const undo = el().querySelector<HTMLButtonElement>('[data-undo]');
      expect(undo).not.toBeNull();
      expect(document.activeElement).toBe(undo);
      expect(component.state()).toBe('paste');
      expect(component.rawText()).toBe('');

      await answerGroup();
      expect(component.undoSnapshot()).not.toBeNull();
      expect(document.activeElement).toBe(undo);
    });

    it('does not focus the box when a draft with text was restored', async () => {
      seedDraft({ rawText: ROSTER });
      await open();
      expect(component.rawText()).toBe(ROSTER);
      expect(document.activeElement).not.toBe(textarea());
    });

    it('does not focus anything when the restored draft is the review step', async () => {
      seedDraft(confirmDraft());
      await open();
      expect(component.state()).toBe('confirm');
      expect(textarea()).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it('does not take focus from the undo button when a clear beats a slow group load', async () => {
      // A restored review is on screen while the group is still loading. The host clears it, and
      // the undo button is focused. The state is then paste and the box empty — the group answering
      // late must not pull focus away.
      seedDraft(confirmDraft());
      await open('pending');
      const discard = el().querySelector<HTMLButtonElement>('[data-discard]')!;
      discard.focus();
      discard.click();
      const undo = el().querySelector<HTMLButtonElement>('[data-undo]');
      expect(undo).not.toBeNull();
      expect(document.activeElement).toBe(undo);

      await answerGroup();
      expect(component.state()).toBe('paste');
      expect(component.rawText()).toBe('');
      expect(document.activeElement).toBe(undo);
    });

    it('does not focus the box for a restored draft whose cleared list has already gone past undo', async () => {
      // The undo is no longer pending, the state is paste and the box is empty: only the fact that
      // this screen came back from a draft says the host is mid-task and not at a fresh start.
      seedDraft(confirmDraft());
      await open('pending');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      el().querySelector<HTMLButtonElement>('[data-discard]')!.click();
      const back = el().querySelector<HTMLAnchorElement>('a.back')!;
      back.focus();
      vi.advanceTimersByTime(8000);
      fixture.detectChanges();
      expect(component.undoSnapshot()).toBeNull();
      expect(component.state()).toBe('paste');
      expect(component.rawText()).toBe('');
      vi.useRealTimers();

      await answerGroup();
      expect(document.activeElement).toBe(back);
    });

    it('leaves focus alone after edit-paste, even if the group answers late', async () => {
      seedDraft(confirmDraft());
      await open('pending');
      el().querySelector<HTMLButtonElement>('[data-edit-paste]')!.click();
      expect(document.activeElement).toBe(textarea());
      el().querySelector<HTMLAnchorElement>('a.back')!.focus();

      await answerGroup();
      expect(document.activeElement).toBe(el().querySelector('a.back'));
    });

    it('leaves focus where it is once the host has typed, even if the group answers after', async () => {
      await open('pending');
      const back = el().querySelector<HTMLAnchorElement>('a.back')!;
      back.focus();
      component.onRawTextChange('1. ตั้ม');
      await answerGroup();
      expect(document.activeElement).toBe(back);
    });

    it('focuses the box when a retry after a failed load succeeds', async () => {
      fixture = TestBed.createComponent(GroupEntry);
      component = fixture.componentInstance;
      httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 503, statusText: 'Unavailable' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.groupStatus()).toBe('error');
      expect(textarea()).toBeNull();

      const retry = component.loadGroup();
      httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
      await retry;
      expect(document.activeElement).toBe(textarea());
    });

    it('does not throw when the group answers after the screen was left', async () => {
      await open('pending');
      const second = component.loadGroup();
      fixture.destroy();
      for (const req of httpMock.match(`${B}/groups/group1`)) req.flush(GROUP);
      await expect(second).resolves.toBeUndefined();
    });
  });

  describe('paste from the clipboard', () => {
    it('has a full-width ghost button above the paste box, inside the paste card', async () => {
      await open();
      const button = clipButton()!;
      expect(button.textContent?.trim()).toBe('วางจากคลิปบอร์ด');
      expect(button.type).toBe('button');
      expect(button.classList.contains('ghost')).toBe(true);
      expect(button.closest('.paste-card')).not.toBeNull();
      expect(button.compareDocumentPosition(textarea()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('a tap reads the clipboard in the tap itself, parses the roster once and lands on the review', async () => {
      const clipboard = readingWith(ROSTER);
      stubClipboard(clipboard);
      await open();

      clipButton()!.click();
      // User activation: iOS refuses a read made after an await.
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
      await settle();
      expect(component.isParsing()).toBe(true);
      const parse = httpMock.expectOne(parseUrl);
      expect(parse.request.body).toEqual({ groupName: 'ก๊วนทดสอบ', rawText: ROSTER });
      parse.flush({
        header: { isoDate: '2026-09-08', venue: null, courtCount: 2 },
        rosterReviews: fourNewPlayers(),
        waitlistReviews: [],
        warnings: [],
        unrecognizedLines: [],
      });
      await settle();
      httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
      await settle();

      expect(component.rawText()).toBe(ROSTER);
      expect(component.state()).toBe('confirm');
      expect(component.rosterReviews()).toHaveLength(4);
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
    });

    it('a fresh parse through the clipboard is a fresh attempt, like a typed one', async () => {
      stubClipboard(readingWith(ROSTER));
      await open();
      const done = component.pasteFromClipboard();
      await settle();
      await answerParse();
      await done;
      expect((component as unknown as { creationIdempotencyKey: string | null }).creationIdempotencyKey).toBeNull();
    });

    it('an empty clipboard says so, parses nothing, and leaves the box alone', async () => {
      stubClipboard(readingWith('  \n '));
      await open();
      component.rawText.set('1. เก่า');
      component.pasteError.set('ข้อผิดพลาดเก่า');
      clipButton()!.focus();
      await component.pasteFromClipboard();

      expect(note()).toBe(EMPTY);
      expect(noteSlot()!.getAttribute('role')).toBe('status');
      expect(noteSlot()!.querySelector('p')!.classList.contains('muted')).toBe(true);
      expect(el().querySelector('[data-clipboard-note] .error')).toBeNull();
      expect(component.rawText()).toBe('1. เก่า');
      expect(component.pasteError()).toBeNull();
      expect(document.activeElement).toBe(clipButton());
      httpMock.expectNone(parseUrl);
      expect(component.isParsing()).toBe(false);
    });

    it('a refused clipboard read falls back to typing: message, focus in the box, no parse', async () => {
      const denied = { readText: vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError'))) };
      stubClipboard(denied);
      await open();
      leaveBox();
      component.rawText.set('1. เก่า');
      await component.pasteFromClipboard();

      expect(denied.readText).toHaveBeenCalledTimes(1);
      expect(note()).toBe(FALLBACK);
      expect(noteSlot()!.getAttribute('role')).toBe('status');
      expect(noteSlot()!.querySelector('p')!.classList.contains('muted')).toBe(true);
      expect(el().querySelector('[data-clipboard-note] .error')).toBeNull();
      expect(document.activeElement).toBe(textarea());
      expect(component.rawText()).toBe('1. เก่า');
      expect(component.pasteError()).toBeNull();
      httpMock.expectNone(parseUrl);
    });

    it('a read that throws outright falls back the same way', async () => {
      stubClipboard({
        readText: () => {
          throw new TypeError('not a function');
        },
      });
      await open();
      leaveBox();
      await component.pasteFromClipboard();
      expect(note()).toBe(FALLBACK);
      expect(document.activeElement).toBe(textarea());
      httpMock.expectNone(parseUrl);
    });

    it('without a clipboard API, the same fallback', async () => {
      stubClipboard(undefined);
      await open();
      leaveBox();
      await component.pasteFromClipboard();
      expect(note()).toBe(FALLBACK);
      expect(document.activeElement).toBe(textarea());
      httpMock.expectNone(parseUrl);
    });

    it('with a clipboard that cannot read text, the same fallback', async () => {
      stubClipboard({});
      await open();
      leaveBox();
      await component.pasteFromClipboard();
      expect(note()).toBe(FALLBACK);
      expect(document.activeElement).toBe(textarea());
      httpMock.expectNone(parseUrl);
    });

    it('shows a roster-less clipboard exactly as a typed paste does', async () => {
      stubClipboard(readingWith('ไกด์\nเตย'));
      await open();
      const done = component.pasteFromClipboard();
      await settle();
      await answerParse([]);
      await done;
      expect(component.state()).toBe('paste');
      expect(component.rawText()).toBe('ไกด์\nเตย');
      expect(component.pasteError()).toContain('ไม่พบรายชื่อผู้เล่น');
      expect(el().querySelector('p.error[role="alert"]')?.textContent).toContain('ไม่พบรายชื่อผู้เล่น');
      expect(note()).toBe('');
    });

    it('shows a failed parse exactly as a typed paste does, text kept for a retry', async () => {
      stubClipboard(readingWith(ROSTER));
      await open();
      const done = component.pasteFromClipboard();
      await settle();
      httpMock.expectOne(parseUrl).flush('boom', { status: 500, statusText: 'Server Error' });
      await done;
      expect(component.state()).toBe('paste');
      expect(component.rawText()).toBe(ROSTER);
      expect(component.pasteError()).toContain('อ่านรายชื่อไม่สำเร็จ');
      expect(component.isParsing()).toBe(false);
    });

    it('withdraws a pending undo, as typing would', async () => {
      stubClipboard(readingWith(ROSTER));
      await open();
      seedUndo();
      expect(el().querySelector('[data-undo]')).not.toBeNull();

      const done = component.pasteFromClipboard();
      await settle();
      expect(component.undoSnapshot()).toBeNull();
      await answerParse();
      await done;
    });

    it('keeps the undo offer when nothing was pasted', async () => {
      stubClipboard(readingWith(''));
      await open();
      seedUndo();
      await component.pasteFromClipboard();
      expect(component.undoSnapshot()).not.toBeNull();
      expect(el().querySelector('[data-undo]')).not.toBeNull();
    });

    it('the message goes when the host types, and when a manual roster is started', async () => {
      stubClipboard(readingWith(''));
      await open();
      await component.pasteFromClipboard();
      expect(note()).toBe(EMPTY);
      component.onRawTextChange('1. ตั้ม');
      expect(note()).toBe('');

      await component.pasteFromClipboard();
      expect(note()).toBe(EMPTY);
      const manual = component.startManual();
      httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
      await manual;
      component.discardDraft();
      fixture.detectChanges();
      expect(component.state()).toBe('paste');
      expect(note()).toBe('');
    });

    it('a new tap takes the old message down while its own read waits', async () => {
      let resolveRead!: (text: string) => void;
      const clipboard = { readText: vi.fn(() => Promise.resolve('')) };
      stubClipboard(clipboard);
      await open();
      await component.pasteFromClipboard();
      expect(note()).toBe(EMPTY);

      clipboard.readText.mockImplementation(() => new Promise<string>((r) => (resolveRead = r)));
      const again = component.pasteFromClipboard();
      expect(note()).toBe('');
      resolveRead('');
      await again;
      expect(note()).toBe(EMPTY);
    });

    it('a second tap while the read is pending does not read twice', async () => {
      let resolveRead!: (text: string) => void;
      const clipboard = { readText: vi.fn(() => new Promise<string>((r) => (resolveRead = r))) };
      stubClipboard(clipboard);
      await open();

      clipButton()!.click();
      clipButton()!.click();
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
      resolveRead(ROSTER);
      await settle();
      await answerParse();
      await settle();
      expect(component.state()).toBe('confirm');
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
    });

    it('can be tapped again once a read has finished empty', async () => {
      const clipboard = { readText: vi.fn(() => Promise.resolve('')) };
      stubClipboard(clipboard);
      await open();
      await component.pasteFromClipboard();
      await component.pasteFromClipboard();
      expect(clipboard.readText).toHaveBeenCalledTimes(2);
    });

    it('a tap while a parse is in flight neither reads nor replaces the text being parsed', async () => {
      const clipboard = readingWith(ROSTER);
      stubClipboard(clipboard);
      await open();
      const first = component.pasteFromClipboard();
      await settle();
      expect(component.isParsing()).toBe(true);

      clipboard.readText.mockImplementation(() => Promise.resolve('1. คนอื่น\n2. อีกคน'));
      await component.pasteFromClipboard();
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
      expect(component.rawText()).toBe(ROSTER);

      await answerParse();
      await first;
      httpMock.expectNone(parseUrl);
    });

    it('is disabled while the group loads, enabled once it is ready, disabled again while parsing', async () => {
      stubClipboard(readingWith(ROSTER));
      await open('pending');
      expect(clipButton()!.disabled).toBe(true);
      await answerGroup();
      expect(clipButton()!.disabled).toBe(false);

      const done = component.pasteFromClipboard();
      await settle();
      fixture.detectChanges();
      expect(clipButton()!.disabled).toBe(true);
      await answerParse();
      await done;
    });

    it('does nothing before the group is ready', async () => {
      const clipboard = readingWith(ROSTER);
      stubClipboard(clipboard);
      await open('pending');
      await component.pasteFromClipboard();
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(note()).toBe('');
      httpMock.expectNone(parseUrl);
      await answerGroup();
    });

    it('leaves the typed buttons as they were', async () => {
      await open();
      const labels = [...el().querySelectorAll<HTMLButtonElement>('.paste-actions button')].map((b) => b.textContent?.trim());
      expect(labels).toEqual(['อ่านรายชื่อ', 'เพิ่มรายชื่อเอง']);
    });

    describe('a read that answers after the host has moved on', () => {
      let resolveRead!: (text: string) => void;
      beforeEach(() => {
        stubClipboard({ readText: vi.fn(() => new Promise<string>((r) => (resolveRead = r))) });
      });

      it('does not parse over a read the host started by tapping อ่านรายชื่อ', async () => {
        await open();
        component.rawText.set('1. พิมพ์เอง');
        const pending = component.pasteFromClipboard();
        const typed = component.parse();
        resolveRead(ROSTER);
        await settle();
        await answerParse();
        await Promise.all([pending, typed]);
        expect(component.rawText()).toBe('1. พิมพ์เอง');
        httpMock.expectNone(parseUrl);
      });

      it('does not write into the box once a manual roster has taken over', async () => {
        await open();
        const pending = component.pasteFromClipboard();
        const manual = component.startManual();
        httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
        await manual;
        expect(component.state()).toBe('confirm');
        resolveRead(ROSTER);
        await pending;
        expect(component.rawText()).toBe('');
        expect(component.state()).toBe('confirm');
        httpMock.expectNone(parseUrl);
      });

      it('does nothing after the screen was left', async () => {
        await open();
        const pending = component.pasteFromClipboard();
        fixture.destroy();
        resolveRead(ROSTER);
        await pending;
        httpMock.expectNone(parseUrl);
      });
    });

    /** A pending undo, by clearing a real review. */
    function seedUndo(): void {
      component.rosterReviews.set([{ inputName: 'ตั้ม', match: { type: 'new' }, decision: 'accept' }]);
      component.rawText.set(ROSTER);
      component.state.set('confirm');
      component.discardDraft();
      fixture.detectChanges();
    }
  });
});
