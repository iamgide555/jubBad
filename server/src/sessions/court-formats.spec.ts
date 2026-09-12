import { describe, expect, it } from 'vitest';
import { formatAt, parseCourtFormats, withFormatAt } from './court-formats.js';

describe('parseCourtFormats', () => {
  it('reads a null column as no entries', () => {
    expect(parseCourtFormats(null)).toEqual([]);
  });

  it('reads a malformed value as no entries rather than throwing', () => {
    expect(parseCourtFormats('not json')).toEqual([]);
    expect(parseCourtFormats('"a string"')).toEqual([]);
  });

  it('normalises an unrecognised entry to doubles', () => {
    expect(parseCourtFormats('["singles","garbage",42]')).toEqual(['singles', 'doubles', 'doubles']);
  });
});

describe('formatAt', () => {
  it('defaults to doubles for a null column', () => {
    expect(formatAt(null, 1)).toBe('doubles');
  });

  it('defaults to doubles past the end of a short array', () => {
    expect(formatAt('["singles"]', 3)).toBe('doubles');
  });

  it('reads the entry for the requested court', () => {
    expect(formatAt('["doubles","singles"]', 2)).toBe('singles');
  });
});

describe('withFormatAt', () => {
  it('pads gaps with doubles, never with the new value', () => {
    const result = withFormatAt(null, 3, 'singles');
    expect(JSON.parse(result)).toEqual(['doubles', 'doubles', 'singles']);
  });

  it('preserves an existing entry when setting another court', () => {
    const withCourt2 = withFormatAt(null, 2, 'singles');
    const withCourt1Too = withFormatAt(withCourt2, 1, 'singles');
    expect(JSON.parse(withCourt1Too)).toEqual(['singles', 'singles']);
  });

  it('overwrites an existing entry for the same court', () => {
    const set = withFormatAt('["singles"]', 1, 'doubles');
    expect(JSON.parse(set)).toEqual(['doubles']);
  });

  it('never writes more than 20 entries, even from an already-long array', () => {
    const bloated = JSON.stringify(Array(25).fill('doubles'));
    const result = withFormatAt(bloated, 1, 'singles');
    expect(JSON.parse(result)).toHaveLength(20);
  });
});
