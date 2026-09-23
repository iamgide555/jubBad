import { IsIn, IsOptional } from 'class-validator';
import { LEVELS, type Level } from '../../../../engines/levels.ts';

export class SetPlayerLevelDto {
  /** Explicit null clears the level. */
  @IsOptional()
  @IsIn(LEVELS)
  level!: Level | null;
}
