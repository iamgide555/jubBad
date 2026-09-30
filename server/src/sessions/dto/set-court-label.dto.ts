import { IsString, Matches, MaxLength } from 'class-validator';

export class SetCourtLabelDto {
  /** Blank (after trim) resets the court to its number. One line only. */
  @IsString()
  @MaxLength(30)
  @Matches(/^[^\p{Cc}\u2028\u2029]*$/u)
  label!: string;
}
