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

// jsdom implements no showModal()/close() on <dialog>; the shuttle picker needs them.
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

  it('heads the court with its label and offers a rename control, even mid-match', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courtLabels: ['สนาม 7'],
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: new Date().toISOString() }],
      })
    );
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.court-num')?.textContent).toBe('สนาม 7');
    expect(el.querySelector('app-court-label-editor button[aria-label="เปลี่ยนชื่อคอร์ท สนาม 7"]')).toBeTruthy();
  });

  it('heads an unlabeled court with its number', async () => {
    const { fixture } = await createPanel();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.court-num')?.textContent).toBe('1');
  });

  it('shows reshuffle and confirm controls, and player names not ids, once pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
      });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
        })
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('สุ่มใหม่');
  });

  it('clicking "confirm" posts to confirm with the court\'s pairingId', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    await fixture.whenStable();
  });

  it('tapping a player name twice takes them off the court', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p5', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p5', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
      })
    );
    await fixture.whenStable();
  });

  it('shows a hint when swap reports no substitute available', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
      })
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ไม่มีคนสำรองให้เปลี่ยน');
  });

  const pendingCourt = () =>
    baseSession({
      courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p2', 'p1'], teamB: ['p3', 'p4'], autoStartAt: null },
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
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p2', 'p1'], teamB: ['p3', 'p4'], autoStartAt: null },
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
            format: 'doubles', mode: 'variety',
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
          courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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

  describe('auto-start countdown', () => {
    it('shows the remaining time', async () => {
      const now = Date.now();
      clockNow.set(now);
      const autoStartAt = new Date(now + 42_000).toISOString();
      const { fixture } = await createPanel(
        baseSession({
          serverNow: new Date(now).toISOString(),
          courts: [
            {
              status: 'pending',
              pairingId: 'pair1',
              format: 'doubles', mode: 'variety',
              teamA: ['p1', 'p2'],
              teamB: ['p3', 'p4'],
              autoStartAt,
            },
          ],
        })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.auto-start-hint')?.textContent).toContain('42');
    });

    it('hides once autoStartAt is null', async () => {
      const { fixture } = await createPanel(
        baseSession({
          courts: [
            { status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null },
          ],
        })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.auto-start-hint')).toBeNull();
    });

    it('reads "starting" once the countdown reaches zero', async () => {
      const now = Date.now();
      clockNow.set(now);
      const autoStartAt = new Date(now).toISOString();
      const { fixture } = await createPanel(
        baseSession({
          serverNow: new Date(now).toISOString(),
          courts: [
            {
              status: 'pending',
              pairingId: 'pair1',
              format: 'doubles', mode: 'variety',
              teamA: ['p1', 'p2'],
              teamB: ['p3', 'p4'],
              autoStartAt,
            },
          ],
        })
      );
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.auto-start-hint')?.textContent).toContain('กำลังเริ่ม');
    });

    it('refreshes the session once, about 6s past the deadline, and never again for the same deadline', async () => {
      const now = Date.now();
      clockNow.set(now);
      // Deadline already 3s in the past when the fixture loads.
      const autoStartAt = new Date(now - 3_000).toISOString();
      const { fixture } = await createPanel(
        baseSession({
          serverNow: new Date(now).toISOString(),
          courts: [
            {
              status: 'pending',
              pairingId: 'pair1',
              format: 'doubles', mode: 'variety',
              teamA: ['p1', 'p2'],
              teamB: ['p3', 'p4'],
              autoStartAt,
            },
          ],
        })
      );
      const liveSession = TestBed.inject(LiveSessionService);
      const refreshSpy = vi.spyOn(liveSession, 'refresh').mockImplementation(() => {});
      fixture.detectChanges();
      expect(refreshSpy).not.toHaveBeenCalled();

      // Now 6s past the deadline — the refresh guard's threshold.
      clockNow.set(now + 3_000);
      TestBed.tick();
      fixture.detectChanges();
      expect(refreshSpy).toHaveBeenCalledOnce();

      // Further past the same deadline: must not fire a second time.
      clockNow.set(now + 4_000);
      TestBed.tick();
      fixture.detectChanges();
      expect(refreshSpy).toHaveBeenCalledOnce();
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
    const { fixture } = await createPanel(baseSession({ courts: [{ status: 'idle', format: 'singles', mode: 'variety' }] }));
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
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ courts: [{ status: 'idle', format: 'singles', mode: 'variety' }] }));
    await fixture.whenStable();
  });

  it('disables the toggle while a match is pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'variety', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();
    for (const button of toggleButtons(fixture)) {
      expect(button.disabled).toBe(true);
    }
  });

  // --- Per-court sticky mode toggle ---------------------------------------

  function modeToggleButtons(fixture: ComponentFixture<CourtPanel>): HTMLButtonElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.court-mode-toggle button')] as HTMLButtonElement[];
  }

  it('shows the per-court mode toggle in a custom session', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'custom', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    expect(modeToggleButtons(fixture)).toHaveLength(4);
  });

  it('hides the per-court mode toggle outside a custom session', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    expect(modeToggleButtons(fixture)).toHaveLength(0);
  });

  it('calls setCourtMode when a mode segment is tapped', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({ mode: 'custom', courts: [{ status: 'idle', format: 'doubles', mode: 'custom' }] })
    );
    fixture.detectChanges();
    const levelBtn = modeToggleButtons(fixture).find((b) => b.textContent?.trim() === 'ระดับ')!;
    levelBtn.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/1/mode`);
    expect(req.request.body).toEqual({ mode: 'level' });
    req.flush({ code: 'sess1', courtNumber: 1, mode: 'level' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ mode: 'custom', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] }));
    await fixture.whenStable();
  });

  // --- Per-court target (Low / High) --------------------------------------

  function targetToggleButtons(fixture: ComponentFixture<CourtPanel>): HTMLButtonElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.court-target-toggle button')] as HTMLButtonElement[];
  }

  it('shows the target toggle on a level court, with the stored target active', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level', target: 'high' }] })
    );
    fixture.detectChanges();
    const buttons = targetToggleButtons(fixture);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['อัตโนมัติ', 'มือล่าง', 'มือบน']);
    expect(buttons.map((b) => b.classList.contains('active'))).toEqual([false, false, true]);
  });

  it('reads a missing target as auto', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    expect(targetToggleButtons(fixture)[0].classList).toContain('active');
  });

  it('hides the target toggle on a court that is not in level mode', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'variety', courts: [{ status: 'idle', format: 'doubles', mode: 'variety' }] })
    );
    fixture.detectChanges();
    expect(targetToggleButtons(fixture)).toHaveLength(0);
  });

  it('shows the target toggle on a level court inside a custom session', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'custom', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    expect(targetToggleButtons(fixture)).toHaveLength(3);
  });

  it('posts the new target when a segment is tapped, and reloads', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    targetToggleButtons(fixture)[1].click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/1/target`);
    expect(req.request.body).toEqual({ target: 'low' });
    req.flush({ code: 'sess1', courtNumber: 1, target: 'low' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level', target: 'low' }] }));
    await fixture.whenStable();
  });

  it('keeps the target toggle settable while a match is active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        mode: 'level',
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', mode: 'level', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    fixture.detectChanges();
    for (const button of targetToggleButtons(fixture)) expect(button.disabled).toBe(false);
  });

  it('disables the target toggle once the session has ended', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', endedAt: '2026-09-08T20:00:00.000Z', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    for (const button of targetToggleButtons(fixture)) expect(button.disabled).toBe(true);
  });

  it('explains a Low/High target', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level', target: 'low' }] })
    );
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('เทียบกับคนที่มาคืนนี้');
  });

  it('says nothing extra for an auto target', async () => {
    const { fixture } = await createPanel(
      baseSession({ mode: 'level', courts: [{ status: 'idle', format: 'doubles', mode: 'level' }] })
    );
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('เทียบกับคนที่มาคืนนี้');
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
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'singles', mode: 'variety', teamA: ['p1'], teamB: ['p2'], autoStartAt: null }],
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
        courts: [{ status: 'active', pairingId: 'pair1', format: 'singles', mode: 'variety', teamA: ['p1'], teamB: ['p2'], startedAt: '2026-09-08T12:00:00.000Z' }],
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
      courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', mode: 'custom', teamA, teamB, autoStartAt: null }],
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
    req.flush({ ok: true, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], autoStartAt: null } });
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
    req.flush({ ok: true, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: [null, 'p2'], teamB: ['p3', 'p4'], autoStartAt: null } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(customPendingCourt([null, 'p2'], ['p3', 'p4']));
    await fixture.whenStable();
  });

  it('tapping a seated player twice on a non-custom court inside a custom session calls the substitute endpoint, not seats', async () => {
    // The session is custom, but this specific court is set to ระดับ (or any
    // non-custom mode) — it must behave like a normal rotation court, not a
    // custom draft: double-tap should call the swap (substitute) endpoint,
    // never vacate the seat.
    const { fixture, httpMock } = await createPanel(
      baseSession({
        mode: 'custom',
        courts: [
          {
            status: 'pending',
            pairingId: 'pair1',
            format: 'doubles',
            mode: 'level',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            autoStartAt: null,
          },
        ],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button.name-tap');
    const nameButton = Array.from(buttons).find((b) => b.textContent === 'ตั้ม') as HTMLButtonElement;
    nameButton.click();
    fixture.detectChanges();
    httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/seats`);
    nameButton.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        mode: 'custom',
        courts: [
          {
            status: 'pending',
            pairingId: 'pair1',
            format: 'doubles',
            mode: 'level',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            autoStartAt: null,
          },
        ],
      })
    );
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
    req.flush({ ok: true, filled: 1, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p5'], teamB: ['p3', 'p4'], autoStartAt: null } });
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

  describe('pair rules', () => {
    const rule = {
      id: 'r1',
      groupId: 'g1',
      playerAId: 'p1',
      playerBId: 'p2',
      kind: 'never-teammates' as const,
      createdAt: '2026-09-30T00:00:00.000Z',
    };
    const withRules = (disabledRuleIds: string[] = []) =>
      TestBed.inject(LiveSessionService).sessionRules.set({ rules: [rule], disabledRuleIds });
    const text = (f: ComponentFixture<CourtPanel>) => (f.nativeElement as HTMLElement).textContent ?? '';
    const pendingCourt = (teamA: string[], teamB: string[]) =>
      baseSession({
        courts: [
          {
            status: 'pending',
            pairingId: 'pair1',
            format: 'doubles',
            mode: 'variety',
            teamA,
            teamB,
            autoStartAt: new Date(Date.now() + 40_000).toISOString(),
          },
        ],
      });

    async function propose(fixture: ComponentFixture<CourtPanel>, httpMock: HttpTestingController, flush: () => void) {
      const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((b) =>
        b.textContent?.includes('เริ่มแมตช์ถัดไป')
      )!;
      button.click();
      flush();
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      httpMock.match(`${B}/sessions/sess1`).forEach((r) => r.flush(baseSession()));
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('explains a rule-blocked proposal with the players and rule, never as not enough players', async () => {
      withRules();
      const { fixture, httpMock } = await createPanel();
      fixture.detectChanges();
      await propose(fixture, httpMock, () =>
        httpMock
          .expectOne(`${B}/sessions/sess1/courts/1/propose`)
          .flush({ ok: false, reason: 'pair-rules-blocked', ruleIds: ['r1'] })
      );
      expect(text(fixture)).toContain('จัดคอร์ทนี้ไม่ได้เพราะกฎการจับคู่: ตั้ม · เบส (ห้ามอยู่ด้วยกัน)');
      expect(text(fixture)).not.toContain('ผู้เล่นไม่พอ');
    });

    it('tells a search-limit refusal apart from not enough players', async () => {
      const { fixture, httpMock } = await createPanel();
      fixture.detectChanges();
      await propose(fixture, httpMock, () =>
        httpMock
          .expectOne(`${B}/sessions/sess1/courts/1/propose`)
          .flush({ code: 'PAIR_RULE_SEARCH_LIMIT' }, { status: 503, statusText: 'Unavailable' })
      );
      expect(text(fixture)).toContain('กฎการจับคู่ซับซ้อนเกินไป');
      expect(text(fixture)).not.toContain('ผู้เล่นไม่พอ');
    });

    it('flags a conflicting pending lineup, hides the auto-start countdown and blocks confirm', async () => {
      withRules();
      const { fixture } = await createPanel(pendingCourt(['p1', 'p2'], ['p3', 'p4']));
      fixture.detectChanges();
      expect(text(fixture)).toContain('ตั้ม · เบส (ห้ามอยู่ด้วยกัน)');
      expect(text(fixture)).toContain('ไลน์อัปนี้ขัดกับกฎการจับคู่');
      expect(text(fixture)).not.toContain('เริ่มอัตโนมัติ');
      const confirm = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((b) =>
        b.textContent?.includes('ยืนยัน')
      )!;
      expect(confirm.disabled).toBe(true);
    });

    it('ignores a rule switched off for tonight', async () => {
      withRules(['r1']);
      const { fixture } = await createPanel(pendingCourt(['p1', 'p2'], ['p3', 'p4']));
      fixture.detectChanges();
      expect(text(fixture)).not.toContain('ไลน์อัปนี้ขัดกับกฎการจับคู่');
      expect(text(fixture)).toContain('เริ่มอัตโนมัติ');
    });

    it('keeps an active match on screen, unflagged, when a rule now forbids it', async () => {
      withRules();
      const { fixture } = await createPanel(
        baseSession({
          courts: [
            {
              status: 'active',
              pairingId: 'pair1',
              format: 'doubles',
              mode: 'variety',
              teamA: ['p1', 'p2'],
              teamB: ['p3', 'p4'],
              startedAt: new Date().toISOString(),
            },
          ],
        })
      );
      fixture.detectChanges();
      expect(text(fixture)).toContain('ตั้ม');
      expect(text(fixture)).not.toContain('ไลน์อัปนี้ขัดกับกฎการจับคู่');
    });

    it('names the broken rule when the server refuses a swap', async () => {
      withRules();
      const { fixture, httpMock } = await createPanel(pendingCourt(['p1', 'p3'], ['p2', 'p4']));
      fixture.detectChanges();
      const done = (fixture.componentInstance as unknown as { runSwap(a: string, b: string, c?: string): Promise<void> }).runSwap(
        'pair1',
        'p3',
        'p2'
      );
      httpMock
        .expectOne(`${B}/sessions/sess1/pairings/pair1/swap`)
        .flush({ code: 'PAIR_RULE_VIOLATION', ruleIds: ['r1'] }, { status: 409, statusText: 'Conflict' });
      await done;
      fixture.detectChanges();
      expect(text(fixture)).toContain('เปลี่ยนไม่ได้ เพราะขัดกับกฎการจับคู่: ตั้ม · เบส (ห้ามอยู่ด้วยกัน)');
      // It describes the refused change, never the court as if it were in violation.
      expect(text(fixture)).not.toContain('ผู้เล่นในคอร์ทนี้ขัดกับกฎการจับคู่');
    });

    it('names the broken rule when the server refuses a seat edit', async () => {
      withRules();
      const { fixture, httpMock } = await createPanel(pendingCourt(['p1', 'p3'], ['p2', 'p4']));
      fixture.detectChanges();
      const done = (
        fixture.componentInstance as unknown as {
          runSetSeat(pairingId: string, team: 'A' | 'B', index: number, playerId?: string): Promise<void>;
        }
      ).runSetSeat('pair1', 'A', 1, 'p2');
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/seats`);
      expect(req.request.body).toEqual({ team: 'A', index: 1, playerId: 'p2' });
      req.flush({ code: 'PAIR_RULE_VIOLATION', ruleIds: ['r1'] }, { status: 409, statusText: 'Conflict' });
      await done;
      fixture.detectChanges();
      expect(text(fixture)).toContain('เปลี่ยนไม่ได้ เพราะขัดกับกฎการจับคู่: ตั้ม · เบส (ห้ามอยู่ด้วยกัน)');
      expect(text(fixture)).not.toContain('ใส่ผู้เล่นไม่สำเร็จ');
    });

    it('shows a refusal beside the seats, above the action buttons, on a pending court', async () => {
      withRules();
      const { fixture, httpMock } = await createPanel(pendingCourt(['p1', 'p3'], ['p2', 'p4']));
      fixture.detectChanges();
      const done = (fixture.componentInstance as unknown as { runSwap(a: string, b: string, c?: string): Promise<void> }).runSwap(
        'pair1',
        'p3',
        'p2'
      );
      httpMock
        .expectOne(`${B}/sessions/sess1/pairings/pair1/swap`)
        .flush({ code: 'PAIR_RULE_VIOLATION', ruleIds: ['r1'] }, { status: 409, statusText: 'Conflict' });
      await done;
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      const alerts = root.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBe(1);
      const row = root.querySelector('.button-row')!;
      expect(alerts[0].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('numbered shuttles', () => {
    const inventory = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      identities: [
        { id: 's1', number: 1, usable: true, voided: false },
        { id: 's2', number: 2, usable: true, voided: false },
        { id: 's3', number: 3, usable: false, voided: false },
      ],
      games: [],
      heldShuttleIds: [],
      lastShuttleByCourt: [],
      ...over,
    });
    const pendingSession = (advanced: boolean) =>
      baseSession({
        shuttleToolsEnabled: advanced,
        courts: [
          {
            status: 'pending',
            pairingId: 'pair1',
            format: 'doubles',
            mode: 'variety',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            autoStartAt: new Date(Date.now() + 40_000).toISOString(),
          },
        ],
      });
    const activeSession = (over: { current?: { id: string; number: number } | null; used?: { id: string; number: number }[]; advanced?: boolean } = {}) =>
      baseSession({
        shuttleToolsEnabled: over.advanced ?? true,
        courts: [
          {
            status: 'active',
            pairingId: 'pair1',
            revision: 7,
            format: 'doubles',
            mode: 'variety',
            teamA: ['p1', 'p2'],
            teamB: ['p3', 'p4'],
            startedAt: new Date().toISOString(),
            ...((over.advanced ?? true)
              ? { currentShuttle: over.current === undefined ? { id: 's2', number: 2 } : over.current, usedShuttles: over.used ?? [{ id: 's1', number: 1 }, { id: 's2', number: 2 }] }
              : {}),
          },
        ],
      });

    const root = (f: ComponentFixture<CourtPanel>) => f.nativeElement as HTMLElement;
    const button = (f: ComponentFixture<CourtPanel>, label: string) =>
      [...root(f).querySelectorAll('button')].find((b) => !b.closest('dialog') && b.textContent?.includes(label)) as HTMLButtonElement | undefined;
    const dialog = (f: ComponentFixture<CourtPanel>) => root(f).querySelector('dialog.shuttle-picker-dialog') as HTMLDialogElement;
    const settle = async (f: ComponentFixture<CourtPanel>) => {
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      await f.whenStable();
      f.detectChanges();
    };
    async function reload(f: ComponentFixture<CourtPanel>, httpMock: HttpTestingController, next: Session) {
      await new Promise((r) => setTimeout(r, 0));
      TestBed.tick();
      httpMock.expectOne(`${B}/sessions/sess1`).flush(next);
      await settle(f);
    }

    it('an ordinary session confirms in one tap with no inventory request and no dialog', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(false));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
      expect(req.request.body).toEqual({});
      req.flush({});
      await reload(fixture, httpMock, activeSession({ advanced: false }));
      expect(dialog(fixture)?.hasAttribute('open') ?? false).toBe(false);
    });

    it('an advanced session asks for a shuttle before confirming, suggesting the court\'s last one', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's2' }] }));
      await settle(fixture);
      expect(dialog(fixture).hasAttribute('open')).toBe(true);
      expect(dialog(fixture).textContent).toContain('#2');
      // Nothing is confirmed until the host chooses.
      httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/confirm`);
      (dialog(fixture).querySelector('[data-submit-shuttle]') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
      expect(req.request.body).toEqual({ shuttle: { kind: 'existing', shuttleId: 's2' } });
      req.flush({});
      await reload(fixture, httpMock, activeSession());
      expect(dialog(fixture).hasAttribute('open')).toBe(false);
    });

    it('with nothing to choose between (no last shuttle on the court, none idle) it confirms with a new shuttle and asks nothing', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ identities: [], heldShuttleIds: [], lastShuttleByCourt: [] }));
      await settle(fixture);
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
      expect(req.request.body).toEqual({ shuttle: { kind: 'new' } });
      expect(dialog(fixture)?.hasAttribute('open') ?? false).toBe(false);
      req.flush({});
      await reload(fixture, httpMock, activeSession());
    });

    it('offers a new shuttle instead when the court\'s last one is retired or busy elsewhere', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      // Court 1's last (#3) is retired; #1 is held by another court.
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's3' }], heldShuttleIds: ['s1'] }));
      await settle(fixture);
      expect(dialog(fixture).querySelector('input[value="last"]')).toBeNull();
      expect((dialog(fixture).querySelector('input[value="new"]') as HTMLInputElement).checked).toBe(true);
      expect(dialog(fixture).querySelector('[data-shuttle-chip="s1"]')).toBeNull();
      expect(dialog(fixture).querySelector('[data-shuttle-chip="s2"]')).toBeTruthy();
      (dialog(fixture).querySelector('[data-submit-shuttle]') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
      expect(req.request.body).toEqual({ shuttle: { kind: 'new' } });
      req.flush({});
      await reload(fixture, httpMock, activeSession());
    });

    it('recovers from the 60s auto-confirm winning the race: closes the prompt, says so, and reloads', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory());
      await settle(fixture);
      (dialog(fixture).querySelector('[data-submit-shuttle]') as HTMLButtonElement).click();
      httpMock
        .expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`)
        .flush({ code: 'PAIRING_CONFIRMED' }, { status: 409, statusText: 'Conflict' });
      await reload(fixture, httpMock, activeSession());
      expect(dialog(fixture).hasAttribute('open')).toBe(false);
      expect(root(fixture).textContent).toContain('ยืนยันไปแล้ว');
    });

    it('names the court in the prompt title, with the word คอร์ท, using its label', async () => {
      const { fixture, httpMock } = await createPanel({ ...pendingSession(true), courtLabels: ['ริมหน้าต่าง'] });
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory());
      await settle(fixture);
      expect(dialog(fixture).querySelector('h2')!.textContent).toContain('คอร์ท ริมหน้าต่าง');
    });

    it('cancelling the prompt confirms nothing', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory());
      await settle(fixture);
      ([...dialog(fixture).querySelectorAll('button')].find((b) => b.textContent?.includes('ยกเลิก')) as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(dialog(fixture).hasAttribute('open')).toBe(false);
      httpMock.expectNone(`${B}/sessions/sess1/pairings/pair1/confirm`);
    });

    it('shows an inventory load failure instead of an empty prompt', async () => {
      const { fixture, httpMock } = await createPanel(pendingSession(true));
      fixture.detectChanges();
      button(fixture, 'ยืนยัน')!.click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush('x', { status: 500, statusText: 'Server Error' });
      await settle(fixture);
      expect(dialog(fixture)?.hasAttribute('open') ?? false).toBe(false);
      expect(root(fixture).querySelector('[role="alert"]')).toBeTruthy();
    });

    it('an active advanced court shows the current shuttle and the distinct ones used this game', async () => {
      const { fixture } = await createPanel(activeSession());
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-current-shuttle]')!.textContent).toContain('#2');
      expect(root(fixture).querySelector('[data-used-shuttles]')!.textContent).toContain('#1');
      expect(root(fixture).querySelector('[data-used-shuttles]')!.textContent).toContain('#2');
      // Two controls, not three: the shuttle in hand opens the picker, which holds "unusable".
      expect(root(fixture).querySelectorAll('.shuttle-actions button')).toHaveLength(2);
      expect(root(fixture).querySelector('[data-retire-shuttle]')).toBeNull();
      for (const attr of ['data-open-new-shuttle', 'data-switch-shuttle']) {
        const el = root(fixture).querySelector(`[${attr}]`) as HTMLButtonElement;
        expect(el, attr).toBeTruthy();
        expect(el.getAttribute('type')).toBe('button');
      }
    });

    it('an active ordinary court shows no shuttle controls at all', async () => {
      const { fixture } = await createPanel(activeSession({ advanced: false }));
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-current-shuttle]')).toBeNull();
      expect(root(fixture).querySelector('[data-open-new-shuttle]')).toBeNull();
    });

    it('open new sends the court\'s revision, then shows what the server now holds', async () => {
      const { fixture, httpMock } = await createPanel(activeSession());
      fixture.detectChanges();
      (root(fixture).querySelector('[data-open-new-shuttle]') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/shuttles/switch`);
      expect(req.request.body).toEqual({ choice: { kind: 'new' }, expectedRevision: 7 });
      // Disabled while the write is in flight; the screen still shows the old shuttle.
      fixture.detectChanges();
      expect((root(fixture).querySelector('[data-open-new-shuttle]') as HTMLButtonElement).disabled).toBe(true);
      expect(root(fixture).querySelector('[data-current-shuttle]')!.textContent).toContain('#2');
      req.flush({});
      await reload(fixture, httpMock, activeSession({ current: { id: 's9', number: 9 }, used: [{ id: 's2', number: 2 }, { id: 's9', number: 9 }] }));
      expect(root(fixture).querySelector('[data-current-shuttle]')!.textContent).toContain('#9');
    });

    it('switch to existing opens the picker without the current shuttle and sends the chosen one', async () => {
      const { fixture, httpMock } = await createPanel(activeSession());
      fixture.detectChanges();
      (root(fixture).querySelector('[data-switch-shuttle]') as HTMLButtonElement).click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ heldShuttleIds: ['s2'] }));
      await settle(fixture);
      expect(dialog(fixture).hasAttribute('open')).toBe(true);
      expect(dialog(fixture).querySelector('[data-shuttle-chip="s2"]')).toBeNull(); // the one in hand
      (dialog(fixture).querySelector('[data-shuttle-chip="s1"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      (dialog(fixture).querySelector('[data-submit-shuttle]') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/shuttles/switch`);
      expect(req.request.body).toEqual({ choice: { kind: 'existing', shuttleId: 's1' }, expectedRevision: 7 });
      req.flush({});
      await reload(fixture, httpMock, activeSession({ current: { id: 's1', number: 1 } }));
      expect(dialog(fixture).hasAttribute('open')).toBe(false);
    });

    it('mark unusable switches away and retires the old shuttle in one action', async () => {
      const { fixture, httpMock } = await createPanel(activeSession());
      fixture.detectChanges();
      (root(fixture).querySelector('[data-switch-shuttle]') as HTMLButtonElement).click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory({ heldShuttleIds: ['s2'] }));
      await settle(fixture);
      const retire = dialog(fixture).querySelector('input[name="retirePrevious"]') as HTMLInputElement;
      expect(retire.checked).toBe(false);
      retire.click();
      fixture.detectChanges();
      (dialog(fixture).querySelector('[data-submit-shuttle]') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/shuttles/switch`);
      expect(req.request.body).toEqual({ choice: { kind: 'new' }, expectedRevision: 7, retirePrevious: true });
      req.flush({});
      await reload(fixture, httpMock, activeSession({ current: { id: 's9', number: 9 } }));
    });

    it('a stale or refused switch shows a localized error, keeps the old shuttle, and reloads', async () => {
      const { fixture, httpMock } = await createPanel(activeSession());
      fixture.detectChanges();
      (root(fixture).querySelector('[data-open-new-shuttle]') as HTMLButtonElement).click();
      httpMock
        .expectOne(`${B}/sessions/sess1/pairings/pair1/shuttles/switch`)
        .flush({ code: 'PAIRING_STALE' }, { status: 409, statusText: 'Conflict' });
      await reload(fixture, httpMock, activeSession());
      expect(root(fixture).querySelector('[role="alert"]')!.textContent).toContain('อุปกรณ์อื่น');
      expect(root(fixture).querySelector('[data-current-shuttle]')!.textContent).toContain('#2');
    });

    it('after an undo-finish with no shuttle in hand, prompts the host to choose one', async () => {
      const { fixture, httpMock } = await createPanel(activeSession({ current: null, used: [{ id: 's1', number: 1 }] }));
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-current-shuttle]')).toBeNull();
      expect(root(fixture).textContent).toContain('ยังไม่ได้เลือกลูกแบด');
      (root(fixture).querySelector('[data-choose-shuttle]') as HTMLButtonElement).click();
      httpMock.expectOne(`${B}/sessions/sess1/shuttles`).flush(inventory());
      await settle(fixture);
      expect(dialog(fixture).hasAttribute('open')).toBe(true);
    });

    it('does not touch the winner buttons: finishing stays independent of any shuttle write', async () => {
      const { fixture, httpMock } = await createPanel(activeSession());
      fixture.detectChanges();
      (root(fixture).querySelector('.win-a') as HTMLButtonElement).click();
      const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/finish`);
      expect(req.request.body).toMatchObject({ winner: 'A' });
      req.flush({});
      await reload(fixture, httpMock, baseSession());
    });
  });
});

