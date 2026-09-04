import { IsString, MinLength } from 'class-validator';

export class ParseRosterDto {
  @IsString()
  @MinLength(1)
  groupName!: string;

  @IsString()
  @MinLength(1)
  rawText!: string;
}
