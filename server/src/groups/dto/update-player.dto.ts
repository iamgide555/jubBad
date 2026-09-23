import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { LEVELS, type Level } from '../../../../engines/levels.ts';

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

  /** Skill level (ระดับมือ). Left out or explicitly null clears it. */
  @IsOptional()
  @IsIn(LEVELS)
  level?: Level | null;
}
