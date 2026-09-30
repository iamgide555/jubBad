import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidPairRules,
  isLegalCourt,
  NoLegalRuleMatchError,
  PairRuleSearchLimitError,
  type PairRule,
} from './pair-rules.ts';
import { completeCourt, generateRound, InvalidRoundInputError, type MatchHistory } from './pairing.ts';

function empty(): MatchHistory {
  return { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession: new Map() };
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const rule = (id: string, a: string, b: string, kind: PairRule['kind']): PairRule => ({
  id,
  playerAId: a,
  playerBId: b,
  kind,
});

const sameTeam = (teams: { teamA: string[]; teamB: string[] }, x: string, y: string) =>
  (teams.teamA.includes(x) && teams.teamA.includes(y)) || (teams.teamB.includes(x) && teams.teamB.includes(y));

test('assertValidPairRules accepts well-formed rules over roster players', () => {
  assert.doesNotThrow(() =>
    assertValidPairRules(
      ['a', 'b', 'c', 'd'],
      [rule('r1', 'a', 'b', 'must-pair'), rule('r2', 'a', 'c', 'never-teammates'), rule('r3', 'c', 'd', 'never-same-court')]
    )
  );
});

test('assertValidPairRules rejects self, cross-roster, overlapping and malformed rules', () => {
  const roster = ['a', 'b', 'c', 'd'];
  const bad: PairRule[][] = [
    [rule('r1', 'a', 'a', 'never-teammates')],
    [rule('r1', 'a', 'z', 'never-teammates')],
    [rule('r1', 'a', 'b', 'must-pair'), rule('r2', 'a', 'c', 'must-pair')],
    [rule('r1', 'a', 'b', 'must-pair'), rule('r2', 'b', 'a', 'never-teammates')],
    [rule('r1', 'a', 'b', 'never-teammates'), rule('r1', 'c', 'd', 'never-teammates')],
    [rule('', 'a', 'b', 'never-teammates')],
    [{ id: 'r1', playerAId: 'a', playerBId: 'b', kind: 'soft' as PairRule['kind'] }],
  ];
  for (const rules of bad) {
    assert.throws(() => assertValidPairRules(roster, rules), InvalidRoundInputError, JSON.stringify(rules));
  }
});

test('isLegalCourt applies each rule kind to one court', () => {
  const nsc = [rule('r', 'a', 'b', 'never-same-court')];
  assert.equal(isLegalCourt(['a', 'c'], ['b', 'd'], nsc), false);
  assert.equal(isLegalCourt(['a', 'c'], ['e', 'd'], nsc), true);

  const nt = [rule('r', 'a', 'b', 'never-teammates')];
  assert.equal(isLegalCourt(['a', 'b'], ['c', 'd'], nt), false);
  assert.equal(isLegalCourt(['a', 'c'], ['b', 'd'], nt), true);

  const mp = [rule('r', 'a', 'b', 'must-pair')];
  assert.equal(isLegalCourt(['a', 'b'], ['c', 'd'], mp), true);
  assert.equal(isLegalCourt(['a', 'c'], ['b', 'd'], mp), false);
  assert.equal(isLegalCourt(['a', 'c'], ['e', 'd'], mp), false, 'a must not play without b');
  assert.equal(isLegalCourt(['a'], ['b'], mp), false, 'a must-pair duo never plays singles');
  assert.equal(isLegalCourt(['c', 'd'], ['e', 'f'], mp), true);
});

test('generateRound never partners a never-teammates pair but lets them oppose', () => {
  const rules = [rule('r', 'a', 'b', 'never-teammates')];
  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = generateRound(['a', 'b', 'c', 'd'], 1, empty(), seeded(seed), undefined, undefined, undefined, false, 'games', undefined, undefined, rules);
    assert.equal(courts.length, 1);
    assert.equal(sameTeam(courts[0], 'a', 'b'), false, `seed ${seed}`);
  }
});

test('generateRound keeps a must-pair duo on one doubles team', () => {
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = generateRound(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      2,
      empty(),
      seeded(seed),
      undefined, undefined, undefined, false, 'games', undefined, undefined,
      rules
    );
    const withA = courts.find((c) => [...c.teamA, ...c.teamB].includes('a'))!;
    assert.ok(sameTeam(withA, 'a', 'b'), `seed ${seed}`);
  }
});

test('generateRound splits a never-same-court pair across two courts', () => {
  const rules = [rule('r', 'a', 'b', 'never-same-court')];
  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = generateRound(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      2,
      empty(),
      seeded(seed),
      undefined, undefined, undefined, false, 'games', undefined, undefined,
      rules
    );
    assert.equal(courts.length, 2);
    for (const c of courts) {
      const players = [...c.teamA, ...c.teamB];
      assert.ok(!(players.includes('a') && players.includes('b')), `seed ${seed}`);
    }
  }
});

test('generateRound throws NoLegalRuleMatchError when four players cannot share a legal court', () => {
  const rules = [rule('r', 'a', 'b', 'never-same-court')];
  assert.throws(
    () => generateRound(['a', 'b', 'c', 'd'], 1, empty(), seeded(1), undefined, undefined, undefined, false, 'games', undefined, undefined, rules),
    (err: unknown) => err instanceof NoLegalRuleMatchError && err.ruleIds.includes('r')
  );
});

test('generateRound repeats the sole legal split rather than an illegal one despite avoidSplit', () => {
  // must-pair a-c leaves ac|bd as the only legal split.
  const rules = [rule('r1', 'a', 'c', 'must-pair')];
  const shown = [
    { teamA: ['a', 'c'], teamB: ['b', 'd'] },
    { teamA: ['a', 'b'], teamB: ['c', 'd'] },
  ];
  for (const avoid of [shown[0], shown]) {
    for (let seed = 1; seed <= 10; seed++) {
      const { courts } = generateRound(['a', 'b', 'c', 'd'], 1, empty(), seeded(seed), avoid, undefined, undefined, false, 'games', undefined, undefined, rules);
      assert.equal(courts.length, 1);
      assert.ok(sameTeam(courts[0], 'a', 'c'), `seed ${seed}`);
    }
  }
});

test('generateRound prefers an unseen legal split over a shown one', () => {
  const rules = [rule('r1', 'a', 'b', 'never-teammates')];
  for (let seed = 1; seed <= 10; seed++) {
    const { courts } = generateRound(
      ['a', 'b', 'c', 'd'],
      1,
      empty(),
      seeded(seed),
      { teamA: ['a', 'c'], teamB: ['b', 'd'] },
      undefined, undefined, false, 'games', undefined, undefined,
      rules
    );
    assert.ok(sameTeam(courts[0], 'a', 'd'), `seed ${seed}`);
  }
});

test('generateRound rejects invalid rule data loudly', () => {
  assert.throws(
    () => generateRound(['a', 'b', 'c', 'd'], 1, empty(), seeded(1), undefined, undefined, undefined, false, 'games', undefined, undefined, [rule('r', 'a', 'z', 'must-pair')]),
    InvalidRoundInputError
  );
});

test('completeCourt seats a must-pair partner beside an already-seated player', () => {
  const history = empty();
  history.gamesPlayedThisSession.set('c', 5);
  const result = completeCourt(
    { teamA: ['a', null], teamB: [null, null] },
    ['b', 'c', 'd', 'e'],
    history,
    seeded(1),
    [rule('r', 'a', 'c', 'must-pair')]
  );
  assert.ok(result);
  assert.deepEqual(result.teamA, ['a', 'c']);
});

test('completeCourt rejects a full lineup that breaks a rule', () => {
  assert.throws(
    () =>
      completeCourt({ teamA: ['a', 'b'], teamB: ['c', 'd'] }, [], empty(), seeded(1), [
        rule('r', 'a', 'b', 'never-teammates'),
      ]),
    NoLegalRuleMatchError
  );
});

test('completeCourt reports a rule conflict distinctly from not enough people', () => {
  const rules = [rule('r', 'a', 'b', 'never-same-court')];
  assert.equal(completeCourt({ teamA: ['a', null], teamB: [null, null] }, ['b', 'c'], empty(), seeded(1), rules), null);
  assert.throws(
    () => completeCourt({ teamA: ['a', null], teamB: [null, null] }, ['b', 'c', 'd'], empty(), seeded(1), rules),
    NoLegalRuleMatchError
  );
});

test('PairRuleSearchLimitError carries a stable code', () => {
  assert.equal(new PairRuleSearchLimitError().code, 'PAIR_RULE_SEARCH_LIMIT');
  assert.equal(new NoLegalRuleMatchError(['r']).code, 'PAIR_RULES_BLOCKED');
});
