import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SetShuttleDetailsDto {
  /**
   * Omitted leaves the stored value unchanged — the client is expected to
   * only send fields it actually changed, so "omitted" means "leave alone,"
   * not "clear" (this is how a concurrent edit from another tab avoids being
   * clobbered). Explicit `null` clears it back to "not recorded". `0` is a
   * valid, meaningful value, distinct from `null`. Range is the standard
   * 32-bit Int range, 0 through 2147483647 inclusive.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  shuttleCount?: number | null;

  /**
   * Price per shuttlecock in satang (1 THB = 100 satang) — a plain integer;
   * baht<->satang conversion is the frontend's job, not this endpoint's.
   * Same omitted/null/value semantics as shuttleCount.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  shuttlePriceSatang?: number | null;
}
