import { buildReviews, resolveReviews } from './roster-review';
import type { Player } from '../../../../fuzzy-match.ts';

const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];

describe('buildReviews', () => {
  it('marks an exact match, defaulting decision to accept', () => {
    const result = buildReviews(['ตั้ม'], players);
    expect(result).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
    ]);
  });

  it('marks a new name as new', () => {
    const result = buildReviews(['เกียร์'], players);
    expect(result[0].match).toEqual({ type: 'new' });
  });

  it('preserves input order for multiple names', () => {
    const result = buildReviews(['ตั้ม', 'เกียร์'], players);
    expect(result.map((r) => r.inputName)).toEqual(['ตั้ม', 'เกียร์']);
  });
});

describe('resolveReviews', () => {
  it('resolves an exact match to its existing playerId, unchanged players', () => {
    const reviews = buildReviews(['ตั้ม'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1']);
    expect(result.players).toEqual(players);
  });

  it('resolves an accepted fuzzy match by adding the raw text as an alias', () => {
    const reviews = [
      {
        inputName: 'ตัม',
        match: { type: 'fuzzy' as const, playerId: 'p1', score: 0.75 },
        decision: 'accept' as const,
      },
    ];
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1']);
    expect(result.players).toEqual([{ id: 'p1', name: 'ตั้ม', aliases: ['ตัม'] }]);
  });

  it('resolves a rejected fuzzy match by creating a new player instead', () => {
    const reviews = [
      {
        inputName: 'ตัม',
        match: { type: 'fuzzy' as const, playerId: 'p1', score: 0.75 },
        decision: 'reject-new' as const,
      },
    ];
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toHaveLength(1);
    expect(result.players).toHaveLength(2);
    expect(result.players[1]).toEqual({ id: result.playerIds[0], name: 'ตัม', aliases: [] });
  });

  it('resolves a new-player match by creating a new player', () => {
    const reviews = buildReviews(['เกียร์'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toHaveLength(1);
    expect(result.players).toHaveLength(2);
    expect(result.players[1]).toEqual({ id: result.playerIds[0], name: 'เกียร์', aliases: [] });
  });

  it('accumulates player updates across multiple reviews in one call', () => {
    const reviews = buildReviews(['ตั้ม', 'เกียร์'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1', result.playerIds[1]]);
    expect(result.players).toHaveLength(2);
  });
});
