import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidPairRules,
  isLegalCourt,
  NoLegalRuleMatchError,
  PairRuleSearchLimitError,
  searchLegalAssignments,
  type PairRule,
} from './pair-rules.ts';
import {
  completeCourt,
  generateRound,
  InvalidRoundInputError,
  type CourtSize,
  type MatchHistory,
  type RoundResult,
} from './pairing.ts';
import type { Level } from './levels.ts';

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

// ---- Task 4: units, bounded search, carry ----

type RoundOpts = {
  history?: MatchHistory;
  seed?: number;
  avoid?: Parameters<typeof generateRound>[4];
  ratings?: Map<string, number>;
  levels?: Map<string, Level | null>;
  band?: boolean;
  queueBy?: 'games' | 'wait';
  carryEligible?: Set<string>;
  policy?: 'requested' | 'partial';
};

function round(roster: string[], courts: number | CourtSize[], rules: PairRule[], o: RoundOpts = {}): RoundResult {
  return generateRound(
    roster,
    courts,
    o.history ?? empty(),
    seeded(o.seed ?? 1),
    o.avoid,
    o.ratings,
    o.levels,
    o.band ?? false,
    o.queueBy ?? 'games',
    o.carryEligible,
    o.carryEligible ? new Set() : undefined,
    rules,
    o.policy
  );
}

function assertLegalRound(result: RoundResult, roster: string[], rules: PairRule[], label: string) {
  const seen = new Set<string>();
  for (const c of result.courts) {
    for (const id of [...c.teamA, ...c.teamB]) {
      assert.ok(!seen.has(id), `${label}: ${id} seated twice`);
      seen.add(id);
    }
    assert.ok(isLegalCourt(c.teamA, c.teamB, rules), `${label}: illegal court ${JSON.stringify(c)}`);
  }
  for (const id of result.sittingOut) assert.ok(!seen.has(id), `${label}: ${id} both plays and sits`);
  assert.equal(seen.size + result.sittingOut.length, roster.length, `${label}: roster not conserved`);
}

const letters = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

test('searchLegalAssignments reports limit when its state budget runs out', () => {
  const out = searchLegalAssignments({
    roster: letters(8),
    sizes: [4, 4],
    rules: [rule('r', 'p1', 'p2', 'never-same-court')],
    gamesPlayedThisSession: new Map(),
    queueBy: 'games',
    random: seeded(1),
    requireFirstCourt: true,
    maxStates: 1,
  });
  assert.deepEqual(out, { status: 'limit' });
});

test('searchLegalAssignments proves a four-player never-same-court court impossible', () => {
  const out = searchLegalAssignments({
    roster: ['a', 'b', 'c', 'd'],
    sizes: [4],
    rules: [rule('r', 'a', 'b', 'never-same-court')],
    gamesPlayedThisSession: new Map(),
    queueBy: 'games',
    random: seeded(1),
    requireFirstCourt: true,
    maxStates: 100_000,
  });
  assert.deepEqual(out, { status: 'impossible' });
});

test('searchLegalAssignments keeps court indexes when it skips a court the unit cannot use', () => {
  const base = {
    roster: ['a', 'b', 'c', 'd'],
    sizes: [2, 4] as CourtSize[],
    rules: [rule('r', 'a', 'b', 'must-pair')],
    gamesPlayedThisSession: new Map<string, number>(),
    queueBy: 'games' as const,
    random: seeded(1),
    maxStates: 100_000,
  };
  const partial = searchLegalAssignments({ ...base, requireFirstCourt: false });
  assert.equal(partial.status, 'found');
  if (partial.status !== 'found') return;
  assert.deepEqual(partial.courts.map((c) => c.courtIndex), [1]);
  assert.deepEqual(new Set(partial.courts[0].players), new Set(['a', 'b', 'c', 'd']));

  const requested = searchLegalAssignments({ ...base, random: seeded(1), requireFirstCourt: true });
  assert.equal(requested.status, 'found');
  if (requested.status !== 'found') return;
  assert.deepEqual(requested.courts.map((c) => c.courtIndex), [0]);
  assert.deepEqual(new Set(requested.courts[0].players), new Set(['c', 'd']));
  assert.deepEqual(new Set(requested.sittingOut), new Set(['a', 'b']));
});

test('a must-pair unit sits together when its less deserving member has the most games', () => {
  const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  for (let seed = 1; seed <= 10; seed++) {
    const history = empty();
    history.gamesPlayedThisSession = new Map([['a', 0], ['b', 3], ['c', 1], ['d', 1], ['e', 1], ['f', 1]]);
    const result = round(roster, 1, rules, { history, seed });
    assert.deepEqual(new Set(result.sittingOut), new Set(['a', 'b']), `seed ${seed}`);
  }
});

test('a deserving must-pair unit plays together as one team', () => {
  const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  for (let seed = 1; seed <= 10; seed++) {
    const history = empty();
    history.gamesPlayedThisSession = new Map([['a', 0], ['b', 0], ['c', 2], ['d', 2], ['e', 2], ['f', 2]]);
    const result = round(roster, 1, rules, { history, seed });
    assertLegalRound(result, roster, rules, `seed ${seed}`);
    assert.ok(sameTeam(result.courts[0], 'a', 'b'), `seed ${seed}`);
  }
});

test('the wait-only queue ranks a must-pair unit by its shorter-waiting member', () => {
  const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  for (let seed = 1; seed <= 10; seed++) {
    const history = empty();
    history.waitingSince = new Map([['a', 0], ['b', 100], ['c', 50], ['d', 50], ['e', 50], ['f', 50]]);
    const result = round(roster, 1, rules, { history, seed, queueBy: 'wait' });
    assert.deepEqual(new Set(result.sittingOut), new Set(['a', 'b']), `seed ${seed}`);
  }
});

test('a must-pair unit skips a singles court and plays on the later doubles court', () => {
  const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  for (let seed = 1; seed <= 10; seed++) {
    const result = round(roster, [2, 4], rules, { seed });
    assertLegalRound(result, roster, rules, `seed ${seed}`);
    assert.equal(result.courts.length, 2);
    const doubles = result.courts.find((c) => c.court === 2)!;
    assert.ok(sameTeam(doubles, 'a', 'b'), `seed ${seed}`);
  }
});

test('partial fill maximizes legal seats without renumbering; requested keeps court 1 first', () => {
  const roster = ['a', 'b', 'c', 'd'];
  const rules = [rule('r', 'a', 'b', 'must-pair')];
  const partial = round(roster, [2, 4], rules, { policy: 'partial' });
  assert.deepEqual(partial.courts.map((c) => c.court), [2]);
  assert.deepEqual(partial.sittingOut, []);
  assert.ok(sameTeam(partial.courts[0], 'a', 'b'));

  const requested = round(roster, [2, 4], rules, { policy: 'requested' });
  assert.deepEqual(requested.courts.map((c) => c.court), [1]);
  assert.deepEqual(new Set(requested.sittingOut), new Set(['a', 'b']));
});

test('variety mode picks the legal split with fewer repeat partners', () => {
  const rules = [rule('r', 'a', 'b', 'never-teammates')];
  for (let seed = 1; seed <= 10; seed++) {
    const history = empty();
    history.partnerCounts.set('a|d', 5);
    const [court] = round(['a', 'b', 'c', 'd'], 1, rules, { history, seed }).courts;
    assert.ok(sameTeam(court, 'a', 'c'), `seed ${seed}`);
  }
});

test('balanced mode picks the smaller rating gap among legal splits', () => {
  const rules = [rule('r', 'a', 'b', 'never-teammates')];
  const ratings = new Map([['a', 1500], ['b', 1000], ['c', 1400], ['d', 1100]]);
  for (let seed = 1; seed <= 10; seed++) {
    const [court] = round(['a', 'b', 'c', 'd'], 1, rules, { seed, ratings }).courts;
    assert.ok(sameTeam(court, 'a', 'd'), `seed ${seed}`);
  }
});

test('level mode keeps its band among legal results', () => {
  const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const rules = [rule('r', 'a', 'b', 'never-teammates')];
  const levels = new Map<string, Level | null>([
    ['a', 'P'], ['b', 'P'], ['c', 'P'], ['d', 'P'],
    ['e', 'N'], ['f', 'N'], ['g', 'N'], ['h', 'N'],
  ]);
  for (let seed = 1; seed <= 10; seed++) {
    const result = round(roster, 2, rules, { seed, levels, band: true, queueBy: 'wait' });
    assertLegalRound(result, roster, rules, `seed ${seed}`);
    const withA = result.courts.find((c) => [...c.teamA, ...c.teamB].includes('a'))!;
    assert.deepEqual(new Set([...withA.teamA, ...withA.teamB]), new Set(['a', 'b', 'c', 'd']), `seed ${seed}`);
  }
});

test('twelve-player constrained rounds find legal courts without claiming impossibility', () => {
  const roster = letters(12);
  const rules = [
    rule('r1', 'p1', 'p2', 'must-pair'),
    rule('r2', 'p3', 'p4', 'never-teammates'),
    rule('r3', 'p5', 'p6', 'never-same-court'),
    rule('r4', 'p1', 'p5', 'never-same-court'),
    rule('r5', 'p7', 'p8', 'must-pair'),
    rule('r6', 'p2', 'p7', 'never-same-court'),
  ];
  for (let seed = 1; seed <= 20; seed++) {
    const history = empty();
    for (const [i, id] of roster.entries()) history.gamesPlayedThisSession.set(id, i % 3);
    const result = round(roster, 3, rules, { history, seed });
    assert.equal(result.courts.length, 3, `seed ${seed}`);
    assertLegalRound(result, roster, rules, `seed ${seed}`);
  }
});

test('an inconclusive larger search surfaces as PairRuleSearchLimitError, not no-legal-match', () => {
  const roster = letters(16);
  const clique = ['p12', 'p13', 'p14', 'p15', 'p16'];
  const rules: PairRule[] = [];
  for (let i = 0; i < clique.length; i++) {
    for (let j = i + 1; j < clique.length; j++) {
      rules.push(rule(`r${i}${j}`, clique[i], clique[j], 'never-same-court'));
    }
  }
  const history = empty();
  for (const id of clique) history.gamesPlayedThisSession.set(id, 5);
  assert.throws(() => round(roster, 4, rules, { history }), PairRuleSearchLimitError);
});

test('a solo carry uses a strictly higher must-pair partner as the pro', () => {
  const history = empty();
  history.waitingSince = new Map([['n', 1000], ['q', 2000], ['r', 3000], ['s', 4000], ['t', 5000]]);
  const levels = new Map<string, Level | null>([['n', 'BG'], ['q', 'P'], ['r', 'B'], ['s', 'C'], ['t', 'P+']]);
  const rules = [rule('mp', 'n', 'q', 'must-pair')];
  const result = round(['n', 'q', 'r', 's', 't'], 1, rules, {
    history, levels, band: true, queueBy: 'wait', carryEligible: new Set(['n']),
  });
  assertLegalRound(result, ['n', 'q', 'r', 's', 't'], rules, 'carry');
  assert.ok(sameTeam(result.courts[0], 'n', 'q'));
});

test('a linked newcomer with an unsuitable required partner skips the forced carry legally', () => {
  const history = empty();
  history.waitingSince = new Map([['n', 1000], ['q', 2000], ['r', 3000], ['s', 4000], ['t', 5000]]);
  const levels = new Map<string, Level | null>([['n', 'BG'], ['q', 'BG'], ['r', 'B'], ['s', 'C'], ['t', 'P+']]);
  const rules = [rule('mp', 'n', 'q', 'must-pair')];
  for (let seed = 1; seed <= 10; seed++) {
    const result = round(['n', 'q', 'r', 's', 't'], 1, rules, {
      history, seed, levels, band: true, queueBy: 'wait', carryEligible: new Set(['n']),
    });
    assertLegalRound(result, ['n', 'q', 'r', 's', 't'], rules, `seed ${seed}`);
    assert.equal(result.courts.length, 1);
  }
});

test('carry courts obey negative rules for both solo and group carry', () => {
  const soloRules = [rule('x', 'n', 'r', 'never-same-court')];
  const history = empty();
  history.waitingSince = new Map([['n', 1000], ['q', 2000], ['r', 3000], ['s', 4000], ['t', 5000]]);
  const levels = new Map<string, Level | null>([['n', 'BG'], ['q', 'P'], ['r', 'B'], ['s', 'C'], ['t', 'P+']]);
  const solo = round(['n', 'q', 'r', 's', 't'], 1, soloRules, {
    history, levels, band: true, queueBy: 'wait', carryEligible: new Set(['n']),
  });
  assertLegalRound(solo, ['n', 'q', 'r', 's', 't'], soloRules, 'solo');
  assert.ok([...solo.courts[0].teamA, ...solo.courts[0].teamB].includes('n'));

  const groupRules = [rule('y', 'n1', 'n2', 'never-same-court')];
  const gh = empty();
  gh.waitingSince = new Map([['n1', 1], ['n2', 2], ['a', 3], ['b', 4], ['c', 5], ['d', 6]]);
  const gLevels = new Map<string, Level | null>([['n1', 'BG'], ['n2', 'BG'], ['a', 'P'], ['b', 'P'], ['c', 'P'], ['d', 'P']]);
  for (let seed = 1; seed <= 10; seed++) {
    const group = round(['n1', 'n2', 'a', 'b', 'c', 'd'], 1, groupRules, {
      history: gh, seed, levels: gLevels, band: true, queueBy: 'wait', carryEligible: new Set(['n1', 'n2']),
    });
    assertLegalRound(group, ['n1', 'n2', 'a', 'b', 'c', 'd'], groupRules, `group seed ${seed}`);
    assert.equal(group.courts.length, 1);
  }
});
