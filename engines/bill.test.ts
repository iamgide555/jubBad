import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBill,
  splitEqual,
  splitByWeight,
  DEFAULT_BILL_CONFIG,
  type BillConfig,
  type BillInput,
  type BillMatch,
} from './bill.ts';

const m = (...players: string[]): BillMatch => ({ players });
// a3 b3 c2 d2 e2
const FIVE: BillMatch[] = [m('a', 'b', 'c', 'd'), m('a', 'b', 'c', 'e'), m('a', 'b', 'd', 'e')];

function input(config: Partial<BillConfig>, extra: Partial<BillInput> = {}): BillInput {
  return {
    config: { ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, ...config },
    matches: FIVE,
    walkInIds: [],
    // Money fields default to "not recorded"; each test that checks amounts sets
    // them explicitly. Every final amount is ceiled to at least 1 baht, so
    // fixtures are chosen to land on whole baht unless rounding is the subject.
    shuttleCount: null,
    shuttlePriceSatang: null,
    ...extra,
  };
}
const amounts = (r: ReturnType<typeof computeBill>) =>
  Object.fromEntries(r.rows.filter((x) => x.status === 'billed').map((x) => [x.playerId, x.amountSatang]));

test('splitEqual gives the remainder to the first entries', () => {
  assert.deepEqual(splitEqual(10, 3), [4, 3, 3]);
  assert.deepEqual(splitEqual(0, 2), [0, 0]);
  assert.deepEqual(splitEqual(5, 0), []);
});

test('splitByWeight is exact, largest remainder, ties by position', () => {
  assert.deepEqual(splitByWeight(100000, [3, 3, 2, 2, 2]), [25000, 25000, 16667, 16667, 16666]);
  assert.deepEqual(splitByWeight(10, [0, 0]), [5, 5]);
});

test('fair: court and shuttles split equally over participants', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal', shuttleSplit: 'equal' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // court 100000/5 = 20000; shuttles 12000/5 = 2400
  assert.deepEqual(amounts(r), { a: 22400, b: 22400, c: 22400, d: 22400, e: 22400 });
  assert.equal(r.totals.collectedSatang, 112000);
  assert.equal(r.totals.costSatang, 112000);
  assert.equal(r.totals.marginSatang, 0);
  assert.deepEqual(r.warnings, []);
});

test('fair: court by games', () => {
  const r = computeBill(input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'byGames', shuttleSplit: 'equal' }));
  const court = Object.fromEntries(r.rows.map((x) => [x.playerId, x.courtSatang]));
  assert.deepEqual(court, { a: 25000, b: 25000, c: 16667, d: 16667, e: 16666 });
});

test('fair: shuttles by games give each match an equal share, split among its players (raw share)', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // 12000 / 3 matches = 4000 per match / 4 players = 1000 per appearance
  const shuttle = Object.fromEntries(r.rows.map((x) => [x.playerId, x.shuttleSatang]));
  assert.deepEqual(shuttle, { a: 3000, b: 3000, c: 2000, d: 2000, e: 2000 });
});

test('fair: removed person\'s cost share is spread equally over the billed', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal', shuttleSplit: 'equal', removedIds: ['e'] },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // court 20000 + e's 20000/4 = 25000; shuttles 2400 + e's 2400/4 = 3000
  assert.deepEqual(amounts(r), { a: 28000, b: 28000, c: 28000, d: 28000 });
  assert.equal(r.totals.collectedSatang, 112000);
  const e = r.rows.find((x) => x.playerId === 'e')!;
  assert.equal(e.status, 'removed');
  assert.equal(e.amountSatang, 0);
});

test('fair: missing shuttle count warns and bills shuttles as 0; margin hidden', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { shuttleCount: null, shuttlePriceSatang: 4000 })
  );
  assert.deepEqual(r.warnings, ['MISSING_SHUTTLE_COUNT']);
  assert.equal(r.totals.collectedSatang, 100000);
  assert.equal(r.totals.costSatang, null);
  assert.equal(r.totals.marginSatang, null);
});

test('fair: missing shuttle price warns', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { shuttleCount: 3, shuttlePriceSatang: null })
  );
  assert.deepEqual(r.warnings, ['MISSING_SHUTTLE_PRICE']);
});

test('fair: missing court fee warns', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: null, courtSplit: 'equal' }, { shuttleCount: 3, shuttlePriceSatang: 4000 })
  );
  assert.deepEqual(r.warnings, ['MISSING_COURT_FEE']);
});

test('perGame: entry + games × rate, capped; no shuttle warning', () => {
  const r = computeBill(
    input(
      { model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 3000, capSatang: 17000 },
      { shuttleCount: null, shuttlePriceSatang: null }
    )
  );
  assert.deepEqual(amounts(r), { a: 17000, b: 17000, c: 13000, d: 13000, e: 13000 });
  assert.deepEqual(r.warnings, []);
});

test('buffet: shuttles included is flat per person', () => {
  const r = computeBill(
    input({ model: 'buffet', buffetPriceSatang: 18000, buffetShuttlesIncluded: true }, { shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.deepEqual(amounts(r), { a: 18000, b: 18000, c: 18000, d: 18000, e: 18000 });
  assert.deepEqual(r.warnings, []);
});

test('buffet: shuttles separate adds each person\'s fair share', () => {
  const r = computeBill(
    input(
      { model: 'buffet', buffetPriceSatang: 18000, buffetShuttlesIncluded: false, shuttleSplit: 'equal' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // shuttle equal: 12000 / 5 = 2400 each
  assert.deepEqual(amounts(r), { a: 20400, b: 20400, c: 20400, d: 20400, e: 20400 });
});

test('added no-show pays only the equal/entry/buffet part, not court/shuttle by games', () => {
  const fair = computeBill(
    input({ model: 'fair', courtFeeSatang: 120000, courtSplit: 'equal', addedIds: ['f'] }, { shuttleCount: 3, shuttlePriceSatang: 4000 })
  );
  const f = fair.rows.find((x) => x.playerId === 'f')!;
  assert.equal(f.added, true);
  assert.equal(f.games, 0);
  assert.equal(f.courtSatang, 20000); // 120000 / 6 participants
  assert.equal(f.shuttleSatang, 0); // byGames default: f played no matches
  const perGame = computeBill(
    input({ model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 3000, addedIds: ['f'] }, { shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.equal(amounts(perGame).f, 3000);
});

test('host fee is added per person; the final amount is ceiled to the rounding step; an override bypasses both', () => {
  const r = computeBill(
    input(
      {
        model: 'fair',
        courtFeeSatang: 100000,
        courtSplit: 'equal',
        hostFeeSatang: 900,
        roundingBaht: 5,
        overrides: [{ playerId: 'e', amountSatang: 0 }],
      },
      { shuttleCount: 0, shuttlePriceSatang: 0 }
    )
  );
  // 100000/5 = 20000 + 900 host fee = 20900 -> ceil to nearest 500 -> 21000
  assert.deepEqual(amounts(r), { a: 21000, b: 21000, c: 21000, d: 21000, e: 0 });
  assert.equal(r.rows.find((x) => x.playerId === 'e')!.overridden, true);
});

test('singles: a match is split between its two players, same rate as doubles', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames' },
      { matches: [m('a', 'b'), m('a', 'b', 'c', 'd')], shuttleCount: 2, shuttlePriceSatang: 4000 }
    )
  );
  // 8000 / 2 matches = 4000/match; singles splits 2 ways (2000 each),
  // doubles splits 4 ways (1000 each) -- the same per-match rate either way
  assert.deepEqual(amounts(r), { a: 3000, b: 3000, c: 1000, d: 1000 });
});

test('empty session: no finished matches and nobody added -> empty bill', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { matches: [], shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.collectedSatang, 0);
  assert.equal(r.totals.billedCount, 0);
});

test('bad input throws', () => {
  assert.throws(() => computeBill(input({ hostFeeSatang: -1 })));
  assert.throws(() => computeBill(input({ perGameRateSatang: 1.5 })));
  assert.throws(() => computeBill(input({ model: 'nope' as never })));
  assert.throws(() => computeBill(input({ roundingBaht: 3 as never })));
  assert.throws(() => computeBill(input({ addedIds: ['f', 'f'] })));
  assert.throws(() =>
    computeBill(input({ overrides: [{ playerId: 'a', amountSatang: 1 }, { playerId: 'a', amountSatang: 2 }] }))
  );
  assert.throws(() => computeBill(input({}, { matches: [m('a', 'a', 'b', 'c')] })));
  assert.throws(() => computeBill(input({}, { shuttleCount: -1 })));
});
