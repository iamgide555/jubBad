import { Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import {
  BILL_MODELS, ROUNDING_STEPS, SHUTTLE_CHARGES, SPLIT_MODES, type BillModel, type RoundingStep, type ShuttleCharge, type SplitMode,
} from '../../../../engines/bill.ts';

const MAX = 2147483647;

export class BillOverrideDto {
  @IsString() @MinLength(1) playerId!: string;
  @IsInt() @Min(0) @Max(MAX) amountSatang!: number;
}

/** Full replace — every field required. Nullable fields must be present as null. */
export class SetBillConfigDto {
  @IsIn(BILL_MODELS) model!: BillModel;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(MAX) courtFeeSatang!: number | null;
  @IsIn(SPLIT_MODES) courtSplit!: SplitMode;
  @IsIn(SPLIT_MODES) shuttleSplit!: SplitMode;
  @IsInt() @Min(0) @Max(MAX) perGameRateSatang!: number;
  @IsInt() @Min(0) @Max(MAX) entryFeeSatang!: number;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(MAX) capSatang!: number | null;
  @IsInt() @Min(0) @Max(MAX) buffetPriceSatang!: number;
  @IsBoolean() buffetShuttlesIncluded!: boolean;
  @IsInt() @Min(0) @Max(MAX) startingFeeSatang!: number;
  // Optional on input so an old open tab that predates these fields still saves; absent means shared / follow-the-price.
  @IsOptional() @IsIn(SHUTTLE_CHARGES) shuttleCharge?: ShuttleCharge;
  @IsOptional() @IsInt() @Min(0) @Max(MAX) perPlayerShuttleSatang?: number | null;
  @IsInt() @Min(0) @Max(MAX) hostFeeSatang!: number;
  @IsInt() @Min(0) @Max(MAX) walkInFeeSatang!: number;
  @IsIn(ROUNDING_STEPS) roundingBaht!: RoundingStep;
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) addedIds!: string[];
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) removedIds!: string[];
  // Optional on input so an old open tab that predates ไม่มา still saves; absent keeps the stored list.
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) absentIds?: string[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => BillOverrideDto) overrides!: BillOverrideDto[];
}
