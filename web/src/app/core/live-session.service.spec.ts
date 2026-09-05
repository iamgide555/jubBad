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
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
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
    expect(service.courts()).toEqual([{ status: 'idle' }]);
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
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );

    expect(await promise).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(service.courts()).toEqual([
      { status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    ]);
  });

  it('proposeMatch returns false when the server reports not-enough-players', async () => {
    await flushSession(baseSession());

    const promise = service.proposeMatch(1);
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toBe(false);
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

    expect(await promise).toBe(true);
  });

  it('swapPlayer returns false when no substitute is available', async () => {
    await flushSession(baseSession());

    const promise = service.swapPlayer('pair1', 'p1');
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/swap`)
      .flush({ ok: false, reason: 'no-substitute' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toBe(false);
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
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
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

  it('endSession surfaces the server error on failure without throwing', async () => {
    await flushSession(baseSession());

    const promise = service.endSession();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1/end`).flush(
      { message: 'Finish all active courts before ending the session.' },
      { status: 409, statusText: 'Conflict' }
    );

    expect(await promise).toEqual({
      ok: false,
      error: 'Finish all active courts before ending the session.',
    });
  });
});
