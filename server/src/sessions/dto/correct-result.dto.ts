import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

/**
 * Replaces a finished game's recorded result. Same shape and coherence rules as
 * finishing (a score needs both sides and a matching winner; a null winner is
 * "no result"), plus the revision the page read so a stale edit is refused.
 */
export class CorrectResultDto {
  @ValidateIf((dto: CorrectResultDto) => dto.scoreA != null || dto.scoreB != null)
  @IsInt()
  @Min(0)
  scoreA?: number | null;

  @ValidateIf((dto: CorrectResultDto) => dto.scoreA != null || dto.scoreB != null)
  @IsInt()
  @Min(0)
  scoreB?: number | null;

  @IsOptional()
  @IsIn(['A', 'B'])
  winner?: 'A' | 'B' | null;

  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
