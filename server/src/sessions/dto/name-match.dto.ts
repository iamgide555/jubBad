import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class NameMatchDto {
  @IsIn(['exact', 'fuzzy', 'duplicate', 'new'])
  type!: 'exact' | 'fuzzy' | 'duplicate' | 'new';

  @IsOptional()
  @IsString()
  playerId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  score?: number;
}
