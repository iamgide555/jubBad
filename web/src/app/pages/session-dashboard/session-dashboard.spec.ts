import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { routes } from '../../app.routes';
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

  it('End session button calls endSession and shows the server error on failure', async () => {
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
      { message: 'จบแมตช์ในคอร์ทที่ยังเล่นอยู่ก่อนจบก๊วน' },
      { status: 409, statusText: 'Conflict' }
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const text2 = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text2).toContain('จบแมตช์ในคอร์ทที่ยังเล่นอยู่ก่อนจบก๊วน');
  });

  it('redirects to / once the session ends successfully', async () => {
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

    expect(navigateSpy).toHaveBeenCalledWith('/');
  });
});
