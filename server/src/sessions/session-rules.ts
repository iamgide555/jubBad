/**
 * Session-level view of a group's pair rules (host-feedback C). The only
 * place `Session.disabledRuleIds` is parsed.
 */

import { isLegalCourt, type PairRule as EnginePairRule } from '../../../engines/pair-rules.ts';

export class InvalidDisabledRuleIdsError extends Error {}

/**
 * Null (a legacy row) means none disabled. Anything else must be a list of
 * distinct non-empty ids: a corrupt value is not permission to drop rules
 * the host thinks are on.
 */
export function parseDisabledRuleIds(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidDisabledRuleIdsError(`disabledRuleIds is not JSON: ${raw}`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((id) => typeof id === 'string' && id.length > 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new InvalidDisabledRuleIdsError(`disabledRuleIds is not a list of distinct ids: ${raw}`);
  }
  return parsed as string[];
}

type RuleLike = { id: string; playerAId: string; playerBId: string };

/** Unknown ids (a rule since deleted) are inert. */
export function enabledRules<T extends RuleLike>(rules: readonly T[], disabledIds: readonly string[]): T[] {
  const disabled = new Set(disabledIds);
  return rules.filter((r) => !disabled.has(r.id));
}

/** A rule binds only while both of its players are active on the roster. */
export function applicableRules<T extends RuleLike>(rules: readonly T[], activeIds: ReadonlySet<string>): T[] {
  return rules.filter((r) => activeIds.has(r.playerAId) && activeIds.has(r.playerBId));
}

/**
 * The rules an engine call may see: only those with both players among
 * `participants` (the engine refuses anything else). A must-pair player whose
 * partner is active but not a participant — seated on another court — is
 * `stranded`: they cannot legally play without that partner, so the caller
 * drops them from the pool rather than letting a proposal seat them alone.
 */
export function rulesForParticipants<T extends RuleLike & { kind: string }>(
  rules: readonly T[],
  participants: ReadonlySet<string>
): { rules: T[]; stranded: Map<string, string> } {
  const inside: T[] = [];
  const stranded = new Map<string, string>(); // player id -> rule id
  for (const r of rules) {
    const a = participants.has(r.playerAId);
    const b = participants.has(r.playerBId);
    if (a && b) inside.push(r);
    else if (r.kind === 'must-pair' && (a || b)) stranded.set(a ? r.playerAId : r.playerBId, r.id);
  }
  return { rules: inside, stranded };
}

/** Which rules one full court breaks, in rule order. */
export function violatedRules(
  teamA: readonly string[],
  teamB: readonly string[],
  rules: readonly EnginePairRule[]
): string[] {
  return rules.filter((r) => !isLegalCourt(teamA, teamB, [r])).map((r) => r.id);
}
