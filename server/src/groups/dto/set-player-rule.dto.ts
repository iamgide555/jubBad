import { IsIn, IsString, MinLength } from 'class-validator';
import { RULE_KINDS, type RuleKind } from '../../../../engines/pair-rules.ts';

export class SetPlayerRuleDto {
  @IsString()
  @MinLength(1)
  playerAId!: string;

  @IsString()
  @MinLength(1)
  playerBId!: string;

  @IsIn(RULE_KINDS)
  kind!: RuleKind;
}

/** Replacing a rule's kind keeps its id and pair — see GroupsService.setRuleKind. */
export class SetPlayerRuleKindDto {
  @IsIn(RULE_KINDS)
  kind!: RuleKind;
}
