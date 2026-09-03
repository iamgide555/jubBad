import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { LiveSessionService } from './live-session.service';
import { RosterService } from './roster.service';

function setUpSession(sessionCode: string, courtCount: number, rosterPlayerIds: string[]) {
  const rosterService = TestBed.inject(RosterService);
  rosterService.createSession({
    code: sessionCode,
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount,
    rawImportText: '',
    rosterPlayerIds,
    waitlistPlayerIds: [],
  });
}

describe('LiveSessionService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    });
  });

  it('initializes one idle court per courtCount, no matches', () => {
    setUpSession('sess1', 2, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);
    expect(service.courts()).toEqual([{ status: 'idle' }, { status: 'idle' }]);
    expect(service.matches()).toEqual([]);
  });

  it('proposeMatch fills an idle court from the roster', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);

    const court = service.courts()[0];
    expect(court.status).toBe('pending');
    if (court.status === 'pending') {
      const allAssigned = [...court.teamA, ...court.teamB].sort();
      expect(allAssigned).toEqual(['p1', 'p2', 'p3', 'p4']);
    }
  });

  it('proposeMatch does nothing when fewer than 4 players are available', () => {
    setUpSession('sess1', 1, ['p1', 'p2']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);

    expect(service.courts()[0]).toEqual({ status: 'idle' });
  });

  it('proposeMatch excludes players reserved by other pending/active courts', () => {
    setUpSession('sess1', 2, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.1);
    const firstCourt = service.courts()[0];
    expect(firstCourt.status).toBe('pending');

    service.proposeMatch(2, () => 0.1);
    const secondCourt = service.courts()[1];
    expect(secondCourt.status).toBe('pending');

    if (firstCourt.status === 'pending' && secondCourt.status === 'pending') {
      const firstIds = new Set([...firstCourt.teamA, ...firstCourt.teamB]);
      const secondIds = [...secondCourt.teamA, ...secondCourt.teamB];
      for (const id of secondIds) {
        expect(firstIds.has(id)).toBe(false);
      }
    }
  });

  it('proposeMatch on an already-pending court reconsiders its own occupants (reshuffle)', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.1);
    service.proposeMatch(1, () => 0.9); // reshuffle with a different random stream

    const court = service.courts()[0];
    expect(court.status).toBe('pending');
    if (court.status === 'pending') {
      const allAssigned = [...court.teamA, ...court.teamB].sort();
      expect(allAssigned).toEqual(['p1', 'p2', 'p3', 'p4']); // still only these 4 players exist
    }
  });

  it('persists after proposeMatch, reloadable by a fresh instance under the same session key', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const first = TestBed.inject(LiveSessionService);
    first.proposeMatch(1, () => 0.5);
    expect(first.courts()[0].status).toBe('pending');

    const second = new LiveSessionService(
      TestBed.inject(ActivatedRoute),
      TestBed.inject(RosterService)
    );
    expect(second.courts()).toEqual(first.courts());
  });

  it('confirmMatch moves a pending court to active and logs a match record', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);

    const court = service.courts()[0];
    expect(court.status).toBe('active');
    expect(service.matches()).toHaveLength(1);
    expect(service.matches()[0]).toMatchObject({ courtNumber: 1, scoreA: null, scoreB: null });
  });

  it('confirmMatch does nothing on an idle court', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.confirmMatch(1);

    expect(service.courts()[0]).toEqual({ status: 'idle' });
    expect(service.matches()).toHaveLength(0);
  });

  it('finishMatch records the score and frees the court back to idle', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    service.finishMatch(1, 21, 15);

    expect(service.courts()[0]).toEqual({ status: 'idle' });
    expect(service.matches()[0]).toMatchObject({ scoreA: 21, scoreB: 15 });
  });

  it('finishMatch without a score still frees the court, leaving scores null', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    service.finishMatch(1, null, null);

    expect(service.courts()[0]).toEqual({ status: 'idle' });
    expect(service.matches()[0]).toMatchObject({ scoreA: null, scoreB: null });
  });

  it('finishMatch does nothing on an idle court', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.finishMatch(1, 21, 15);

    expect(service.courts()[0]).toEqual({ status: 'idle' });
    expect(service.matches()).toHaveLength(0);
  });

  it('finishMatch updates the correct match when a court has played more than once', () => {
    setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);

    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    service.finishMatch(1, 21, 10);

    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    service.finishMatch(1, 15, 21);

    expect(service.matches()).toHaveLength(2);
    expect(service.matches()[0]).toMatchObject({ scoreA: 21, scoreB: 10 });
    expect(service.matches()[1]).toMatchObject({ scoreA: 15, scoreB: 21 });
  });
});
