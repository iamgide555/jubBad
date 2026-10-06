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
import { standardLadderFixture } from '../../core/group-levels.testing';

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
    queueBy: 'games',
    lastPlayedAt: {},
    activatedAt: {},
    waitlistPlayerIds: [],
    courts: [{ status: 'idle', format: 'doubles', mode: 'variety' }],
    courtLabels: [],
    editableCourtCount: 1,
    ...overrides,
  };
}

describe('SessionDashboard', () => {
  let fixture: ComponentFixture<SessionDashboard>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    // The roster starts collapsed in the app; most specs here drive its chips, so they start expanded.
    localStorage.setItem('jubbad.dashboard.rosterOpen', '1');
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
    // Pair rules are host-only and loaded the same fire-and-forget way.
    for (const req of httpMock.match((r) => r.url.endsWith('/sessions/sess1/rules'))) {
      req.flush({ rules: [], disabledRuleIds: [] });
    }
    httpMock.verify();
  });

  it('an ended session lists retired courts for renaming, including one never labeled', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        endedAt: '2026-09-08T20:00:00.000Z',
        courtCount: 1,
        editableCourtCount: 3,
        courtLabels: [null, 'หลัง'],
      })
    );
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const retired = el.querySelector('.retired-courts')!;
    expect(retired).toBeTruthy();
    expect(retired.querySelector('button[aria-label="เปลี่ยนชื่อคอร์ท หลัง"]')).toBeTruthy();
    const court3 = retired.querySelector('button[aria-label="เปลี่ยนชื่อคอร์ท 3"]') as HTMLButtonElement;
    court3.click();
    fixture.detectChanges();
    const input = retired.querySelector('input') as HTMLInputElement;
    input.value = 'หน้าต่าง';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    ([...retired.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'บันทึก') as HTMLButtonElement).click();
    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/3/label`);
    expect(req.request.body).toEqual({ label: 'หน้าต่าง' });
    req.flush({ code: 'sess1', courtNumber: 3, label: 'หน้าต่าง' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match((r) => r.url === `${B}/sessions/sess1` || r.url.includes('/stats'))) {
      r.flush(r.request.url.includes('/stats') ? [] : baseSession({ endedAt: '2026-09-08T20:00:00.000Z', courtCount: 1, editableCourtCount: 3, courtLabels: [null, 'หลัง', 'หน้าต่าง'] }));
    }
  });

  it('a live session shows no retired-court list', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ courtCount: 1, editableCourtCount: 3 }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.retired-courts')).toBeNull();
  });

  describe('early checkout', () => {
    async function load(session: Session, checkouts?: object[]) {
      fixture = TestBed.createComponent(SessionDashboard);
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
      httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
      if (checkouts) {
        await new Promise((r) => setTimeout(r, 0));
        httpMock.expectOne(`${B}/sessions/sess1/checkouts`).flush(checkouts);
      }
      await fixture.whenStable();
      fixture.detectChanges();
    }
    const el = () => fixture.nativeElement as HTMLElement;

    it('an ordinary session has no checkout action and never asks for receipts', async () => {
      await load(baseSession());
      expect(el().querySelector('[data-early-checkout]')).toBeNull();
      expect(el().querySelector('app-early-checkout-dialog')).toBeNull();
    });

    it('an advanced live session offers it as a roster action', async () => {
      await load(baseSession({ shuttleToolsEnabled: true }), []);
      expect(el().querySelector('[data-early-checkout]')).toBeTruthy();
    });

    it('an ended advanced session offers no checkout', async () => {
      await load(baseSession({ shuttleToolsEnabled: true, endedAt: '2026-09-08T20:00:00.000Z' }), []);
      expect(el().querySelector('[data-early-checkout]')).toBeNull();
    });

    it('a live session links to the summary so the host can correct games before ending', async () => {
      await load(baseSession());
      const link = el().querySelector<HTMLAnchorElement>('[data-live-summary]');
      expect(link?.getAttribute('href')).toBe('/s/sess1/summary');
    });

    it('an ended session has no live-summary shortcut (the ended banner carries the link)', async () => {
      await load(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
      expect(el().querySelector('[data-live-summary]')).toBeNull();
    });

    it('a settled player is a distinct, disabled, non-reactivatable chip', async () => {
      const receipt = { id: 'r1', playerId: 'p1', model: 'perGame', amountSatang: 4500, breakdown: { baseSatang: 4500, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 }, settledAt: '2026-09-08T13:00:00.000Z' };
      await load(baseSession({ shuttleToolsEnabled: true, restingPlayerIds: ['p1'] }), [receipt]);
      const chips = [...el().querySelectorAll<HTMLButtonElement>('.roster-chips .chip')];
      const out = chips.find((c) => c.classList.contains('checked-out'))!;
      expect(out).toBeTruthy();
      expect(out.disabled).toBe(true);
      expect(out.classList.contains('resting')).toBe(false);
      expect(out.getAttribute('aria-label')).toContain('เช็คเอาต์แล้ว');
      expect(out.getAttribute('aria-pressed')).toBeNull();
      expect(chips.filter((c) => !c.classList.contains('checked-out'))).toHaveLength(1);
    });
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
    httpMock.expectOne(`${B}/groups/group1/levels`).flush(standardLadderFixture());
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
    expect(putReq.request.body).toEqual({ level: 'BG', expectedLadderRevision: 0 });
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

  describe('group ladders (host feedback F)', () => {
    const custom = {
      mode: 'custom' as const,
      revision: 7,
      levels: [{ id: 'x', name: 'มือใหม่', startingElo: 1000 }, { id: 'y', name: 'เก่ง', startingElo: 1400 }],
      assignedCounts: { x: 0, y: 0 },
    };
    async function openPanel(ladderResponse: object | 'fail') {
      fixture = TestBed.createComponent(SessionDashboard);
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
      httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
      const ladderReq = httpMock.expectOne(`${B}/groups/group1/levels`);
      if (ladderResponse === 'fail') ladderReq.flush('x', { status: 500, statusText: 'Server Error' });
      else ladderReq.flush(ladderResponse);
      await fixture.whenStable();
      fixture.detectChanges();
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-player-panel-toggle]')!.click();
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1/players`).flush([
        { playerId: 'p1', name: 'ตั้ม', level: null, resting: false, played: 0, won: 0, lost: 0, ratingDelta: null },
      ]);
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('the player panel offers this group\'s own level names and sends the revision it read', async () => {
      await openPanel(custom);
      const el = fixture.nativeElement as HTMLElement;
      el.querySelector<HTMLButtonElement>('.player-panel .level-trigger')!.click();
      fixture.detectChanges();
      const chips = [...el.querySelectorAll('.player-panel .chip')].map((b) => b.textContent!.trim());
      expect(chips).toEqual(['-', 'มือใหม่', 'เก่ง']);
      (el.querySelectorAll('.player-panel .chip')[2] as HTMLButtonElement).click();
      const put = httpMock.expectOne(`${B}/groups/group1/players/p1/level`);
      expect(put.request.body).toEqual({ level: 'เก่ง', expectedLadderRevision: 7 });
      put.flush({ id: 'p1', level: 'เก่ง' });
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      for (const r of httpMock.match((req) => req.url.endsWith('/sessions/sess1/players'))) r.flush([]);
      await fixture.whenStable();
    });

    it('a new walk-in with a level sends the ladder revision; one without a level sends none', async () => {
      await openPanel(custom);
      const submit = (fixture.componentInstance as unknown as { submitWalkIn(i: object): Promise<void> }).submitWalkIn.bind(fixture.componentInstance);
      const withLevel = submit({ name: 'Late', level: 'เก่ง' });
      const a = httpMock.expectOne(`${B}/sessions/sess1/roster`);
      expect(a.request.body).toEqual({ name: 'Late', level: 'เก่ง', expectedLadderRevision: 7 });
      a.flush({ playerId: 'new1' });
      await withLevel;
      for (const r of httpMock.match((req) => req.url.endsWith('/levels') || req.url.endsWith('/stats?scope=session') || /\/sessions\/sess1(\/players)?$/.test(req.url))) r.flush(r.request.url.endsWith('/sessions/sess1') ? baseSession() : []);
      const plain = submit({ name: 'Plain' });
      const b = httpMock.expectOne(`${B}/sessions/sess1/roster`);
      expect(b.request.body).toEqual({ name: 'Plain' });
      b.flush({ playerId: 'new2' });
      await plain;
    });

    it('a failed ladder read disables the panel\'s level choice and says so, instead of offering a guess', async () => {
      await openPanel('fail');
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector<HTMLButtonElement>('.player-panel .level-trigger')!.disabled).toBe(true);
      expect(el.querySelector('[data-ladder-unavailable]')).toBeTruthy();
    });

    it('a stale revision on a panel save is shown and the ladder is read again', async () => {
      await openPanel(custom);
      const el = fixture.nativeElement as HTMLElement;
      el.querySelector<HTMLButtonElement>('.player-panel .level-trigger')!.click();
      fixture.detectChanges();
      (el.querySelectorAll('.player-panel .chip')[1] as HTMLButtonElement).click();
      httpMock.expectOne(`${B}/groups/group1/players/p1/level`).flush({ code: 'LEVEL_LADDER_STALE' }, { status: 409, statusText: 'Conflict' });
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      httpMock.expectOne(`${B}/groups/group1/levels`).flush({ ...custom, revision: 8 });
      for (const r of httpMock.match((req) => req.url.endsWith('/sessions/sess1/players'))) r.flush([]);
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('[data-panel-level-error]')!.textContent).toContain('มีการแก้ระดับ');
    });
  });

  it('opening the player panel does not push the court toolbar down', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const toolbarBefore = el.querySelector('.court-toolbar');
    // The dialog is always in the DOM (a native modal, not an inline @if
    // block) — its previous sibling in flow never changes, which is what
    // used to shift when the panel content itself was inserted inline.
    const anchorBefore = el.querySelector('dialog.player-panel-dialog')!.previousElementSibling;

    el.querySelector<HTMLButtonElement>('[data-player-panel-toggle]')!.click();
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1/players`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('.court-toolbar')).toBe(toolbarBefore);
    expect(el.querySelector('dialog.player-panel-dialog')!.previousElementSibling).toBe(
      anchorBefore
    );
  });

  it('closing the player panel dialog natively (Escape/backdrop) syncs panelOpen', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const toggle = el.querySelector<HTMLButtonElement>('[data-player-panel-toggle]')!;
    toggle.click();
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1/players`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    el.querySelector<HTMLDialogElement>('dialog.player-panel-dialog')!.close();
    fixture.detectChanges();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.player-panel')).toBeNull();
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
          courts: [
            { status: 'idle', format: 'doubles', mode: 'variety' },
            { status: 'idle', format: 'doubles', mode: 'variety' },
          ],
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

  // Scoped to .shuttle-dialog: the player panel also keeps its own <dialog>
  // permanently in the DOM (closed, content gated by its own panelOpen()),
  // and it now renders earlier in the template — an unscoped
  // `querySelector('dialog')` here would silently grab that one instead.
  function dialogButtonWith(text: string): HTMLButtonElement {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog.shuttle-dialog')!;
    return Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(text)
    ) as HTMLButtonElement;
  }

  function dialogInputs() {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog.shuttle-dialog')!;
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
            format: 'doubles', mode: 'variety',
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
            format: 'doubles', mode: 'variety',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
          {
            status: 'active',
            pairingId: 'c2',
            format: 'doubles', mode: 'variety',
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
            format: 'doubles', mode: 'variety',
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

  it('shows a hint under the waiting list when any court is set to ระดับ in a custom session', async () => {
    await settled(
      baseSession({
        mode: 'custom',
        courtCount: 2,
        courts: [
          { status: 'idle', format: 'doubles', mode: 'level' },
          { status: 'idle', format: 'doubles', mode: 'custom' },
        ],
      })
    );
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'คอร์ทที่ตั้งเป็นตามระดับอาจเรียกคิวข้ามลำดับที่เห็นด้านบน'
    );
  });

  it('shows no ระดับ queue hint in a custom session with no level court', async () => {
    await settled(
      baseSession({
        mode: 'custom',
        courts: [{ status: 'idle', format: 'doubles', mode: 'custom' }],
      })
    );
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
      'คอร์ทที่ตั้งเป็นตามระดับอาจเรียกคิวข้ามลำดับที่เห็นด้านบน'
    );
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
            format: 'doubles', mode: 'variety',
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

  it('uses each court\'s name in the share text, keeping the literal text of an HTML-looking name', async () => {
    await settled(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        courtCount: 3,
        editableCourtCount: 3,
        courtLabels: ['<b>A</b>', 'หลัง'],
        courts: [
          {
            status: 'active',
            pairingId: 'x',
            format: 'doubles', mode: 'variety',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: '2026-09-08T12:00:00.000Z',
          },
          { status: 'idle', format: 'doubles', mode: 'variety' },
          { status: 'idle', format: 'doubles', mode: 'variety' },
        ],
      })
    );

    const lines = fixture.componentInstance.shareText().split('\n');
    expect(lines[0]).toMatch(/^คอร์ท <b>A<\/b>: ตั้ม/);
    expect(lines[1]).toBe('คอร์ท หลัง: ว่าง');
    expect(lines[2]).toBe('คอร์ท 3: ว่าง');
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
            format: 'singles', mode: 'variety',
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

  describe('lineup launcher', () => {
    async function load(overrides: Parameters<typeof baseSession>[0]) {
      fixture = TestBed.createComponent(SessionDashboard);
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession(overrides));
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      for (const r of httpMock.match(`${B}/groups/group1/players`)) {
        r.flush([
          { id: 'p1', name: 'ตั้ม', aliases: [] },
          { id: 'p2', name: 'เบส', aliases: [] },
          { id: 'p3', name: 'โอ', aliases: [] },
        ]);
      }
      for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    }
    const root = () => fixture.nativeElement as HTMLElement;

    it('has no inline lineup panel above the courts, only launch buttons with the count', async () => {
      await load({
        rosterPlayerIds: ['p1', 'p2', 'p3'],
        lineupQueue: [
          { id: 'q1', position: 0, teamA: ['p1', null], teamB: ['p2', null], blocked: [] },
          { id: 'q2', position: 1, teamA: ['p3', null], teamB: [null, null], blocked: [] },
        ],
      });
      expect(root().querySelector('.courts-list')!.previousElementSibling?.classList.contains('lineup-queue')).toBe(false);
      const buttons = Array.from(root().querySelectorAll('[data-lineup-open]'));
      expect(buttons.length).toBe(2); // toolbar copy and rail copy; CSS shows one per width
      for (const b of buttons) expect(b.querySelector('.lineup-launch-count')?.textContent?.trim()).toBe('2');
    });

    it('previews the next lineup in the rail copy only', async () => {
      await load({
        rosterPlayerIds: ['p1', 'p2', 'p3'],
        lineupQueue: [{ id: 'q1', position: 0, teamA: ['p1', 'p3'], teamB: ['p2', null], blocked: [] }],
      });
      const preview = root().querySelectorAll('[data-lineup-preview]');
      expect(preview.length).toBe(1);
      expect(preview[0].closest('.wq-lineup')).toBeTruthy();
      expect(preview[0].textContent?.replace(/\s+/g, ' ').trim()).toBe('ถัดไป: ตั้ม·โอ vs เบส·…');
    });

    it('shows no preview and no count when nothing is queued', async () => {
      await load({ rosterPlayerIds: ['p1', 'p2', 'p3'] });
      expect(root().querySelector('[data-lineup-preview]')).toBeNull();
      expect(root().querySelector('.lineup-launch-count')).toBeNull();
    });
  });

  describe('collapsible roster', () => {
    async function load(overrides: Parameters<typeof baseSession>[0]) {
      fixture = TestBed.createComponent(SessionDashboard);
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession(overrides));
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      for (const r of httpMock.match(`${B}/groups/group1/players`)) {
        r.flush([
          { id: 'p1', name: 'ตั้ม', aliases: [] },
          { id: 'p2', name: 'เบส', aliases: [] },
          { id: 'p3', name: 'โอ', aliases: [] },
        ]);
      }
      for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    }
    const chips = () =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.roster-chips .chip')).map((b) =>
        b.textContent?.replace(/\s+/g, ' ').trim()
      );
    const toggle = () => (fixture.nativeElement as HTMLElement).querySelector('[data-roster-toggle]') as HTMLButtonElement;

    it('starts collapsed, showing only the count and the players who are resting', async () => {
      localStorage.removeItem('jubbad.dashboard.rosterOpen');
      await load({ rosterPlayerIds: ['p1', 'p2', 'p3'], restingPlayerIds: ['p2'] });
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(toggle().textContent).toContain('3');
      expect(chips()).toEqual(['เบส']);
    });

    it('expands to every player and remembers the choice', async () => {
      localStorage.removeItem('jubbad.dashboard.rosterOpen');
      await load({ rosterPlayerIds: ['p1', 'p2', 'p3'], restingPlayerIds: [] });
      expect(chips()).toEqual([]);
      toggle().click();
      fixture.detectChanges();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(chips()).toEqual(['ตั้ม', 'เบส', 'โอ']);
      expect(localStorage.getItem('jubbad.dashboard.rosterOpen')).toBe('1');
    });
  });

  it('keeps the waiting list compact while its natural spot is below the screen, and opens it once scrolled to', async () => {
    let notify: IntersectionObserverCallback = () => {};
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) { notify = cb; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    try {
      fixture = TestBed.createComponent(SessionDashboard);
      fixture.detectChanges();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
      for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      const entry = (isIntersecting: boolean, top: number) =>
        [{ isIntersecting, boundingClientRect: { top } }] as unknown as IntersectionObserverEntry[];

      notify(entry(false, 900), {} as IntersectionObserver); // natural spot still below the screen
      fixture.detectChanges();
      expect(root.querySelector('.waiting-queue.is-stuck')).toBeTruthy();

      notify(entry(true, 400), {} as IntersectionObserver); // scrolled down to it
      fixture.detectChanges();
      expect(root.querySelector('.waiting-queue.is-stuck')).toBeNull();

      notify(entry(false, -50), {} as IntersectionObserver); // scrolled past it
      fixture.detectChanges();
      expect(root.querySelector('.waiting-queue.is-stuck')).toBeNull();
    } finally {
      globalThis.IntersectionObserver = original;
    }
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
    // Holding a waiting player is not a court hold, so there is no swap hint.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue .bench-hint')
    ).toBeNull();

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
          { status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
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

    // Holding a court player shows the swap hint on the (always sticky) waiting list.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue .bench-hint')
    ).toBeTruthy();

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
            { status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
          ],
        })
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    for (const r of httpMock.match(`${B}/groups/group1/players`)) r.flush([]);
    for (const r of httpMock.match(`${B}/sessions/sess1/stats?scope=session`)) r.flush([]);
  });

  describe('pair rules', () => {
    const rule = {
      id: 'r1',
      groupId: 'g1',
      playerAId: 'p1',
      playerBId: 'p2',
      kind: 'never-teammates' as const,
      createdAt: '2026-09-30T00:00:00.000Z',
    };
    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

    async function flushRules(disabledRuleIds: string[] = [], rules = [rule]) {
      for (const r of httpMock.match(`${B}/sessions/sess1/rules`)) r.flush({ rules, disabledRuleIds });
      await fixture.whenStable();
      fixture.detectChanges();
    }

    function ruleToggle(): HTMLInputElement {
      return (fixture.nativeElement as HTMLElement).querySelector('.session-rules input[type="checkbox"]')!;
    }

    it('switches a group rule off for tonight only, then back on', async () => {
      await settled();
      await flushRules();
      expect(text()).toContain('ตั้ม · เบส');
      expect(ruleToggle().checked).toBe(true);

      ruleToggle().click();
      const off = httpMock.expectOne(`${B}/sessions/sess1/rules/r1/toggle`);
      expect(off.request.body).toEqual({ enabled: false });
      off.flush({ ruleId: 'r1', enabled: false, disabledRuleIds: ['r1'] });
      await drainReload(baseSession());
      await flushRules(['r1']);
      expect(ruleToggle().checked).toBe(false);

      ruleToggle().click();
      const on = httpMock.expectOne(`${B}/sessions/sess1/rules/r1/toggle`);
      expect(on.request.body).toEqual({ enabled: true });
      on.flush({ ruleId: 'r1', enabled: true, disabledRuleIds: [] });
      await drainReload(baseSession());
      await flushRules([]);
      expect(ruleToggle().checked).toBe(true);
      // The group's own rule list is never written from the dashboard.
      expect(httpMock.match((r) => r.url.includes('/groups/group1/rules'))).toEqual([]);
    });

    it('picks up a rule added in another tab when the window regains focus', async () => {
      await settled();
      await flushRules([], []);
      expect((fixture.nativeElement as HTMLElement).querySelector('.session-rules')).toBeNull();

      window.dispatchEvent(new Event('focus'));
      await drainReload(baseSession());
      await flushRules();
      // drainReload re-flushes the player list empty, so names read '?' here.
      expect(text()).toContain('— ห้ามอยู่ด้วยกัน');
    });

    describe('adding a rule from the dashboard', () => {
      const dialog = () => (fixture.nativeElement as HTMLElement).querySelector('dialog.add-rule-dialog') as HTMLDialogElement;
      const addRuleButton = () =>
        (fixture.nativeElement as HTMLElement).querySelector('[data-add-rule]') as HTMLButtonElement | null;

      function tapPlayer(id: string): void {
        (dialog().querySelector(`[data-player-chip="${id}"]`) as HTMLButtonElement).click();
        fixture.detectChanges();
      }

      async function openAndFill(kind?: string) {
        addRuleButton()!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        tapPlayer('p1');
        tapPlayer('p2');
        if (kind) {
          (dialog().querySelector(`input[type="radio"][value="${kind}"]`) as HTMLInputElement).click();
          fixture.detectChanges();
        }
      }

      it('keeps the roster buttons in one spaced row, not loose siblings', async () => {
        await settled();
        await flushRules([], []);
        const row = (fixture.nativeElement as HTMLElement).querySelector('.roster-actions')!;
        expect(row).toBeTruthy();
        expect(row.querySelector('[data-add-walk-in]')).toBeTruthy();
        expect(row.querySelector('[data-add-rule]')).toBeTruthy();
        expect(row.querySelector('[data-player-panel-toggle]')).toBeTruthy();
      });

      it('offers the button even when the group has no rules yet', async () => {
        await settled();
        await flushRules([], []);
        expect(addRuleButton()).not.toBeNull();
      });

      it('hides the button once the session has ended', async () => {
        await settled(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
        await flushRules([], []);
        expect(addRuleButton()).toBeNull();
      });

      it('creates a persistent group rule, then shows it with its tonight switch', async () => {
        await settled();
        await flushRules([], []);
        await openAndFill('never-teammates');
        expect(dialog().hasAttribute('open')).toBe(true);

        (dialog().querySelector('[data-submit-rule]') as HTMLButtonElement).click();
        const post = httpMock.expectOne(`${B}/groups/group1/rules`);
        expect(post.request.method).toBe('POST');
        expect(post.request.body).toEqual({ playerAId: 'p1', playerBId: 'p2', kind: 'never-teammates' });
        post.flush(rule);
        await new Promise((r) => setTimeout(r, 0));

        // The session's rules are re-read so the new row and switch appear.
        await flushRules();
        expect(text()).toContain('ตั้ม · เบส');
        expect(ruleToggle().checked).toBe(true);
        expect(dialog().hasAttribute('open')).toBe(false);
      });

      it('keeps the dialog open and names the problem when the server refuses', async () => {
        await settled();
        await flushRules([], []);
        await openAndFill();

        (dialog().querySelector('[data-submit-rule]') as HTMLButtonElement).click();
        httpMock
          .expectOne(`${B}/groups/group1/rules`)
          .flush({ code: 'PAIR_RULE_EXISTS' }, { status: 409, statusText: 'Conflict' });
        await new Promise((r) => setTimeout(r, 0));
        fixture.detectChanges();

        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().textContent).toContain('ผู้เล่นคู่นี้มีกฎอยู่แล้ว');
        // Nothing was created, so the rules are not re-read.
        expect(httpMock.match(`${B}/sessions/sess1/rules`)).toEqual([]);
      });
    });

    async function fill(response: object) {
      buttonWith('จัดคู่ทุกคอร์ทว่าง').click();
      httpMock.expectOne(`${B}/sessions/sess1/courts/fill`).flush(response);
      await drainReload(baseSession());
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('names the courts fill-all left empty because of rules, even when others filled', async () => {
      await settled();
      await flushRules();
      await fill({ ok: true, filled: [1], blocked: [{ courtNumber: 2, ruleIds: ['r1'] }], inconclusive: [] });
      expect(text()).toContain('คอร์ท 2 จัดไม่ได้เพราะกฎการจับคู่: ตั้ม · เบส (ห้ามอยู่ด้วยกัน)');
    });

    it('never reports a rule-blocked or search-limited fill as not enough players', async () => {
      await settled();
      await flushRules();
      await fill({ ok: false, reason: 'pair-rules-blocked', filled: [], blocked: [{ courtNumber: 1, ruleIds: ['r1'] }], inconclusive: [] });
      expect(text()).toContain('คอร์ท 1 จัดไม่ได้เพราะกฎการจับคู่');
      expect(text()).not.toContain('ผู้เล่นไม่พอ');

      await fill({ ok: false, reason: 'pair-rule-search-limit', filled: [], blocked: [], inconclusive: [1] });
      expect(text()).toContain('คอร์ท 1 หาคู่ตามกฎไม่ทัน');
      expect(text()).not.toContain('ผู้เล่นไม่พอ');
    });
  });
});

