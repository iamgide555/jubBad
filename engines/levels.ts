/**
 * Skill level (ระดับมือ), the letter grade Thai groups already use to
 * describe a player. There is no single authoritative standard (regions and
 * apps disagree — see docs/superpowers/specs, C1's research), so this list
 * and its order are the app's own working standard: Elo corrects any
 * misplacement as results accumulate.
 */
export const LEVELS = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'] as const;

export type Level = (typeof LEVELS)[number];

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** Parses a DB or DTO value into a Level, or null for anything else — never throws. */
export function asLevel(value: string | null | undefined): Level | null {
  return typeof value === 'string' && isLevel(value) ? value : null;
}

export function levelIndex(level: Level): number {
  return LEVELS.indexOf(level);
}

/**
 * Elo seed for a level, 100 points apart starting at 900 (BG) up to 1600 (B).
 * A 100-point gap is about a 64% expected win — enough to seed balanced mode
 * sensibly without a placement being unrecoverable if it's wrong. Unknown
 * (null) seeds at the plain starting rating, same as before this feature.
 */
export function seedFor(level: Level | null): number {
  if (level === null) return 1200;
  return 900 + 100 * levelIndex(level);
}

/**
 * Whether two levels are close enough to share a court under the ±1 band.
 * An unknown level (null) fits any level — a group can turn the band on
 * before everyone is tagged without locking untagged players out of courts.
 */
export function withinBand(a: Level | null, b: Level | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(levelIndex(a) - levelIndex(b)) <= 1;
}
