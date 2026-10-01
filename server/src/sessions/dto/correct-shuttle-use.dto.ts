import { IsArray, IsBoolean, IsInt, IsString, Min, MinLength } from 'class-validator';

/**
 * Replaces a finished game's shuttle set. Duplicates are refused rather than
 * silently deduplicated: a repeated id is a client bug worth surfacing.
 */
export class CorrectShuttleUseDto {
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  shuttleIds!: string[];

  /** Also open one new numbered shuttle and add it to the set (a missed one). */
  @IsBoolean()
  openNew!: boolean;

  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
