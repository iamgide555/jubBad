/**
 * How long a game has run or ran, derived rather than stored: the server
 * only ever persists `Pairing.confirmedAt` (start) and `endedAt` (end), so
 * every duration shown here is `endedAt - confirmedAt` (or, for a still-active
 * court, `now - confirmedAt`).
 *
 * Elapsed time is always "latest confirm → latest finish" — undoing a finish
 * resumes the same timer rather than starting a new one, and undoing a
 * confirm clears it entirely. There is no cumulative history and no pause
 * concept: a host who re-confirms after an undo gets a fresh start time.
 */

/** Seconds since `startedAt`, clamped to 0 for a clock-skewed future start. */
export function elapsedSeconds(startedAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

/**
 * Stopwatch format for a live, ticking court — "0:47", "12:07", "72:14".
 * Keeps counting minutes past 60 rather than rolling into hours: a badminton
 * game running that long almost always means a score was never submitted,
 * and an escalating minute count is the clearest signal of exactly that.
 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Whole-minutes format for a finished game — "12 น.", or "2 ชม. 17 น." once
 * the total crosses an hour (a per-player session total, not a single game).
 * Floors rather than rounds, so this never claims more court time than
 * actually elapsed.
 */
export function formatMinutes(totalSeconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return $localize`:@@duration.minutesShort:${minutes}:minutes: น.`;
  }
  return $localize`:@@duration.hoursMinutes:${hours}:hours: ชม. ${minutes}:minutes: น.`;
}
