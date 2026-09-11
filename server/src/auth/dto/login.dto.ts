import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /**
   * Bounded so a caller cannot make the server hash an unbounded body — scrypt
   * runs whether or not the email matches an account, see
   * UsersService#verifyCredentials.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password!: string;
}
