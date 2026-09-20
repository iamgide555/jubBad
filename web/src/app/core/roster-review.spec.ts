import {
  attachDecisions,
  claimedPlayerIds,
  exactPlayerMatch,
  literalNewNameDrafts,
  searchCandidates,
  type NameReview,
} from './roster-review';
import type { Player, RosterNameMatch } from '../../../../engines/fuzzy-match.ts';

describe('attachDecisions', () => {
  it('defaults exact and new matches to accept', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
      { inputName: 'เกียร์', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches)).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' },
    ]);
  });

  it('defaults a duplicate to being a different person', () => {
    // "ตั้ม (1)" / "ตั้ม (2)" is two people far more often than it is one name
    // pasted twice, and a merge that should have been two people is the one
    // the host cannot undo afterwards. So the default is a new player, and
    // "same person" is the deliberate tap.
    const matches: RosterNameMatch[] = [
      { inputName: 'ตั้ม (1)', match: { type: 'exact', playerId: 'p1' } },
      { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' } },
    ];
    expect(attachDecisions(matches).map((r) => r.decision)).toEqual(['accept', 'reject-new']);
  });

  it('defaults a fuzzy suggestion to being a different person', () => {
    // A fuzzy hit is a guess, not evidence — "same person" must be a
    // deliberate tap, the same as a duplicate, or a host who confirms the
    // list without reading every row could silently merge two players.
    const matches: RosterNameMatch[] = [
      { inputName: 'เกีย', match: { type: 'fuzzy', playerId: 'p1', score: 0.667 } },
    ];
    expect(attachDecisions(matches).map((r) => r.decision)).toEqual(['reject-new']);
  });

  it('preserves input order', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'a', match: { type: 'new' } },
      { inputName: 'b', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches).map((r) => r.inputName)).toEqual(['a', 'b']);
  });
});

// Focused coverage for the manual-add helpers (Task 1). Task 3 owns the
// exhaustive behavioral suite for the group-entry integration.
describe('claimedPlayerIds', () => {
  it('claims accepted exact and fuzzy matches, not rejected ones', () => {
    const roster: NameReview[] = [
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกีย', match: { type: 'fuzzy', playerId: 'p2', score: 0.7 }, decision: 'reject-new' },
    ];
    expect(claimedPlayerIds(roster, [])).toEqual(new Set(['p1']));
  });

  it('does not claim a rejected duplicate, but does claim an accepted one', () => {
    const rejected: NameReview[] = [
      { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' }, decision: 'reject-new' },
    ];
    expect(claimedPlayerIds(rejected, [])).toEqual(new Set());

    const accepted: NameReview[] = [
      { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' }, decision: 'accept' },
    ];
    expect(claimedPlayerIds(accepted, [])).toEqual(new Set(['p1']));
  });

  it('unions across roster and waitlist', () => {
    const roster: NameReview[] = [
      { inputName: 'a', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
    ];
    const waitlist: NameReview[] = [
      { inputName: 'b', match: { type: 'exact', playerId: 'p2' }, decision: 'accept' },
    ];
    expect(claimedPlayerIds(roster, waitlist)).toEqual(new Set(['p1', 'p2']));
  });
});

describe('literalNewNameDrafts', () => {
  it('includes an accepted new-type row', () => {
    const roster: NameReview[] = [{ inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' }];
    expect(literalNewNameDrafts(roster, [])).toEqual(new Set(['เกียร์']));
  });

  it('includes a rejected exact/fuzzy/duplicate row — the review screen displays it as new too', () => {
    const roster: NameReview[] = [
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'reject-new' },
    ];
    expect(literalNewNameDrafts(roster, [])).toEqual(new Set(['ตั้ม']));
  });

  it('folds case and whitespace but preserves a parenthetical label', () => {
    const roster: NameReview[] = [
      { inputName: '  ตั้ม (2)  ', match: { type: 'new' }, decision: 'accept' },
    ];
    const drafts = literalNewNameDrafts(roster, []);
    expect(drafts.has('ตั้ม (2)')).toBe(true);
    expect(drafts.has('ตั้ม')).toBe(false);
  });
});

describe('exactPlayerMatch', () => {
  const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: ['Tum'] }];

  it('matches case-insensitively on the canonical name or an alias', () => {
    expect(exactPlayerMatch('ตั้ม', players)?.id).toBe('p1');
    expect(exactPlayerMatch('tum', players)?.id).toBe('p1');
  });

  it('returns null for a blank query or no match', () => {
    expect(exactPlayerMatch('   ', players)).toBeNull();
    expect(exactPlayerMatch('เกียร์', players)).toBeNull();
  });
});

describe('searchCandidates', () => {
  const players: Player[] = [
    { id: 'p1', name: 'ตั้ม', aliases: [] },
    { id: 'p2', name: 'ตั้มมี่', aliases: [] },
    { id: 'p3', name: 'เกียร์', aliases: [] },
  ];

  it('returns nothing for a blank query', () => {
    expect(searchCandidates('  ', players, new Set())).toEqual([]);
  });

  it('excludes already-claimed players', () => {
    const results = searchCandidates('ตั้ม', players, new Set(['p1']));
    expect(results.map((c) => c.player.id)).not.toContain('p1');
  });

  it('ranks an exact match before a prefix match', () => {
    const results = searchCandidates('ตั้ม', players, new Set());
    expect(results.map((c) => c.player.id)).toEqual(['p1', 'p2']);
    expect(results[0].rank).toBe('exact');
    expect(results[1].rank).toBe('prefix');
  });
});
