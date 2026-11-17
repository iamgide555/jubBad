import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The email and password of an account that already exists. The password rule is login's (any length), not a new
 * account's 8: an older account may have a shorter one, and refusing it here would leave that host unable to link.
 */
export class LinkDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password!: string;
}
