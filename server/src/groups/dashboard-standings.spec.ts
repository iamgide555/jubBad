import {
  DASHBOARD_SESSION_LIMIT,
  buildSessionList,
  buildStandings,
  type DashboardMatch,
} from './dashboard-standings.js';

const names = new Map([
  ['a', 'Ann'],
  ['b', 'Ben'],
  ['c', 'Cat'],
  ['d', 'Dan'],
]);

describe('buildStandings', () => {
  it('ranks by sessions attended, then games played, then name', () => {
    const matches: DashboardMatch[] = [
      { sessionCode: 's1', playerIds: ['a', 'b', 'c', 'd'] },
      { sessionCode: 's1', playerIds: ['a', 'b', 'c', 'd'] },
      { sessionCode: 's2', playerIds: ['a', 'b'] },
      { sessionCode: 's2', playerIds: ['a', 'c'] },
    ];
    // a: 2 sessions/4 games; b: 2/3; c: 2/3; d: 1/2.
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 2, gamesPlayed: 4 },
      { name: 'Ben', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Cat', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Dan', sessionsAttended: 1, gamesPlayed: 2 },
    ]);
  });

  it('counts a session once however many games a player had in it', () => {
    const matches: DashboardMatch[] = [
      { sessionCode: 's1', playerIds: ['a'] },
      { sessionCode: 's1', playerIds: ['a'] },
      { sessionCode: 's1', playerIds: ['a'] },
    ];
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 1, gamesPlayed: 3 },
    ]);
  });

  it('skips a player id that no longer exists instead of crashing', () => {
    const matches: DashboardMatch[] = [{ sessionCode: 's1', playerIds: ['a', 'deleted'] }];
    expect(buildStandings(matches, names)).toEqual([
      { name: 'Ann', sessionsAttended: 1, gamesPlayed: 1 },
    ]);
  });

  it('returns nothing for no matches', () => {
    expect(buildStandings([], names)).toEqual([]);
  });

  it('exposes exactly name, sessionsAttended and gamesPlayed', () => {
    const [row] = buildStandings([{ sessionCode: 's1', playerIds: ['a'] }], names);
    expect(Object.keys(row).sort()).toEqual(['gamesPlayed', 'name', 'sessionsAttended']);
  });
});

describe('buildSessionList', () => {
  const at = (iso: string) => new Date(iso);
  const base = { date: null, venue: null };

  it('counts matches and distinct players per session from confirmed matches', () => {
    const list = buildSessionList(
      [{ code: 's1', ...base, createdAt: at('2026-09-01'), endedAt: at('2026-09-01') }],
      [
        { sessionCode: 's1', playerIds: ['a', 'b'] },
        { sessionCode: 's1', playerIds: ['a', 'c'] },
      ]
    );
    expect(list).toEqual([
      {
        code: 's1',
        date: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        venue: null,
        playerCount: 3,
        matchCount: 2,
        live: false,
      },
    ]);
  });

  it('drops an ended session nobody played but keeps a live one with no matches yet', () => {
    const list = buildSessionList(
      [
        { code: 'live', ...base, createdAt: at('2026-09-03'), endedAt: null },
        { code: 'never', ...base, createdAt: at('2026-09-02'), endedAt: at('2026-09-02') },
        { code: 'played', ...base, createdAt: at('2026-09-01'), endedAt: at('2026-09-01') },
      ],
      [{ sessionCode: 'played', playerIds: ['a', 'b'] }]
    );
    expect(list.map((s) => [s.code, s.live])).toEqual([
      ['live', true],
      ['played', false],
    ]);
  });

  it('keeps the input order (newest first) and stops at the limit', () => {
    const sessions = Array.from({ length: DASHBOARD_SESSION_LIMIT + 2 }, (_, i) => ({
      code: `s${i}`,
      ...base,
      createdAt: at('2026-09-01'),
      endedAt: at('2026-09-01'),
    }));
    const matches = sessions.map((s) => ({ sessionCode: s.code, playerIds: ['a'] }));
    const list = buildSessionList(sessions, matches);
    expect(list).toHaveLength(DASHBOARD_SESSION_LIMIT);
    expect(list[0].code).toBe('s0');
  });
});
