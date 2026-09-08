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

  /**
   * Finding 35: a player rested after the proposal was made is still standing
   * in it, and the server refuses the confirm. Saying so here means the host
   * fixes it deliberately rather than discovering it by tapping a button that
   * fails.
   */
  it('names a rested player still standing in a pending proposal and blocks confirm', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        restingPlayerIds: ['p3'],
      })
    );
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent ?? '').toContain('ปอม');
    expect(el.textContent ?? '').toContain('พักอยู่');
    const confirm = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'ยืนยัน'
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('leaves confirm alone when the rested player is not in this proposal', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        restingPlayerIds: ['p5'],
      })
    );
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent ?? '').not.toContain('พักอยู่');
    const confirm = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'ยืนยัน'
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
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
      .flush({ code: 'PAIRING_CONFIRMED' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('แมตช์นี้ยืนยันไปแล้ว');
  });

  it('shows the mapped error when finishing a match is rejected', async () => {
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
      .flush({ code: 'PAIRING_ENDED' }, { status: 409, statusText: 'Conflict' });
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
      .flush({ code: 'PAIRING_CONFIRMED' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ยืนยันไปแล้ว');

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

  it('tapping a player name twice takes them off the court', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    // First tap only holds them; the second is what asks for a replacement.
    nameButton.click();
    fixture.detectChanges();
    httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/swap`);
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
    fixture.detectChanges();
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

  const pendingCourt = () =>
    baseSession({
      courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
    });

  const nameButton = (fixture: ComponentFixture<CourtPanel>, name: string) =>
    Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap')
    ).find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

  it('sends the chosen player when one is picked up first', async () => {
    const { fixture, httpMock } = await createPanel(pendingCourt());
    fixture.detectChanges();

    // Pick เบส up, then tap ตั้ม: เบส takes ตั้ม's place.
    nameButton(fixture, 'เบส').click();
    fixture.detectChanges();
    nameButton(fixture, 'ตั้ม').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`);
    expect(req.request.body).toEqual({ playerId: 'p1', withPlayerId: 'p2' });
    req.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p2', 'p1'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(pendingCourt());
  });

  it('holds a player on the first tap without sending anything', async () => {
    // The first tap is now purely a selection: nothing reaches the server
    // until the host says who — or says "anyone" by tapping again.
    const { fixture, httpMock } = await createPanel(pendingCourt());
    fixture.detectChanges();

    nameButton(fixture, 'ตั้ม').click();
    fixture.detectChanges();

    expect(fixture.componentInstance['selection'].isPicked('p1')).toBe(true);
    httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/swap`);
  });

  it('lets the server choose the replacement when the held player is tapped again', async () => {
    const { fixture, httpMock } = await createPanel(pendingCourt());
    fixture.detectChanges();

    nameButton(fixture, 'ตั้ม').click();
    fixture.detectChanges();
    nameButton(fixture, 'ตั้ม').click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`);
    expect(req.request.body).toEqual({ playerId: 'p1' });
    expect(req.request.body.withPlayerId).toBeUndefined();
    // The hold is released before the request, so the next tap starts fresh.
    expect(fixture.componentInstance['selection'].active()).toBe(false);
    req.flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(pendingCourt());
    await fixture.whenStable();
  });

  it('offers a way to put a held player back without finding them again', async () => {
    const { fixture } = await createPanel(pendingCourt());
    fixture.detectChanges();

    nameButton(fixture, 'เบส').click();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('กำลังถือ');

    (host.querySelector('.pick-hint .link') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance['selection'].active()).toBe(false);
  });

  it('clears the pick after a swap so the next tap is not captured', async () => {
    // Leaving the selection set would silently turn the following quick tap
    // into a second manual swap.
    const { fixture, httpMock } = await createPanel(pendingCourt());
    fixture.detectChanges();

    nameButton(fixture, 'เบส').click();
    fixture.detectChanges();
    nameButton(fixture, 'ตั้ม').click();

    httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/swap`).flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p2', 'p1'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(pendingCourt());
    expect(fixture.componentInstance['selection'].active()).toBe(false);
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
  it('undo posts to the court undo endpoint', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const undo = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes('ย้อนกลับ')) as HTMLButtonElement;
    undo.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/1/undo`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, undone: 'finish' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
  });

  it('explains when undo is blocked by players already on another court', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();

    const undo = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes('ย้อนกลับ')) as HTMLButtonElement;
    undo.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/undo`)
      .flush({ ok: false, reason: 'players-busy' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ลงคอร์ทอื่นแล้ว');
  });
});

