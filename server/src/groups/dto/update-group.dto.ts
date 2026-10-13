import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';
import { trimString } from './trim.js';

export class UpdateGroupDto {
  /** Trimmed exactly like CreateGroupDto.name, so rename and creation accept and store the same names. */
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  name!: string;
}
