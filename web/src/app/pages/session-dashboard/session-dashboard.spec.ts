import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { Session } from '../../core/session.model';

const B = environment.apiBaseUrl;

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    endedAt: null,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2'],
    restingPlayerIds: [],
    queueGames: {},
    createdAt: '2026-09-08T12:00:00.000Z',
    mode: 'variety',
    lastPlayedAt: {},
    activatedAt: {},
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
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
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
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


  it('renders one CourtPanel per court', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courtCount: 2,
          rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
          courts: [{ status: 'idle' }, { status: 'idle' }],
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

  it('End session button calls endSession and shows the mapped error on failure', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent === 'จบก๊วน') as HTMLButtonElement;
    button.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/end`);
    req.flush(
      { code: 'SESSION_HAS_UNFINISHED_PAIRINGS' },
      { status: 409, statusText: 'Conflict' }
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const text2 = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text2).toContain('ยังมีแมตช์ที่ยังไม่จบ กรุณาบันทึกผลให้ครบก่อน');
  });

  it('redirects to the summary screen once the session ends successfully', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent === 'จบก๊วน') as HTMLButtonElement;
    button.click();

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

  function buttonWith(text: string): HTMLButtonElement {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
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
        courts: [{ status: 'active', pairingId: 'c1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
          { status: 'active', pairingId: 'c1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
          { status: 'active', pairingId: 'c2', teamA: ['p5', 'p6'], teamB: ['p7', 'p8'] },
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
        courts: [{ status: 'active', pairingId: 'x', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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

  /**
   * Finding 31: a booking commonly opens more courts later in the evening, and
   * the session carries a single count, so the host has to be able to change it
   * without re-importing.
   */
  it('adds a court when the later booking slot opens', async () => {
    await settled();
    buttonWith('+').click();

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
        courts: [{ status: 'active', pairingId: 'x', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
          { status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
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
            { status: 'pending', pairingId: 'pair1', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] },
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
