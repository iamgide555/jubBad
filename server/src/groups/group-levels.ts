/**
 * The only place Group.levelLadder is parsed or written (host feedback F).
 *
 * A group either uses the built-in ladder (the column is null) or its own
 * ordered list of { id, name, startingElo }. The id is what keeps a level the
 * same level across a rename or reorder, so a save can tell "renamed" from
 * "removed and a different one added".
 *
 * Unlike most JSON columns in this codebase, a corrupt value is NOT quietly
 * replaced by a default: reading garbage as "the standard ladder" would
 * relabel a whole group's players, so it throws and the caller reports it.
 */
import { DEFAULT_LEVEL_LADDER, validateLevelSpecs, type LevelSpec } from '../../../engines/levels.ts';

export interface StoredLevel extends LevelSpec {
  id: string;
}

export interface GroupLadder {
  mode: 'standard' | 'custom';
  levels: readonly StoredLevel[];
}

export class LevelLadderCorruptError extends Error {
  readonly code = 'LEVEL_LADDER_CORRUPT';
  constructor(detail: string) {
    super(`stored level ladder is corrupt: ${detail}`);
    this.name = 'LevelLadderCorruptError';
  }
}

/** The built-in ladder with deterministic ids, so callers can treat standard and custom alike. */
export const STANDARD_STORED_LEVELS: readonly StoredLevel[] = DEFAULT_LEVEL_LADDER.map((l) => ({
  id: `standard:${l.name}`,
  name: l.name,
  startingElo: l.startingElo,
}));

function checkIds(levels: readonly StoredLevel[]): void {
  const seen = new Set<string>();
  for (const l of levels) {
    if (typeof l.id !== 'string' || l.id === '') throw new Error('every level needs an id');
    if (seen.has(l.id)) throw new Error(`duplicate level id "${l.id}"`);
    seen.add(l.id);
  }
}

export function parseGroupLadder(raw: string | null): GroupLadder {
  if (raw === null) return { mode: 'standard', levels: STANDARD_STORED_LEVELS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LevelLadderCorruptError('not valid JSON');
  }
  if (!Array.isArray(value)) throw new LevelLadderCorruptError('not a list');
  const levels = value.map((v) => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return { id: o['id'], name: o['name'], startingElo: o['startingElo'] } as StoredLevel;
  });
  try {
    checkIds(levels);
    validateLevelSpecs(levels);
  } catch (e) {
    throw new LevelLadderCorruptError((e as Error).message);
  }
  return { mode: 'custom', levels };
}

/** Validates, then serializes. Throws on anything the parser would refuse to read back. */
export function serializeGroupLadder(levels: readonly StoredLevel[]): string {
  checkIds(levels);
  validateLevelSpecs(levels);
  return JSON.stringify(levels.map((l) => ({ id: l.id, name: l.name, startingElo: l.startingElo })));
}
