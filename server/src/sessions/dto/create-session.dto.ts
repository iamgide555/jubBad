import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { NameMatchDto } from './name-match.dto.js';

export class NameReviewDto {
  @IsString()
  inputName!: string;

  @ValidateNested()
  @Type(() => NameMatchDto)
  match!: NameMatchDto;

  @IsIn(['accept', 'reject-new'])
  decision!: 'accept' | 'reject-new';
}

export class CreateSessionDto {
  @IsString()
  groupCode!: string;

  @IsOptional()
  @IsString()
  date!: string | null;

  @IsOptional()
  @IsString()
  venue!: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  courtCount!: number | null;

  @IsString()
  rawImportText!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NameReviewDto)
  rosterReviews!: NameReviewDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NameReviewDto)
  waitlistReviews!: NameReviewDto[];
}
