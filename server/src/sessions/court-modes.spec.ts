import { describe, expect, it } from 'vitest';
import {
  InvalidCourtNumberError,
  modeAt,
  parseCourtModes,
  withModeAt,
} from './court-modes.js';

describe('parseCourtModes', () => {
  it('reads a null column as no entries', () => {
    expect(parseCourtModes(null)).toEqual([]);
  });

  it('reads a malformed value as no entries rather than throwing', () => {
    expect(parseCourtModes('not json')).toEqual([]);
  });

  it('normalises an unrecognised entry to custom', () => {
    expect(parseCourtModes('["level","garbage",42]')).toEqual(['level', 'custom', 'custom']);
  });
});

describe('modeAt', () => {
  it('defaults to custom for a null column', () => {
    expect(modeAt(null, 1)).toBe('custom');
  });

  it('defaults to custom past the end of a short array', () => {
    expect(modeAt('["level"]', 3)).toBe('custom');
  });

  it('reads the entry for the requested court', () => {
    expect(modeAt('["variety","level"]', 2)).toBe('level');
  });
});

describe('withModeAt', () => {
  it('pads gaps with custom, never with the new value', () => {
    const result = withModeAt(null, 3, 'level');
    expect(JSON.parse(result)).toEqual(['custom', 'custom', 'level']);
  });

  it('preserves an existing entry when setting another court', () => {
    const withCourt2 = withModeAt(null, 2, 'level');
    const withCourt1Too = withModeAt(withCourt2, 1, 'variety');
    expect(JSON.parse(withCourt1Too)).toEqual(['variety', 'level']);
  });

  it('overwrites an existing entry for the same court', () => {
    const set = withModeAt('["level"]', 1, 'balanced');
    expect(JSON.parse(set)).toEqual(['balanced']);
  });

  it('throws rather than silently dropping a write for a court beyond the maximum', () => {
    expect(() => withModeAt(null, 25, 'level')).toThrow(InvalidCourtNumberError);
  });
});
