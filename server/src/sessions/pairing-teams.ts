/**
 * Parses `Pairing.teamA`/`teamB` — JSON-encoded string arrays in TEXT columns,
 * since SQLite has no array type (same convention as `Player.aliases`).
 *
 * Nothing in SQL or in any DTO constrains a team's length: a doubles row has
 * two players, a singles row has one, and the column itself cannot tell you
 * which. Every reader used to bake in `as [string, string]` — a cast the
 * compiler cannot check and a singles row makes false, producing `undefined`
 * silently rather than an error (see the corrupt-state comment on
 * `CorruptPairingError` below). Parsing through this module instead makes
 * "not a valid team" a loud, typed failure the moment a row is read, and
 * makes every call site's length ambiguity structurally impossible: a team is
 * whatever length it actually is, and code that assumes two must say so.
 */
export class CorruptPairingError extends Error {
  readonly code = 'INVALID_SESSION_STATE';

  constructor(message: string) {
    super(message);
    this.name = 'CorruptPairingError';
  }
}

/** A team is 1 player (singles) or 2 (doubles). */
export function parseTeam(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CorruptPairingError(`pairing team is not valid JSON: ${raw}`);
  }
  if (
    !Array.isArray(value) ||
    (value.length !== 1 && value.length !== 2) ||
    value.some((id) => typeof id !== 'string')
  ) {
    throw new CorruptPairingError(`pairing team is not a 1- or 2-player id array: ${raw}`);
  }
  return value;
}

/**
 * Both teams on a court are always the same size — this is what makes
 * `teamA.length` a sufficient, self-consistent discriminator for a match's
 * format everywhere else in the service, rather than a stored (and
 * driftable) marker on the row.
 */
export function parseTeams(pairing: { teamA: string; teamB: string }): {
  teamA: string[];
  teamB: string[];
} {
  const teamA = parseTeam(pairing.teamA);
  const teamB = parseTeam(pairing.teamB);
  if (teamA.length !== teamB.length) {
    throw new CorruptPairingError(
      `pairing teams differ in size: teamA has ${teamA.length}, teamB has ${teamB.length}`
    );
  }
  return { teamA, teamB };
}

/** Every player id named by a pairing's two teams, in teamA-then-teamB order. */
export function teamPlayers(pairing: { teamA: string; teamB: string }): string[] {
  const { teamA, teamB } = parseTeams(pairing);
  return [...teamA, ...teamB];
}
