import { IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdatePlayerDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age?: number;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Matches(/^[0-9+\- ]{6,20}$/)
  phone?: string;

  /**
   * Skill level (ระดับมือ), a name from this group's ladder. Left out, the player's
   * level is untouched (a contact-only edit never clears a tag); an explicit null
   * clears it. Either way a present key needs `expectedLadderRevision`.
   */
  @IsOptional()
  @IsString()
  level?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedLadderRevision?: number;
}
