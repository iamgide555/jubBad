/**
 * Season-length simulation measuring whether the real pairing engine
 * delivers more partner variety than two naive baselines. See
 * docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md, section C14.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatchHistory } from './pairing.ts';
import {
  DEFAULT_SCENARIO,
  coAttendanceCounts,
  fillAllIdleCourts,
  generateAttendance,
  makeSeededRandom,
  metricsAtNight,
  pickNoBackToBackSplit,
  pickRandomSplit,
  playerIdsFor,
  simulateNights,
} from './variety-sim.ts';

function emptyHistory(ids: string[]): MatchHistory {
  const gamesPlayedThisSession = new Map<string, number>();
  const waitingSince = new Map<string, number>();
  for (const id of ids) waitingSince.set(id, 0);
  return { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession, waitingSince };
}

test('generateAttendance draws between minAttend and maxAttend distinct players, for every night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  assert.equal(attendance.length, DEFAULT_SCENARIO.nights);
  const players = new Set(playerIdsFor(DEFAULT_SCENARIO));
  for (const night of attendance) {
    assert.ok(night.length >= DEFAULT_SCENARIO.minAttend, `night has ${night.length} attendees`);
    assert.ok(night.length <= DEFAULT_SCENARIO.maxAttend, `night has ${night.length} attendees`);
    assert.equal(new Set(night).size, night.length, 'no duplicate attendee in one night');
    for (const id of night) assert.ok(players.has(id), `${id} must be one of the 16 players`);
  }
});

test('generateAttendance is deterministic for a given seed', () => {
  const a = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const b = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  assert.deepEqual(a, b);
});

test('coAttendanceCounts counts exactly the nights both players attended', () => {
  const attendance = [
    ['p0', 'p1', 'p2'],
    ['p0', 'p2'],
    ['p1', 'p2'],
  ];
  const co = coAttendanceCounts(attendance);
  assert.equal(co.get('p0|p1'), 1);
  assert.equal(co.get('p0|p2'), 2);
  assert.equal(co.get('p1|p2'), 2);
});

test('pickRandomSplit always returns one of the three splits of four', () => {
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  for (let seed = 0; seed < 20; seed++) {
    const { teamA, teamB } = pickRandomSplit(four, makeSeededRandom(seed));
    const label = [teamA, teamB].map((t) => [...t].sort().join('')).sort().join('|');
    assert.ok(['ab|cd', 'ac|bd', 'ad|bc'].includes(label), `unexpected split ${label}`);
  }
});

test('pickNoBackToBackSplit avoids reuniting a player with their last partner when an alternative exists', () => {
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  const lastPartner = new Map([
    ['a', 'b'],
    ['b', 'a'],
  ]);
  for (let seed = 0; seed < 20; seed++) {
    const { teamA, teamB } = pickNoBackToBackSplit(four, lastPartner, makeSeededRandom(seed));
    const reunited =
      (teamA.includes('a') && teamA.includes('b')) || (teamB.includes('a') && teamB.includes('b'));
    assert.equal(reunited, false, 'a and b must not be reunited as partners');
  }
});

test('pickNoBackToBackSplit falls back to a random split when every split reunites someone', () => {
  // With two simultaneous "just played together" pairs among four players,
  // every one of the three splits reunites at least one of them — there is no
  // clean split left, so the function must still return a legal split rather
  // than throwing or returning nothing.
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  const lastPartner = new Map([
    ['a', 'b'],
    ['b', 'a'],
    ['c', 'd'],
    ['d', 'c'],
  ]);
  const { teamA, teamB } = pickNoBackToBackSplit(four, lastPartner, makeSeededRandom(1));
  assert.equal(teamA.length, 2);
  assert.equal(teamB.length, 2);
  assert.equal(new Set([...teamA, ...teamB]).size, 4);
});

for (const picker of ['engine', 'random', 'no-back-to-back'] as const) {
  test(`fillAllIdleCourts (${picker}) fills every requested court with 4 distinct players each, no overlap`, () => {
    const available = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const history = emptyHistory(available);
    const { courts } = fillAllIdleCourts(available, 3, picker, history, new Map(), makeSeededRandom(7));

    assert.equal(courts.length, 3);
    const seen = new Set<string>();
    for (const { teamA, teamB } of courts) {
      for (const id of [...teamA, ...teamB]) {
        assert.equal(seen.has(id), false, `${id} appears on more than one court`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, 12);
  });

  test(`fillAllIdleCourts (${picker}) fills one court from a wider available pool`, () => {
    const available = Array.from({ length: 6 }, (_, i) => `p${i}`);
    const history = emptyHistory(available);
    const { courts } = fillAllIdleCourts(available, 1, picker, history, new Map(), makeSeededRandom(7));

    assert.equal(courts.length, 1);
    const [{ teamA, teamB }] = courts;
    assert.equal(new Set([...teamA, ...teamB]).size, 4);
  });
}

test('simulateNights plays exactly courts * matchesPerCourt matches per night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const snapshots = simulateNights(DEFAULT_SCENARIO, attendance, 'engine', makeSeededRandom(11));

  assert.equal(snapshots.length, DEFAULT_SCENARIO.nights);

  const totalPairCount = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const matchesPerNight = DEFAULT_SCENARIO.courts * DEFAULT_SCENARIO.matchesPerCourt;
  assert.equal(totalPairCount(snapshots[0]), matchesPerNight * 2);
  assert.equal(totalPairCount(snapshots[1]) - totalPairCount(snapshots[0]), matchesPerNight * 2);
});

test('simulateNights never lets a cumulative partner count go down night over night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const snapshots = simulateNights(DEFAULT_SCENARIO, attendance, 'random', makeSeededRandom(12));
  for (let n = 1; n < snapshots.length; n++) {
    for (const [key, count] of snapshots[n - 1]) {
      assert.ok((snapshots[n].get(key) ?? 0) >= count, `${key} count must not decrease`);
    }
  }
});

test('simulateNights is deterministic for a given attendance and seed', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const a = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));
  const b = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));
  assert.deepEqual(a.map((m) => [...m.entries()].sort()), b.map((m) => [...m.entries()].sort()));
});

test('metricsAtNight computes distinct partners, spread and never-met share by hand', () => {
  // Four players, p0..p3. Partner counts: p0-p1 met 3 times, p0-p2 met once,
  // p2-p3 met once. p0-p3 and p1-p2 and p1-p3 never met.
  const partnerCounts = new Map([
    ['p0|p1', 3],
    ['p0|p2', 1],
    ['p2|p3', 1],
  ]);
  // All 3 pairs among p0..p2 co-attended >= half of 4 nights; p3 only ever
  // co-attended with p2, twice.
  const coAttendance = new Map([
    ['p0|p1', 4],
    ['p0|p2', 4],
    ['p0|p3', 0],
    ['p1|p2', 4],
    ['p1|p3', 0],
    ['p2|p3', 2],
  ]);
  const players = ['p0', 'p1', 'p2', 'p3'];

  const m = metricsAtNight(partnerCounts, coAttendance, players, 4);

  // distinct partners: p0 has 2 (p1, p2), p1 has 1 (p0), p2 has 2 (p0, p3),
  // p3 has 1 (p2) -> mean = (2 + 1 + 2 + 1) / 4 = 1.5
  assert.equal(m.meanDistinctPartners, 1.5);

  // threshold = ceil(4/2) = 2. Qualifying pairs: p0|p1 (4), p0|p2 (4),
  // p1|p2 (4), p2|p3 (2). Counts among those: 3, 1, 0, 1 -> spread = 3 - 0 = 3.
  assert.equal(m.pairSpread, 3);

  // 6 total pairs, 3 never met (p0|p3, p1|p2, p1|p3) -> 3/6 = 0.5
  assert.equal(m.neverMetShare, 0.5);
});
