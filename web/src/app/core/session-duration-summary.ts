export function durationSummary(
  matches: readonly {
    durationSeconds: number | null;
    durationSource?: 'recorded' | 'estimated' | 'unknown';
  }[],
) {
  const result = {
    totalSeconds: 0,
    measuredTotalSeconds: 0,
    measuredMatchCount: 0,
    estimatedMatchCount: 0,
    unknownDurationMatchCount: 0,
  };
  for (const m of matches) {
    const source = m.durationSource ?? (m.durationSeconds === null ? 'unknown' : 'recorded');
    if (m.durationSeconds !== null) result.totalSeconds += m.durationSeconds;
    if (source === 'recorded' && m.durationSeconds !== null) {
      result.measuredTotalSeconds += m.durationSeconds;
      result.measuredMatchCount++;
    } else if (source === 'estimated') result.estimatedMatchCount++;
    else result.unknownDurationMatchCount++;
  }
  return result;
}
