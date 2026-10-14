export interface DurationRow {
  confirmedAt: Date | null;
  endedAt: Date | null;
  closedWithoutResultAt: Date | null;
  estimatedDurationSeconds: number | null;
}
export function matchDuration(row: DurationRow): {
  seconds: number | null; source: 'recorded' | 'estimated' | 'unknown';
} {
  if (row.closedWithoutResultAt !== null) return row.estimatedDurationSeconds === null
    ? { seconds: null, source: 'unknown' }
    : { seconds: row.estimatedDurationSeconds, source: 'estimated' };
  if (row.confirmedAt === null || row.endedAt === null) return { seconds: null, source: 'unknown' };
  return { seconds: Math.max(0, Math.round((+row.endedAt - +row.confirmedAt) / 1000)), source: 'recorded' };
}
export function averageRecordedSeconds(rows: readonly DurationRow[]): number | null {
  const samples = rows.filter(r => r.closedWithoutResultAt === null && r.confirmedAt !== null
    && r.endedAt !== null && +r.endedAt > +r.confirmedAt)
    .map(r => (+r.endedAt! - +r.confirmedAt!) / 1000);
  return samples.length ? Math.round(samples.reduce((sum, s) => sum + s, 0) / samples.length) : null;
}
export function estimateAtClosure(row: DurationRow, average: number | null, now: Date): number | null {
  if (average === null || row.confirmedAt === null) return null;
  return Math.min(average, Math.max(0, Math.floor((+now - +row.confirmedAt) / 1000)));
}
