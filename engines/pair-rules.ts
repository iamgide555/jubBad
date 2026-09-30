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
 */
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
