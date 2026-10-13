import { Transform } from 'class-transformer';
import { IsString, Matches, MinLength } from 'class-validator';
import { trimString } from './trim.js';

/**
 * A full lowercase UUID, as `crypto.randomUUID()` makes one. The client reuses one code
 * across retries of the same creation, so it must be too long to collide with another
 * host's group — an 8-hex clash would 404 on every retry with no way out. Legacy 8-hex
 * codes stay valid everywhere else; only creation enforces this.
 */
export const NEW_GROUP_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CreateGroupDto {
  @IsString()
  @Matches(NEW_GROUP_CODE)
  code!: string;

  /** Trimmed first: `@MinLength(1)` alone accepts "   ". */
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  name!: string;
}
