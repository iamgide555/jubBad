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
});
