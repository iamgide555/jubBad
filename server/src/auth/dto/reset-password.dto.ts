import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  /** Eight characters is the one policy this app enforces on a password. */
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;
}
