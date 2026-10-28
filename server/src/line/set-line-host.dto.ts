import { IsBoolean } from 'class-validator';

export class SetLineHostDto {
  @IsBoolean()
  enabled!: boolean;
}
