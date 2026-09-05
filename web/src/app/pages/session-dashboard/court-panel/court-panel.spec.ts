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
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('เริ่มแมตช์ถัดไป');
  });

  it('shows reshuffle and confirm controls, and player names not ids, once pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('สุ่มใหม่');
    expect(text).toContain('ยืนยัน');
    expect(text).toContain('ตั้ม');
    expect(text).not.toContain('p1');
  });

  it('shows named winner buttons once active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม & เบส ชนะ');
    expect(text).toContain('ปอม & ไม้ ชนะ');
  });

  it('clicking a winner button finishes with that winner and current scores', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const scoreInputs = (fixture.nativeElement as HTMLElement).querySelectorAll('input[type="number"]');
    (scoreInputs[0] as HTMLInputElement).value = '21';
    (scoreInputs[0] as HTMLInputElement).dispatchEvent(new Event('input'));
    (scoreInputs[1] as HTMLInputElement).value = '15';
    (scoreInputs[1] as HTMLInputElement).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const winButton = Array.from(buttons).find((b) => b.textContent?.includes('ตั้ม')) as HTMLButtonElement;
    winButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/finish`);
    expect(req.request.body).toEqual({ scoreA: 21, scoreB: 15, winner: 'A' });
    req.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
  });

  it('finishes with no winner when the match is ended without a result', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const noResult = Array.from(buttons).find((b) =>
      b.textContent?.includes('ไม่มีผล')
    ) as HTMLButtonElement;
    noResult.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/finish`);
    expect(req.request.body).toEqual({ scoreA: null, scoreB: null, winner: null });
    req.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
  });

  it('shows the server message when confirming a match is rejected', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const confirmButton = Array.from(buttons).find((b) =>
      b.textContent?.includes('ยืนยัน')
    ) as HTMLButtonElement;
    confirmButton.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`)
      .flush({ message: 'แมตช์นี้เริ่มไปแล้ว' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('แมตช์นี้เริ่มไปแล้ว');
  });

  it('shows the server message when finishing a match is rejected', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const winButton = Array.from(buttons).find((b) =>
      b.textContent?.includes('ตั้ม')
    ) as HTMLButtonElement;
    winButton.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/finish`)
      .flush({ message: 'แมตช์นี้จบไปแล้ว' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('แมตช์นี้จบไปแล้ว');
  });

  it('clears a previous action error when the next action starts', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const findConfirm = () =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((b) =>
        b.textContent?.includes('ยืนยัน')
      ) as HTMLButtonElement;

    findConfirm().click();
    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`)
      .flush({ message: 'แมตช์นี้เริ่มไปแล้ว' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('เริ่มไปแล้ว');

    findConfirm().click();
    const retry = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
    retry.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('เริ่มไปแล้ว');
  });

  it('shows a plain ended state instead of controls once the session has ended', async () => {
    const { fixture } = await createPanel(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('จบก๊วนแล้ว');
    expect(text).not.toContain('เริ่มแมตช์ถัดไป');
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

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('สุ่มใหม่');
  });

  it('clicking "confirm" posts to confirm with the court\'s pairingId', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const confirmButton = Array.from(buttons).find((b) => b.textContent === 'ยืนยัน') as HTMLButtonElement;
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

  it('tapping a player name on a pending court swaps them out', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`);
    expect(req.request.body).toEqual({ playerId: 'p1' });
    req.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
  });

  it('shows a hint when swap reports no substitute available', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่มีคนสำรองให้เปลี่ยน');
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

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ผู้เล่นไม่พอ');
  });
});
