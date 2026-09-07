import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class FinishPairingDto {
  @ValidateIf((dto: FinishPairingDto) => dto.scoreA != null || dto.scoreB != null)
  @IsInt()
  @Min(0)
  scoreA?: number | null;

  @ValidateIf((dto: FinishPairingDto) => dto.scoreA != null || dto.scoreB != null)
  @IsInt()
  @Min(0)
  scoreB?: number | null;

  // Nullable: a match abandoned part-way (injury, court time ran out) still
  // has to free the court, and recording a winner that did not happen would
  // poison both the stats table and any future rating model.
  @IsOptional()
  @IsIn(['A', 'B'])
  winner?: 'A' | 'B' | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
