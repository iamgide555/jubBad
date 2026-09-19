import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeCourt, InvalidRoundInputError, type MatchHistory, type SeatedCourt } from './pairing.ts';

function empty(): MatchHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
  };
}

function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test('completeCourt fills exactly the empty seats and moves no seated player (doubles)', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p2', 'p3'] };
  const result = completeCourt(seats, ['p4'], empty());
  assert.deepEqual(result, { teamA: ['p1', 'p4'], teamB: ['p2', 'p3'] });
});

test('completeCourt fills the single empty seat on a singles court', () => {
  const seats: SeatedCourt = { teamA: ['p1'], teamB: [null] };
  const result = completeCourt(seats, ['p2'], empty());
  assert.deepEqual(result, { teamA: ['p1'], teamB: ['p2'] });
});

test('completeCourt returns the court unchanged when there are no empty seats', () => {
  const seats: SeatedCourt = { teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] };
  const result = completeCourt(seats, ['p5'], empty());
  assert.deepEqual(result, { teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] });
});

test('completeCourt returns null when the pool has fewer players than empty seats', () => {
  const seats: SeatedCourt = { teamA: [null, null], teamB: ['p1', 'p2'] };
  const result = completeCourt(seats, ['p3'], empty());
  assert.equal(result, null);
});

test('completeCourt picks the fewest-games player for the empty seat', () => {
  const seats: SeatedCourt = { teamA: ['p1'], teamB: [null] };
  const history = empty();
  history.gamesPlayedThisSession.set('p2', 3);
  history.gamesPlayedThisSession.set('p3', 0);
  const result = completeCourt(seats, ['p2', 'p3'], history);
  assert.deepEqual(result, { teamA: ['p1'], teamB: ['p3'] });
});

test('completeCourt breaks a games tie by longest wait', () => {
  const seats: SeatedCourt = { teamA: ['p1'], teamB: [null] };
  const history = empty();
  history.gamesPlayedThisSession.set('p2', 0);
  history.gamesPlayedThisSession.set('p3', 0);
  // Smaller waitingSince = wait started earlier = waited longer.
  history.waitingSince = new Map([
    ['p2', 5000],
    ['p3', 1000],
  ]);
  const result = completeCourt(seats, ['p2', 'p3'], history);
  assert.deepEqual(result, { teamA: ['p1'], teamB: ['p3'] });
});

test('completeCourt uses partner history to break a full games-and-wait tie, favoring the fresher pairing', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p3', 'p4'] };
  const history = empty();
  // p2 and p5 tied on games and wait, both zero.
  history.gamesPlayedThisSession.set('p2', 0);
  history.gamesPlayedThisSession.set('p5', 0);
  history.partnerCounts.set([...(['p1', 'p2'] as const)].sort().join('|'), 3);
  history.partnerCounts.set([...(['p1', 'p5'] as const)].sort().join('|'), 0);
  const result = completeCourt(seats, ['p2', 'p5'], history);
  assert.deepEqual(result, { teamA: ['p1', 'p5'], teamB: ['p3', 'p4'] });
});

test('completeCourt is deterministic under a seeded random', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p3', 'p4'] };
  const history = empty();
  history.gamesPlayedThisSession.set('p2', 0);
  history.gamesPlayedThisSession.set('p5', 0);
  const a = completeCourt(seats, ['p2', 'p5'], history, makeSeededRandom(7));
  const b = completeCourt(seats, ['p2', 'p5'], history, makeSeededRandom(7));
  assert.deepEqual(a, b);
});

test('completeCourt throws when a pool member is already seated', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p2', 'p3'] };
  assert.throws(() => completeCourt(seats, ['p1'], empty()), InvalidRoundInputError);
});

test('completeCourt throws on a duplicate pool id', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p2', 'p3'] };
  assert.throws(() => completeCourt(seats, ['p4', 'p4'], empty()), InvalidRoundInputError);
});

test('completeCourt throws when the two teams differ in length', () => {
  const seats: SeatedCourt = { teamA: ['p1'], teamB: ['p2', null] };
  assert.throws(() => completeCourt(seats, ['p3'], empty()), InvalidRoundInputError);
});

test('completeCourt throws on a negative history count', () => {
  const seats: SeatedCourt = { teamA: ['p1', null], teamB: ['p2', 'p3'] };
  const history = empty();
  history.gamesPlayedThisSession.set('p4', -1);
  assert.throws(() => completeCourt(seats, ['p4'], history), InvalidRoundInputError);
});
