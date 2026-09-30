/**
 * Host pair rules (host-feedback C). A rule links two players of one group:
 *
 * - `must-pair` (คู่กัน): while both are available they play as doubles
 *   teammates or both sit out.
 * - `never-teammates` (ห้ามอยู่ด้วยกัน): never on the same team; opposing is fine.
 * - `never-same-court` (ห้ามเล่นด้วยกัน): never on the same court at all.
 *
 * Enabled rules are hard constraints in every pairing mode — see
 * docs/archive/specs/2026-09-30-pair-rules-design.md.
 *
 * The engine only ever sees *applicable* rules — both players present in the
 * roster it was handed — so a rule with one player on a court and the other
 * elsewhere is a real violation, not an absent partner.
 */
import { InvalidRoundInputError } from './errors.ts';
import { shuffle, type CourtSize } from './pairing.ts';

export const RULE_KINDS = ['must-pair', 'never-teammates', 'never-same-court'] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export type PairRule = {
  id: string;
  playerAId: string;
  playerBId: string;
  kind: RuleKind;
};

export function isRuleKind(value: unknown): value is RuleKind {
  return typeof value === 'string' && (RULE_KINDS as readonly string[]).includes(value);
}

/**
 * Fails loudly on rule data the server should never have produced: a
 * malformed or duplicate id, an unknown kind, a self-link, a player outside
 * the roster, the same pair twice, or a player with two required partners.
 * Coping instead would let a corrupt rule silently relax or over-constrain a
 * round.
 */
export function assertValidPairRules(roster: readonly string[], rules: readonly PairRule[]): void {
  const present = new Set(roster);
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const mustPaired = new Set<string>();
  for (const r of rules) {
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new InvalidRoundInputError('pair rule has an empty or non-string id');
    }
    if (ids.has(r.id)) throw new InvalidRoundInputError(`pair rule "${r.id}" appears more than once`);
    ids.add(r.id);
    if (!isRuleKind(r.kind)) throw new InvalidRoundInputError(`pair rule "${r.id}" has unknown kind "${r.kind}"`);
    if (r.playerAId === r.playerBId) {
      throw new InvalidRoundInputError(`pair rule "${r.id}" links a player to themselves`);
    }
    for (const player of [r.playerAId, r.playerBId]) {
      if (!present.has(player)) {
        throw new InvalidRoundInputError(`pair rule "${r.id}" names "${player}", who is not in the roster`);
      }
    }
    const pair = [r.playerAId, r.playerBId].sort().join('|');
    if (pairs.has(pair)) throw new InvalidRoundInputError(`pair rule "${r.id}" repeats an already-linked pair`);
    pairs.add(pair);
    if (r.kind === 'must-pair') {
      for (const player of [r.playerAId, r.playerBId]) {
        if (mustPaired.has(player)) {
          throw new InvalidRoundInputError(`"${player}" has more than one must-pair rule`);
        }
        mustPaired.add(player);
      }
    }
  }
}

/**
 * Whether one court satisfies every rule. A must-pair duo is legal only on
 * the same doubles team — never split across teams or courts, never singles.
 */
export function isLegalCourt(
  teamA: readonly string[],
  teamB: readonly string[],
  rules: readonly PairRule[]
): boolean {
  for (const r of rules) {
    const aTeam = teamA.includes(r.playerAId) ? 'A' : teamB.includes(r.playerAId) ? 'B' : null;
    const bTeam = teamA.includes(r.playerBId) ? 'A' : teamB.includes(r.playerBId) ? 'B' : null;
    if (aTeam === null && bTeam === null) continue;
    switch (r.kind) {
      case 'never-same-court':
        if (aTeam !== null && bTeam !== null) return false;
        break;
      case 'never-teammates':
        if (aTeam !== null && aTeam === bTeam) return false;
        break;
      case 'must-pair':
        if (aTeam !== bTeam || teamA.length < 2) return false;
        break;
    }
  }
  return true;
}

/** The rules that touch any of `players` — what a host must look at when a
 *  court involving them could not be legally filled. */
export function rulesTouching(players: Iterable<string>, rules: readonly PairRule[]): string[] {
  const set = new Set(players);
  return rules.filter((r) => set.has(r.playerAId) || set.has(r.playerBId)).map((r) => r.id);
}

/**
 * Every candidate for the requested players was checked and none satisfies
 * the enabled rules. Distinct from "not enough players": the people are
 * there, the rules forbid every lineup. `ruleIds` are the rules touching
 * those players — any of them may be the cause, not necessarily all.
 */
export class NoLegalRuleMatchError extends Error {
  readonly code = 'PAIR_RULES_BLOCKED';
  readonly ruleIds: string[];

  constructor(ruleIds: string[]) {
    super('no lineup satisfies the enabled pair rules');
    this.ruleIds = ruleIds;
    this.name = 'NoLegalRuleMatchError';
  }
}

/** The bounded search ran out before proving a legal lineup exists or not —
 *  never to be reported as "no legal match". */
export class PairRuleSearchLimitError extends Error {
  readonly code = 'PAIR_RULE_SEARCH_LIMIT';

  constructor() {
    super('pair-rule search limit reached before a legal lineup was found');
    this.name = 'PairRuleSearchLimitError';
  }
}

/** Explored partial assignments allowed per proposal (or per fill-all mode
 *  group) before the search reports itself inconclusive. */
export const PAIR_RULE_MAX_STATES = 100_000;

export interface LegalSearchInput {
  roster: readonly string[];
  sizes: readonly CourtSize[];
  rules: readonly PairRule[];
  gamesPlayedThisSession: ReadonlyMap<string, number>;
  waitingSince?: ReadonlyMap<string, number>;
  queueBy: 'games' | 'wait';
  random: () => number;
  /** Court index 0 (the requested court on propose) must be filled. */
  requireFirstCourt: boolean;
  maxStates: number;
  /** Every court in `sizes` must be filled — checking a pre-chosen playing set. */
  requireAllCourts?: boolean;
}

export type LegalSearchResult =
  | { status: 'found'; courts: { courtIndex: number; players: string[] }[]; sittingOut: string[] }
  | { status: 'impossible' }
  | { status: 'limit' };

/**
 * The roster as rotation units, most deserving first: a must-pair duo is one
 * two-seat unit ranked by its less deserving member (more games then shorter
 * wait; wait alone in the level queue), everyone else a unit of one. Ties
 * fall to `random`, exactly as `selectSittingOut` breaks them.
 */
export function rotationUnits(
  roster: readonly string[],
  rules: readonly PairRule[],
  gamesPlayedThisSession: ReadonlyMap<string, number>,
  waitingSince: ReadonlyMap<string, number> | undefined,
  queueBy: 'games' | 'wait',
  random: () => number
): string[][] {
  const deserving = shuffle([...roster], random).sort((a, b) => {
    if (queueBy === 'games') {
      const byGames = (gamesPlayedThisSession.get(a) ?? 0) - (gamesPlayedThisSession.get(b) ?? 0);
      if (byGames !== 0) return byGames;
    }
    return (waitingSince?.get(a) ?? 0) - (waitingSince?.get(b) ?? 0);
  });
  return unitsInOrder(deserving, rules);
}

/** Groups `deservingFirst` into units, each placed at its less deserving
 *  member's position. */
export function unitsInOrder(deservingFirst: readonly string[], rules: readonly PairRule[]): string[][] {
  const present = new Set(deservingFirst);
  const partner = new Map<string, string>();
  for (const r of rules) {
    if (r.kind !== 'must-pair' || !present.has(r.playerAId) || !present.has(r.playerBId)) continue;
    partner.set(r.playerAId, r.playerBId);
    partner.set(r.playerBId, r.playerAId);
  }
  const units: string[][] = [];
  const placed = new Set<string>();
  // Walking deserving-first, a duo is emitted when its *second* member is
  // reached — i.e. at the less deserving member's position.
  for (const id of deservingFirst) {
    const mate = partner.get(id);
    if (mate === undefined) {
      units.push([id]);
    } else if (placed.has(mate)) {
      units.push([mate, id]);
    }
    placed.add(id);
  }
  return units;
}

function hasLegalSplit(group: readonly string[], rules: readonly PairRule[]): boolean {
  if (group.length === 2) return isLegalCourt([group[0]], [group[1]], rules);
  const [a, b, c, d] = group;
  return (
    isLegalCourt([a, b], [c, d], rules) || isLegalCourt([a, c], [b, d], rules) || isLegalCourt([a, d], [b, c], rules)
  );
}

/**
 * Finds which players can legally fill which courts, choosing by rotation
 * priority: the depth-first search places units most-deserving-first and
 * tries "play" before "sit", so the first complete assignment it reaches is
 * the fairest legal selection. Court sets are tried most seats first; among
 * equals the legacy in-order prefix (what the no-rule engine would fill)
 * leads, then earliest courts — so a unit a singles court cannot hold never
 * starves a later doubles court.
 *
 * `impossible` is a proof (every candidate checked); `limit` means the shared
 * `maxStates` budget ran out first and says nothing about feasibility.
 */
export function searchLegalAssignments(input: LegalSearchInput): LegalSearchResult {
  const { roster, sizes, rules, maxStates } = input;
  const units = rotationUnits(
    roster,
    rules,
    input.gamesPlayedThisSession,
    input.waitingSince,
    input.queueBy,
    input.random
  );

  const allIndexes = sizes.map((_, i) => i);
  const seatsOf = (set: number[]) => set.reduce((sum, i) => sum + sizes[i], 0);
  const candidates = input.requireAllCourts
    ? seatsOf(allIndexes) <= roster.length
      ? [allIndexes]
      : []
    : courtSetsBySeats(sizes, roster.length, input.requireFirstCourt);

  if (candidates.length === 0) {
    // Not enough people for any court at all — not a rule question.
    return { status: 'found', courts: [], sittingOut: [...roster] };
  }

  let states = 0;
  for (const set of candidates) {
    const outcome = fillCourts(units, set.map((i) => sizes[i]), rules, () => ++states > maxStates);
    if (outcome === 'limit') return { status: 'limit' };
    if (outcome === 'impossible') continue;
    const placed = new Set(outcome.flat());
    return {
      status: 'found',
      courts: set.map((courtIndex, k) => ({ courtIndex, players: outcome[k] })),
      sittingOut: roster.filter((id) => !placed.has(id)),
    };
  }
  return { status: 'impossible' };
}

/**
 * Candidate court sets, most seats first. Courts of one size are
 * interchangeable for feasibility, so a set is identified by how many
 * doubles and singles courts it uses and always takes the earliest indexes
 * of each — which is also exactly what the legacy in-order prefix looks like,
 * so it leads among equal seat counts. At most 21×21 sets for the 20-court
 * cap, never 2^20 subsets.
 */
export function courtSetsBySeats(
  sizes: readonly CourtSize[],
  available: number,
  requireFirstCourt: boolean
): number[][] {
  const doubles = sizes.flatMap((size, i) => (size === 4 ? [i] : []));
  const singles = sizes.flatMap((size, i) => (size === 2 ? [i] : []));

  let prefixKey = '';
  {
    const prefix: number[] = [];
    let used = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (used + sizes[i] > available) break;
      prefix.push(i);
      used += sizes[i];
    }
    prefixKey = prefix.join(',');
  }

  const sets: { set: number[]; seats: number; key: string }[] = [];
  for (let d = 0; d <= doubles.length; d++) {
    for (let t = 0; t <= singles.length; t++) {
      const seats = d * 4 + t * 2;
      if (seats === 0 || seats > available) continue;
      const set = [...doubles.slice(0, d), ...singles.slice(0, t)].sort((a, b) => a - b);
      if (requireFirstCourt && set[0] !== 0) continue;
      sets.push({ set, seats, key: set.join(',') });
    }
  }
  sets.sort((a, b) => {
    if (a.seats !== b.seats) return b.seats - a.seats;
    const aPrefix = a.key === prefixKey ? 0 : 1;
    const bPrefix = b.key === prefixKey ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    for (let k = 0; k < Math.min(a.set.length, b.set.length); k++) {
      if (a.set[k] !== b.set[k]) return a.set[k] - b.set[k];
    }
    return a.set.length - b.set.length;
  });
  return sets.map((entry) => entry.set);
}

function fillCourts(
  units: readonly string[][],
  courtSizes: readonly number[],
  rules: readonly PairRule[],
  spend: () => boolean
): string[][] | 'impossible' | 'limit' {
  const total = courtSizes.reduce((a, b) => a + b, 0);
  const seatsFrom = new Array<number>(units.length + 1).fill(0);
  for (let u = units.length - 1; u >= 0; u--) seatsFrom[u] = seatsFrom[u + 1] + units[u].length;

  const apart = new Map<string, Set<string>>();
  for (const r of rules) {
    if (r.kind !== 'never-same-court') continue;
    for (const [x, y] of [[r.playerAId, r.playerBId], [r.playerBId, r.playerAId]]) {
      if (!apart.has(x)) apart.set(x, new Set());
      apart.get(x)!.add(y);
    }
  }

  const members: string[][] = courtSizes.map(() => []);
  let filled = 0;

  const dfs = (u: number): 'found' | 'impossible' | 'limit' => {
    if (filled === total) return 'found';
    if (seatsFrom[u] < total - filled) return 'impossible';
    if (spend()) return 'limit';
    const unit = units[u];
    const triedEmpty = new Set<number>();
    for (let c = 0; c < courtSizes.length; c++) {
      const size = courtSizes[c];
      if (size - members[c].length < unit.length) continue;
      if (unit.length === 2 && size === 2) continue;
      if (members[c].length === 0) {
        // Empty courts of one size are interchangeable for feasibility.
        if (triedEmpty.has(size)) continue;
        triedEmpty.add(size);
      }
      if (unit.some((id) => members[c].some((other) => apart.get(id)?.has(other)))) continue;
      members[c].push(...unit);
      filled += unit.length;
      if (members[c].length < size || hasLegalSplit(members[c], rules)) {
        const outcome = dfs(u + 1);
        if (outcome !== 'impossible') return outcome;
      }
      members[c].length -= unit.length;
      filled -= unit.length;
    }
    return dfs(u + 1);
  };

  const outcome = dfs(0);
  if (outcome === 'found') return members.map((m) => [...m]);
  return outcome;
}
