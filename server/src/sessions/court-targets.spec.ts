import { describe, expect, it } from 'vitest';
import { InvalidCourtNumberError, parseCourtTargets, targetAt, withTargetAt } from './court-targets.js';

describe('parseCourtTargets', () => {
  it('reads a null column as no entries', () => {
    expect(parseCourtTargets(null)).toEqual([]);
  });

  it('reads a malformed or non-array value as no entries rather than throwing', () => {
    expect(parseCourtTargets('not json')).toEqual([]);
    expect(parseCourtTargets('{"1":"low"}')).toEqual([]);
  });

  it('normalises an unrecognised entry to auto', () => {
    expect(parseCourtTargets('["low","garbage",42,"high"]')).toEqual(['low', 'auto', 'auto', 'high']);
  });
});

describe('targetAt', () => {
  it('defaults to auto when unset or out of range', () => {
    expect(targetAt(null, 1)).toBe('auto');
    expect(targetAt('["high"]', 2)).toBe('auto');
    expect(targetAt('["high"]', 1)).toBe('high');
  });
});

describe('withTargetAt', () => {
  it('pads any gap before the court with auto', () => {
    expect(JSON.parse(withTargetAt(null, 3, 'low'))).toEqual(['auto', 'auto', 'low']);
  });

  it('replaces one court and keeps the others', () => {
    expect(JSON.parse(withTargetAt('["low","high"]', 1, 'auto'))).toEqual(['auto', 'high']);
  });

  it('throws beyond the 20-court cap instead of truncating silently', () => {
    expect(() => withTargetAt(null, 21, 'low')).toThrow(InvalidCourtNumberError);
  });
});
