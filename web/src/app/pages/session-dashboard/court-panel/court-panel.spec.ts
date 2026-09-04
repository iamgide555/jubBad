import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CourtPanel } from './court-panel';
import { LiveSessionService } from '../../../core/live-session.service';
import { environment } from '../../../../environments/environment';
import type { Session } from '../../../core/session.model';

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
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
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

async function createPanel(session = baseSession()): Promise<{
  fixture: ComponentFixture<CourtPanel>;
  httpMock: HttpTestingController;
}> {
  const httpMock = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(CourtPanel);
  fixture.componentRef.setInput('courtNumber', 1);
  fixture.componentRef.setInput('players', players);
  fixture.detectChanges();

  httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
  await fixture.whenStable();

  return { fixture, httpMock };
}

describe('CourtPanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
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

  it('shows a "Start next match" button when idle', async () => {
    const { fixture } = await createPanel();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Start next match');
  });

  it('shows reshuffle and confirm controls, and player names not ids, once pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Reshuffle');
    expect(text).toContain('Confirm');
    expect(text).toContain('ตั้ม');
    expect(text).not.toContain('p1');
  });

  it('shows a "Finish match" control once active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Finish match');
  });

  it('shows a plain ended state instead of controls once the session has ended', async () => {
    const { fixture } = await createPanel(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session ended');
    expect(text).not.toContain('Start next match');
  });

  it('clicking "Start next match" calls proposeMatch and reflects the pending court', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({
        ok: true,
        pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
      });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        })
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reshuffle');
  });

  it('clicking "confirm" posts to confirm with the court\'s pairingId', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const confirmButton = Array.from(buttons).find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
    confirmButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
    expect(req.request.method).toBe('POST');
    req.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
  });
});

describe('CourtPanel with too few players', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
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

  it('shows a message when there are not enough players to start a match', async () => {
    const { fixture, httpMock } = await createPanel(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Not enough players waiting');
  });
});
