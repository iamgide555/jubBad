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
