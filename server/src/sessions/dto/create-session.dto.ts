import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { NameMatchDto } from './name-match.dto.js';
import { LEVELS, type Level } from '../../../../engines/levels.ts';

export class NameReviewDto {
  @IsString()
  inputName!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => NameMatchDto)
  match!: NameMatchDto;

  @IsIn(['accept', 'reject-new'])
  decision!: 'accept' | 'reject-new';

  /**
   * Set on a new player's chip, or on an existing player who has none yet
   * (C1). Ignored for an existing player who already has a level — a level
   * change is a deliberate edit on the roster page, not a side effect of
   * reviewing tonight's paste.
   */
  @IsOptional()
  @IsIn(LEVELS)
  level?: Level;
}

export class CreateSessionDto {
  @IsString()
  groupCode!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string | null;

  @IsOptional()
  @IsString()
  venue!: string | null;

  /** Same ceiling as SetCourtCountDto — a session created directly at an
   *  out-of-range court count would otherwise let a later per-court write
   *  (e.g. setting a court's format) name a court number storage silently
   *  can't hold. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  courtCount!: number | null;

  @IsString()
  rawImportText!: string;

  @IsUUID()
  idempotencyKey!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NameReviewDto)
  rosterReviews!: NameReviewDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NameReviewDto)
  waitlistReviews!: NameReviewDto[];
}
