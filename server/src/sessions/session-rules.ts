/**
 * Session-level view of a group's pair rules (host-feedback C). The only
 * place `Session.disabledRuleIds` is parsed.
 */

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
