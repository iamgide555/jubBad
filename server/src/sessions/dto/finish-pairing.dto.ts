import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class FinishPairingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  scoreA!: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  scoreB!: number | null;

  // Nullable: a match abandoned part-way (injury, court time ran out) still
  // has to free the court, and recording a winner that did not happen would
  // poison both the stats table and any future rating model.
  @IsOptional()
  @IsIn(['A', 'B'])
  winner!: 'A' | 'B' | null;
}
