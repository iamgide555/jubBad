import { IsBoolean, ValidateIf } from 'class-validator';

export class UpdateLineSettingsDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  summaryDefault?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  rosterOnly?: boolean;
}
