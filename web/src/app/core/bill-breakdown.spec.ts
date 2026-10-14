import { billBreakdown, type BreakdownLine } from './bill-breakdown';
import type { BillConfig, BillRow } from './bill.model';

const config = (over: Partial<BillConfig> = {}): BillConfig => ({
  model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
  entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, startingFeeSatang: 0,
  shuttleCharge: 'shared', perPlayerShuttleSatang: null, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
  addedIds: [], removedIds: [], absentIds: [], overrides: [], ...over,
});

const row = (over: Partial<BillRow> = {}): BillRow => ({
  playerId: 'p', games: 3, status: 'billed', added: false, absent: false, walkIn: false, courtSatang: 0, shuttleSatang: 0,
  baseSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 0, overridden: false, amountSatang: 0, ...over,
});

const sum = (lines: BreakdownLine[]) => lines.reduce((s, l) => s + l.amountSatang, 0);
const kinds = (lines: BreakdownLine[]) => lines.map((l) => l.kind);

describe('billBreakdown', () => {
  it('fair: court share and shuttle share, then host fee, rounding up to the step', () => {
    // 4550 + 3025 + 1000 = 8575 -> ceil to a 5 baht step = 9000
    const r = row({ courtSatang: 4550, shuttleSatang: 3025, baseSatang: 7575, hostFeeSatang: 1000, amountSatang: 9000 });
    const b = billBreakdown(r, config({ courtSplit: 'equal', shuttleSplit: 'byGames', hostFeeSatang: 1000, roundingBaht: 5 }), 8500);
    expect(b.lines).toEqual([
      { kind: 'court', amountSatang: 4550, split: 'equal' },
      { kind: 'shuttle', amountSatang: 3025, split: 'byGames' },
      { kind: 'hostFee', amountSatang: 1000 },
      { kind: 'rounding', amountSatang: 425 },
    ]);
    expect(b.computedSatang).toBe(9000);
    expect(b.overridden).toBe(false);
  });

  it('fair: an absent player shows the equal court share only', () => {
    const r = row({ absent: true, games: 0, courtSatang: 3000, baseSatang: 3000, amountSatang: 3000 });
    const b = billBreakdown(r, config({ courtSplit: 'byGames', hostFeeSatang: 1000 }), 8500);
    expect(b.lines).toEqual([{ kind: 'court', amountSatang: 3000, split: 'equal' }]);
  });

  it('perGame: entry fee plus games times rate', () => {
    const r = row({ games: 3, baseSatang: 6000, amountSatang: 6000 });
    const b = billBreakdown(r, config({ model: 'perGame', entryFeeSatang: 1500, perGameRateSatang: 1500 }), null);
    expect(b.lines).toEqual([
      { kind: 'entry', amountSatang: 1500 },
      { kind: 'games', amountSatang: 4500, count: 3, rateSatang: 1500 },
    ]);
  });

  it('perGame: a hit cap shows as a negative line so the lines still add up', () => {
    // raw 1500 + 4*1500 = 7500, cap 5000
    const r = row({ games: 4, baseSatang: 5000, amountSatang: 5000 });
    const b = billBreakdown(r, config({ model: 'perGame', entryFeeSatang: 1500, perGameRateSatang: 1500, capSatang: 5000 }), null);
    expect(kinds(b.lines)).toEqual(['entry', 'games', 'cap']);
    expect(b.lines[2].amountSatang).toBe(-2500);
    expect(sum(b.lines)).toBe(5000);
  });

  it('perGame: a cap not reached adds no cap line', () => {
    const r = row({ games: 1, baseSatang: 3000, amountSatang: 3000 });
    const b = billBreakdown(r, config({ model: 'perGame', entryFeeSatang: 1500, perGameRateSatang: 1500, capSatang: 5000 }), null);
    expect(kinds(b.lines)).toEqual(['entry', 'games']);
  });

  it('perGame: no entry fee leaves out the entry line', () => {
    const r = row({ games: 2, baseSatang: 3000, amountSatang: 3000 });
    const b = billBreakdown(r, config({ model: 'perGame', perGameRateSatang: 1500 }), null);
    expect(kinds(b.lines)).toEqual(['games']);
  });

  it('perShuttle shared: starting fee plus the shared shuttle share', () => {
    const r = row({ shuttleSatang: 2125, baseSatang: 5125, amountSatang: 5200 });
    const b = billBreakdown(r, config({ model: 'perShuttle', startingFeeSatang: 3000, shuttleCharge: 'shared' }), 8500);
    expect(b.lines).toEqual([
      { kind: 'startingFee', amountSatang: 3000 },
      { kind: 'shuttle', amountSatang: 2125, split: 'shared' },
      { kind: 'rounding', amountSatang: 75 },
    ]);
  });

  it('perShuttle full: shows how many shuttles at the per-player rate', () => {
    const r = row({ shuttleSatang: 3000, baseSatang: 6000, amountSatang: 6000 });
    const b = billBreakdown(r, config({ model: 'perShuttle', startingFeeSatang: 3000, shuttleCharge: 'full', perPlayerShuttleSatang: 1000 }), 8500);
    expect(b.lines).toEqual([
      { kind: 'startingFee', amountSatang: 3000 },
      { kind: 'shuttle', amountSatang: 3000, count: 3, rateSatang: 1000 },
    ]);
  });

  it('perShuttle full: a blank per-player rate falls back to the session shuttle price', () => {
    const r = row({ shuttleSatang: 17000, baseSatang: 17000, amountSatang: 17000 });
    const b = billBreakdown(r, config({ model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: null }), 8500);
    expect(b.lines).toEqual([{ kind: 'shuttle', amountSatang: 17000, count: 2, rateSatang: 8500 }]);
  });

  it('buffet with shuttles included: the buffet price only', () => {
    const r = row({ baseSatang: 12000, amountSatang: 12000 });
    const b = billBreakdown(r, config({ model: 'buffet', buffetPriceSatang: 12000, buffetShuttlesIncluded: true }), 8500);
    expect(b.lines).toEqual([{ kind: 'buffet', amountSatang: 12000 }]);
  });

  it('buffet with shuttles separate: buffet price plus shuttle share', () => {
    const r = row({ shuttleSatang: 2000, baseSatang: 14000, amountSatang: 14000 });
    const b = billBreakdown(r, config({ model: 'buffet', buffetPriceSatang: 12000, buffetShuttlesIncluded: false, shuttleSplit: 'equal' }), 8500);
    expect(b.lines).toEqual([
      { kind: 'buffet', amountSatang: 12000 },
      { kind: 'shuttle', amountSatang: 2000, split: 'equal' },
    ]);
  });

  it('a walk-in shows the fee charged and the discount handed back', () => {
    // base 8000, rounded 8000, + fee 2000 - discount 500
    const r = row({ courtSatang: 8000, baseSatang: 8000, walkIn: true, walkInFeeSatang: 2000, walkInDiscountSatang: 500, amountSatang: 9500 });
    const b = billBreakdown(r, config({ walkInFeeSatang: 2000 }), null);
    expect(b.lines.slice(-2)).toEqual([
      { kind: 'walkInFee', amountSatang: 2000 },
      { kind: 'walkInDiscount', amountSatang: -500 },
    ]);
    expect(b.computedSatang).toBe(9500);
  });

  it('a regular player with a discount shows the discount only', () => {
    const r = row({ courtSatang: 8000, baseSatang: 8000, walkInDiscountSatang: 500, amountSatang: 7500 });
    const b = billBreakdown(r, config(), null);
    expect(kinds(b.lines)).toEqual(['court', 'walkInDiscount']);
  });

  it('an override keeps the computed lines and flags the row', () => {
    const r = row({ courtSatang: 8000, baseSatang: 8000, overridden: true, amountSatang: 5000 });
    const b = billBreakdown(r, config(), null);
    expect(b.overridden).toBe(true);
    expect(b.computedSatang).toBe(8000);
    expect(b.lines).toEqual([{ kind: 'court', amountSatang: 8000, split: 'equal' }]);
  });

  it('a removed row has nothing to explain', () => {
    const b = billBreakdown(row({ status: 'removed' }), config(), null);
    expect(b.lines).toEqual([]);
    expect(b.computedSatang).toBe(0);
  });
});
