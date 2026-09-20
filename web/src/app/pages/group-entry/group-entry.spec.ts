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

  it('links to the player roster page', () => {
    const links = [...fixture.nativeElement.querySelectorAll('a')] as HTMLAnchorElement[];
    const manage = links.find((a) => a.getAttribute('href') === '/g/group1/players');
    expect(manage).toBeTruthy();
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

    httpMock.expectOne(`${B}/groups/group1`).flush('Not Found', { status: 404, statusText: 'Not Found' });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
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
    const confirmPromise = component.confirmRoster();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('#manual-add-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await confirmPromise;
  });
});