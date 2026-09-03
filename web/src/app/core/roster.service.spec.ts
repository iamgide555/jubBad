import { TestBed } from '@angular/core/testing';
import { RosterService } from './roster.service';
import type { Player } from '../../../../fuzzy-match.ts';
import type { Session } from './session.model';

describe('RosterService', () => {
  let service: RosterService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(RosterService);
  });

  it('getPlayers returns an empty array when nothing is stored', () => {
    expect(service.getPlayers('group1')).toEqual([]);
  });

  it('savePlayers then getPlayers round-trips', () => {
    const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];
    service.savePlayers('group1', players);
    expect(service.getPlayers('group1')).toEqual(players);
  });

  it('players are scoped per group', () => {
    service.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    expect(service.getPlayers('group2')).toEqual([]);
  });

  it('getSession returns null when nothing is stored', () => {
    expect(service.getSession('sess1')).toBeNull();
  });

  it('createSession then getSession round-trips', () => {
    const session: Session = {
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
      rawImportText: 'raw text',
      rosterPlayerIds: ['p1', 'p2'],
      waitlistPlayerIds: [],
    };
    service.createSession(session);
    expect(service.getSession('sess1')).toEqual(session);
  });
});
