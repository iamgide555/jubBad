import { IsString, MinLength } from 'class-validator';

export class UpdateGroupDto {
  @IsString()
  @MinLength(1)
  name!: string;
}
