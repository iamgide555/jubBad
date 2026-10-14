import { expect, it } from 'vitest';
import { durationSummary } from './session-duration-summary';
it('does not mix estimates or unknown games into measured averages', () => {
  expect(
    durationSummary([
      { durationSeconds: 600, durationSource: 'recorded' },
      { durationSeconds: 900, durationSource: 'estimated' },
      { durationSeconds: null, durationSource: 'unknown' },
    ]),
  ).toEqual({
    totalSeconds: 1500,
    measuredTotalSeconds: 600,
    measuredMatchCount: 1,
    estimatedMatchCount: 1,
    unknownDurationMatchCount: 1,
  });
});
