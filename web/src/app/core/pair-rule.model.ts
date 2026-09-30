export type RuleKind = 'must-pair' | 'never-teammates' | 'never-same-court';

export interface PairRule {
  id: string;
  groupId: string;
  playerAId: string;
  playerBId: string;
  kind: RuleKind;
  createdAt: string;
}

export interface CreatePairRuleRequest {
  playerAId: string;
  playerBId: string;
  kind: RuleKind;
}

export const RULE_KINDS: readonly { kind: RuleKind; label: string }[] = [
  { kind: 'must-pair', label: $localize`:@@pairRule.mustPair:คู่กัน` },
  { kind: 'never-teammates', label: $localize`:@@pairRule.neverTeammates:ห้ามอยู่ด้วยกัน` },
  { kind: 'never-same-court', label: $localize`:@@pairRule.neverSameCourt:ห้ามเล่นด้วยกัน` },
];

export function ruleKindLabel(kind: RuleKind): string {
  return RULE_KINDS.find((k) => k.kind === kind)!.label;
}

/** "ตั้ม · มด (คู่กัน)" per rule, comma-joined; ids no longer known are skipped. */
export function describeRules(
  ruleIds: readonly string[],
  rules: readonly PairRule[],
  players: readonly { id: string; name: string }[]
): string {
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? '?';
  return ruleIds
    .map((id) => rules.find((r) => r.id === id))
    .filter((r): r is PairRule => r !== undefined)
    .map((r) => `${nameOf(r.playerAId)} · ${nameOf(r.playerBId)} (${ruleKindLabel(r.kind)})`)
    .join(', ');
}
