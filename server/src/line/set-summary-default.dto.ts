import { IsBoolean } from 'class-validator';

export class SetSummaryDefaultDto {
  @IsBoolean()
  summaryDefault!: boolean;
}
