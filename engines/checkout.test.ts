import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BILL_CONFIG, type BillConfig, type BillMatch } from './bill.ts';
import { CheckoutBlockedError, computeCheckoutPreview, type CheckoutPreviewInput } from './checkout.ts';

const game = (players: string[], shuttleIds: string[] | null): BillMatch => ({ players, shuttleIds });

function input(over: Partial<CheckoutPreviewInput> = {}, config: Partial<BillConfig> = {}): CheckoutPreviewInput {
  return {
    playerId: 'p',
    model: 'perShuttle',
    config: { ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, ...config },
    matches: [],
    shuttlePriceSatang: 12000,
    walkInIds: [],
    otherSettled: [],
    ...over,
  };
}

test('perShuttle: one shuttle used by two games is paid once, split game then player', () => {
  const r = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['d', 'e', 'f', 'g'], ['s1'])] })
  );
  // 12000 over one id, 6000 per game, 1500 per player.
  assert.equal(r.breakdown.shuttleSatang, 1500);
  assert.equal(r.games, 1);
});

test('perShuttle: a player in both games gets both game shares, never the whole shuttle twice', () => {
  const r = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s1'])] })
  );
  assert.equal(r.breakdown.shuttleSatang, 3000);
  assert.equal(r.games, 2);
});

test('perShuttle: two different shuttles in two games are each charged for their own game', () => {
  const r = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s2'])] })
  );
  // each shuttle 12000 over its single game = 3000 per player; p was in both.
  assert.equal(r.breakdown.shuttleSatang, 6000);
});

test('perShuttle: base is the starting fee plus the shuttle share, then rounded up to the step', () => {
  const r = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: 10000 }, { startingFeeSatang: 3000 })
  );
  // 10000/4 = 2500; 3000 + 2500 = 5500 -> already whole baht.
  assert.deepEqual(r.breakdown, { baseSatang: 3000, shuttleSatang: 2500, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 });
  assert.equal(r.amountSatang, 5500);
  const odd = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: 10100 }, { startingFeeSatang: 3000 })
  );
  assert.equal(odd.breakdown.shuttleSatang, 2525);
  assert.equal(odd.amountSatang, 5600); // 5525 ceiled to a whole baht
});

test('perShuttle: with no finished games only the starting fee is charged, even without a price', () => {
  const r = computeCheckoutPreview(input({ shuttlePriceSatang: null }, { startingFeeSatang: 4000 }));
  assert.equal(r.amountSatang, 4000);
  assert.equal(r.games, 0);
  assert.equal(r.breakdown.shuttleSatang, 0);
});

test('perShuttle: games recorded as using none need no price and add nothing', () => {
  const r = computeCheckoutPreview(input({ matches: [game(['p', 'a', 'b', 'c'], [])], shuttlePriceSatang: null }, { startingFeeSatang: 4000 }));
  assert.equal(r.amountSatang, 4000);
  assert.equal(r.games, 1);
});

test('perShuttle: an unknown log in the leaver\'s own game blocks; another player\'s unknown game does not', () => {
  assert.throws(
    () => computeCheckoutPreview(input({ matches: [game(['p', 'a', 'b', 'c'], null)] })),
    (e: unknown) => e instanceof CheckoutBlockedError && e.code === 'UNKNOWN_SHUTTLE_USE'
  );
  const ok = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['x', 'y', 'z', 'w'], null)] })
  );
  assert.equal(ok.breakdown.shuttleSatang, 3000);
});

test('perShuttle: a missing price blocks when use is priced, but a price of zero is valid', () => {
  assert.throws(
    () => computeCheckoutPreview(input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: null })),
    (e: unknown) => e instanceof CheckoutBlockedError && e.code === 'MISSING_SHUTTLE_PRICE'
  );
  const free = computeCheckoutPreview(input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: 0 }, { startingFeeSatang: 2000 }));
  assert.equal(free.amountSatang, 2000);
});

test('perShuttle: a singles game splits the shuttle between two players', () => {
  const r = computeCheckoutPreview(input({ matches: [game(['p', 'a'], ['s1'])], shuttlePriceSatang: 10000 }));
  assert.equal(r.breakdown.shuttleSatang, 5000);
});

test('perGame: entry fee plus rate per finished game, capped, and no shuttle part', () => {
  const matches = [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s1']), game(['p', 'g', 'h', 'i'], ['s2'])];
  const r = computeCheckoutPreview(input({ model: 'perGame', matches }, { entryFeeSatang: 2000, perGameRateSatang: 3000 }));
  assert.equal(r.games, 3);
  assert.equal(r.amountSatang, 11000);
  assert.equal(r.breakdown.shuttleSatang, 0);
  const capped = computeCheckoutPreview(input({ model: 'perGame', matches }, { entryFeeSatang: 2000, perGameRateSatang: 3000, capSatang: 8000 }));
  assert.equal(capped.amountSatang, 8000);
});

test('perGame: zero games still pays the entry fee', () => {
  const r = computeCheckoutPreview(input({ model: 'perGame' }, { entryFeeSatang: 2000, perGameRateSatang: 3000 }));
  assert.equal(r.amountSatang, 2000);
});

test('buffet: shuttles included is just the flat price; excluded adds the recorded shuttle share', () => {
  const matches = [game(['p', 'a', 'b', 'c'], ['s1'])];
  const included = computeCheckoutPreview(input({ model: 'buffet', matches }, { buffetPriceSatang: 8000, buffetShuttlesIncluded: true }));
  assert.equal(included.amountSatang, 8000);
  const excluded = computeCheckoutPreview(input({ model: 'buffet', matches, shuttlePriceSatang: 10000 }, { buffetPriceSatang: 8000, buffetShuttlesIncluded: false }));
  assert.equal(excluded.breakdown.shuttleSatang, 2500);
  assert.equal(excluded.amountSatang, 10500);
});

test('buffet with shuttles excluded needs known use and a price, like perShuttle', () => {
  const cfg = { buffetPriceSatang: 8000, buffetShuttlesIncluded: false };
  assert.throws(() => computeCheckoutPreview(input({ model: 'buffet', matches: [game(['p', 'a', 'b', 'c'], null)] }, cfg)), /unknown/i);
  assert.throws(() => computeCheckoutPreview(input({ model: 'buffet', matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: null }, cfg)), /price/i);
  const included = computeCheckoutPreview(input({ model: 'buffet', matches: [game(['p', 'a', 'b', 'c'], null)], shuttlePriceSatang: null }, { buffetPriceSatang: 8000, buffetShuttlesIncluded: true }));
  assert.equal(included.amountSatang, 8000);
});

test('host fee is added before rounding, and rounding steps up to 5 and 10 baht', () => {
  const matches = [game(['p', 'a', 'b', 'c'], ['s1'])];
  const base = { matches, shuttlePriceSatang: 10100 };
  const one = computeCheckoutPreview(input(base, { startingFeeSatang: 3000, hostFeeSatang: 1000 }));
  assert.equal(one.breakdown.hostFeeSatang, 1000);
  assert.equal(one.amountSatang, 6600); // 3000+2525+1000 = 6525 -> 6600
  const five = computeCheckoutPreview(input(base, { startingFeeSatang: 3000, hostFeeSatang: 1000, roundingBaht: 5 }));
  assert.equal(five.amountSatang, 7000);
  const ten = computeCheckoutPreview(input(base, { startingFeeSatang: 3000, hostFeeSatang: 1000, roundingBaht: 10 }));
  assert.equal(ten.amountSatang, 7000);
});

test('walk-in: the leaver pays the surcharge rounded up to a whole step, with no discount in the receipt', () => {
  const r = computeCheckoutPreview(input({ model: 'perGame', walkInIds: ['p'] }, { entryFeeSatang: 5000, walkInFeeSatang: 1500, roundingBaht: 10 }));
  // fee 1500 rounds up to 2000 at a 10-baht step; base 5000.
  assert.equal(r.breakdown.walkInFeeSatang, 2000);
  assert.equal(r.breakdown.discountSatang, 0);
  assert.equal(r.amountSatang, 7000);
});

test('walk-in: a non-walk-in pays no surcharge, and a zero fee charges nothing', () => {
  const plain = computeCheckoutPreview(input({ model: 'perGame', walkInIds: ['someoneElse'] }, { entryFeeSatang: 5000, walkInFeeSatang: 2000 }));
  assert.equal(plain.breakdown.walkInFeeSatang, 0);
  const none = computeCheckoutPreview(input({ model: 'perGame', walkInIds: ['p'] }, { entryFeeSatang: 5000, walkInFeeSatang: 0 }));
  assert.equal(none.breakdown.walkInFeeSatang, 0);
});

test('an override replaces the amount and bypasses the walk-in surcharge', () => {
  const r = computeCheckoutPreview(
    input({ model: 'perGame', walkInIds: ['p'] }, { entryFeeSatang: 5000, walkInFeeSatang: 2000, overrides: [{ playerId: 'p', amountSatang: 1234 }] })
  );
  assert.equal(r.amountSatang, 1234);
  assert.equal(r.breakdown.walkInFeeSatang, 0);
});

test('credits from earlier leavers reduce the unsettled shuttle cost and exclude settled players', () => {
  const matches = [game(['s', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s1'])];
  const paid = (playerId: string, amountSatang: number) => ({ playerId, amountSatang, walkInFeeSatang: 0, walkInDiscountSatang: 0 });
  // Nominal: 12000 over one id, 6000 per game, 1500 each. Nothing settled: p pays 1500.
  assert.equal(computeCheckoutPreview(input({ matches })).breakdown.shuttleSatang, 1500);
  // One leaver paid exactly their nominal share: nobody else's share moves.
  assert.equal(computeCheckoutPreview(input({ matches, otherSettled: [paid('s', 1500)] })).breakdown.shuttleSatang, 1500);
  // Two leavers paid 3000 each: 12000 - 6000 = 6000 left for the 6 unsettled players -> 1000 each.
  const afterTwo = computeCheckoutPreview(input({ matches, otherSettled: [paid('s', 3000), paid('a', 3000)] }));
  assert.equal(afterTwo.breakdown.shuttleSatang, 1000);
});

test('a leaver whose payments already cover the shuttle cost owes no further shuttle share', () => {
  const matches = [game(['s', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s1'])];
  const r = computeCheckoutPreview(input({ matches, otherSettled: [{ playerId: 's', amountSatang: 20000, walkInFeeSatang: 0, walkInDiscountSatang: 0 }] }, { startingFeeSatang: 3000 }));
  assert.equal(r.breakdown.shuttleSatang, 0);
  assert.equal(r.amountSatang, 3000);
});

test('a settled player\'s own earlier receipt is not double counted if listed again', () => {
  const matches = [game(['p', 'a', 'b', 'c'], ['s1'])];
  const r = computeCheckoutPreview(input({ matches, otherSettled: [{ playerId: 'z', amountSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 0 }] }));
  assert.equal(r.breakdown.shuttleSatang, 3000);
});

test('shares are integer satang that conserve the shuttle cost across the unsettled players', () => {
  const matches = [game(['p', 'a', 'b'], ['s1']), game(['p', 'c', 'd', 'e'], ['s1']), game(['f', 'g', 'h', 'i'], ['s2'])];
  const shares = ['p', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(
    (id) => computeCheckoutPreview(input({ playerId: id, matches, shuttlePriceSatang: 10001 })).breakdown.shuttleSatang
  );
  assert.ok(shares.every((n) => Number.isInteger(n) && n >= 0));
  assert.equal(shares.reduce((a, b) => a + b, 0), 2 * 10001);
});

test('a fair early checkout is not a thing: the model type rejects it at runtime too', () => {
  assert.throws(() => computeCheckoutPreview(input({ model: 'fair' as never })), /model/);
});
