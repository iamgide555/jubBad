import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { SessionDisplay } from './session-display';
import { environment } from '../../../environments/environment';
import type { Session } from '../../core/session.model';

const B = environment.apiBaseUrl;

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: 'KIP',
    courtCount: 1,
    endedAt: null,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    restingPlayerIds: [],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}

const players = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
  { id: 'p3', name: 'ปอม', aliases: [] },
  { id: 'p4', name: 'ไม้', aliases: [] },
];

async function createDisplay(session = baseSession()): Promise<{
  fixture: ComponentFixture<SessionDisplay>;
  httpMock: HttpTestingController;
}> {
  const httpMock = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SessionDisplay);
  fixture.detectChanges();

  httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();

  return { fixture, httpMock };
}

describe('SessionDisplay', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows the Group name as the header when one is set', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'Group A', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.header()).toBe('Group A');
  });

  it('falls back to date + venue when no Group name is set', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.header()).toBe('2026-09-08 · KIP');
  });

  it('shows "waiting" for an idle or pending court, never a proposed pairing', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.courtLines()[0].text).toBe('ว่าง');
  });

  it('shows the pairing for an active court', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    const line = fixture.componentInstance.courtLines()[0];
    expect(line.text).toContain('vs');
    expect(line.text).not.toBe('ว่าง');
  });

  it('shows a plain ended state instead of the live court grid once the session has ended', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({ endedAt: '2026-09-08T20:00:00.000Z' })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('จบก๊วนแล้ว');
  });

  it('clicking refresh calls liveSession.refresh', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
  });

  it('lists waiting players by name', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.waitingNames().sort()).toEqual(
      ['ตั้ม', 'ปอม', 'เบส', 'ไม้'].sort()
    );
  });
});

describe('SessionDisplay with an unknown sessionCode', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'ghost' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a "session not found" message', async () => {
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SessionDisplay);
    fixture.detectChanges();

    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/ghost`).flush('Not Found', {
      status: 404,
      statusText: 'Not Found',
    });
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ไม่พบก๊วนนี้');
  });
});
