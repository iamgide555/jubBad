import { HttpErrorResponse } from '@angular/common/http';

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

/** One line on what each kind does — shown where a host picks a kind, so
 *  ห้ามอยู่ด้วยกัน and ห้ามเล่นด้วยกัน (one word apart) are never a guess. */
export const RULE_KIND_HINTS: Readonly<Record<RuleKind, string>> = {
  'must-pair': $localize`:@@pairRule.mustPairHint:ลงทีมเดียวกัน หรือพักพร้อมกัน`,
  'never-teammates': $localize`:@@pairRule.neverTeammatesHint:เป็นคู่แข่งกันได้ แต่ไม่ลงทีมเดียวกัน`,
  'never-same-court': $localize`:@@pairRule.neverSameCourtHint:ไม่ลงคอร์ทเดียวกันเลย`,
};

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

/** Maps a failed create/edit-rule response to the host-facing message. */
export function ruleErrorMessage(err: unknown): string {
  const code = err instanceof HttpErrorResponse ? err.error?.code : undefined;
  switch (code) {
    case 'PAIR_RULE_EXISTS':
      return $localize`:@@playerRoster.ruleExists:ผู้เล่นคู่นี้มีกฎอยู่แล้ว`;
    case 'PAIR_RULE_MUST_PAIR_TAKEN':
      return $localize`:@@playerRoster.ruleMustPairTaken:ผู้เล่นคนนี้มีคู่กันอยู่แล้ว`;
    case 'PAIR_RULE_SELF':
      return $localize`:@@playerRoster.ruleSelf:เลือกผู้เล่นสองคนที่ต่างกัน`;
    default:
      return $localize`:@@playerRoster.ruleSaveFailed:บันทึกกฎไม่สำเร็จ`;
  }
}
