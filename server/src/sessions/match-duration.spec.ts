import { describe, expect, it } from 'vitest';
import { averageRecordedSeconds, estimateAtClosure, matchDuration, type DurationRow } from './match-duration.js';

const row = (seconds: number): DurationRow => ({
  confirmedAt: new Date(0), endedAt: new Date(seconds * 1000),
  closedWithoutResultAt: null, estimatedDurationSeconds: null,
});

describe('recovery durations', () => {
  it('averages only positive measured completed games', () => {
    expect(averageRecordedSeconds([
      row(600), row(1200), row(0), row(-1),
      { ...row(86400), closedWithoutResultAt: new Date(), estimatedDurationSeconds: 900 },
      { ...row(60), endedAt: null },
      { ...row(60), confirmedAt: null },
    ])).toBe(900);
  });
  it('returns unknown without a sample', () => {
    expect(averageRecordedSeconds([row(0)])).toBeNull();
    expect(matchDuration({ ...row(86400), closedWithoutResultAt: new Date() }))
      .toEqual({ seconds: null, source: 'unknown' });
  });
  it('caps an estimate to the possible elapsed time', () => {
    expect(estimateAtClosure({ ...row(60), endedAt: null }, 900, new Date(60_000))).toBe(60);
    expect(estimateAtClosure({ ...row(60), endedAt: null }, null, new Date(60_000))).toBeNull();
    expect(estimateAtClosure({ ...row(60), confirmedAt: new Date(120_000) }, 900, new Date(60_000))).toBe(0);
  });
  it('uses estimates without pretending the end timestamp was measured', () => {
    expect(matchDuration({ ...row(86400), closedWithoutResultAt: new Date(), estimatedDurationSeconds: 900 }))
      .toEqual({ seconds: 900, source: 'estimated' });
    expect(matchDuration(row(600))).toEqual({ seconds: 600, source: 'recorded' });
  });
  it('rounds the mean once rather than each sample', () => {
    expect(averageRecordedSeconds([row(1.4), row(1.4), row(1.8)])).toBe(2);
  });
});
