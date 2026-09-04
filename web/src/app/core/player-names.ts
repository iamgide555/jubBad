import type { Player } from '../../../../engines/fuzzy-match.ts';

export function resolvePlayerNames(ids: string[], players: Player[]): string[] {
  const byId = new Map(players.map((p) => [p.id, p.name]));
  return ids.map((id) => byId.get(id) ?? id);
}
