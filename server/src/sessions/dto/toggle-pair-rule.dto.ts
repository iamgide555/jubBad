import { IsBoolean } from 'class-validator';

export class TogglePairRuleDto {
  @IsBoolean()
  enabled!: boolean;
}
