import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { LiveSessionService } from './live-session.service';
import { environment } from '../../environments/environment';
import type { Session } from './session.model';

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
    serverNow: '2026-09-08T12:00:00.000Z',
    mode: 'variety',
    lastPlayedAt: {},
    activatedAt: {},
    waitlistPlayerIds: [],
    courts: [{ status: 'idle', format: 'doubles' }],
    ...overrides,
  };
}

describe('LiveSessionService', () => {
  let service: LiveSessionService;
  let httpMock: HttpTestingController;

  function setUp() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    });
    service = TestBed.inject(LiveSessionService);
    httpMock = TestBed.inject(HttpTestingController);
  }

  async function flushSession(session: Session) {
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(session);
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    setUp();
  });

  it('exposes courts from the fetched session', async () => {
    await flushSession(baseSession());
    expect(service.courts()).toEqual([{ status: 'idle', format: 'doubles' }]);
  });

  it('serverSkewMs is near 0 when the client and server clocks agree', async () => {
    await flushSession(baseSession({ serverNow: new Date().toISOString() }));
    expect(Math.abs(service.serverSkewMs())).toBeLessThan(1000);
  });

  it('serverSkewMs reflects how far ahead the client clock is', async () => {
    const serverTime = new Date(Date.now() - 5 * 60_000);
    await flushSession(baseSession({ serverNow: serverTime.toISOString() }));
    expect(Math.round(service.serverSkewMs() / 60_000)).toBe(5);
  });

  it('proposeMatch posts to the propose endpoint and reloads the session', async () => {
    await flushSession(baseSession());

    const promise = service.proposeMatch(1);
    const proposeReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/courts/1/propose`
    );
    expect(proposeReq.request.method).toBe('POST');
    proposeReq.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    const reloadReq = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`);
    reloadReq.flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );

    expect(await promise).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(service.courts()).toEqual([
      { status: 'pending', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    ]);
  });

  it('proposeMatch reports the not-enough-players reason', async () => {
    await flushSession(baseSession());

    const promise = service.proposeMatch(1);
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: false, reason: 'not-enough-players' });
  });

  it('swapPlayer posts the playerId to the swap endpoint, reloads, and returns ok', async () => {
    await flushSession(baseSession());

    const promise = service.swapPlayer('pair1', 'p1');
    const swapReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/swap`
    );
    expect(swapReq.request.method).toBe('POST');
    expect(swapReq.request.body).toEqual({ playerId: 'p1' });
    swapReq.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p5', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: true });
  });

  it('swapPlayer reports the no-substitute reason', async () => {
    await flushSession(baseSession());

    const promise = service.swapPlayer('pair1', 'p1');
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: false, reason: 'no-substitute' });
  });

  it('confirmMatch posts to the confirm endpoint with the given pairingId and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.confirmMatch('pair1');
    const confirmReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/confirm`
    );
    expect(confirmReq.request.method).toBe('POST');
    confirmReq.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    await promise;
  });

  it('finishMatch posts scores and winner to the finish endpoint and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.finishMatch('pair1', 21, 15, 'A');
    const finishReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/finish`
    );
    expect(finishReq.request.method).toBe('POST');
    expect(finishReq.request.body).toEqual({ scoreA: 21, scoreB: 15, winner: 'A' });
    finishReq.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    await promise;
  });

  it('waitingPlayerIds excludes players on non-idle courts', async () => {
    await flushSession(
      baseSession({
        rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
        courts: [{ status: 'active', pairingId: 'pair1', format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], startedAt: '2026-09-08T12:00:00.000Z' }],
      })
    );
    expect(service.waitingPlayerIds().sort()).toEqual(['p5', 'p6']);
  });

  it('refresh triggers a reload', async () => {
    await flushSession(baseSession());
    service.refresh();
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());
  });

  it('endSession posts to the end endpoint and reloads on success', async () => {
    await flushSession(baseSession());

    const promise = service.endSession();
    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`);
    expect(req.request.method).toBe('POST');
    req.flush({ code: 'sess1', endedAt: '2026-09-08T20:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(
      baseSession({ endedAt: '2026-09-08T20:00:00.000Z' })
    );

    expect(await promise).toEqual({ ok: true });
  });

  it('endSession maps the server error code to a localized message', async () => {
    await flushSession(baseSession());

    const promise = service.endSession();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`).flush(
      { code: 'SESSION_HAS_UNFINISHED_PAIRINGS' },
      { status: 409, statusText: 'Conflict' }
    );

    expect(await promise).toEqual({
      ok: false,
      error: 'ยังมีแมตช์ที่ยังไม่จบ กรุณาบันทึกผลให้ครบก่อน',
    });
  });

  it('deprioritizeWaiting posts to the roster endpoint with no body, reloads, and returns ok', async () => {
    await flushSession(baseSession());

    const promise = service.deprioritizeWaiting();
    const req = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/roster/deprioritize-waiting`
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ ok: true, deprioritized: ['p2'] });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: true });
  });

  it('exposes mode from the fetched session', async () => {
    await flushSession(baseSession({ mode: 'custom' }));
    expect(service.mode()).toBe('custom');
  });

  it('setSeat posts team/index/playerId to the seats endpoint and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.setSeat('pair1', 'A', 1, 'p2');
    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/seats`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ team: 'A', index: 1, playerId: 'p2' });
    req.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: [null, 'p2'], teamB: [null, null] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: true });
  });

  it('setSeat with no playerId vacates the seat', async () => {
    await flushSession(baseSession());

    const promise = service.setSeat('pair1', 'B', 0);
    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/seats`);
    expect(req.request.body).toEqual({ team: 'B', index: 0, playerId: null });
    req.flush({ ok: true, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: [], teamB: [] } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: true });
  });

  it('autoPair posts to the autopair endpoint and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.autoPair('pair1');
    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/autopair`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ ok: true, filled: 2, pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] } });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: true });
  });

  it('autoPair reports the not-enough-players reason', async () => {
    await flushSession(baseSession());

    const promise = service.autoPair('pair1');
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/autopair`)
      .flush({ ok: false, reason: 'not-enough-players', available: 1 });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toEqual({ ok: false, reason: 'not-enough-players', available: 1 });
  });

  it('setMode accepts custom and maps PAIRING_INCOMPLETE to a localized message', async () => {
    await flushSession(baseSession());

    const modePromise = service.setMode('custom');
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/mode`).flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession({ mode: 'custom' }));
    expect(await modePromise).toEqual({ ok: true });

    const confirmPromise = service.confirmMatch('pair1');
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/confirm`)
      .flush({ code: 'PAIRING_INCOMPLETE', emptySeats: 1 }, { status: 409, statusText: 'Conflict' });
    expect(await confirmPromise).toEqual({
      ok: false,
      error: 'ยังมีที่ว่างในคอร์ท ใส่ผู้เล่นให้ครบก่อนยืนยัน',
    });
  });

  it('falls back to the action message for an unknown or missing error code', async () => {
    await flushSession(baseSession());

    const unknown = service.endSession();
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`)
      .flush({ code: 'SOMETHING_NEW' }, { status: 409, statusText: 'Conflict' });
    expect(await unknown).toEqual({ ok: false, error: 'จบก๊วนไม่สำเร็จ' });

    const noCode = service.fillCourts();
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/courts/fill`)
      .flush({ message: 'raw server prose' }, { status: 500, statusText: 'Server Error' });
    expect(await noCode).toEqual({ ok: false, error: 'จัดคู่ไม่สำเร็จ' });
  });
});
