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
  pickNoBackToBackSplit,
  pickRandomSplit,
  playerIdsFor,
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
