import { IsInt, IsString, Min, ValidateIf } from 'class-validator';

export class SetPlayerLevelDto {
  /**
   * The level name in THIS group's ladder, or an explicit null to clear. The key
   * itself is required: an absent `level` is a 400, never a silent clear. Which
   * names are valid depends on the group's ladder, so the service checks that.
   */
  @ValidateIf((_, v) => v !== null)
  @IsString()
  level!: string | null;

  /** The ladder revision the host saw when picking; required even to clear. */
  @IsInt()
  @Min(0)
  expectedLadderRevision!: number;
}
