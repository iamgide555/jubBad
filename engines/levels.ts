/**
 * Skill level (ระดับมือ), the letter grade Thai groups already use to
 * describe a player. There is no single authoritative standard (regions and
 * apps disagree — see docs/superpowers/specs, C1's research), so the built-in
 * list and its order are the app's own working standard: Elo corrects any
 * misplacement as results accumulate.
 *
 * A group may instead define its own ordered ladder (host feedback F). Every
 * helper here takes the ladder explicitly and defaults to the built-in one, so
 * nothing reads a process-global list and an ordinary group is unchanged.
 */
export const LEVELS = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'] as const;

/** A level's name. Names are free text in a custom ladder, so this is no longer a closed union. */
export type Level = string;

/** One rung: its display name and the Elo a player tagged with it starts from. */
export interface LevelSpec {
  name: string;
  startingElo: number;
}

/**
 * The built-in ladder: 100 points apart from 900 (BG) up to 1600 (B). A
 * 100-point gap is about a 64% expected win — enough to seed balanced mode
 * sensibly without a placement being unrecoverable if it's wrong.
 */
export const DEFAULT_LEVEL_LADDER: readonly LevelSpec[] = LEVELS.map((name, i) => ({
  name,
  startingElo: 900 + 100 * i,
}));

/** The rating an untagged player starts at, same as before levels existed. */
const UNTAGGED_SEED = 1200;
const MAX_LEVELS = 16;
const MAX_NAME_CODE_POINTS = 16;
const MAX_SEED = 2147483647; // fits the database INTEGER column

export function isLevel(value: string, ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER): value is Level {
  return ladder.some((l) => l.name === value);
}

/** Parses a DB or DTO value into a Level, or null for anything else — never throws. */
export function asLevel(
  value: string | null | undefined,
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER
): Level | null {
  return typeof value === 'string' && isLevel(value, ladder) ? value : null;
}

/** Position in the ladder. A name the ladder does not contain is a bug upstream, so it throws rather than answering -1. */
export function levelIndex(level: Level, ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER): number {
  const index = ladder.findIndex((l) => l.name === level);
  if (index === -1) throw new Error(`unknown level "${level}" for this ladder`);
  return index;
}

/** Elo seed for a level. Unknown (null) seeds at the plain starting rating. */
export function seedFor(level: Level | null, ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER): number {
  if (level === null) return UNTAGGED_SEED;
  return ladder[levelIndex(level, ladder)].startingElo;
}

/**
 * Whether two levels are close enough to share a court under the ±1 band.
 * An unknown level (null) fits any level — a group can turn the band on
 * before everyone is tagged without locking untagged players out of courts.
 */
export function withinBand(
  a: Level | null,
  b: Level | null,
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER
): boolean {
  if (a === null || b === null) return true;
  return Math.abs(levelIndex(a, ladder) - levelIndex(b, ladder)) <= 1;
}

/**
 * Whether `id` is far enough below tonight's active roster to trigger a
 * carry game (see docs/archive/specs/2026-09-27-level-rework-design.md,
 * section 1b): tagged, fewer than 4 active players (self included) within
 * ±1 of them, and every other tagged player outside that band is above
 * them. An untagged player never qualifies, and — following the same
 * convention as `withinBand` — never counts toward "in band" or "above"
 * for anyone else.
 */
export function isFarBelow(
  id: string,
  activeLevels: ReadonlyMap<string, Level | null>,
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER
): boolean {
  const level = activeLevels.get(id) ?? null;
  if (level === null) return false;

  let inBand = 0;
  for (const [otherId, otherLevel] of activeLevels) {
    if (otherId === id || otherLevel === null) continue;
    if (withinBand(level, otherLevel, ladder)) {
      inBand += 1;
    } else if (levelIndex(otherLevel, ladder) <= levelIndex(level, ladder)) {
      // Another tagged player sits at or below `id`, outside their band —
      // `id` is not at the bottom of the group, so this is never a carry case.
      return false;
    }
  }
  return inBand + 1 < 4; // +1 counts `id` itself.
}

const codePoints = (s: string): number => [...s].length;
// Case-folded so "bg" and "BG" collide; NFC so a composed and a decomposed spelling do too.
const foldName = (s: string): string => s.normalize('NFC').toLowerCase();

/**
 * Throws a message a host can act on if a custom ladder is unusable: 1–16
 * levels, trimmed non-empty names of at most 16 code points with no control
 * characters and no case-insensitive duplicates, and whole-number seeds that
 * strictly increase (the order IS the ranking, so a tie or reversal would make
 * two levels indistinguishable to the rating).
 */
export function validateLevelSpecs(levels: readonly LevelSpec[]): void {
  if (levels.length < 1 || levels.length > MAX_LEVELS) {
    throw new Error(`a ladder needs 1 to ${MAX_LEVELS} levels, got ${levels.length}`);
  }
  const seen = new Set<string>();
  let previous = -Infinity;
  for (const [i, level] of levels.entries()) {
    const label = `level ${i + 1}`;
    if (typeof level.name !== 'string' || level.name === '' || level.name !== level.name.trim()) {
      throw new Error(`${label}: name must be non-empty and have no leading or trailing spaces`);
    }
    if (/\p{Cc}/u.test(level.name)) throw new Error(`${label}: name must not contain control characters`);
    if (codePoints(level.name) > MAX_NAME_CODE_POINTS) {
      throw new Error(`${label}: name must be at most ${MAX_NAME_CODE_POINTS} characters`);
    }
    const folded = foldName(level.name);
    if (seen.has(folded)) throw new Error(`${label}: names must be unique (duplicate "${level.name}")`);
    seen.add(folded);
    if (!Number.isInteger(level.startingElo) || level.startingElo < 0 || level.startingElo > MAX_SEED) {
      throw new Error(`${label}: starting Elo must be a whole number from 0 to ${MAX_SEED}`);
    }
    if (level.startingElo <= previous) {
      throw new Error(`${label}: starting Elo must be higher than the level before it`);
    }
    previous = level.startingElo;
  }
}

/**
 * Suggested seeds for a new ladder: 100 apart, centred on 1200 (one level is
 * 1200, three are 1100/1200/1300, an even count uses 50-point offsets so
 * neighbours stay 100 apart). The host may override every one.
 */
export function centeredLevelSpecs(names: readonly string[]): LevelSpec[] {
  const middle = (names.length - 1) / 2;
  return names.map((name, i) => ({ name, startingElo: UNTAGGED_SEED + Math.round((i - middle) * 100) }));
}

/**
 * A court's target for tonight: 'low' and 'high' aim it at one half of the
 * roster, 'auto' leaves it to the ordinary ±1 band.
 */
export const COURT_TARGETS = ['auto', 'low', 'high'] as const;
export type CourtTarget = (typeof COURT_TARGETS)[number];

export function isCourtTarget(value: unknown): value is CourtTarget {
  return typeof value === 'string' && (COURT_TARGETS as readonly string[]).includes(value);
}

/**
 * Which half of tonight's roster each tagged player is in, for per-court
 * Low/High targets. The cut is relative to who actually turned up, not to the
 * ladder: a group that is all P- to P+ would otherwise land entirely in one
 * half of the ladder and a target would do nothing.
 *
 * The cut is the rung that leaves the two sides closest in headcount
 * (Low = strictly below it, High = at or above it), so a group of five
 * beginners and one pro splits 5/1 instead of everyone landing in High. On a
 * tie the lower cut wins, making High the larger side. Untagged players and
 * anyone off the roster are left out (they fit either half). Fewer than two
 * distinct tagged levels is no split at all: an empty map, and every target
 * then does nothing.
 */
export function splitTonight(
  levels: ReadonlyMap<string, Level | null>,
  rosterIds: readonly string[],
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER
): Map<string, 'low' | 'high'> {
  const tagged: { id: string; index: number }[] = [];
  for (const id of rosterIds) {
    const level = levels.get(id) ?? null;
    if (level !== null) tagged.push({ id, index: levelIndex(level, ladder) });
  }
  const distinct = [...new Set(tagged.map((t) => t.index))].sort((a, b) => a - b);
  const split = new Map<string, 'low' | 'high'>();
  if (distinct.length < 2) return split;

  let cut = distinct[1];
  let bestGap = Infinity;
  for (const candidate of distinct.slice(1)) {
    const below = tagged.filter((t) => t.index < candidate).length;
    const gap = Math.abs(tagged.length - 2 * below);
    if (gap < bestGap) {
      bestGap = gap;
      cut = candidate;
    }
  }
  for (const t of tagged) split.set(t.id, t.index < cut ? 'low' : 'high');
  return split;
}
