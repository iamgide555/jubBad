import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CourtPanel } from './court-panel';
import { ClockService } from '../../../core/clock.service';
import { LiveSessionService } from '../../../core/live-session.service';
import { SwapSelectionService } from '../../../core/swap-selection.service';
import { environment } from '../../../../environments/environment';
import type { Session } from '../../../core/session.model';

const B = environment.apiBaseUrl;

/**
 * Never ticking on its own: the real ClockService's 1Hz interval writes a
 * signal outside Angular's render cycle, which — per the doc comment on
 * core/motion/odometer.ts — has intermittently tripped HttpTestingController
 * .verify() in an unrelated spec. Every test here stubs the clock instead;
 * tests that need it to move call `clockNow.set(...)` themselves.
 *
 * Seeded from the real Date.now() (not a fixed calendar date) because
 * LiveSessionService.serverSkewMs deliberately reads the real clock to
 * capture skew at response time — a frozen fixture date would show up as a
 * many-day "skew" against it.
 */
let clockNow: ReturnType<typeof signal<number>>;

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
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
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
    clockNow = signal(Date.now());
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        { provide: ClockService, useValue: { now: clockNow } },
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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

  it('names each winner button for a screen reader without printing it', async () => {
    // The visible label is only "ชนะ" — the column says which team — so the
    // names have to survive somewhere a screen reader still reaches.
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const winA = host.querySelector('.win-a') as HTMLButtonElement;
    const winB = host.querySelector('.win-b') as HTMLButtonElement;
    expect(winA.getAttribute('aria-label')).toBe('ตั้ม & เบส ชนะ');
    expect(winB.getAttribute('aria-label')).toBe('ปอม & ไม้ ชนะ');

    // Long names must not come back as button text: that is what made one
    // court's panel twice the height of its neighbours.
    expect(winA.textContent?.trim()).toBe('ชนะ');
    expect(winB.textContent?.trim()).toBe('ชนะ');
  });

  it('clicking a winner button finishes with that winner and current scores', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();

    const scoreInputs = (fixture.nativeElement as HTMLElement).querySelectorAll('input[type="number"]');
    (scoreInputs[0] as HTMLInputElement).value = '21';
    (scoreInputs[0] as HTMLInputElement).dispatchEvent(new Event('input'));
    (scoreInputs[1] as HTMLInputElement).value = '15';
    (scoreInputs[1] as HTMLInputElement).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const winButton = (fixture.nativeElement as HTMLElement).querySelector(
      '.win-a'
    ) as HTMLButtonElement;
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();

    const winButton = (fixture.nativeElement as HTMLElement).querySelector(
      '.win-a'
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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

    const button = (fixture.nativeElement as HTMLElement).querySelector('.court-panel > button') as HTMLButtonElement;
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
          courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        })
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('สุ่มใหม่');
  });

  it('clicking "confirm" posts to confirm with the court\'s pairingId', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    await fixture.whenStable();
  });

  it('tapping a player name twice takes them off the court', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
  });

  it('shows a hint when swap reports no substitute available', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่มีคนสำรองให้เปลี่ยน');
  });

  const pendingCourt = () =>
    baseSession({
      courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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

  describe('live court timer', () => {
    /**
     * `startedAgoMs`/`serverNowAgoMs` are both relative to a `now` captured
     * once per test (real Date.now(), matching clockNow's seed) — not a fixed
     * calendar date. serverSkewMs is `realNow_atFlush - serverNow`, so a
     * non-zero serverNowAgoMs is exactly how these tests simulate clock skew:
     * a serverNow reported further in the past than clockNow reads as "ahead".
     */
    function activeCourt(now: number, startedAgoMs: number, serverNowAgoMs = 0) {
      return baseSession({
        courts: [
          {
            status: 'active',
            pairingId: 'pair1',
            format: 'doubles',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: new Date(now - startedAgoMs).toISOString(),
          },
        ],
        serverNow: new Date(now - serverNowAgoMs).toISOString(),
      });
    }

    it('shows elapsed time as M:SS for an active court', async () => {
      const now = Date.now();
      clockNow.set(now);
      // +500ms padding: a few ms of real wall-clock time pass between capturing
      // `now` and the resource flush that serverSkewMs measures against, so an
      // offset exactly on a second boundary can floor down by one.
      const { fixture } = await createPanel(activeCourt(now, (12 * 60 + 7) * 1000 + 500));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.textContent?.trim()).toBe('12:07');
    });

    it('shows no timer on a pending court', async () => {
      const { fixture } = await createPanel(
        baseSession({
          courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')).toBeNull();
    });

    it('shows no timer on an idle court', async () => {
      const { fixture } = await createPanel(baseSession());
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')).toBeNull();
    });

    it('shifts the displayed elapsed time by the server clock skew', async () => {
      // Server says the match started 5 minutes ago, but its own clock is
      // reported 2 minutes further behind the client's — i.e. the client
      // clock reads 2 minutes fast — so the true elapsed time is 3 minutes.
      const now = Date.now();
      clockNow.set(now);
      const { fixture } = await createPanel(activeCourt(now, 5 * 60_000 + 500, 2 * 60_000));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.textContent?.trim()).toBe('3:00');
    });

    it('flags the court as overrun past 30 minutes', async () => {
      const now = Date.now();
      clockNow.set(now);
      const { fixture } = await createPanel(activeCourt(now, 31 * 60_000));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.classList.contains('overrun')).toBe(true);
    });

    it('does not flag a court under 30 minutes as overrun', async () => {
      const now = Date.now();
      clockNow.set(now);
      const { fixture } = await createPanel(activeCourt(now, 5 * 60_000));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.classList.contains('overrun')).toBe(false);
    });

    it('ticks the displayed time forward as the clock advances', async () => {
      const now = Date.now();
      clockNow.set(now);
      const { fixture } = await createPanel(activeCourt(now, 0));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.textContent?.trim()).toBe('0:00');

      // +500ms padding: see the earlier boundary comment — real wall-clock
      // time passes between capturing `now` and this second flush too.
      clockNow.set(now + 47_500);
      TestBed.tick();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.court-timer')?.textContent?.trim()).toBe('0:47');
    });
  });
});

describe('CourtPanel with too few players', () => {
  beforeEach(async () => {
    clockNow = signal(Date.now());
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        { provide: ClockService, useValue: { now: clockNow } },
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

    const button = (fixture.nativeElement as HTMLElement).querySelector('.court-panel > button') as HTMLButtonElement;
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();

    const undo = (fixture.nativeElement as HTMLElement).querySelector(
      'button.undo'
    ) as HTMLButtonElement;
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

    const undo = (fixture.nativeElement as HTMLElement).querySelector(
      'button.undo'
    ) as HTMLButtonElement;
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

  it('shows each pending player\'s real games-played tally next to their name', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.componentRef.setInput('gamesPlayed', { p1: 3, p2: 2, p3: 1 });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const tallies = [...el.querySelectorAll('.tally')].map((t) => t.textContent?.trim());
    expect(tallies).toEqual(['3 เกม', '2 เกม', '1 เกม', '0 เกม']);
  });

  it('shows each active player\'s real games-played tally next to their name', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.componentRef.setInput('gamesPlayed', { p1: 5, p4: 4 });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const tallies = [...el.querySelectorAll('.tally')].map((t) => t.textContent?.trim());
    expect(tallies).toEqual(['5 เกม', '0 เกม', '0 เกม', '4 เกม']);
  });

  // --- Per-court format toggle -------------------------------------------

  function toggleButtons(fixture: ComponentFixture<CourtPanel>): HTMLButtonElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.format-toggle button')] as HTMLButtonElement[];
  }

  it('marks the current format active on an idle court', async () => {
    const { fixture } = await createPanel(baseSession({ courts: [{ status: 'idle', format: 'singles' }] }));
    fixture.detectChanges();
    const [doublesBtn, singlesBtn] = toggleButtons(fixture);
    expect(doublesBtn.classList).not.toContain('active');
    expect(singlesBtn.classList).toContain('active');
  });

  it('posts the new format when the toggle is tapped, and reloads', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();
    const [, singlesBtn] = toggleButtons(fixture);
    singlesBtn.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/1/format`);
    expect(req.request.body).toEqual({ format: 'singles' });
    req.flush({ code: 'sess1', courtNumber: 1, format: 'singles' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ courts: [{ status: 'idle', format: 'singles' }] }));
    await fixture.whenStable();
  });

  it('disables the toggle while a match is pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    for (const button of toggleButtons(fixture)) {
      expect(button.disabled).toBe(true);
    }
  });

  it('disables the toggle while a match is active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();
    for (const button of toggleButtons(fixture)) {
      expect(button.disabled).toBe(true);
    }
  });

  it('disables the toggle once the session has ended', async () => {
    const { fixture } = await createPanel(baseSession({ endedAt: '2026-09-08T20:00:00.000Z' }));
    fixture.detectChanges();
    for (const button of toggleButtons(fixture)) {
      expect(button.disabled).toBe(true);
    }
  });

  it('renders exactly two slots for a singles pending court, with working pick/target/aria', async () => {
    const { fixture } = await createPanel(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'singles', teamA: ['p1'], teamB: ['p2'] }],
      })
    );
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const slots = el.querySelectorAll('.matchup-columns .slot');
    expect(slots.length).toBe(2);
    const nameTaps = [...el.querySelectorAll('.name-tap')] as HTMLButtonElement[];
    expect(nameTaps.map((b) => b.textContent?.trim())).toEqual(['ตั้ม', 'เบส']);
    expect(nameTaps[0].getAttribute('aria-label')).toContain('ตั้ม');
  });

  it('joins a singles winner label with just the one name, not "X & undefined"', async () => {
    const { fixture } = await createPanel(
      baseSession({
        rosterPlayerIds: ['p1', 'p2'],
        courts: [{ status: 'active', pairingId: 'pair1', format: 'singles', teamA: ['p1'], teamB: ['p2'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const winA = el.querySelector('.win-a') as HTMLButtonElement;
    expect(winA.getAttribute('aria-label')).not.toContain('undefined');
    expect(winA.getAttribute('aria-label')).toContain('ตั้ม');
  });

  it('shows a try-singles hint when a doubles court comes back short by 2-3 players', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('.court-panel > button')!.dispatchEvent(new Event('click'));

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players', available: 2, format: 'doubles' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('เหลือ 2');
    expect(text).toContain('สลับเป็นเดี่ยวได้');
  });

  it('falls back to the plain not-enough-players hint at 0-1 players free', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('.court-panel > button')!.dispatchEvent(new Event('click'));

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players', available: 1, format: 'doubles' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ผู้เล่นไม่พอ');
    expect(text).not.toContain('สลับเป็นเดี่ยวได้');
  });

  // --- Custom mode: empty seats, seat editing, auto-pair -----------------

  const customPendingCourt = (teamA: (string | null)[], teamB: (string | null)[]) =>
    baseSession({
      mode: 'custom',
      courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA, teamB }],
    });

  it('renders an empty seat distinctly from a named one', async () => {
    const { fixture } = await createPanel(customPendingCourt(['p1', null], ['p3', 'p4']));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const emptySlots = el.querySelectorAll('.slot.is-empty');
    expect(emptySlots.length).toBe(1);
    const namedSlots = el.querySelectorAll('.slot:not(.is-empty)');
    expect(namedSlots.length).toBe(3);
    expect(el.querySelector('.name-tap.seat-empty')?.textContent?.trim()).toBe('ที่ว่าง');
  });

  it('places the held player into a tapped empty seat', async () => {
    const { fixture, httpMock } = await createPanel(customPendingCourt(['p1', null], ['p3', 'p4']));
    fixture.detectChanges();

    // Hold a waiting player (p2) via the roster/waiting chip path is
    // exercised in session-dashboard.spec.ts; here we simulate the hold
    // directly through the shared selection service the component reads.
    const selection = fixture.debugElement.injector.get(SwapSelectionService);
    selection.toggle({ playerId: 'p2', name: 'เบส', pairingId: null });
    fixture.detectChanges();

    const emptyButton = (fixture.nativeElement as HTMLElement).querySelector(
      '.name-tap.seat-empty'
    ) as HTMLButtonElement;
    emptyButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/seats`);
    expect(req.request.body).toEqual({ team: 'A', index: 1, playerId: 'p2' });
    req.flush({ ok: true, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      customPendingCourt(['p1', 'p2'], ['p3', 'p4'])
    );
    await fixture.whenStable();
  });

  it('tapping a seated player twice in custom mode vacates the seat, not a rotation swap', async () => {
    const { fixture, httpMock } = await createPanel(customPendingCourt(['p1', 'p2'], ['p3', 'p4']));
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();
    fixture.detectChanges();
    httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/swap`);
    nameButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/seats`);
    expect(req.request.body).toEqual({ team: 'A', index: 0, playerId: null });
    req.flush({ ok: true, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: [null, 'p2'], teamB: ['p3', 'p4'] } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(customPendingCourt([null, 'p2'], ['p3', 'p4']));
    await fixture.whenStable();
  });

  it('disables confirm and shows the empty-seats hint while a seat is unfilled', async () => {
    const { fixture } = await createPanel(customPendingCourt(['p1', null], ['p3', 'p4']));
    fixture.detectChanges();

    const confirmBtn = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes('ยืนยัน')) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ยังมีที่ว่าง 1 ที่');
  });

  it('shows the auto-pair button only while a seat is empty, and it posts to autopair', async () => {
    const { fixture, httpMock } = await createPanel(customPendingCourt(['p1', null], ['p3', 'p4']));
    fixture.detectChanges();

    const autoPairBtn = (fixture.nativeElement as HTMLElement).querySelector(
      '.auto-pair'
    ) as HTMLButtonElement;
    expect(autoPairBtn).toBeTruthy();
    autoPairBtn.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/autopair`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, filled: 1, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p5'], teamB: ['p3', 'p4'] } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(customPendingCourt(['p1', 'p5'], ['p3', 'p4']));
    await fixture.whenStable();
  });

  it('hides the auto-pair button once every seat is filled', async () => {
    const { fixture } = await createPanel(customPendingCourt(['p1', 'p2'], ['p3', 'p4']));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.auto-pair')).toBeNull();
  });

  it('shows "clear court" instead of "reshuffle" in custom mode', async () => {
    const { fixture } = await createPanel(customPendingCourt(['p1', 'p2'], ['p3', 'p4']));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ล้างคอร์ท');
    expect(text).not.toContain('สุ่มใหม่');
  });

  it('renders the localized message when confirm reports PAIRING_INCOMPLETE', async () => {
    const { fixture, httpMock } = await createPanel(customPendingCourt(['p1', 'p2'], ['p3', 'p4']));
    fixture.detectChanges();

    const confirmBtn = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.includes('ยืนยัน')) as HTMLButtonElement;
    confirmBtn.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`)
      .flush({ code: 'PAIRING_INCOMPLETE', emptySeats: 1 }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ยังมีที่ว่างในคอร์ท ใส่ผู้เล่นให้ครบก่อนยืนยัน'
    );
  });
});

