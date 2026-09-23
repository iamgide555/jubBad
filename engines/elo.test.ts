import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRatings,
  computeRatingTracks,
  ratingGap,
  teamRating,
  STARTING_RATING,
  type FinishedMatch,
  type RatingAnchor,
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

test('teamRating averages a singles "team" of one', () => {
  const ratings = new Map([['a', 1300]]);
  assert.equal(teamRating(['a'], ratings), 1300);
});

test('computeRatings moves a singles match exactly like a doubles one, one member per side', () => {
  const ratings = computeRatings([{ teamA: ['a'], teamB: ['b'], winner: 'A' }]);
  assert.ok(ratings.get('a')! > STARTING_RATING);
  assert.ok(ratings.get('b')! < STARTING_RATING);
});

test('computeRatingTracks: a singles result never moves the doubles track', () => {
  const tracks = computeRatingTracks([
    { teamA: ['a'], teamB: ['b'], winner: 'A' },
    { teamA: ['c', 'd'], teamB: ['e', 'f'], winner: 'A' },
  ]);
  assert.equal(tracks.doubles.get('a'), undefined);
  assert.equal(tracks.doubles.has('a'), false);
  assert.ok(tracks.singles.get('a')! > STARTING_RATING);
});

test('computeRatingTracks: a doubles result never moves the singles track', () => {
  const tracks = computeRatingTracks([
    { teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A' },
    { teamA: ['e'], teamB: ['f'], winner: 'A' },
  ]);
  assert.equal(tracks.singles.has('a'), false);
  assert.ok(tracks.doubles.get('a')! > STARTING_RATING);
});

test('computeRatingTracks: a first-time player on either track starts at STARTING_RATING', () => {
  const tracks = computeRatingTracks([]);
  assert.equal(teamRating(['a'], tracks.singles), STARTING_RATING);
  assert.equal(teamRating(['a', 'b'], tracks.doubles), STARTING_RATING);
});

test('computeRatingTracks: a player active in both formats keeps two independent ratings', () => {
  const tracks = computeRatingTracks([
    { teamA: ['a'], teamB: ['x'], winner: 'A' },
    { teamA: ['a'], teamB: ['x'], winner: 'A' },
    { teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'B' },
  ]);
  assert.ok(tracks.singles.get('a')! > STARTING_RATING);
  assert.ok(tracks.doubles.get('a')! < STARTING_RATING);
});

test('computeRatings: a seeded player with no matches yet gets no map entry — .has() still means "has played"', () => {
  const ratings = computeRatings([], new Map([['a', 1400]]));
  assert.equal(ratings.has('a'), false);
  assert.equal(teamRating(['a'], ratings), STARTING_RATING);
});

test('computeRatings: a seed is the starting point a player\'s first match moves from', () => {
  const ratings = computeRatings(
    [match(['a', 'b'], ['c', 'd'], 'A')],
    new Map([['a', 1400]])
  );
  assert.ok(ratings.get('a')! > 1400);
});

test('computeRatings: an unseeded player still falls back to STARTING_RATING', () => {
  const ratings = computeRatings([], new Map([['a', 1400]]));
  assert.equal(teamRating(['b'], ratings), STARTING_RATING);
});

// --- RatingAnchor: a level set (or edited) mid-session resets the rating to
// the level's seed at that moment, rather than adding it on top of whatever
// the player earned while unlevelled (see docs/superpowers/specs/
// 2026-09-23-c1-level-followup-design.md). `at` timestamps below are plain
// epoch ms, spaced far enough apart that comparisons are unambiguous.

const matchAt = (
  teamA: [string, string],
  teamB: [string, string],
  winner: 'A' | 'B',
  at: number
): FinishedMatch => ({ teamA, teamB, winner, at });

test('RatingAnchor: setAt null behaves exactly like the old numeric seed', () => {
  const anchor: RatingAnchor = { rating: 1400, setAt: null };
  const withAnchor = computeRatings(
    [matchAt(['a', 'b'], ['c', 'd'], 'A', 1)],
    new Map([['a', anchor]])
  );
  const withLegacySeed = computeRatings(
    [match(['a', 'b'], ['c', 'd'], 'A')],
    new Map([['a', 1400]])
  );
  assert.equal(withAnchor.get('a'), withLegacySeed.get('a'));
});

test('RatingAnchor: 3 wins while unlevelled, then a level set, resets the rating to the seed exactly', () => {
  const history = [
    matchAt(['a', 'b'], ['c', 'd'], 'A', 1),
    matchAt(['a', 'b'], ['c', 'd'], 'A', 2),
    matchAt(['a', 'b'], ['c', 'd'], 'A', 3),
  ];
  // 3 wins would otherwise push 'a' well above STARTING_RATING.
  const unlevelled = computeRatings(history);
  assert.ok(unlevelled.get('a')! > STARTING_RATING);

  // The level is set after all 3 matches (setAt after every match's `at`),
  // and no match happens on or after it — so the anchor is never "applied"
  // inside the replay loop and only the end-of-replay reset fires.
  const anchor: RatingAnchor = { rating: 1300, setAt: 10 };
  const levelled = computeRatings(history, new Map([['a', anchor]]));
  assert.equal(levelled.get('a'), 1300);
});

test('RatingAnchor: matches confirmed after the level move the rating from the seed', () => {
  const anchor: RatingAnchor = { rating: 1300, setAt: 5 };
  const ratings = computeRatings(
    [matchAt(['a', 'b'], ['c', 'd'], 'A', 10)],
    new Map([['a', anchor]])
  );
  assert.ok(ratings.get('a')! > 1300);
});

test('RatingAnchor: editing the level resets again, discarding what was earned under the old one', () => {
  const history = [
    matchAt(['a', 'b'], ['c', 'd'], 'A', 10), // played after the first level, moves it up
  ];
  const firstLevel: RatingAnchor = { rating: 1300, setAt: 5 };
  const afterFirstLevel = computeRatings(history, new Map([['a', firstLevel]]));
  assert.ok(afterFirstLevel.get('a')! > 1300);

  // Editing to a new level replaces the anchor with a later setAt. Replaying
  // the *same* history against it: the one match above now falls before the
  // new setAt, so it no longer applies, and the end-of-replay reset lands
  // 'a' on the new seed exactly — the earlier level's gain is gone.
  const editedLevel: RatingAnchor = { rating: 1600, setAt: 20 };
  const afterEdit = computeRatings(history, new Map([['a', editedLevel]]));
  assert.equal(afterEdit.get('a'), 1600);
});

test('RatingAnchor: an opponent\'s rating from a pre-level match is computed against 1200, not the eventual seed', () => {
  const history = [matchAt(['a', 'b'], ['c', 'd'], 'A', 1)];
  // 'a' is leveled well after this match plays.
  const anchor: RatingAnchor = { rating: 1600, setAt: 100 };
  const withAnchor = computeRatings(history, new Map([['a', anchor]]));
  const withoutAnchor = computeRatings(history);
  assert.equal(withAnchor.get('c'), withoutAnchor.get('c'));
  assert.equal(withAnchor.get('d'), withoutAnchor.get('d'));
});

test('RatingAnchor: a player absent from every match stays absent, even with an anchor', () => {
  const ratings = computeRatings(
    [matchAt(['x', 'y'], ['z', 'w'], 'A', 1)],
    new Map([['a', { rating: 1600, setAt: null } satisfies RatingAnchor]])
  );
  assert.equal(ratings.has('a'), false);
});

test('RatingAnchor: a match with no timestamp throws when a player on it has a timed anchor', () => {
  const anchor: RatingAnchor = { rating: 1600, setAt: 5 };
  assert.throws(
    () => computeRatings([match(['a', 'b'], ['c', 'd'], 'A')], new Map([['a', anchor]])),
    /timestamp/
  );
});

test('computeRatingTracks: the same seed applies to both tracks once a player has played', () => {
  const tracks = computeRatingTracks(
    [{ teamA: ['a'], teamB: ['x'], winner: 'A' }],
    new Map([['a', 1400]])
  );
  assert.ok(tracks.singles.get('a')! > 1400);
  // 'a' has never played doubles, so the doubles track has no entry for
  // them at all — a seed moves where a player's own history starts from,
  // it does not fabricate history that isn't there.
  assert.equal(tracks.doubles.has('a'), false);
});

