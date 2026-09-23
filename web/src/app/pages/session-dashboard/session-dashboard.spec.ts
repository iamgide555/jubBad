import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { ClockService } from '../../core/clock.service';
import { environment } from '../../../environments/environment';
import type { Session } from '../../core/session.model';

const B = environment.apiBaseUrl;

// jsdom 28's HTMLDialogElement implements no showModal()/close() (an empty
// subclass — see jsdom's HTMLDialogElement-impl.js). This dashboard now opens
// one (the end-session confirm dialog), so the shim is needed here too.
// Guarded so a future jsdom that implements them takes over.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    shuttleCount: null,
    shuttlePriceSatang: null,
    endedAt: null,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2'],
    restingPlayerIds: [],
    queueGames: {},
    createdAt: '2026-09-08T12:00:00.000Z',
    serverNow: '2026-09-08T12:00:00.000Z',
    mode: 'variety',
    lastPlayedAt: {},
    activatedAt: {},
    waitlistPlayerIds: [],
    courts: [{ status: 'idle', format: 'doubles' }],
    ...overrides,
  };
}

describe('SessionDashboard', () => {
  let fixture: ComponentFixture<SessionDashboard>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDashboard],
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
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
        // court-panel.ts injects ClockService for its live timer. The real
        // implementation's 1Hz interval writes a signal outside Angular's
        // render cycle, which core/motion/odometer.ts documents as having
        // intermittently tripped HttpTestingController.verify() in an
        // unrelated spec — no test here needs the timer to move, so it is
        // stubbed inert rather than left running for the whole suite.
        { provide: ClockService, useValue: { now: () => Date.now() } },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // The dashboard loads level badges as a fire-and-forget side effect on
    // construction, every refresh tick and after a walk-in — not the subject
    // of most tests here, so it's drained rather than asserted on in each one.
    for (const req of httpMock.match((r) => r.url.endsWith('/levels'))) {
      req.flush({});
    }
    httpMock.verify();
  });

  it('renders the confirmed roster as chips', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).toContain('เบส');
  });


  it('the player panel toggle fetches and shows tonight\'s roster with level, record and rating delta', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    // Closed by default — no request until the host opens it.
    httpMock.expectNone(`${B}/sessions/sess1/players`);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-player-panel-toggle]')!
      .click();
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1/players`).flush([
      {
        playerId: 'p1',
        name: 'ตั้ม',
        level: 'P',
        resting: false,
        played: 3,
        won: 2,
        lost: 1,
        ratingDelta: 50,
      },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('3');
    expect(text).toContain('2');
    expect(text).toContain('1');
    expect(text).toContain('P +50');
  });

  it('editing a level in the player panel saves it and reloads the panel', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-player-panel-toggle]')!
      .click();
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1/players`).flush([
      {
        playerId: 'p1',
        name: 'ตั้ม',
        level: null,
        resting: false,
        played: 0,
        won: 0,
        lost: 0,
        ratingDelta: null,
      },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.player-panel .level-trigger')!
      .click();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('.player-panel .chip')[1] // 'BG', first real level after "-" (unset)
      .click();

    const putReq = httpMock.expectOne(`${B}/groups/group1/players/p1/level`);
    expect(putReq.request.body).toEqual({ level: 'BG' });
    putReq.flush({ id: 'p1', level: 'BG' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    // The panel reloads itself (its own resource, not sessionResource) —
    // and loadLevels() refreshes the roster-chip badges too.
    httpMock.expectOne(`${B}/sessions/sess1/players`).flush([
      { playerId: 'p1', name: 'ตั้ม', level: 'BG', resting: false, played: 0, won: 0, lost: 0, ratingDelta: 0 },
    ]);
    for (const r of httpMock.match((req) => req.url.endsWith('/levels'))) {
      r.flush({ p1: 'BG' });
    }
    await fixture.whenStable();
  });

  it('tapping a roster chip rests that player', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const chip = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.roster-chips button')
    ).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    chip.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/roster/p1/active`);
    expect(req.request.body).toEqual({ active: false });
    req.flush({ playerId: 'p1', active: false });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    // whenStable() deadlocks here: settling this reload fires the dependent
    // players/stats resources with nothing left to flush them.
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ restingPlayerIds: ['p1'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    // The reload gives the dependent resources a new session value, so they
    // refire; leaving them unflushed trips httpMock.verify() in afterEach.
    for (const r of httpMock.match(`${B}/groups/group1/players`)) {
      r.flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    }
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const after = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.roster-chips button')
    ).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    expect(after.classList.contains('resting')).toBe(true);
  });

  it('tapping a resting chip brings that player back', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ restingPlayerIds: ['p1'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const chip = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.roster-chips button')
    ).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    expect(chip.classList.contains('resting')).toBe(true);
    chip.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/roster/p1/active`);
    expect(req.request.body).toEqual({ active: true });
    req.flush({ playerId: 'p1', active: true });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    // The reload gives the dependent resources a new session value, so they
    // refire; leaving them unflushed trips httpMock.verify() in afterEach.
    for (const r of httpMock.match(`${B}/groups/group1/players`)) {
      r.flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    }
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const after = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.roster-chips button')
    ).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    expect(after.classList.contains('resting')).toBe(false);
  });

  it('keeps a resting player out of the waiting queue', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2'], restingPlayerIds: ['p1'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const waiting = (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue');
    expect(waiting?.textContent).toContain('เบส');
    expect(waiting?.textContent).not.toContain('ตั้ม');
  });

  it('adds an existing player to the roster via the add-walk-in button', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
        { id: 'p9', name: 'บอล', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    buttonWith('เพิ่มคน').click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    // Scoped to .walk-in-dialog: the end-session ShuttleDetailsDialog also
    // keeps its own <dialog> permanently in the DOM (closed, content gated by
    // its own isOpen()), so an unscoped `querySelector('dialog')` here would
    // silently grab that one instead — it renders first.
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog.walk-in-dialog')!;
    const search = dialog.querySelector('input[name="search"]') as HTMLInputElement;
    typeInto(search, 'บอล');

    const candidate = dialog.querySelector('[data-candidate]') as HTMLButtonElement;
    expect(candidate.textContent).toContain('บอล');
    candidate.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/roster`);
    expect(req.request.body).toEqual({ playerId: 'p9' });
    req.flush({ playerId: 'p9' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2', 'p9'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    // Regression guard: submitWalkIn must not manually reload playersResource
    // on top of the automatic refetch every mutation's session reload already
    // causes (see statsResource's comment above, in this file) — that
    // combination previously fired this request twice instead of once.
    const playersReqs = httpMock.match(`${B}/groups/group1/players`);
    expect(playersReqs.length).toBe(1);
    playersReqs[0].flush([
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
      { id: 'p9', name: 'บอล', aliases: [] },
    ]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      fixture.componentInstance.rosterEntries().some((r) => r.id === 'p9' && r.name === 'บอล')
    ).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('shows the server error inside the dialog when adding a walk-in is refused', async () => {
    await settled();

    buttonWith('เพิ่มคน').click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    // See the note in the previous test: scoped to avoid the end-session
    // dialog's own always-present <dialog> tag.
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog.walk-in-dialog')!;
    const search = dialog.querySelector('input[name="search"]') as HTMLInputElement;
    typeInto(search, 'ซ้ำ');

    const addNew = dialog.querySelector('[data-add-new]') as HTMLButtonElement;
    addNew.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/roster`);
    expect(req.request.body).toEqual({ name: 'ซ้ำ' });
    req.flush({ code: 'ROSTER_DUPLICATE' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(dialog.querySelector('.error')?.textContent).toContain('ผู้เล่นคนนี้อยู่ในก๊วนแล้ว');
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('renders one CourtPanel per court', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courtCount: 2,
          rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
          courts: [{ status: 'idle', format: 'doubles' }, { status: 'idle', format: 'doubles' }],
        })
      );
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();

    fixture.detectChanges();
    const panels = (fixture.nativeElement as HTMLElement).querySelectorAll('app-court-panel');
    expect(panels).toHaveLength(2);
  });

  it('renders the waiting queue', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();

    fixture.detectChanges();
    const waitingSection = (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue');
    expect(waitingSection?.textContent).toContain('ตั้ม');
  });

  it('renders the waitlist as chips', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1'], waitlistPlayerIds: ['p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();

    fixture.detectChanges();
    const waitlistSection = (fixture.nativeElement as HTMLElement).querySelector('.waitlist');
    expect(waitlistSection?.textContent).toContain('เบส');
  });

  it('shows a "session not found" message for an unknown sessionCode', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush('Not Found', { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ไม่พบก๊วนนี้');
  });

  /**
   * The end-session dialog replaced a single unguarded click that used to
   * fire `/end` immediately (see git history) — this is the direct
   * regression test for that: opening it must not, by itself, touch the
   * network at all.
   */
  it('clicking จบก๊วน opens the confirm dialog without any HTTP request', async () => {
    await settled();
    await openEndDialog();

    httpMock.expectNone(`${B}/sessions/sess1/end`);
    httpMock.expectNone(`${B}/sessions/sess1/shuttle-details`);
    expect(dialogInputs().count).not.toBeNull();
  });

  it('confirming with blank fields sends only /end, then navigates to the summary', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await settled();
    await openEndDialog();

    dialogButtonWith('จบก๊วน').click();

    httpMock.expectNone(`${B}/sessions/sess1/shuttle-details`);
    const req = httpMock.expectOne(`${B}/sessions/sess1/end`);
    req.flush({ code: 'sess1', endedAt: '2026-09-08T20:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    for (const request of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) {
      request.flush([]);
    }

    expect(navigateSpy).toHaveBeenCalledWith('/s/sess1/summary');
  });

  it('confirming with a typed shuttle count saves it before ending, then navigates', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await settled();
    await openEndDialog();
    typeInto(dialogInputs().count!, '12');

    dialogButtonWith('จบก๊วน').click();

    const shuttleReq = httpMock.expectOne(`${B}/sessions/sess1/shuttle-details`);
    expect(shuttleReq.request.body).toEqual({ shuttleCount: 12 });
    httpMock.expectNone(`${B}/sessions/sess1/end`);
    shuttleReq.flush({ code: 'sess1', shuttleCount: 12, shuttlePriceSatang: null });
    await drainReload(baseSession({ shuttleCount: 12 }));

    const endReq = httpMock.expectOne(`${B}/sessions/sess1/end`);
    endReq.flush({ code: 'sess1', endedAt: '2026-09-08T20:00:00.000Z' });
    await drainReload(baseSession({ endedAt: '2026-09-08T20:00:00.000Z', shuttleCount: 12 }));

    expect(navigateSpy).toHaveBeenCalledWith('/s/sess1/summary');
  });

  it('a failed shuttle save blocks /end and shows the error inside the dialog', async () => {
    await settled();
    await openEndDialog();
    typeInto(dialogInputs().count!, '7');

    dialogButtonWith('จบก๊วน').click();
    httpMock
      .expectOne(`${B}/sessions/sess1/shuttle-details`)
      .flush(
        { statusCode: 400, message: ['bad'], error: 'Bad Request' },
        { status: 400, statusText: 'Bad Request' }
      );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    httpMock.expectNone(`${B}/sessions/sess1/end`);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'บันทึกข้อมูลลูกแบดไม่สำเร็จ'
    );
  });

  it('a failed /end (e.g. unfinished pairings) shows the mapped error inside the dialog', async () => {
    await settled();
    await openEndDialog();

    dialogButtonWith('จบก๊วน').click();
    httpMock.expectNone(`${B}/sessions/sess1/shuttle-details`);
    const req = httpMock.expectOne(`${B}/sessions/sess1/end`);
    req.flush(
      { code: 'SESSION_HAS_UNFINISHED_PAIRINGS' },
      { status: 409, statusText: 'Conflict' }
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ยังมีแมตช์ที่ยังไม่จบ กรุณาบันทึกผลให้ครบก่อน'
    );
  });

  /**
   * Migrated from the inline editor's own pending-state test. The dialog
   * itself does not guard against a duplicate submit (see
   * shuttle-details-dialog.ts's comment) — `confirmEndSession`'s own
   * `if (this.endSessionBusy()) return;` is what stops the second call, so
   * both clicks are fired back-to-back with no render in between: waiting
   * for a `detectChanges()` after the first click would write the button's
   * `disabled` DOM property before the second click, and jsdom's
   * `<button>.click()` silently no-ops on an already-disabled element —
   * which would make "only one request" pass even with the guard deleted.
   */
  it('disables the dialog and drops a duplicate confirm click without a second /end request', async () => {
    await settled();
    await openEndDialog();

    const confirmButton = dialogButtonWith('จบก๊วน');
    confirmButton.click();
    confirmButton.click();

    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const { count, price } = dialogInputs();
    expect(count!.disabled).toBe(true);
    expect(price!.disabled).toBe(true);
    expect(dialogButtonWith('จบก๊วน').disabled).toBe(true);
    expect(dialogButtonWith('ยกเลิก').disabled).toBe(true);

    const reqs = httpMock.match(`${B}/sessions/sess1/end`);
    expect(reqs.length).toBe(1);

    reqs[0].flush({ code: 'sess1', endedAt: '2026-09-08T20:00:00.000Z' });
    await drainReload(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
  });
  async function settled(session = baseSession()) {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * Excludes any button inside the end-session dialog: its confirm button
   * shares the same "จบก๊วน" text as the opener button that reveals it, so a
   * plain unscoped match would silently grab whichever one comes first.
   */
  function buttonWith(text: string): HTMLButtonElement {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => !b.closest('dialog') && b.textContent?.includes(text)) as HTMLButtonElement;
  }

  function dialogButtonWith(text: string): HTMLButtonElement {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
    return Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(text)
    ) as HTMLButtonElement;
  }

  function dialogInputs() {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
    return {
      count: dialog.querySelector('input[name="shuttleCount"]') as HTMLInputElement | null,
      price: dialog.querySelector('input[name="shuttlePrice"]') as HTMLInputElement | null,
    };
  }

  function typeInto(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  /**
   * Opens the end-session dialog and flushes the microtask NgModel defers
   * its initial DOM write to (see shuttle-details-dialog.spec.ts's identical
   * note) — needed before the dialog's freshly-mounted inputs are readable.
   */
  async function openEndDialog(): Promise<void> {
    buttonWith('จบก๊วน').click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  /**
   * Drains the session/players/stats requests a mutation's reload can
   * trigger, round by round, the same way 'switches to custom mode' above
   * does — a single flush pass is not always enough since the players/stats
   * resources can refire once the reloaded session lands.
   */
  async function drainReload(nextSession: Session): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      const pending = [
        ...httpMock.match(`${B}/sessions/sess1`),
        ...httpMock.match(`${B}/groups/group1/players`),
        ...httpMock.match(`${B}/sessions/sess1/stats?scope=session`),
      ];
      if (pending.length === 0) break;
      for (const r of pending) {
        if (r.request.url.endsWith('/sessions/sess1')) r.flush(nextSession);
        else r.flush([]);
      }
    }
    fixture.detectChanges();
  }

  it('shows how long each waiting player has been off court', async () => {
    const start = new Date(Date.now() - 20 * 60_000).toISOString();
    const lastPlayed = new Date(Date.now() - 5 * 60_000).toISOString();
    await settled(
      baseSession({
        createdAt: start,
        rosterPlayerIds: ['p1', 'p2'],
        lastPlayedAt: { p1: lastPlayed },
      })
    );

    const waiting = fixture.componentInstance.waiting();
    // p2 never played, so their wait runs from the session start and is longer.
    expect(waiting.map((w) => w.name)).toEqual(['เบส', 'ตั้ม']);
    expect(waiting[0].minutes).toBe(20);
    expect(waiting[1].minutes).toBe(5);
  });

  it('shows each on-court player\'s real games-played tally, not the rotation number', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        queueGames: { p1: 99, p2: 99 },
        courts: [
          {
            status: 'active',
            pairingId: 'c1',
            format: 'doubles',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      })
    );
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    httpMock
      .expectOne(`${B}/sessions/sess1/stats?scope=session`)
      .flush([{ playerId: 'p1', name: 'ตั้ม', played: 3, won: 2 }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const tallies = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.tally')].map(
      (t) => t.textContent?.trim()
    );
    // p1 really played 3 (from /stats) — not 99, the unrelated rotation-fairness
    // number on the session object. Everyone else is absent from /stats, so 0.
    expect(tallies).toEqual(['3 เกม', '0 เกม', '0 เกม', '0 เกม']);
  });

  it('fills every idle court in one tap', async () => {
    await settled();
    buttonWith('จัดคู่ทุกคอร์ทว่าง').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/fill`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, filled: [1] });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1`)) r.flush(baseSession());
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('deprioritizes the waiting queue in one tap', async () => {
    await settled(
      baseSession({
        courtCount: 2,
        rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'],
        courts: [
          {
            status: 'active',
            pairingId: 'c1',
            format: 'doubles',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
          {
            status: 'active',
            pairingId: 'c2',
            format: 'doubles',
            teamA: ['p5', 'p6'],
            teamB: ['p7', 'p8'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      })
    );
    buttonWith('จัดคิวใหม่').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/roster/deprioritize-waiting`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, deprioritized: ['p9'] });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1`)) r.flush(baseSession());
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('hides the deprioritize-waiting button on a single court or with one or fewer waiting', async () => {
    await settled(baseSession());
    expect(buttonWith('จัดคิวใหม่')).toBeUndefined();
  });

  it('hides the fill button when no court is idle', async () => {
    await settled(
      baseSession({
        courts: [
          {
            status: 'active',
            pairingId: 'x',
            format: 'doubles',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      })
    );
    expect(buttonWith('จัดคู่ทุกคอร์ทว่าง')).toBeUndefined();
  });

  it('switches the pairing mode', async () => {
    await settled();
    buttonWith('สูสี').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/mode`);
    expect(req.request.body).toEqual({ mode: 'balanced' });
    req.flush({ code: 'sess1', mode: 'balanced' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1`)) r.flush(baseSession({ mode: 'balanced' }));
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('switches to level mode and shows its hint', async () => {
    await settled();
    buttonWith('ตามระดับ').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/mode`);
    expect(req.request.body).toEqual({ mode: 'level' });
    req.flush({ code: 'sess1', mode: 'level' });
    for (let round = 0; round < 5; round++) {
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      const pending = [
        ...httpMock.match(`${B}/sessions/sess1`),
        ...httpMock.match(`${B}/groups/group1/players`),
        ...httpMock.match(`${B}/sessions/sess1/stats?scope=session`),
      ];
      if (pending.length === 0) break;
      for (const r of pending) {
        if (r.request.url.endsWith('/sessions/sess1')) r.flush(baseSession({ mode: 'level' }));
        else if (r.request.url.endsWith('/players')) r.flush([]);
        else r.flush([]);
      }
    }
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('จัดคนระดับใกล้กัน');
  });

  it('switches to custom mode and shows its hint', async () => {
    await settled();
    buttonWith('เลือกเอง').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/mode`);
    expect(req.request.body).toEqual({ mode: 'custom' });
    req.flush({ code: 'sess1', mode: 'custom' });

    // Reloading after the mutation can trigger more than one wave of
    // dependent requests (session, then players/stats reacting to the new
    // mutationVersion); drain until nothing is left pending rather than
    // assuming a single round.
    for (let round = 0; round < 5; round++) {
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      const pending = [
        ...httpMock.match(`${B}/sessions/sess1`),
        ...httpMock.match(`${B}/groups/group1/players`),
        ...httpMock.match(`${B}/sessions/sess1/stats?scope=session`),
      ];
      if (pending.length === 0) break;
      for (const r of pending) {
        if (r.request.url.endsWith('/sessions/sess1')) r.flush(baseSession({ mode: 'custom' }));
        else if (r.request.url.endsWith('/players')) r.flush([]);
        else r.flush([]);
      }
    }
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('จัดคู่เองทีละคน');
  });

  /**
   * Finding 31: a booking commonly opens more courts later in the evening, and
   * the session carries a single count, so the host has to be able to change it
   * without re-importing.
   */
  it('adds a court when the later booking slot opens', async () => {
    await settled();
    // Not buttonWith('+'): the add-walk-in button's own label ("+ เพิ่มคน")
    // now also contains '+' and sits earlier in the DOM, so a plain
    // substring match would grab that one instead of the court-count
    // stepper. The stepper has a stable, unique aria-label instead.
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        'button[aria-label="เพิ่มจำนวนคอร์ท"]'
      ) as HTMLButtonElement
    ).click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/court-count`);
    expect(req.request.body).toEqual({ courtCount: 2 });
    req.flush({ code: 'sess1', courtCount: 2 });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1`)) r.flush(baseSession());
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('cannot step the court count below one', async () => {
    await settled();
    expect(buttonWith('−')?.disabled).toBe(true);
  });

  it('builds share text listing the courts and who is waiting', async () => {
    await settled(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        courts: [
          {
            status: 'active',
            pairingId: 'x',
            format: 'doubles',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      })
    );

    const text = fixture.componentInstance.shareText();
    expect(text).toContain('คอร์ท 1');
    expect(text).toContain('ตั้ม');
    expect(text).toContain('vs');
  });

  it('marks an idle court as idle in the share text', async () => {
    await settled();
    expect(fixture.componentInstance.shareText()).toContain('ว่าง');
  });

  it('writes a singles court as one name per side in the share text', async () => {
    await settled(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        courts: [
          {
            status: 'active',
            pairingId: 'x',
            format: 'singles',
            teamA: ['p1'],
            teamB: ['p2'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      })
    );

    const text = fixture.componentInstance.shareText();
    expect(text).toContain('ตั้ม vs เบส');
  });

  it('copies a link to the venue display, which nothing else in the app links to', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
    await settled();

    await fixture.componentInstance.copyDisplayLink();

    // The display route has never been reachable from anywhere in the UI — the
    // host had to know to type /display onto the end of the session URL.
    expect(copied).toEqual([`${location.origin}/s/sess1/display`]);
    expect(fixture.componentInstance.displayLinkCopied()).toBe(true);
  });

  it('copies a link to the session summary once the session has ended', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
    await settled(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));

    await fixture.componentInstance.copySummaryLink();

    expect(copied).toEqual([`${location.origin}/s/sess1/summary`]);
    expect(fixture.componentInstance.summaryLinkCopied()).toBe(true);
  });

  it('says so when the clipboard refuses rather than silently doing nothing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    await settled();

    await fixture.componentInstance.copyDisplayLink();

    expect(fixture.componentInstance.displayLinkCopied()).toBe(false);
    expect(fixture.componentInstance.rosterError()).toBeTruthy();
  });

  it('exposes the display link when clipboard access is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    await settled();

    await fixture.componentInstance.copyDisplayLink();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement.querySelector('.clipboard-fallback') as HTMLTextAreaElement).value
    ).toBe(`${location.origin}/s/sess1/display`);
  });

  it('lets a waiting player be picked up for a manual swap', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/groups/group1/players`)) {
      r.flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    }
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const chip = (fixture.nativeElement as HTMLElement).querySelector(
      '.waiting-queue .chip-pick'
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();

    chip.click();
    fixture.detectChanges();
    expect(fixture.componentInstance['selection'].active()).toBe(true);
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    // Tapping again puts them back, so a mis-tap costs nothing.
    chip.click();
    fixture.detectChanges();
    expect(fixture.componentInstance['selection'].active()).toBe(false);

    // A second tap on a waiting player must never mean "take them off court" —
    // that gesture only has meaning on a court, and they are not on one.
    httpMock.expectNone((r) => r.url.includes('/swap'));
  });

  it('swaps a held court player with the waiting player that is tapped', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        courts: [
          { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
        ],
      })
    );
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/groups/group1/players`)) {
      r.flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
        { id: 'p3', name: 'โอ', aliases: [] },
        { id: 'p4', name: 'นัท', aliases: [] },
        { id: 'p5', name: 'ปอ', aliases: [] },
      ]);
    }
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    // Hold ตั้ม, who is on the court, by tapping their name in the panel.
    const courtName = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap')
    ).find((b) => b.textContent?.trim() === 'ตั้ม') as HTMLButtonElement;
    courtName.click();
    fixture.detectChanges();
    expect(fixture.componentInstance['selection'].isPicked('p1')).toBe(true);

    // Then tap ปอ, who is waiting: ปอ takes ตั้ม's place.
    const chip = (fixture.nativeElement as HTMLElement).querySelector(
      '.waiting-queue .chip-pick'
    ) as HTMLButtonElement;
    expect(chip.textContent).toContain('ปอ');
    chip.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`);
    expect(req.request.body).toEqual({ playerId: 'p1', withPlayerId: 'p5' });
    expect(fixture.componentInstance['selection'].active()).toBe(false);
    req.flush({
      ok: true,
      pairing: {
        id: 'pair1',
        courtNumber: 1,
        matchNumber: 1,
        teamA: ['p5', 'p2'],
        teamB: ['p3', 'p4'],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/sessions/sess1`)) {
      r.flush(
        baseSession({
          rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
          ],
        })
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
  });

});
