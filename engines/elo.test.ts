import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRatings,
  ratingGap,
  teamRating,
  STARTING_RATING,
  type FinishedMatch,
} from './elo.ts';

const match = (
  teamA: [string, string],
  teamB: [string, string],
  winner: 'A' | 'B'
): FinishedMatch => ({ teamA, teamB, winner });

test('an unrated player sits at the starting rating', () => {
  const ratings = computeRatings([]);
  assert.equal(teamRating(['a', 'b'], ratings), STARTING_RATING);
});

test('winners gain and losers lose', () => {
  const ratings = computeRatings([match(['a', 'b'], ['c', 'd'], 'A')]);
  assert.ok(ratings.get('a')! > STARTING_RATING);
  assert.ok(ratings.get('c')! < STARTING_RATING);
});

test('both members of a team move by the same amount', () => {
  const ratings = computeRatings([match(['a', 'b'], ['c', 'd'], 'A')]);
  assert.equal(ratings.get('a'), ratings.get('b'));
  assert.equal(ratings.get('c'), ratings.get('d'));
});

test('rating is conserved across a match', () => {
  const ratings = computeRatings([match(['a', 'b'], ['c', 'd'], 'A')]);
  const total = ['a', 'b', 'c', 'd'].reduce((sum, id) => sum + ratings.get(id)!, 0);
  assert.ok(Math.abs(total - 4 * STARTING_RATING) < 1e-9);
});

test('beating a stronger team is worth more than beating an even one', () => {
  // Build a gap first, then compare the reward for the underdog winning.
  const history = [
    match(['c', 'd'], ['a', 'b'], 'A'),
    match(['c', 'd'], ['a', 'b'], 'A'),
    match(['c', 'd'], ['a', 'b'], 'A'),
  ];
  const before = computeRatings(history);
  const underdogGain =
    computeRatings([...history, match(['a', 'b'], ['c', 'd'], 'A')]).get('a')! -
    before.get('a')!;

  const evenGain =
    computeRatings([match(['e', 'f'], ['g', 'h'], 'A')]).get('e')! - STARTING_RATING;

  assert.ok(underdogGain > evenGain);
});

test('a repeatedly losing player ends up below a repeatedly winning one', () => {
  const ratings = computeRatings([
    match(['a', 'b'], ['c', 'd'], 'A'),
    match(['a', 'c'], ['b', 'd'], 'A'),
    match(['a', 'd'], ['b', 'c'], 'A'),
  ]);
  assert.ok(ratings.get('a')! > ratings.get('d')!);
});

test('order matters — Elo is path dependent', () => {
  // The same two teams trade wins. Whoever wins second does so as the
  // underdog, and is rewarded slightly more, so the pair does not cancel out.
  const forward = computeRatings([
    match(['a', 'b'], ['c', 'd'], 'A'),
    match(['a', 'b'], ['c', 'd'], 'B'),
  ]);
  const backward = computeRatings([
    match(['a', 'b'], ['c', 'd'], 'B'),
    match(['a', 'b'], ['c', 'd'], 'A'),
  ]);
  assert.notEqual(forward.get('a'), backward.get('a'));
});

test('ratingGap is zero for two unrated teams', () => {
  assert.equal(ratingGap(['a', 'b'], ['c', 'd'], new Map()), 0);
});

test('ratingGap measures the distance between team averages', () => {
  const ratings = new Map([
    ['a', 1300],
    ['b', 1300],
    ['c', 1100],
    ['d', 1100],
  ]);
  assert.equal(ratingGap(['a', 'b'], ['c', 'd'], ratings), 200);
});

test('ratingGap is symmetric', () => {
  const ratings = new Map([['a', 1400]]);
  assert.equal(
    ratingGap(['a', 'b'], ['c', 'd'], ratings),
    ratingGap(['c', 'd'], ['a', 'b'], ratings)
  );
});
