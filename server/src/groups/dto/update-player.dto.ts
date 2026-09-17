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
}
