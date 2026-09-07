import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /**
   * Bounded so a caller cannot make the server hash or compare an unbounded
   * body. The comparison itself is length-checked before it runs, so this is
   * about the request rather than the check.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;
}
