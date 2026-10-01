import { IsBoolean } from 'class-validator';

export class SetShuttleUsableDto {
  @IsBoolean()
  usable!: boolean;
}
