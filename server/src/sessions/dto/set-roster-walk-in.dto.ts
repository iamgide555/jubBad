import { IsBoolean } from 'class-validator';

export class SetRosterWalkInDto {
  @IsBoolean()
  walkIn!: boolean;
}
