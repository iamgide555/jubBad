import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Email and password for the LINE sign-up and link pages. Same rules as `RegisterDto`, without the bot trap. */
export class CredentialsDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;
}
