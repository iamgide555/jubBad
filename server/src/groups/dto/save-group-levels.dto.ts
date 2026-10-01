import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export const LEVEL_ACTIONS = ['customize', 'edit', 'reset'] as const;
export type LevelAction = (typeof LEVEL_ACTIONS)[number];

export class LevelDraftDto {
  /** Present only for an existing custom level; the server assigns ids to new ones. */
  @IsOptional()
  @IsString()
  id?: string;

  /** Shape-checked here; the rules (length, case-folded uniqueness, order) live in engines/levels.ts. */
  @IsString()
  name!: string;

  @IsNumber()
  startingElo!: number;
}

export class SaveGroupLevelsDto {
  @IsIn(LEVEL_ACTIONS)
  action!: LevelAction;

  /** The revision the host saw; a stale one is refused so a second tab cannot overwrite a newer ladder. */
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LevelDraftDto)
  levels?: LevelDraftDto[];
}
