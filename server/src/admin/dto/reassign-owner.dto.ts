import { IsString, MinLength } from 'class-validator';

export class ReassignOwnerDto {
  @IsString()
  @MinLength(1)
  toUserId!: string;
}
