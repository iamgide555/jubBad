import { IsInt, IsOptional, Min } from 'class-validator';

export class FinishPairingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  scoreA!: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  scoreB!: number | null;
}
