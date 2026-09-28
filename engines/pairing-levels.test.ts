import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectSittingOut,
  generateRound,
  groupKey,
  type MatchHistory,
} from './pairing.ts';
import type { Level } from './levels.ts';

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

function levelsOf(record: Record<string, Level>): Map<string, Level> {
  return new Map(Object.entries(record));
}

/** Max pairwise level-index gap on a court, ignoring unknown (null) levels. -1 if nobody has a known level. */
function courtLevelSpread(players: string[], levels: Map<string, Level>): number {
  const LEVELS = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
  const indices = players
    .map((p) => levels.get(p))
    .filter((l): l is Level => l !== undefined)
    .map((l) => LEVELS.indexOf(l));
  if (indices.length === 0) return -1;
  return Math.max(...indices) - Math.min(...indices);
}

test('band off: a levels map has no effect on the round', () => {
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2', 'p3', 'p4'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+',
  });
  const withLevels = generateRound(roster, 2, empty(), makeSeededRandom(7), undefined, undefined, levels, false);
  const withoutLevels = generateRound(roster, 2, empty(), makeSeededRandom(7), undefined, undefined, undefined, false);
  assert.deepEqual(withLevels, withoutLevels);
});

test('band on, 4N + 4P+ on 2 courts: the exhaustive search never mixes them', () => {
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2', 'p3', 'p4'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+',
  });
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(roster, 2, empty(), makeSeededRandom(seed), undefined, undefined, levels, true);
    for (const court of courts) {
      const players = [...court.teamA, ...court.teamB];
      assert.equal(courtLevelSpread(players, levels), 0, `seed ${seed}: court mixed N and P+`);
    }
  }
});

test('band on, 3 P+ + 5 N on 2 courts: exactly one court breaks the band', () => {
  const roster = ['p1', 'p2', 'p3', 'n1', 'n2', 'n3', 'n4', 'n5'];
  const levels = levelsOf({
    p1: 'P+', p2: 'P+', p3: 'P+', n1: 'N', n2: 'N', n3: 'N', n4: 'N', n5: 'N',
  });
  const { courts } = generateRound(roster, 2, empty(), makeSeededRandom(3), undefined, undefined, levels, true);
  const breaking = courts.filter(
    (c) => courtLevelSpread([...c.teamA, ...c.teamB], levels) > 1
  );
  assert.equal(breaking.length, 1);
});

test('band on: selection prefers an all-in-band court over rotation order alone', () => {
  // 4 N players and 2 P+ players, one court of 4. The most-deserving player
  // (fewest games) is an N, so with the band on, the court fills entirely
  // from the other N's rather than pulling in a more-deserving P+.
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2'];
  const levels = levelsOf({ n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+' });
  const gamesPlayedThisSession = new Map([
    ['n1', 0], ['n2', 2], ['n3', 2], ['n4', 3], ['p1', 1], ['p2', 1],
  ]);

  const withoutBand = selectSittingOut(roster, 1, gamesPlayedThisSession, makeSeededRandom(1));
  // Fewest games first: n1(0), p1(1), p2(1), then one of n2/n3 (tied at 2) —
  // either way, both P+ players make the cut ahead of n4, so it's mixed.
  assert.ok(withoutBand.playing.includes('p1') && withoutBand.playing.includes('p2'));

  const withBand = selectSittingOut(
    roster, 1, gamesPlayedThisSession, makeSeededRandom(1), undefined, null, levels, true
  );
  assert.deepEqual([...withBand.playing].sort(), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual([...withBand.sittingOut].sort(), ['p1', 'p2']);
});

test('band on: a lone rare-level player still plays when most deserving, despite an unavoidable mismatch', () => {
  const roster = [
    'b1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11',
  ];
  const levels = new Map<string, Level>([['b1', 'B']]);
  for (let i = 1; i <= 11; i++) levels.set(`n${i}`, 'N');
  const gamesPlayedThisSession = new Map(roster.map((p) => [p, p === 'b1' ? 0 : 1]));

  const { playing, sittingOut } = selectSittingOut(
    roster, 2, gamesPlayedThisSession, makeSeededRandom(5), undefined, null, levels, true
  );
  assert.ok(playing.includes('b1'), 'the most-deserving player must never be excluded by the band');
  assert.equal(playing.length, 8);
  assert.equal(sittingOut.length, 4);
});

test('band on: never leaves a court empty when a full court of players is offered', () => {
  const roster = ['b1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
  const levels = new Map<string, Level>([['b1', 'B']]);
  for (let i = 1; i <= 7; i++) levels.set(`n${i}`, 'N');
  const { courts, sittingOut } = generateRound(
    roster, 2, empty(), makeSeededRandom(2), undefined, undefined, levels, true
  );
  assert.equal(courts.length, 2);
  assert.equal(sittingOut.length, 0);
  const seated = courts.flatMap((c) => [...c.teamA, ...c.teamB]);
  assert.deepEqual([...seated].sort(), [...roster].sort());
});

test('band on: groupRepeat still dominates the band key', () => {
  // A single idle court, one recent group would recreate. With enough
  // in-band alternatives, the band selection must not force the repeat.
  const roster = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const levels = levelsOf({ n1: 'N', n2: 'N', n3: 'N', n4: 'N', n5: 'N' });
  const history: MatchHistory = {
    ...empty(),
    recentGroupKeys: new Set([groupKey(['n1', 'n2', 'n3', 'n4'])]),
  };
  const { courts } = generateRound(roster, 1, history, makeSeededRandom(4), undefined, undefined, levels, true);
  const seated = groupKey([...courts[0].teamA, ...courts[0].teamB]);
  assert.notEqual(seated, groupKey(['n1', 'n2', 'n3', 'n4']));
});

test('band on: a court never spans more than one level, even when both neighbours of the anchor are queued ahead', () => {
  // The anchor (P) is within one level of both P- and P+, but P- and P+ are
  // two apart from each other. Admitting both breaks the band on a court the
  // search cannot repair, since one idle court has nothing to swap with.
  const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const levels = levelsOf({ a: 'P', b: 'P-', c: 'P+', d: 'P-', e: 'P+', f: 'P', g: 'BG' });
  const gamesPlayedThisSession = new Map([
    ['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4], ['f', 5], ['g', 6],
  ]);
  const { playing } = selectSittingOut(
    roster, 1, gamesPlayedThisSession, makeSeededRandom(1), undefined, null, levels, true
  );
  assert.equal(playing.length, 4);
  assert.ok(playing.includes('a'), 'the most-deserving player still anchors the court');
  assert.ok(courtLevelSpread(playing, levels) <= 1, `court spans ${courtLevelSpread(playing, levels)} levels`);
});

test('selectSittingOut with queueBy "wait" ignores games played, orders by wait alone', () => {
  const random = makeSeededRandom(1);
  const gamesPlayedThisSession = new Map([
    ['a', 5], // most games, but longest wait
    ['b', 0],
    ['c', 0],
  ]);
  const waitingSince = new Map([
    ['a', 1000], // earliest = longest wait
    ['b', 3000],
    ['c', 2000],
  ]);
  // 1 doubles court (size 4) for 3 players sits everyone... use 2 for a size-2
  // (singles) cut instead, so exactly one player sits out.
  const result = selectSittingOut(
    ['a', 'b', 'c'],
    [2],
    gamesPlayedThisSession,
    random,
    waitingSince,
    null,
    undefined,
    false,
    'wait'
  );
  // Under 'games' ordering, 'a' (5 games) would sit out first. Under 'wait',
  // 'a' has the longest wait and must play; 'b' (shortest wait) sits.
  assert.deepEqual(result.sittingOut, ['b']);
  assert.deepEqual(new Set(result.playing), new Set(['a', 'c']));
});

function levelMap(entries: Record<string, Level | null>): Map<string, Level | null> {
  return new Map(Object.entries(entries));
}

function historyWithWait(waitingSince: Record<string, number>): MatchHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
    waitingSince: new Map(Object.entries(waitingSince)),
  };
}

test('generateRound locks a carry court: far-below anchor partners the highest-level pro', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000, p5: 5000 });
  const levels = levelMap({ p1: 'BG', p2: 'P-', p3: 'S', p4: 'P+', p5: 'P' });
  const result = generateRound(
    ['p1', 'p2', 'p3', 'p4', 'p5'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true, // band (level mode)
    'wait',
    new Set(['p1']), // carryEligible
    new Set() // carriedTonight
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  // p1 (anchor) partners p4 (P+, the highest tagged level available).
  assert.deepEqual(new Set(court.teamA), new Set(['p1', 'p4']));
  // Opponents: p5 (P, within ±1 of P+) plus a top-up (no second in-band
  // candidate exists), by longest wait: p2.
  assert.deepEqual(new Set(court.teamB), new Set(['p5', 'p2']));
  // p3 is the only player left over, with no second court offered.
  assert.deepEqual(result.sittingOut, ['p3']);
});

test('generateRound: no tagged player available leaves the round to normal band pairing', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000 });
  const levels = levelMap({ p1: 'BG', p2: null, p3: null, p4: null });
  const result = generateRound(
    ['p1', 'p2', 'p3', 'p4'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  // Every player is seated (no untouched carry pool member left dangling),
  // and nobody sits out — the normal path, not a locked carry split.
  assert.deepEqual(new Set([...court.teamA, ...court.teamB]), new Set(['p1', 'p2', 'p3', 'p4']));
  assert.deepEqual(result.sittingOut, []);
});

test('generateRound: reshuffling a carry court with alternates picks new opponents, same pro', () => {
  // p6 is P-, index 3 — two away from the pro's P+ (index 5), so it is
  // *outside* the ±1 band, not in it. p5/p7/p8 are P (index 4, one away —
  // in band). This makes the in-band pool {p5, p7, p8}: two candidates
  // (p5, p7, longest wait first) chosen initially, leaving p8 (still in
  // band) as the reshuffle's first pick, topped up with the only player
  // left, out-of-band p6.
  const history = historyWithWait({
    p1: 1000, // anchor
    p4: 4000, // pro (P+)
    p5: 5000, // first-choice opponent (P, in band)
    p6: 5500, // out of band (P-), only reachable via top-up
    p7: 6000, // first-choice opponent (P, in band)
    p8: 6500, // reshuffle's opponent (P, in band)
  });
  const levels = levelMap({ p1: 'BG', p4: 'P+', p5: 'P', p6: 'P-', p7: 'P', p8: 'P' });
  const roster = ['p1', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const first = generateRound(
    roster,
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  const [firstCourt] = first.courts;
  assert.deepEqual(new Set(firstCourt.teamA), new Set(['p1', 'p4']));
  assert.deepEqual(new Set(firstCourt.teamB), new Set(['p5', 'p7']));

  const reshuffled = generateRound(
    roster,
    1,
    history,
    makeSeededRandom(2),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  const [again] = reshuffled.courts;
  assert.deepEqual(new Set(again.teamA), new Set(['p1', 'p4'])); // same anchor + pro
  assert.deepEqual(new Set(again.teamB), new Set(['p8', 'p6'])); // different opponents
});

test('generateRound: reshuffling falls back to a new pro when opponents cannot change', () => {
  // Same 5-player setup as the first test: only one true in-band opponent
  // (p5) exists for pro p4, so a reshuffle cannot vary the opponents and
  // must try a different pro instead (p5 itself, next-highest tagged).
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000, p5: 5000 });
  const levels = levelMap({ p1: 'BG', p2: 'P-', p3: 'S', p4: 'P+', p5: 'P' });
  const roster = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const first = generateRound(
    roster, 1, history, makeSeededRandom(1), undefined, undefined, levels, true, 'wait',
    new Set(['p1']), new Set()
  );
  const [firstCourt] = first.courts;
  assert.deepEqual(new Set(firstCourt.teamA), new Set(['p1', 'p4']));

  const reshuffled = generateRound(
    roster, 1, history, makeSeededRandom(3),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined, levels, true, 'wait', new Set(['p1']), new Set()
  );
  const [again] = reshuffled.courts;
  assert.deepEqual(new Set(again.teamA), new Set(['p1', 'p5'])); // pro changed
  assert.deepEqual(new Set(again.teamB), new Set(['p2', 'p4'])); // opponents changed too, as a side effect
});

test('generateRound: a singles-only offer never triggers a carry court', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000 });
  const levels = levelMap({ p1: 'BG', p2: 'P' });
  const result = generateRound(
    ['p1', 'p2'],
    [2], // singles court
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  assert.equal(result.courts[0].teamA.length, 1);
});

test('generateRound: a carry court never pairs the far-below anchor with a same-or-lower-level "pro"', () => {
  // Only bg1 is carry-eligible tonight (bg2 is tagged the same level but not
  // itself eligible — e.g. already carried once — so this exercises the
  // *solo* pro-carry path, not the group-carry rule two eligible newcomers
  // would trigger). With no one tagged above bg1, there is no real pro, so
  // this must fall back to normal band pairing, never partner bg1 with bg2.
  const history = historyWithWait({
    bg1: 1000,
    bg2: 2000,
    u1: 3000,
    u2: 4000,
    u3: 5000,
    u4: 6000,
  });
  const levels = levelMap({ bg1: 'BG', bg2: 'BG', u1: null, u2: null, u3: null, u4: null });
  const result = generateRound(
    ['bg1', 'bg2', 'u1', 'u2', 'u3', 'u4'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['bg1']),
    new Set()
  );
  const [court] = result.courts;
  const seated = [...court.teamA, ...court.teamB];
  assert.equal(seated.includes('bg1'), true);
  // bg1 (the anchor) must never be forced to partner bg2: with no one
  // tagged above bg1, this must not become a locked carry split at all.
  const bg1Team = court.teamA.includes('bg1') ? court.teamA : court.teamB;
  assert.equal(bg1Team.includes('bg2'), false);
});

test('generateRound: a carry court never picks another far-below player as the pro when the real pro is busy', () => {
  // Only p1 is carry-eligible tonight (p2 is tagged the same level but not
  // eligible, so this exercises the solo pro-carry path, not group-carry).
  // p4 (P+, the only real pro) is reserved elsewhere (not in the roster
  // passed to generateRound), leaving p1 (BG anchor), p2 (also BG), and two
  // untagged players. p2 must never be chosen as the "pro".
  const history = historyWithWait({ p1: 1000, p2: 2000, u1: 3000, u2: 4000 });
  const levels = levelMap({ p1: 'BG', p2: 'BG', u1: null, u2: null });
  const result = generateRound(
    ['p1', 'p2', 'u1', 'u2'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  const [court] = result.courts;
  const p1Team = court.teamA.includes('p1') ? court.teamA : court.teamB;
  assert.equal(p1Team.includes('p2'), false);
});

test('generateRound: an empty waitingSince map (first-ever propose) does not crash and still forms a carry court', () => {
  // Review Focus #1: no player has a real wait record yet. Every waitingSince
  // lookup falls back to 0 (a tie), so the anchor is simply the first player
  // in roster order — this must not throw.
  const history: MatchHistory = {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
    waitingSince: new Map(), // present but empty
  };
  const levels = levelMap({ p1: 'BG', p2: 'P+', p3: 'P', p4: 'P' });
  assert.doesNotThrow(() => {
    const result = generateRound(
      ['p1', 'p2', 'p3', 'p4'],
      1,
      history,
      makeSeededRandom(1),
      undefined,
      undefined,
      levels,
      true,
      'wait',
      new Set(['p1']),
      new Set()
    );
    assert.equal(result.courts.length, 1);
  });
});

test('generateRound: reshuffling a carry court with no alternate pro or opponents returns the same court, not null', () => {
  // Review Focus #3: p2 (P+) is the only tagged player besides the anchor —
  // no fallback pro, and no fallback opponents once p2 is fixed as the pro.
  const history = historyWithWait({ p1: 1000, p2: 2000, u1: 3000, u2: 4000 });
  const levels = levelMap({ p1: 'BG', p2: 'P+', u1: null, u2: null });
  const roster = ['p1', 'p2', 'u1', 'u2'];
  const first = generateRound(
    roster, 1, history, makeSeededRandom(1), undefined, undefined, levels, true, 'wait',
    new Set(['p1']), new Set()
  );
  const [firstCourt] = first.courts;
  assert.deepEqual(new Set(firstCourt.teamA), new Set(['p1', 'p2']));

  const reshuffled = generateRound(
    roster, 1, history, makeSeededRandom(2),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined, levels, true, 'wait', new Set(['p1']), new Set()
  );
  const [again] = reshuffled.courts;
  // Nothing else exists to vary — the same court comes back, not "not enough players".
  assert.deepEqual(new Set(again.teamA), new Set(['p1', 'p2']));
  assert.deepEqual(new Set(again.teamB), new Set(['u1', 'u2']));
});

test('generateRound: a second far-below player can still be carried by the only pro, deprioritised but not excluded', () => {
  // Review Focus #5: p1 already carried tonight (carriedTonight has the pro),
  // p2 is a second far-below player now at the front of the queue. With no
  // other tagged player available, the same pro must still carry them —
  // deprioritised-but-not-excluded, per the spec.
  const history = historyWithWait({ p2: 1000, u1: 2000, u2: 3000, pro: 4000 });
  const levels = levelMap({ p2: 'BG', pro: 'P+', u1: null, u2: null });
  const result = generateRound(
    ['p2', 'u1', 'u2', 'pro'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p2']),
    new Set(['pro']) // carried tonight already, but still the only option
  );
  const [court] = result.courts;
  const p2Team = court.teamA.includes('p2') ? court.teamA : court.teamB;
  assert.equal(p2Team.includes('pro'), true);
});

test('generateRound: fewer than 4 players never attempts a carry court', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000 });
  const levels = levelMap({ p1: 'BG', p2: 'P', p3: 'P' });
  assert.doesNotThrow(() => {
    generateRound(
      ['p1', 'p2', 'p3'],
      [2], // singles court anyway, but also below the 4-player floor
      history,
      makeSeededRandom(1),
      undefined,
      undefined,
      levels,
      true,
      'wait',
      new Set(['p1']),
      new Set()
    );
  });
});

test('generateRound: a second far-below newcomer jumps the queue to join the first one\'s court', () => {
  // n2 has by far the shortest wait of anyone (would ordinarily sit out
  // entirely under plain band ordering) but is still carry-eligible — the
  // group-carry rule must pull them onto the anchor's court regardless.
  const history = historyWithWait({ n1: 1000, u1: 2000, u2: 3000, u3: 4000, n2: 9000 });
  const levels = levelMap({ n1: 'BG', u1: null, u2: null, u3: null, n2: 'BG' });
  const result = generateRound(
    ['n1', 'u1', 'u2', 'u3', 'n2'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['n1', 'n2']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  const seated = [...court.teamA, ...court.teamB];
  assert.equal(seated.includes('n1'), true);
  assert.equal(seated.includes('n2'), true);
  assert.equal(seated.length, 4);
});

test('generateRound: two grouped newcomers are partnered together, not split across teams', () => {
  // With no partner/opponent history, an unconstrained search has no reason
  // to keep n1 and n2 together — this only holds because the group-carry
  // rule locks them onto the same team, no pro involved.
  const history = historyWithWait({ n1: 1000, n2: 2000, u1: 3000, u2: 4000, u3: 5000, u4: 6000 });
  const levels = levelMap({ n1: 'BG', n2: 'BG', u1: null, u2: null, u3: null, u4: null });
  const result = generateRound(
    ['n1', 'n2', 'u1', 'u2', 'u3', 'u4'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['n1', 'n2']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  const teamWithN1 = court.teamA.includes('n1') ? court.teamA : court.teamB;
  assert.equal(teamWithN1.includes('n2'), true);
});

test('generateRound: four or more eligible newcomers still fill only one court, the rest wait', () => {
  const history = historyWithWait({ n1: 1000, n2: 2000, n3: 3000, n4: 4000, n5: 5000 });
  const levels = levelMap({ n1: 'BG', n2: 'BG', n3: 'N', n4: 'N', n5: 'BG' });
  const result = generateRound(
    ['n1', 'n2', 'n3', 'n4', 'n5'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['n1', 'n2', 'n3', 'n4', 'n5']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  const seated = [...court.teamA, ...court.teamB];
  assert.equal(seated.length, 4);
  // The 4 longest-waiting join; n5 (shortest wait) is left for a later court.
  assert.equal(seated.includes('n5'), false);
  assert.deepEqual(result.sittingOut, ['n5']);
});

test('generateRound: reshuffling a group carry court still returns a full court, not null', () => {
  const history = historyWithWait({ n1: 1000, n2: 2000, u1: 3000, u2: 4000 });
  const levels = levelMap({ n1: 'BG', n2: 'BG', u1: null, u2: null });
  const roster = ['n1', 'n2', 'u1', 'u2'];
  const first = generateRound(
    roster, 1, history, makeSeededRandom(1), undefined, undefined, levels, true, 'wait',
    new Set(['n1', 'n2']), new Set()
  );
  const [firstCourt] = first.courts;
  assert.equal(firstCourt.teamA.length + firstCourt.teamB.length, 4);

  const reshuffled = generateRound(
    roster, 1, history, makeSeededRandom(2),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined, levels, true, 'wait', new Set(['n1', 'n2']), new Set()
  );
  const [again] = reshuffled.courts;
  assert.equal(again.teamA.length + again.teamB.length, 4);
  assert.equal([...again.teamA, ...again.teamB].includes('n1'), true);
  assert.equal([...again.teamA, ...again.teamB].includes('n2'), true);
});
