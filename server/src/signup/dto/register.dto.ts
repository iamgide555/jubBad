import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  /** Trimmed first: a phone keyboard often leaves a trailing space. */
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;

  /**
   * A trap for form-filling bots: the page carries a hidden input with this name
   * that no person fills. A filled one is answered like a success and creates nothing.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
