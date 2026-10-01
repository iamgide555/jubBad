import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBill,
  DEFAULT_BILL_CONFIG,
  type BillConfig,
  type BillInput,
  type BillMatch,
  type BillResult,
  type SettledPayment,
} from './bill.ts';

const game = (players: string[], shuttleIds: string[] | null): BillMatch => ({ players, shuttleIds });
const paid = (playerId: string, model: SettledPayment['model'], amountSatang: number, extra: Partial<SettledPayment> = {}): SettledPayment => ({
  id: `r-${playerId}`, playerId, model, amountSatang, settledAt: '2026-10-01T10:00:00Z', walkInFeeSatang: 0, walkInDiscountSatang: 0, startingFeeSatang: 0, ...extra,
});

function bill(config: Partial<BillConfig>, over: Partial<BillInput> = {}): BillResult {
  return computeBill({
    config: { ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, ...config },
    matches: [],
    walkInIds: [],
    shuttleCount: 0,
    shuttlePriceSatang: 0,
    shuttleAllocation: 'identities',
    ...over,
  });
}
const due = (r: BillResult) => Object.fromEntries(r.rows.filter((x) => x.status === 'billed').map((x) => [x.playerId, x.amountSatang]));

// --- no checkout: nothing changes -----------------------------------------------------------------

test('without settlements the totals gain only zeroes and stillDue equals collected', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000 }, { matches: [game(['a', 'b'], [])] });
  assert.deepEqual(due(r), { a: 5000, b: 5000 });
  assert.equal(r.totals.settledTotalSatang, 0);
  assert.equal(r.totals.stillDueSatang, 10000);
  assert.equal(r.totals.collectedSatang, 10000);
  assert.equal(r.totals.excessCreditSatang, 0);
  assert.equal(r.totals.uncoveredCostSatang, 0);
  assert.equal(r.totals.unreturnedSurchargeSatang, 0);
  assert.deepEqual(r.settledRows, []);
});

// --- fair ------------------------------------------------------------------------------------------

test('fair: a frozen payment is credited and only the residual is split among those still due', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000 }, {
    matches: [game(['a', 'b', 'c'], [])],
    settled: [paid('a', 'perGame', 2000)],
  });
  assert.deepEqual(due(r), { b: 4000, c: 4000 });
  assert.equal(r.totals.stillDueSatang, 8000);
  assert.equal(r.totals.settledTotalSatang, 2000);
  assert.equal(r.totals.collectedSatang, 10000);
  assert.equal(r.totals.marginSatang, 0);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.settledRows.map((s) => [s.playerId, s.model, s.amountSatang]), [['a', 'perGame', 2000]]);
  assert.ok(!r.rows.some((x) => x.playerId === 'a'), 'a settled player is never a still-due row');
});

test('fair: settled payments above the cost leave nobody negative and surface the excess', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000 }, {
    matches: [game(['a', 'b', 'c'], [])],
    settled: [paid('a', 'buffet', 12000)],
  });
  assert.deepEqual(due(r), { b: 0, c: 0 });
  assert.equal(r.totals.excessCreditSatang, 2000);
  assert.equal(r.totals.stillDueSatang, 0);
  assert.ok(r.warnings.includes('EXCESS_CREDIT'));
  assert.ok(r.rows.every((x) => x.amountSatang >= 0));
});

test('fair: everyone left, the cost is not covered, and the shortfall is shown not invented', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000 }, {
    matches: [game(['a', 'b'], [])],
    settled: [paid('a', 'perGame', 3000), paid('b', 'perGame', 3000)],
  });
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.uncoveredCostSatang, 4000);
  assert.equal(r.totals.stillDueSatang, 0);
  assert.ok(r.warnings.includes('UNCOVERED_COST'));
});

test('fair by games: the residual keeps the selected split weights', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 9000, courtSplit: 'byGames' }, {
    matches: [game(['a', 'b'], []), game(['a', 'c'], []), game(['a', 'c'], []), game(['d', 'a'], [])],
    settled: [paid('a', 'perGame', 3000)],
  });
  // games: a4 b1 c2 d1 -> nominal 4500/1125/2250/1125; residual 6000 over b,c,d by 1:2:1 weights.
  assert.deepEqual(due(r), { b: 1500, c: 3000, d: 1500 });
});

test('fair: the host fee is still owed on top by every person still due, settled people are not billed it again', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000, hostFeeSatang: 500 }, {
    matches: [game(['a', 'b', 'c'], [])],
    settled: [paid('a', 'perGame', 2000)],
  });
  assert.deepEqual(due(r), { b: 4500, c: 4500 });
});

test('a settled player also removed, overridden or added in the config never becomes billable again', () => {
  const r = bill(
    { model: 'perGame', entryFeeSatang: 1000, perGameRateSatang: 1000, removedIds: ['a'], addedIds: ['a', 'z'], overrides: [{ playerId: 'a', amountSatang: 1 }] },
    { matches: [game(['a', 'b'], [])], settled: [paid('a', 'perGame', 2000)] }
  );
  assert.deepEqual(r.rows.map((x) => x.playerId).sort(), ['b', 'z']);
  assert.equal(r.rows.find((x) => x.playerId === 'b')!.amountSatang, 2000);
  assert.equal(r.totals.settledTotalSatang, 2000);
});

// --- perShuttle ------------------------------------------------------------------------------------

const PS = { model: 'perShuttle' as const, startingFeeSatang: 3000 };
const price = { shuttlePriceSatang: 12000 };

test('perShuttle: a reused shuttle is charged once; the leaver keeps their frozen amount and the rest pay the same share', () => {
  const matches = [game(['a', 'b', 'c', 'd'], ['n1']), game(['e', 'f', 'g', 'h'], ['n1'])];
  // a left after game 1 and paid 3000 start + 1500 shuttle share.
  const r = bill(PS, { matches, ...price, settled: [paid('a', 'perShuttle', 4500, { startingFeeSatang: 3000 })] });
  assert.deepEqual(due(r), { b: 4500, c: 4500, d: 4500, e: 4500, f: 4500, g: 4500, h: 4500 });
  assert.equal(r.totals.settledTotalSatang, 4500);
  // 8 starting fees + the 12000 shuttle, once.
  assert.equal(r.totals.collectedSatang, 8 * 3000 + 12000);
  assert.deepEqual(r.warnings, []);
});

test('perShuttle: sequential leavers and a later game never rebill the shuttle', () => {
  const matches = [game(['a', 'b', 'c', 'd'], ['n1']), game(['a', 'b', 'e', 'f'], ['n1']), game(['g', 'h', 'i', 'j'], ['n2'])];
  // nominal: n1 12000 -> 6000/game -> 1500 each; n2 12000 -> 3000 each.
  // a (two n1 games = 3000) and g (3000) left early at those amounts.
  const r = bill(PS, {
    matches, ...price,
    settled: [paid('a', 'perShuttle', 6000, { startingFeeSatang: 3000 }), paid('g', 'perShuttle', 6000, { startingFeeSatang: 3000 })],
  });
  assert.equal(r.totals.collectedSatang, 10 * 3000 + 24000);
  assert.deepEqual(r.warnings, []);
});

test('perShuttle: a settled per-game or buffet payment credits the recorded shuttle cost in full', () => {
  const matches = [game(['a', 'b', 'c', 'd'], ['n1'])];
  const r = bill({ ...PS, startingFeeSatang: 2000 }, { matches, ...price, settled: [paid('a', 'perGame', 6000)] });
  // residual 12000 - 6000 = 6000 over b,c,d = 2000 each, plus a 2000 start.
  assert.deepEqual(due(r), { b: 4000, c: 4000, d: 4000 });
});

test('perShuttle: starting fees alone never look like an overpayment', () => {
  const r = bill(PS, {
    matches: [game(['a', 'b', 'c', 'd'], [])], ...price,
    settled: [paid('a', 'perShuttle', 3000, { startingFeeSatang: 3000 }), paid('b', 'perShuttle', 3000, { startingFeeSatang: 3000 })],
  });
  assert.equal(r.totals.excessCreditSatang, 0);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(due(r), { c: 3000, d: 3000 });
});

test('perShuttle: a correction that cuts the shuttle cost below what was paid shows an excess, never a negative bill', () => {
  const r = bill(PS, {
    matches: [game(['a', 'b', 'c', 'd'], ['n1'])], shuttlePriceSatang: 4000,
    settled: [paid('a', 'perShuttle', 4500, { startingFeeSatang: 3000 })],
  });
  // recorded cost is now 4000, a's shuttle credit is 1500: residual 2500 over b,c,d.
  assert.equal(r.totals.excessCreditSatang, 0);
  const cut = bill(PS, {
    matches: [game(['a', 'b', 'c', 'd'], ['n1'])], shuttlePriceSatang: 400,
    settled: [paid('a', 'perShuttle', 4500, { startingFeeSatang: 3000 })],
  });
  assert.equal(cut.totals.excessCreditSatang, 1100); // 1500 credited against a 400 cost
  assert.ok(cut.warnings.includes('EXCESS_CREDIT'));
  assert.deepEqual(due(cut), { b: 3000, c: 3000, d: 3000 });
});

test('perShuttle: no physical count is needed and an unknown finished game blocks the bill', () => {
  const ok = bill(PS, { matches: [game(['a', 'b'], ['n1'])], ...price, shuttleCount: null });
  assert.deepEqual(ok.warnings, []);
  const unknown = bill(PS, { matches: [game(['a', 'b'], null), game(['a', 'b'], ['n1'])], ...price });
  assert.ok(unknown.warnings.includes('UNKNOWN_SHUTTLE_USE'));
  const noPrice = bill(PS, { matches: [game(['a', 'b'], ['n1'])], shuttlePriceSatang: null });
  assert.ok(noPrice.warnings.includes('MISSING_SHUTTLE_PRICE'));
  const free = bill(PS, { matches: [game(['a', 'b'], ['n1'])], shuttlePriceSatang: 0 });
  assert.deepEqual(free.warnings, []);
});

test('perShuttle: everyone left with the shuttles unpaid reports the uncovered cost', () => {
  const r = bill(PS, {
    matches: [game(['a', 'b'], ['n1'])], ...price,
    settled: [paid('a', 'perShuttle', 3000, { startingFeeSatang: 3000 }), paid('b', 'perShuttle', 3000, { startingFeeSatang: 3000 })],
  });
  assert.equal(r.totals.uncoveredCostSatang, 12000);
  assert.ok(r.warnings.includes('UNCOVERED_COST'));
});

// --- price-based finals ---------------------------------------------------------------------------

test('perGame final: still-due rates are unchanged and the settled payment counts once in collected and margin', () => {
  const r = bill({ model: 'perGame', entryFeeSatang: 1000, perGameRateSatang: 2000, courtFeeSatang: 4000 }, {
    matches: [game(['a', 'b'], []), game(['a', 'b'], [])], shuttleCount: 0,
    settled: [paid('a', 'buffet', 7000)],
  });
  assert.deepEqual(due(r), { b: 5000 });
  assert.equal(r.totals.collectedSatang, 12000);
  assert.equal(r.totals.marginSatang, 8000);
  assert.equal(r.totals.stillDueSatang, 5000);
});

test('buffet final: still-due pay the flat price, settled add to collected once', () => {
  const r = bill({ model: 'buffet', buffetPriceSatang: 8000 }, {
    matches: [game(['a', 'b', 'c'], [])], settled: [paid('a', 'perGame', 3500)],
  });
  assert.deepEqual(due(r), { b: 8000, c: 8000 });
  assert.equal(r.totals.collectedSatang, 19500);
});

// --- walk-in surcharge: a group transfer, never profit ---------------------------------------------

test('price model: a settled walk-in surcharge is handed back once to those still due', () => {
  const r = bill({ model: 'perGame', entryFeeSatang: 5000, walkInFeeSatang: 2000 }, {
    matches: [game(['a', 'b', 'c', 'w'], [])], walkInIds: ['w'],
    settled: [paid('w', 'perGame', 7000, { walkInFeeSatang: 2000 })],
  });
  // 2000 pool = 20 steps of 100 over three people: 7+7+6.
  assert.deepEqual(due(r), { a: 4300, b: 4300, c: 4400 });
  assert.equal(r.totals.collectedSatang, 7000 + 13000);
  assert.equal(r.totals.collectedSatang, 4 * 5000, 'the same total as if nobody paid a surcharge');
  assert.equal(r.totals.unreturnedSurchargeSatang, 0);
});

test('price model: the last eligible walk-in absorbs both their own and a settled walk-in surcharge', () => {
  const r = bill({ model: 'perGame', entryFeeSatang: 5000, walkInFeeSatang: 2000 }, {
    matches: [game(['v', 'w'], [])], walkInIds: ['v', 'w'],
    settled: [paid('w', 'perGame', 7000, { walkInFeeSatang: 2000 })],
  });
  assert.deepEqual(due(r), { v: 3000 });
  assert.equal(r.totals.collectedSatang, 10000);
  assert.equal(r.totals.unreturnedSurchargeSatang, 0);
});

test('price model: nobody eligible to take the surcharge back is surfaced, not counted as profit', () => {
  const nobody = bill({ model: 'perGame', entryFeeSatang: 5000, walkInFeeSatang: 2000 }, {
    matches: [game(['w'], [])], walkInIds: ['w'], settled: [paid('w', 'perGame', 7000, { walkInFeeSatang: 2000 })],
  });
  assert.equal(nobody.totals.unreturnedSurchargeSatang, 2000);
  assert.ok(nobody.warnings.includes('UNRETURNED_SURCHARGE'));
  const overridden = bill({ model: 'perGame', entryFeeSatang: 5000, walkInFeeSatang: 2000, overrides: [{ playerId: 'a', amountSatang: 1000 }] }, {
    matches: [game(['a', 'w'], [])], walkInIds: ['w'], settled: [paid('w', 'perGame', 7000, { walkInFeeSatang: 2000 })],
  });
  assert.equal(overridden.totals.unreturnedSurchargeSatang, 2000);
  assert.equal(due(overridden).a, 1000, 'an overridden row bypasses the discount');
});

test('price model: a discount already frozen in a receipt is not handed out a second time', () => {
  const r = bill({ model: 'perGame', entryFeeSatang: 5000, walkInFeeSatang: 2000 }, {
    matches: [game(['a', 'w'], [])], walkInIds: ['w'],
    settled: [paid('w', 'perGame', 6000, { walkInFeeSatang: 2000, walkInDiscountSatang: 1000 })],
  });
  assert.deepEqual(due(r), { a: 4000 }); // only the 1000 not yet returned
});

test('cost model: a settled surcharge inside the frozen amount credits the cost once and adds no second discount', () => {
  const r = bill({ model: 'fair', courtFeeSatang: 10000, walkInFeeSatang: 2000 }, {
    matches: [game(['a', 'b', 'w'], [])], walkInIds: ['w'],
    settled: [paid('w', 'perGame', 5400, { walkInFeeSatang: 2000 })],
  });
  assert.equal(r.totals.stillDueSatang, 4600);
  assert.equal(r.totals.collectedSatang, 10000);
});

// --- rounding and conservation ---------------------------------------------------------------------

test('rounding: still-due amounts round up to the step and the residual satang are conserved before rounding', () => {
  for (const roundingBaht of [1, 5, 10] as const) {
    const r = bill({ model: 'fair', courtFeeSatang: 10001, roundingBaht }, {
      matches: [game(['a', 'b', 'c', 'd'], [])], settled: [paid('a', 'perGame', 1)],
    });
    const step = roundingBaht * 100;
    for (const row of r.rows) assert.equal(row.amountSatang % step, 0);
    assert.ok(r.totals.stillDueSatang >= 10000 && r.totals.stillDueSatang < 10000 + step * 3);
  }
});

test('shuttle shares across due players stay integer and sum to the residual', () => {
  const matches = [game(['a', 'b', 'c'], ['n1']), game(['a', 'd', 'e', 'f'], ['n1']), game(['g', 'h', 'i', 'j'], ['n2'])];
  const r = bill({ ...PS, startingFeeSatang: 0 }, { matches, shuttlePriceSatang: 10001, settled: [paid('g', 'perGame', 500)] });
  const shuttleSum = r.rows.reduce((s, x) => s + x.shuttleSatang, 0);
  assert.ok(r.rows.every((x) => Number.isInteger(x.shuttleSatang) && x.shuttleSatang >= 0));
  assert.equal(shuttleSum, 2 * 10001 - 500);
});

test('invalid settled input fails loudly', () => {
  const base = { matches: [game(['a'], [])] };
  assert.throws(() => bill({}, { ...base, settled: [paid('a', 'perGame', -1)] }), /settled/);
  assert.throws(() => bill({}, { ...base, settled: [paid('a', 'perGame', 1.5)] }), /settled/);
  assert.throws(() => bill({}, { ...base, settled: [paid('a', 'perGame', 1), paid('a', 'buffet', 1)] }), /duplicate/);
  assert.throws(() => bill({}, { ...base, settled: [paid('a', 'fair' as never, 1)] }), /settled/);
});
