import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SetSeatDto {
  @IsIn(['A', 'B'])
  team!: 'A' | 'B';

  @IsInt()
  @Min(0)
  @Max(1)
  index!: number;

  /**
   * The player to place in this seat. Omitted (or explicitly `null`) vacates
   * it instead — the seat route's equivalent of `SwapPlayerDto`'s "take them
   * off," except there is nobody rotation should pick to fill in: the seat
   * just goes back to empty, for the host to fill by hand or with auto-pair.
   */
  @IsOptional()
  @IsString()
  playerId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
