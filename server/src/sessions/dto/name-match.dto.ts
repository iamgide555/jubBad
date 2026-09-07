import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class NameMatchDto {
  @IsIn(['exact', 'fuzzy', 'duplicate', 'new'])
  type!: 'exact' | 'fuzzy' | 'duplicate' | 'new';

  @ValidateIf((match: NameMatchDto) => ['exact', 'fuzzy', 'duplicate'].includes(match.type))
  @IsString()
  @IsNotEmpty()
  playerId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  score?: number;
}
