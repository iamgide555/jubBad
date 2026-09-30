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
