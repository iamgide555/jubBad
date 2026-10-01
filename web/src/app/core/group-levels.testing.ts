import type { GroupLevelsResponse } from './group-levels.model';

/** Test-only: the standard ladder as the owner route returns it. */
export function standardLadderFixture(over: Partial<GroupLevelsResponse> = {}): GroupLevelsResponse {
  const names = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
  return {
    mode: 'standard',
    revision: 0,
    levels: names.map((name, i) => ({ id: `standard:${name}`, name, startingElo: 900 + 100 * i })),
    assignedCounts: Object.fromEntries(names.map((n) => [`standard:${n}`, 0])),
    ...over,
  };
}
