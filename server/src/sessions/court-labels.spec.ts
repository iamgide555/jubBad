import { describe, expect, it } from 'vitest';
import {
  editableCourtCount,
  hasDuplicateCourtLabels,
  normalizeCourtLabel,
  parseCourtLabels,
  withLabelAt,
} from './court-labels.js';

describe('parseCourtLabels', () => {
  it('reads null, malformed JSON, and non-array JSON as no labels', () => {
    expect(parseCourtLabels(null)).toEqual([]);
    expect(parseCourtLabels('not json')).toEqual([]);
    expect(parseCourtLabels('{"1":"A"}')).toEqual([]);
  });

  it('reads invalid array entries as unset', () => {
    expect(parseCourtLabels('["A", 3, null, "", {"x":1}, "B"]')).toEqual(['A', null, null, null, null, 'B']);
  });
});

describe('normalizeCourtLabel', () => {
  it('trims and normalizes to NFC', () => {
    const decomposed = 'Cafe\u0301';
    expect(normalizeCourtLabel(`  ${decomposed}  `)).toBe('Caf\u00e9');
    expect(normalizeCourtLabel('  โซนหน้า ')).toBe('โซนหน้า');
  });

  it('reads blank input as a reset', () => {
    expect(normalizeCourtLabel('')).toBeNull();
    expect(normalizeCourtLabel('   ')).toBeNull();
  });
});

describe('withLabelAt', () => {
  it('writes one slot, preserving others and padding gaps with null', () => {
    expect(JSON.parse(withLabelAt('["A"]', 3, 'C'))).toEqual(['A', null, 'C']);
  });

  it('clears a slot with null', () => {
    expect(JSON.parse(withLabelAt('["A","B"]', 1, null))).toEqual([null, 'B']);
  });

  it('recovers from a malformed column', () => {
    expect(JSON.parse(withLabelAt('{"1":"A"}', 2, 'B'))).toEqual([null, 'B']);
  });
});

describe('editableCourtCount', () => {
  it('is the current court count with nothing else', () => {
    expect(editableCourtCount(2, [], [])).toBe(2);
    expect(editableCourtCount(null, [], [])).toBe(0);
  });

  it('includes a retired court that has a pairing', () => {
    expect(editableCourtCount(2, [{ courtNumber: 3 }], [])).toBe(3);
  });

  it('includes a retired court with a non-null override, but not null padding', () => {
    expect(editableCourtCount(1, [], [null, null, 'C'])).toBe(3);
    expect(editableCourtCount(1, [], ['A', null, null, null])).toBe(1);
  });
});

describe('hasDuplicateCourtLabels', () => {
  it('detects case-only duplicates', () => {
    expect(hasDuplicateCourtLabels(['A', 'a'], 2)).toBe(true);
  });

  it('detects composed/decomposed duplicates', () => {
    expect(hasDuplicateCourtLabels(['Caf\u00e9', 'Cafe\u0301'], 2)).toBe(true);
  });

  it('detects a custom label colliding with another court default', () => {
    expect(hasDuplicateCourtLabels(['2', null], 2)).toBe(true);
  });

  it('only checks slots within count', () => {
    expect(hasDuplicateCourtLabels(['3', null], 2)).toBe(false);
    expect(hasDuplicateCourtLabels(['3', null], 3)).toBe(true);
  });

  it('accepts distinct names and defaults', () => {
    expect(hasDuplicateCourtLabels(['A', null, 'C'], 3)).toBe(false);
  });
});
