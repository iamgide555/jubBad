import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { parseBillConfig, sanitizeForRoster, serializeBillConfig, withoutPerPerson } from './bill-config.js';

describe('bill-config', () => {
  it('null and malformed read as null', () => {
    expect(parseBillConfig(null)).toBeNull();
    expect(parseBillConfig('{not json')).toBeNull();
    expect(parseBillConfig('[1,2]')).toBeNull();
  });

  it('round-trips a full config', () => {
    const c = { ...DEFAULT_BILL_CONFIG, model: 'perGame' as const, perGameRateSatang: 5000, addedIds: ['x'] };
    expect(parseBillConfig(serializeBillConfig(c))).toEqual(c);
  });

  it('fills missing and invalid fields from the defaults', () => {
    const c = parseBillConfig(JSON.stringify({ model: 'buffet', hostFeeSatang: -5, roundingBaht: 3, capSatang: 100 }));
    expect(c).toEqual({ ...DEFAULT_BILL_CONFIG, model: 'buffet', capSatang: 100 });
  });

  it('drops invalid overrides and non-string ids', () => {
    const c = parseBillConfig(
      JSON.stringify({ addedIds: ['a', 3], overrides: [{ playerId: 'a', amountSatang: 100 }, { playerId: 'b', amountSatang: -1 }] })
    );
    expect(c!.addedIds).toEqual(['a']);
    expect(c!.overrides).toEqual([{ playerId: 'a', amountSatang: 100 }]);
  });

  it('withoutPerPerson clears added, removed and overrides only', () => {
    const c = { ...DEFAULT_BILL_CONFIG, hostFeeSatang: 1000, addedIds: ['a'], removedIds: ['b'], overrides: [{ playerId: 'c', amountSatang: 0 }] };
    expect(withoutPerPerson(c)).toEqual({ ...DEFAULT_BILL_CONFIG, hostFeeSatang: 1000 });
  });

  it('sanitizeForRoster drops ids not on the roster', () => {
    const c = { ...DEFAULT_BILL_CONFIG, addedIds: ['a', 'gone'], removedIds: ['gone'], overrides: [{ playerId: 'gone', amountSatang: 1 }] };
    expect(sanitizeForRoster(c, ['a'])).toEqual({ ...DEFAULT_BILL_CONFIG, addedIds: ['a'] });
  });
});
