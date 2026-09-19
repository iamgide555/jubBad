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
 *
 * **A `null` entry (a seat) may exist only while `confirmedAt` is null** — a
 * custom-mode pairing the host hasn't finished filling. `parseSeats` and its
 * derivatives (`parseSeatTeams`, `seatedPlayers`, `emptySeatCount`) are
 * tolerant of that; `parseTeam`/`parseTeams`/`teamPlayers` stay strict and
 * throw the moment a `null` reaches them, so every existing reader — which by
 * construction only ever sees confirmed rows — keeps its non-null guarantee
 * without an edit. The confirm guard in `sessions.service.ts` is what makes
 * that guarantee true: it refuses to confirm a pairing with any seat still
 * empty.
 */
export class CorruptPairingError extends Error {
  readonly code = 'INVALID_SESSION_STATE';

  constructor(message: string) {
    super(message);
    this.name = 'CorruptPairingError';
  }
}

/** A seat is a player id, or empty (unfilled, custom-mode only). */
export type Seat = string | null;

/** A team is 1 or 2 seats (singles or doubles), each filled or empty. */
export function parseSeats(raw: string): Seat[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CorruptPairingError(`pairing team is not valid JSON: ${raw}`);
  }
  if (
    !Array.isArray(value) ||
    (value.length !== 1 && value.length !== 2) ||
    value.some((seat) => seat !== null && typeof seat !== 'string')
  ) {
    throw new CorruptPairingError(`pairing team is not a 1- or 2-seat array: ${raw}`);
  }
  return value;
}

/**
 * Both teams on a court are always the same size — this is what makes
 * `teamA.length` a sufficient, self-consistent discriminator for a match's
 * format everywhere else in the service, rather than a stored (and
 * driftable) marker on the row. Holds equally for a court still being filled:
 * an empty seat still occupies a position, it just names nobody yet.
 */
export function parseSeatTeams(pairing: { teamA: string; teamB: string }): {
  teamA: Seat[];
  teamB: Seat[];
} {
  const teamA = parseSeats(pairing.teamA);
  const teamB = parseSeats(pairing.teamB);
  if (teamA.length !== teamB.length) {
    throw new CorruptPairingError(
      `pairing teams differ in size: teamA has ${teamA.length}, teamB has ${teamB.length}`
    );
  }
  return { teamA, teamB };
}

/** Every occupied seat's player id, teamA-then-teamB order. Empty seats are
 *  dropped, so this answers "who is on this court right now" regardless of
 *  whether every seat is filled yet. */
export function seatedPlayers(pairing: { teamA: string; teamB: string }): string[] {
  const { teamA, teamB } = parseSeatTeams(pairing);
  return [...teamA, ...teamB].filter((seat): seat is string => seat !== null);
}

/** How many of this court's seats are still unfilled. */
export function emptySeatCount(pairing: { teamA: string; teamB: string }): number {
  const { teamA, teamB } = parseSeatTeams(pairing);
  return [...teamA, ...teamB].filter((seat) => seat === null).length;
}

/**
 * A team is 1 player (singles) or 2 (doubles) — every seat filled. Built on
 * `parseSeats`, but throws rather than passing a `null` through: a caller
 * asking for a `string[]` is, by construction, only ever reading a confirmed
 * row (see the module doc above), where an empty seat would be corrupt state.
 */
export function parseTeam(raw: string): string[] {
  const seats = parseSeats(raw);
  if (seats.some((seat) => seat === null)) {
    throw new CorruptPairingError(`pairing team has an unfilled seat: ${raw}`);
  }
  return seats;
}

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
