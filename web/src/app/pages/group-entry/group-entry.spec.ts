import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';
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
    await fixture.whenStable();
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
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
    });
    req.flush({ code: 'sess1' });
    await confirmPromise;
    await fixture.whenStable();

    expect(router.url).toBe('/s/sess1');
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

  it('saveGroupName sends the group name via renameGroup', () => {
    component.groupName.set('Group A');
    component.saveGroupName();

    const req = httpMock.expectOne(`${B}/groups/group1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'Group A' });
    req.flush({ code: 'group1', name: 'Group A' });
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
    await fixture.whenStable();

    expect(fixture.componentInstance.groupName()).toBe('Group A');
    expect(fixture.componentInstance.lastSessionCode()).toBe('sess1');
  });
});
